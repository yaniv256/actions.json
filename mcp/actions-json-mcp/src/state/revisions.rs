use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;

use super::{
    operations::{accept_in_transaction, AcceptOutcome, OperationAcceptance},
    LifecycleState,
};

pub const DEFAULT_NOTICE_LIMIT: usize = 5;
pub const MAX_NOTICE_LIMIT: usize = 50;
pub const OPERATION_METADATA_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const MUTATION_HISTORY_RETENTION_MS: i64 = OPERATION_METADATA_RETENTION_MS;

#[derive(Debug, Clone, Serialize)]
pub struct InterveningMutation {
    pub revision: i64,
    pub operation_id: String,
    pub caller_label: String,
    pub completed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationNoticePage {
    pub target_id: String,
    pub current_revision: i64,
    pub cursor: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub history_truncated: bool,
    pub oldest_available_cursor: i64,
    pub notices: Vec<InterveningMutation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationAdmission {
    pub operation_id: String,
    pub target_id: String,
    pub target_generation: String,
    pub catalog_revision: String,
    pub queue_sequence: i64,
    pub accepted_at_ms: i64,
    pub current_revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_authority: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationClaim {
    pub operation_id: String,
    pub target_id: String,
    pub target_generation: String,
    pub catalog_revision: String,
    pub queue_sequence: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_authority: Option<String>,
    pub accepted_at_ms: i64,
    pub dispatched_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationCompletion {
    pub operation_id: String,
    pub target_id: String,
    pub mutation_revision: i64,
    pub interference: MutationNoticePage,
    pub canonical_result: Value,
}

pub(crate) struct MutationInsert<'a> {
    pub acceptance: &'a OperationAcceptance,
    pub target_id: &'a str,
    pub target_generation: &'a str,
    pub catalog_revision: &'a str,
    pub caller_key: Option<&'a str>,
    pub caller_label: &'a str,
    pub lease_authority: Option<&'a str>,
    pub now_ms: i64,
}

pub(crate) fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS target_mutation_revisions (\
           target_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);\
         CREATE TABLE IF NOT EXISTS mutation_queue (\
           queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,\
           target_id TEXT NOT NULL, target_generation TEXT NOT NULL, catalog_revision TEXT NOT NULL,\
           caller_key TEXT, caller_label TEXT NOT NULL, lease_authority TEXT,\
           state TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL, dispatched_at_ms INTEGER, completed_at_ms INTEGER);\
         CREATE INDEX IF NOT EXISTS mutation_queue_target_state ON mutation_queue(target_id,state,queue_sequence);\
         CREATE TABLE IF NOT EXISTS mutation_events (\
           target_id TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE,\
           caller_key TEXT, caller_label TEXT NOT NULL, completed_at_ms INTEGER NOT NULL,\
           PRIMARY KEY(target_id,revision));\
         CREATE TABLE IF NOT EXISTS mutation_event_floors (\
           target_id TEXT PRIMARY KEY, floor_revision INTEGER NOT NULL DEFAULT 0);\
         CREATE TABLE IF NOT EXISTS profile_target_cursors (\
           profile_key TEXT NOT NULL, target_id TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,\
           updated_at_ms INTEGER NOT NULL, PRIMARY KEY(profile_key,target_id));",
    )
}

pub(crate) fn admit(tx: &Transaction<'_>, insert: MutationInsert<'_>) -> Result<MutationAdmission> {
    let outcome = accept_in_transaction(
        tx,
        insert.acceptance,
        OPERATION_METADATA_RETENTION_MS,
        insert.now_ms,
    )?;
    let operation_id = match outcome {
        AcceptOutcome::Conflict { .. } => bail!("request_identity_conflict"),
        AcceptOutcome::Existing(operation) => {
            let admission = load_admission(tx, &operation.operation_id)?
                .context("request identity belongs to a non-mutation operation")?;
            return Ok(admission);
        }
        AcceptOutcome::Accepted(operation) => operation.operation_id,
    };
    tx.execute(
        "INSERT INTO target_mutation_revisions(target_id,revision) VALUES(?,0) ON CONFLICT(target_id) DO NOTHING",
        [insert.target_id],
    )?;
    tx.execute(
        "INSERT INTO mutation_queue(operation_id,target_id,target_generation,catalog_revision,caller_key,caller_label,lease_authority,state,accepted_at_ms) VALUES(?,?,?,?,?,?,?,'accepted',?)",
        params![operation_id, insert.target_id, insert.target_generation, insert.catalog_revision, insert.caller_key, insert.caller_label, insert.lease_authority, insert.now_ms],
    )?;
    load_admission(tx, &operation_id)?.context("accepted mutation disappeared")
}

pub(crate) fn claim_next(
    tx: &Transaction<'_>,
    target_id: &str,
    now_ms: i64,
) -> Result<Option<MutationClaim>> {
    // Receipt reconciliation may close the durable journal after a resident
    // crash. Mirror that terminal classification before checking the lane so
    // a dead dispatcher can never wedge all later mutations for the target.
    tx.execute(
        "UPDATE mutation_queue SET state=(SELECT lifecycle FROM durable_operations d WHERE d.operation_id=mutation_queue.operation_id),completed_at_ms=COALESCE(completed_at_ms,?) \
         WHERE target_id=? AND state='dispatched' AND EXISTS(SELECT 1 FROM durable_operations d WHERE d.operation_id=mutation_queue.operation_id AND d.lifecycle IN ('terminal','indeterminate'))",
        params![now_ms,target_id],
    )?;
    let in_flight: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mutation_queue WHERE target_id=? AND state='dispatched')",
        [target_id],
        |row| row.get(0),
    )?;
    if in_flight {
        return Ok(None);
    }
    let operation_id: Option<String> = tx.query_row(
        "SELECT operation_id FROM mutation_queue WHERE target_id=? AND state='accepted' ORDER BY queue_sequence LIMIT 1",
        [target_id], |row| row.get(0),
    ).optional()?;
    let Some(operation_id) = operation_id else {
        return Ok(None);
    };
    let authority_valid: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mutation_queue q \
         JOIN resident_targets t ON t.target_id=q.target_id AND t.target_generation=q.target_generation AND t.live=1 \
         JOIN catalog_snapshots c ON c.target_id=q.target_id AND c.target_generation=q.target_generation AND c.revision=q.catalog_revision \
         WHERE q.operation_id=?)",
        [&operation_id], |row| row.get(0),
    )?;
    if !authority_valid {
        tx.execute("UPDATE mutation_queue SET state='indeterminate',completed_at_ms=? WHERE operation_id=? AND state='accepted'", params![now_ms,operation_id])?;
        tx.execute("UPDATE durable_operations SET lifecycle='indeterminate',updated_at_ms=? WHERE operation_id=? AND lifecycle='accepted_not_dispatched'", params![now_ms,operation_id])?;
        bail!("stale_mutation_authority");
    }
    let changed = tx.execute(
        "UPDATE mutation_queue SET state='dispatched',dispatched_at_ms=? WHERE operation_id=? AND state='accepted'",
        params![now_ms, operation_id],
    )?;
    if changed != 1 {
        return Ok(None);
    }
    tx.execute(
        "UPDATE durable_operations SET lifecycle='dispatched',updated_at_ms=? WHERE operation_id=? AND lifecycle='accepted_not_dispatched'",
        params![now_ms, operation_id],
    )?;
    load_claim(tx, &operation_id)
}

