use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    spill::{SpillDescriptor, SpillPolicy},
    store::StateStore,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    AcceptedNotDispatched,
    Dispatched,
    Terminal,
    Indeterminate,
}

impl LifecycleState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AcceptedNotDispatched => "accepted_not_dispatched",
            Self::Dispatched => "dispatched",
            Self::Terminal => "terminal",
            Self::Indeterminate => "indeterminate",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "accepted_not_dispatched" => Ok(Self::AcceptedNotDispatched),
            "dispatched" => Ok(Self::Dispatched),
            "terminal" => Ok(Self::Terminal),
            "indeterminate" => Ok(Self::Indeterminate),
            _ => bail!("invalid operation lifecycle {value}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptState {
    Absent,
    Received,
    Started,
    Terminal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationAcceptance {
    pub request_id: String,
    pub scope: String,
    pub normalized_request: Value,
    pub profile_token: Option<String>,
    pub target_generation: Option<String>,
    pub catalog_revision: Option<String>,
    pub lease_authority: Option<String>,
    pub output_policy: Value,
    pub is_mutation: bool,
}

impl OperationAcceptance {
    pub fn fingerprint(&self) -> Result<String> {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "normalized_request": self.normalized_request,
            "profile_token": self.profile_token,
            "target_generation": self.target_generation,
            "catalog_revision": self.catalog_revision,
            "lease_authority": self.lease_authority,
            "output_policy": self.output_policy,
            "is_mutation": self.is_mutation,
        }))?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DurableOperation {
    pub operation_id: String,
    pub request_id: String,
    pub scope: String,
    pub fingerprint: String,
    pub state: LifecycleState,
    pub result: Option<Value>,
    pub spill: Option<Value>,
    pub accepted_at_ms: i64,
    pub updated_at_ms: i64,
    pub retention_deadline_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationStatus {
    pub operation_id: String,
    pub request_id: String,
    pub scope: String,
    pub fingerprint: String,
    pub state: LifecycleState,
    pub outcome: Option<Value>,
    pub spill: Option<Value>,
    pub accepted_at_ms: i64,
    pub updated_at_ms: i64,
    pub retention_deadline_ms: i64,
}

#[derive(Debug, Clone)]
pub enum AcceptOutcome {
    Accepted(DurableOperation),
    Existing(DurableOperation),
    Conflict { operation_id: String },
}

#[derive(Clone)]
pub struct DurableOperationJournal {
    store: StateStore,
    metadata_retention_ms: i64,
}

impl DurableOperationJournal {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        let store = StateStore::open(path)?;
        let journal = Self {
            store,
            metadata_retention_ms: 30 * 24 * 60 * 60 * 1000,
        };
        journal.migrate()?;
        Ok(journal)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.store.connection()?;
        ensure_operation_schema(&conn)?;
        Ok(())
    }

    pub(crate) fn from_store(store: StateStore) -> Result<Self> {
        let journal = Self {
            store,
            metadata_retention_ms: 30 * 24 * 60 * 60 * 1000,
        };
        journal.migrate()?;
        Ok(journal)
    }

    pub fn accept(&self, acceptance: &OperationAcceptance) -> Result<AcceptOutcome> {
        let now = now_ms();
        let mut conn = self.store.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let outcome = accept_in_transaction(&tx, acceptance, self.metadata_retention_ms, now)?;
        tx.commit()?;
        Ok(outcome)
    }

    pub fn get(&self, operation_id: &str) -> Result<Option<DurableOperation>> {
        load_by_id(&*self.store.connection()?, operation_id)
    }

    /// Public status deliberately excludes replay payloads and result bodies.
    pub fn status(&self, operation_id: &str) -> Result<Option<OperationStatus>> {
        Ok(self.get(operation_id)?.map(|operation| OperationStatus {
            operation_id: operation.operation_id,
            request_id: operation.request_id,
            scope: operation.scope,
            fingerprint: operation.fingerprint,
            state: operation.state,
            outcome: operation.result.as_ref().map(|result| {
                serde_json::json!({
                    "ok": result.get("ok").and_then(Value::as_bool),
                    "type": result.get("type").and_then(Value::as_str),
                    "error_code": result.pointer("/error/code").and_then(Value::as_str),
                })
            }),
            spill: operation.spill,
            accepted_at_ms: operation.accepted_at_ms,
            updated_at_ms: operation.updated_at_ms,
            retention_deadline_ms: operation.retention_deadline_ms,
        }))
    }

    pub fn replayable(&self) -> Result<Vec<(DurableOperation, OperationAcceptance)>> {
        let conn = self.store.connection()?;
        let mut statement = conn.prepare("SELECT operation_id,replay_payload FROM durable_operations WHERE lifecycle='accepted_not_dispatched' ORDER BY accepted_at_ms")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (id, payload) = row?;
            let op = load_by_id(&*conn, &id)?.context("replay row absent")?;
            Ok((op, serde_json::from_str(&payload)?))
        })
        .collect()
    }

    pub fn mark_dispatched(&self, operation_id: &str) -> Result<()> {
        let conn = self.store.connection()?;
        let changed = conn.execute(
            "UPDATE durable_operations SET lifecycle='dispatched',updated_at_ms=? WHERE operation_id=? AND lifecycle='accepted_not_dispatched'",
            params![now_ms(), operation_id],
        )?;
        if changed == 1 {
            return Ok(());
        }
        match load_by_id(&conn, operation_id)?.map(|operation| operation.state) {
            Some(
                LifecycleState::Dispatched
                | LifecycleState::Terminal
                | LifecycleState::Indeterminate,
            ) => Ok(()),
            _ => bail!("unknown durable operation {operation_id}"),
        }
    }
    pub fn mark_terminal(
        &self,
        operation_id: &str,
        result: &Value,
        spill: Option<&Value>,
    ) -> Result<()> {
        self.transition_any(
            operation_id,
            LifecycleState::Terminal,
            Some(result),
            spill,
            true,
        )
    }
    pub fn mark_indeterminate(&self, operation_id: &str) -> Result<()> {
        let conn = self.store.connection()?;
        let changed = conn.execute(
            "UPDATE durable_operations SET lifecycle='indeterminate',replay_payload=NULL,updated_at_ms=? WHERE operation_id=? AND lifecycle IN ('accepted_not_dispatched','dispatched')",
            params![now_ms(), operation_id],
        )?;
        if changed == 1 {
            return Ok(());
        }
        match load_by_id(&conn, operation_id)?.map(|operation| operation.state) {
            Some(LifecycleState::Indeterminate | LifecycleState::Terminal) => Ok(()),
            _ => bail!("unknown durable operation {operation_id}"),
        }
    }

    pub fn outstanding_operation_ids(&self) -> Result<Vec<String>> {
        let conn = self.store.connection()?;
        let mut statement = conn.prepare("SELECT operation_id FROM durable_operations WHERE lifecycle IN ('accepted_not_dispatched','dispatched') ORDER BY accepted_at_ms")?;
        let operation_ids = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(operation_ids)
    }

    pub fn reconcile_receipt(
        &self,
        operation_id: &str,
        receipt: ReceiptState,
        terminal: Option<&Value>,
    ) -> Result<LifecycleState> {
        let current = self
            .get(operation_id)?
            .context("unknown durable operation")?;
        match (current.state, receipt) {
            (LifecycleState::AcceptedNotDispatched, ReceiptState::Absent) => Ok(current.state),
            (
                LifecycleState::AcceptedNotDispatched,
                ReceiptState::Received | ReceiptState::Started,
            ) => {
                self.mark_dispatched(operation_id)?;
                Ok(LifecycleState::Dispatched)
            }
            (_, ReceiptState::Terminal) => {
                self.mark_terminal(
                    operation_id,
                    terminal.context("terminal receipt missing result")?,
                    None,
                )?;
                Ok(LifecycleState::Terminal)
            }
            (LifecycleState::Dispatched, ReceiptState::Absent) => {
                self.mark_indeterminate(operation_id)?;
                Ok(LifecycleState::Indeterminate)
            }
            _ => Ok(current.state),
        }
    }

    fn transition_any(
        &self,
        id: &str,
        to: LifecycleState,
        result: Option<&Value>,
        spill: Option<&Value>,
        clear_replay: bool,
    ) -> Result<()> {
        let conn = self.store.connection()?;
        let changed=conn.execute("UPDATE durable_operations SET lifecycle=?,result_json=COALESCE(result_json,?),spill_json=COALESCE(spill_json,?),replay_payload=CASE WHEN ? THEN NULL ELSE replay_payload END,updated_at_ms=? WHERE operation_id=? AND lifecycle IN ('accepted_not_dispatched','dispatched','indeterminate','terminal')",params![to.as_str(),result.map(serde_json::to_string).transpose()?,spill.map(serde_json::to_string).transpose()?,clear_replay,now_ms(),id])?;
        if changed != 1 {
            bail!("invalid terminal transition for {id}");
        }
        Ok(())
    }

    pub fn purge_expired(&self, now_ms: i64) -> Result<usize> {
        Ok(self.store.connection()?.execute("DELETE FROM durable_operations WHERE retention_deadline_ms < ? AND lifecycle IN ('terminal','indeterminate')", [now_ms])?)
    }

    /// Delete expired spill bytes before deleting their recovery metadata. A
    /// failed file deletion leaves the journal row intact so cleanup is safe to
    /// retry and never loses the only integrity descriptor.
    pub fn purge_expired_with_spills(&self, now_ms: i64, policy: &SpillPolicy) -> Result<usize> {
        self.purge_expired_with_spills_bounded(now_ms, policy, 1_000)
    }

    pub fn purge_expired_with_spills_bounded(
        &self,
        now_ms: i64,
        policy: &SpillPolicy,
        limit: usize,
    ) -> Result<usize> {
        let candidates = {
            let conn = self.store.connection()?;
            let mut statement = conn.prepare("SELECT operation_id,spill_json FROM durable_operations WHERE retention_deadline_ms < ? AND lifecycle IN ('terminal','indeterminate') ORDER BY retention_deadline_ms,operation_id LIMIT ?")?;
            let collected = statement
                .query_map(params![now_ms, limit.clamp(1, 1_000) as i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                })?
                .map(|row| {
                    let (operation_id, spill) = row?;
                    Ok((
                        operation_id,
                        spill
                            .map(|value| serde_json::from_str::<SpillDescriptor>(&value))
                            .transpose()?,
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            collected
        };
        let mut deleted = 0;
        for (operation_id, descriptor) in candidates {
            if let Some(descriptor) = descriptor {
                policy.delete(&descriptor)?;
            }
            deleted += self.store.connection()?.execute(
                "DELETE FROM durable_operations WHERE operation_id=? AND retention_deadline_ms < ? AND lifecycle IN ('terminal','indeterminate')",
                params![operation_id, now_ms],
            )?;
        }
        Ok(deleted)
    }
}

pub(crate) fn ensure_operation_schema(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch("\
      CREATE TABLE IF NOT EXISTS durable_operations (\
        operation_id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL,\
        fingerprint TEXT NOT NULL, lifecycle TEXT NOT NULL, replay_payload TEXT,\
        result_json TEXT, spill_json TEXT, accepted_at_ms INTEGER NOT NULL,\
        updated_at_ms INTEGER NOT NULL, retention_deadline_ms INTEGER NOT NULL,\
        UNIQUE(scope, request_id));\
      CREATE INDEX IF NOT EXISTS durable_operations_retention ON durable_operations(retention_deadline_ms);\
      PRAGMA user_version=1;")?;
    Ok(())
}

pub(crate) fn accept_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    acceptance: &OperationAcceptance,
    metadata_retention_ms: i64,
    now: i64,
) -> Result<AcceptOutcome> {
    let fingerprint = acceptance.fingerprint()?;
    if let Some(prior) = load_by_identity(tx, &acceptance.scope, &acceptance.request_id)? {
        return Ok(if prior.fingerprint == fingerprint {
            AcceptOutcome::Existing(prior)
        } else {
            AcceptOutcome::Conflict {
                operation_id: prior.operation_id,
            }
        });
    }
    let replay_payload = serde_json::to_string(acceptance)?;
    let operation_id = operation_id_for(&acceptance.scope, &acceptance.request_id);
    tx.execute("INSERT INTO durable_operations(operation_id,scope,request_id,fingerprint,lifecycle,replay_payload,accepted_at_ms,updated_at_ms,retention_deadline_ms) VALUES(?,?,?,?,?,?,?,?,?)",
      params![operation_id, acceptance.scope, acceptance.request_id, fingerprint, LifecycleState::AcceptedNotDispatched.as_str(), replay_payload, now, now, now + metadata_retention_ms])?;
    Ok(AcceptOutcome::Accepted(
        load_by_id(tx, &operation_id)?.context("accepted operation disappeared")?,
    ))
}

fn operation_id_for(scope: &str, request_id: &str) -> String {
    let identity = serde_json::to_vec(&[scope, request_id]).expect("string identity serializes");
    format!("ajo_{:x}", Sha256::digest(identity))
}

fn load_by_identity(
    conn: &rusqlite::Connection,
    scope: &str,
    request_id: &str,
) -> Result<Option<DurableOperation>> {
    conn.query_row("SELECT operation_id,request_id,scope,fingerprint,lifecycle,result_json,spill_json,accepted_at_ms,updated_at_ms,retention_deadline_ms FROM durable_operations WHERE scope=? AND request_id=?",params![scope,request_id],row_to_operation).optional().map_err(Into::into)
}
fn load_by_id(conn: &rusqlite::Connection, id: &str) -> Result<Option<DurableOperation>> {
    conn.query_row("SELECT operation_id,request_id,scope,fingerprint,lifecycle,result_json,spill_json,accepted_at_ms,updated_at_ms,retention_deadline_ms FROM durable_operations WHERE operation_id=?",[id],row_to_operation).optional().map_err(Into::into)
}
fn row_to_operation(row: &rusqlite::Row<'_>) -> rusqlite::Result<DurableOperation> {
    let lifecycle: String = row.get(4)?;
    let result: Option<String> = row.get(5)?;
    let spill: Option<String> = row.get(6)?;
    Ok(DurableOperation {
        operation_id: row.get(0)?,
        request_id: row.get(1)?,
        scope: row.get(2)?,
        fingerprint: row.get(3)?,
        state: LifecycleState::parse(&lifecycle).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, e.into())
        })?,
        result: result
            .map(|v| serde_json::from_str(&v))
            .transpose()
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, e.into())
            })?,
        spill: spill
            .map(|v| serde_json::from_str(&v))
            .transpose()
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, e.into())
            })?,
        accepted_at_ms: row.get(7)?,
        updated_at_ms: row.get(8)?,
        retention_deadline_ms: row.get(9)?,
    })
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
