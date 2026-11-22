use std::fmt;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MAX_LEASE_DURATION_MS: i64 = 60_000;

#[derive(Debug, Clone, Serialize)]
pub struct LeaseGrant {
    pub target_id: String,
    pub lease_id: String,
    pub token: String,
    pub holder_label: String,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LeaseStatus {
    pub target_id: String,
    pub lease_id: String,
    pub holder_label: String,
    pub acquired_at_ms: i64,
    pub expires_at_ms: i64,
    pub remaining_ms: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ActiveLease {
    pub lease_id: String,
    pub holder_key: String,
    pub holder_label: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LeaseError {
    code: &'static str,
    details: Option<Value>,
}

impl LeaseError {
    pub(crate) fn new(code: &'static str, details: Option<Value>) -> Self {
        Self { code, details }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn details(&self) -> Option<&Value> {
        self.details.as_ref()
    }
}
impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for LeaseError {}

pub(crate) fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS target_leases (\
           target_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL UNIQUE,\
           holder_key TEXT NOT NULL, holder_label TEXT NOT NULL, token_hash TEXT NOT NULL,\
           acquired_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);\
         CREATE INDEX IF NOT EXISTS target_leases_expiry ON target_leases(expires_at_ms);",
    )
}

pub(crate) fn active(
    tx: &Transaction<'_>,
    target_id: &str,
    now_ms: i64,
) -> rusqlite::Result<Option<ActiveLease>> {
    tx.query_row(
        "SELECT lease_id,holder_key,holder_label,expires_at_ms FROM target_leases WHERE target_id=? AND expires_at_ms>?",
        params![target_id, now_ms],
        |row| Ok(ActiveLease { lease_id: row.get(0)?, holder_key: row.get(1)?, holder_label: row.get(2)?, expires_at_ms: row.get(3)? }),
    ).optional()
}

pub(crate) fn inspect(
    conn: &rusqlite::Connection,
    target_id: &str,
    now_ms: i64,
) -> rusqlite::Result<Option<LeaseStatus>> {
    conn.query_row(
        "SELECT lease_id,holder_label,acquired_at_ms,expires_at_ms FROM target_leases WHERE target_id=? AND expires_at_ms>?",
        params![target_id, now_ms],
        |row| {
            let expires_at_ms: i64 = row.get(3)?;
            Ok(LeaseStatus {
                target_id: target_id.to_string(),
                lease_id: row.get(0)?,
                holder_label: row.get(1)?,
                acquired_at_ms: row.get(2)?,
                expires_at_ms,
                remaining_ms: expires_at_ms - now_ms,
            })
        },
    ).optional()
}

pub(crate) fn acquire(
    tx: &Transaction<'_>,
    target_id: &str,
    holder_key: &str,
    holder_label: &str,
    duration_ms: i64,
    now_ms: i64,
) -> Result<LeaseGrant, LeaseError> {
    if !(1..=MAX_LEASE_DURATION_MS).contains(&duration_ms) {
        return Err(LeaseError::new(
            "invalid_lease_duration",
            Some(json!({"max_ms":MAX_LEASE_DURATION_MS})),
        ));
    }
    if let Some(existing) =
        active(tx, target_id, now_ms).map_err(|_| LeaseError::new("state_failure", None))?
    {
        if existing.holder_key != holder_key {
            return Err(LeaseError::new(
                "tab_locked",
                Some(json!({
                    "remaining_ms": existing.expires_at_ms - now_ms,
                    "holder_label": existing.holder_label,
                })),
            ));
        }
        // An explicit acquire by the same cooperative caller is the only
        // supported renewal. There is no timer or operation-driven extension.
    }
    let lease_id = format!("ajl_{}", Uuid::new_v4().simple());
    let token = format!("ajlt_{}", Uuid::new_v4().simple());
    let expires_at_ms = now_ms + duration_ms;
    tx.execute(
        "INSERT INTO target_leases(target_id,lease_id,holder_key,holder_label,token_hash,acquired_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?) \
         ON CONFLICT(target_id) DO UPDATE SET lease_id=excluded.lease_id,holder_key=excluded.holder_key,holder_label=excluded.holder_label,token_hash=excluded.token_hash,acquired_at_ms=excluded.acquired_at_ms,expires_at_ms=excluded.expires_at_ms",
        params![target_id, lease_id, holder_key, holder_label, hash_token(&token), now_ms, expires_at_ms],
    ).map_err(|_| LeaseError::new("state_failure", None))?;
    Ok(LeaseGrant {
        target_id: target_id.into(),
        lease_id,
        token,
        holder_label: holder_label.into(),
        acquired_at_ms: now_ms,
        expires_at_ms,
    })
}

pub(crate) fn authorize_mutation(
    tx: &Transaction<'_>,
    target_id: &str,
    caller_key: Option<&str>,
    supplied_token: Option<&str>,
    now_ms: i64,
) -> Result<Option<String>, LeaseError> {
    let Some(lease) =
        active(tx, target_id, now_ms).map_err(|_| LeaseError::new("state_failure", None))?
    else {
        return Ok(None);
    };
    if caller_key != Some(lease.holder_key.as_str()) {
        return Err(LeaseError::new(
            "tab_locked",
            Some(json!({
                "remaining_ms": lease.expires_at_ms - now_ms,
                "holder_label": lease.holder_label,
            })),
        ));
    }
    let supplied = supplied_token.ok_or_else(|| LeaseError::new("lease_token_required", None))?;
    let expected: String = tx
        .query_row(
            "SELECT token_hash FROM target_leases WHERE lease_id=?",
            [&lease.lease_id],
            |row| row.get(0),
        )
        .map_err(|_| LeaseError::new("state_failure", None))?;
    if expected != hash_token(supplied) {
        return Err(LeaseError::new("lease_token_mismatch", None));
    }
    Ok(Some(lease.lease_id))
}

pub(crate) fn release(
    tx: &Transaction<'_>,
    target_id: &str,
    holder_key: &str,
    token: &str,
    now_ms: i64,
) -> Result<(), LeaseError> {
    let row: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT holder_key,token_hash,expires_at_ms FROM target_leases WHERE target_id=?",
            [target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| LeaseError::new("state_failure", None))?;
    let Some((expected_holder, expected_token, expires_at_ms)) = row else {
        return Err(LeaseError::new("lease_not_found", None));
    };
    if expires_at_ms <= now_ms {
        return Err(LeaseError::new("lease_expired", None));
    }
    if expected_holder != holder_key {
        return Err(LeaseError::new("lease_not_holder", None));
    }
    if expected_token != hash_token(token) {
        return Err(LeaseError::new("lease_token_mismatch", None));
    }
    tx.execute("DELETE FROM target_leases WHERE target_id=?", [target_id])
        .map_err(|_| LeaseError::new("state_failure", None))?;
    Ok(())
}

fn hash_token(token: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(token.as_bytes()))
}