/// Claim one known accepted operation only when it is the FIFO head. Unlike
/// `claim_next`, this cannot accidentally transition an earlier operation that
/// belongs to another resident request task.
pub(crate) fn claim_specific(
    tx: &Transaction<'_>,
    target_id: &str,
    operation_id: &str,
    now_ms: i64,
) -> Result<Option<MutationClaim>> {
    tx.execute(
        "UPDATE mutation_queue SET state=(SELECT lifecycle FROM durable_operations d WHERE d.operation_id=mutation_queue.operation_id),completed_at_ms=COALESCE(completed_at_ms,?) \
         WHERE target_id=? AND state='dispatched' AND EXISTS(SELECT 1 FROM durable_operations d WHERE d.operation_id=mutation_queue.operation_id AND d.lifecycle IN ('terminal','indeterminate'))",
        params![now_ms,target_id],
    )?;
    let in_flight: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mutation_queue WHERE target_id=? AND state='dispatched')",
        [target_id],
        |row| row.get(0),
    )?;
    if in_flight {
        return Ok(None);
    }
    let head: Option<String> = tx.query_row(
        "SELECT operation_id FROM mutation_queue WHERE target_id=? AND state='accepted' ORDER BY queue_sequence LIMIT 1",
        [target_id],
        |row| row.get(0),
    ).optional()?;
    if head.as_deref() != Some(operation_id) {
        return Ok(None);
    }
    let changed=tx.execute(
        "UPDATE mutation_queue SET state='dispatched',dispatched_at_ms=? WHERE operation_id=? AND state='accepted'",
        params![now_ms,operation_id],
    )?;
    if changed != 1 {
        return Ok(None);
    }
    load_claim(tx, operation_id)
}

pub(crate) fn mark_indeterminate(
    tx: &Transaction<'_>,
    operation_id: &str,
    now_ms: i64,
) -> Result<()> {
    let changed = tx.execute(
        "UPDATE mutation_queue SET state='indeterminate',completed_at_ms=? WHERE operation_id=? AND state IN ('accepted','dispatched')",
        params![now_ms,operation_id],
    )?;
    if changed != 1 {
        bail!("mutation_not_active");
    }
    tx.execute(
        "UPDATE durable_operations SET lifecycle='indeterminate',replay_payload=NULL,updated_at_ms=? WHERE operation_id=? AND lifecycle IN ('accepted_not_dispatched','dispatched')",
        params![now_ms,operation_id],
    )?;
    Ok(())
}

pub(crate) fn complete(
    tx: &Transaction<'_>,
    operation_id: &str,
    result: &Value,
    now_ms: i64,
) -> Result<MutationCompletion> {
    let row: Option<(String, Option<String>, String, Option<String>)> = tx.query_row(
        "SELECT target_id,caller_key,caller_label,lease_authority FROM mutation_queue WHERE operation_id=? AND state='dispatched'",
        [operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    let Some((target_id, caller_key, caller_label, lease_authority)) = row else {
        bail!("mutation_not_dispatched");
    };
    tx.execute("INSERT INTO target_mutation_revisions(target_id,revision) VALUES(?,0) ON CONFLICT(target_id) DO NOTHING", [&target_id])?;
    tx.execute(
        "UPDATE target_mutation_revisions SET revision=revision+1 WHERE target_id=?",
        [&target_id],
    )?;
    let revision: i64 = tx.query_row(
        "SELECT revision FROM target_mutation_revisions WHERE target_id=?",
        [&target_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO mutation_events(target_id,revision,operation_id,caller_key,caller_label,completed_at_ms) VALUES(?,?,?,?,?,?)",
        params![target_id, revision, operation_id, caller_key, caller_label, now_ms],
    )?;
    tx.execute(
        "UPDATE mutation_queue SET state='terminal',completed_at_ms=? WHERE operation_id=?",
        params![now_ms, operation_id],
    )?;
    let cursor = caller_key
        .as_deref()
        .map(|key| load_cursor(tx, key, &target_id))
        .transpose()?
        .unwrap_or(0);
    let interference = notices(
        tx,
        caller_key.as_deref(),
        &target_id,
        cursor,
        DEFAULT_NOTICE_LIMIT,
        false,
        now_ms,
    )?;
    if let Some(key) = caller_key.as_deref() {
        set_cursor(tx, key, &target_id, interference.next_cursor, now_ms)?;
    }
    let canonical_result =
        augment_result(result, revision, &interference, lease_authority.as_deref());
    tx.execute(
        "UPDATE durable_operations SET lifecycle=?,result_json=?,replay_payload=NULL,updated_at_ms=? WHERE operation_id=?",
        params![LifecycleState::Terminal.as_str(), serde_json::to_string(&canonical_result)?, now_ms, operation_id],
    )?;
    Ok(MutationCompletion {
        operation_id: operation_id.into(),
        target_id,
        mutation_revision: revision,
        interference,
        canonical_result,
    })
}

pub(crate) fn notices(
    tx: &Transaction<'_>,
    caller_key: Option<&str>,
    target_id: &str,
    cursor: i64,
    limit: usize,
    advance_cursor: bool,
    now_ms: i64,
) -> Result<MutationNoticePage> {
    let limit = limit.clamp(1, MAX_NOTICE_LIMIT);
    let current_revision: i64 = tx
        .query_row(
            "SELECT revision FROM target_mutation_revisions WHERE target_id=?",
            [target_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let history_floor: i64 = tx
        .query_row(
            "SELECT floor_revision FROM mutation_event_floors WHERE target_id=?",
            [target_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let effective_cursor = cursor.max(history_floor);
    let mut statement = tx.prepare(
        "SELECT revision,operation_id,caller_label,completed_at_ms FROM mutation_events \
         WHERE target_id=? AND revision>? AND (?3 IS NULL OR caller_key IS NULL OR caller_key<>?3) \
         ORDER BY revision LIMIT ?4",
    )?;
    // Ask for one extra row so pagination never requires an unbounded count.
    let rows = statement
        .query_map(
            params![target_id, effective_cursor, caller_key, (limit + 1) as i64],
            |row| {
                Ok(InterveningMutation {
                    revision: row.get(0)?,
                    operation_id: row.get(1)?,
                    caller_label: row.get(2)?,
                    completed_at_ms: row.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit;
    let notices = rows.into_iter().take(limit).collect::<Vec<_>>();
    let next_cursor = notices
        .last()
        .map(|n| n.revision)
        .unwrap_or(effective_cursor)
        .min(current_revision);
    if advance_cursor {
        if let Some(key) = caller_key {
            set_cursor(
                tx,
                key,
                target_id,
                if has_more {
                    next_cursor
                } else {
                    current_revision
                },
                now_ms,
            )?;
        }
    }
    Ok(MutationNoticePage {
        target_id: target_id.into(),
        current_revision,
        cursor,
        next_cursor: if has_more {
            next_cursor
        } else {
            current_revision
        },
        has_more,
        history_truncated: cursor < history_floor,
        oldest_available_cursor: history_floor,
        notices,
    })
}

/// Remove only completed coordination history older than the retention
/// boundary. Active accepted/dispatched work is never a candidate. Event floors
/// preserve an explicit signal when a caller resumes behind pruned history.
pub(crate) fn prune_completed(
    tx: &Transaction<'_>,
    now_ms: i64,
    limit: usize,
) -> Result<(usize, usize)> {
    let cutoff = now_ms.saturating_sub(MUTATION_HISTORY_RETENTION_MS);
    let limit = limit.clamp(1, 1_000) as i64;
    let event_rows = {
        let mut statement = tx.prepare(
            "SELECT target_id,revision FROM mutation_events WHERE completed_at_ms<? ORDER BY completed_at_ms,revision LIMIT ?",
        )?;
        let rows = statement
            .query_map(params![cutoff, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (target_id, revision) in &event_rows {
        tx.execute(
            "INSERT INTO mutation_event_floors(target_id,floor_revision) VALUES(?,?) ON CONFLICT(target_id) DO UPDATE SET floor_revision=MAX(floor_revision,excluded.floor_revision)",
            params![target_id, revision],
        )?;
        tx.execute(
            "DELETE FROM mutation_events WHERE target_id=? AND revision=?",
            params![target_id, revision],
        )?;
    }
    let queue_deleted = tx.execute(
        "DELETE FROM mutation_queue WHERE operation_id IN (SELECT operation_id FROM mutation_queue WHERE state IN ('terminal','indeterminate') AND completed_at_ms<? ORDER BY completed_at_ms,queue_sequence LIMIT ?)",
        params![cutoff, limit],
    )?;
    Ok((queue_deleted, event_rows.len()))
}

fn load_admission(tx: &Transaction<'_>, operation_id: &str) -> Result<Option<MutationAdmission>> {
    tx.query_row(
        "SELECT q.operation_id,q.target_id,q.target_generation,q.catalog_revision,q.queue_sequence,q.accepted_at_ms,r.revision,q.lease_authority \
         FROM mutation_queue q JOIN target_mutation_revisions r ON r.target_id=q.target_id WHERE q.operation_id=?",
        [operation_id], |row| Ok(MutationAdmission { operation_id: row.get(0)?, target_id: row.get(1)?, target_generation: row.get(2)?, catalog_revision: row.get(3)?, queue_sequence: row.get(4)?, accepted_at_ms: row.get(5)?, current_revision: row.get(6)?, lease_authority: row.get(7)? }),
    ).optional().map_err(Into::into)
}

fn load_claim(tx: &Transaction<'_>, operation_id: &str) -> Result<Option<MutationClaim>> {
    tx.query_row(
        "SELECT operation_id,target_id,target_generation,catalog_revision,queue_sequence,lease_authority,accepted_at_ms,dispatched_at_ms FROM mutation_queue WHERE operation_id=? AND state='dispatched'",
        [operation_id], |row| Ok(MutationClaim { operation_id: row.get(0)?, target_id: row.get(1)?, target_generation: row.get(2)?, catalog_revision: row.get(3)?, queue_sequence: row.get(4)?, lease_authority: row.get(5)?, accepted_at_ms: row.get(6)?, dispatched_at_ms: row.get(7)? }),
    ).optional().map_err(Into::into)
}

fn load_cursor(tx: &Transaction<'_>, profile_key: &str, target_id: &str) -> Result<i64> {
    Ok(tx
        .query_row(
            "SELECT cursor FROM profile_target_cursors WHERE profile_key=? AND target_id=?",
            params![profile_key, target_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}
fn set_cursor(
    tx: &Transaction<'_>,
    profile_key: &str,
    target_id: &str,
    cursor: i64,
    now_ms: i64,
) -> Result<()> {
    tx.execute("INSERT INTO profile_target_cursors(profile_key,target_id,cursor,updated_at_ms) VALUES(?,?,?,?) ON CONFLICT(profile_key,target_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),updated_at_ms=excluded.updated_at_ms", params![profile_key,target_id,cursor,now_ms])?;
    Ok(())
}
fn augment_result(
    result: &Value,
    revision: i64,
    interference: &MutationNoticePage,
    lease_authority: Option<&str>,
) -> Value {
    let mut value = match result {
        Value::Object(map) => Value::Object(map.clone()),
        _ => serde_json::json!({"result":result}),
    };
    if let Value::Object(map) = &mut value {
        map.insert("mutation_revision".into(), revision.into());
        map.insert(
            "interference".into(),
            serde_json::to_value(interference).expect("serializable metadata"),
        );
        map.insert(
            "lease_authority".into(),
            lease_authority.map(Value::from).unwrap_or(Value::Null),
        );
    }
    value
}
