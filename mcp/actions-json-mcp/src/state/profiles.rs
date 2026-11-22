use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::store::StateStore;

#[derive(Debug, Clone)]
pub struct ProfileCredential {
    pub name: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileStatus {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_target_id: Option<String>,
    pub mutation_cursor: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_identity: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// The unauthenticated listing is intentionally metadata-only. In particular,
/// a process that knows a cooperative profile name does not learn or inherit
/// its ambient target, cursor, lease identity, or opaque token.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileListItem {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_target_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone)]
pub struct ProfileStore {
    store: StateStore,
}

impl ProfileStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_store(StateStore::open(path)?)
    }

    pub(crate) fn from_store(store: StateStore) -> Result<Self> {
        let profiles = Self { store };
        profiles.migrate()?;
        Ok(profiles)
    }

    fn migrate(&self) -> Result<()> {
        self.store.connection()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS aj_schema_migrations (\
               component TEXT PRIMARY KEY, version INTEGER NOT NULL);\
             CREATE TABLE IF NOT EXISTS cooperative_profiles (\
               name TEXT PRIMARY KEY, token_hash TEXT NOT NULL, label TEXT,\
               selected_target_id TEXT, mutation_cursor INTEGER NOT NULL DEFAULT 0,\
               lease_identity TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);\
             INSERT INTO aj_schema_migrations(component,version) VALUES('profiles',1)\
               ON CONFLICT(component) DO UPDATE SET version=MAX(version,excluded.version);",
        )?;
        Ok(())
    }

    pub fn create(&self, name: &str, label: Option<&str>) -> Result<ProfileCredential> {
        validate_profile_name(name)?;
        let token = fresh_token();
        let now = now_ms();
        let changed = self.store.connection()?.execute(
            "INSERT OR IGNORE INTO cooperative_profiles(name,token_hash,label,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?)",
            params![name, token_hash(&token), normalized_label(label), now, now],
        )?;
        if changed != 1 {
            bail!("profile_already_exists");
        }
        Ok(ProfileCredential {
            name: name.into(),
            token,
        })
    }

    pub fn inspect(&self, name: &str, token: &str) -> Result<ProfileStatus> {
        let conn = self.store.connection()?;
        let row = conn
            .query_row(
                "SELECT token_hash,label,selected_target_id,mutation_cursor,lease_identity,created_at_ms,updated_at_ms FROM cooperative_profiles WHERE name=?",
                [name],
                |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )
            .optional()?;
        let Some((
            expected,
            label,
            selected_target_id,
            mutation_cursor,
            lease_identity,
            created_at_ms,
            updated_at_ms,
        )) = row
        else {
            bail!("profile_not_found");
        };
        require_token_hash(&expected, token)?;
        Ok(ProfileStatus {
            name: name.into(),
            label,
            selected_target_id,
            mutation_cursor,
            lease_identity,
            created_at_ms,
            updated_at_ms,
        })
    }

    pub fn list(&self) -> Result<Vec<ProfileListItem>> {
        let conn = self.store.connection()?;
        let mut statement = conn.prepare(
            "SELECT name,label,created_at_ms,updated_at_ms FROM cooperative_profiles ORDER BY name",
        )?;
        let profiles = statement
            .query_map([], |row| {
                Ok(ProfileListItem {
                    name: row.get(0)?,
                    label: row.get(1)?,
                    selected_target_id: None,
                    created_at_ms: row.get(2)?,
                    updated_at_ms: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(profiles)
    }

    pub fn rotate(&self, name: &str, current_token: &str) -> Result<ProfileCredential> {
        let token = fresh_token();
        let mut conn = self.store.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected: Option<String> = tx
            .query_row(
                "SELECT token_hash FROM cooperative_profiles WHERE name=?",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        let Some(expected) = expected else {
            bail!("profile_not_found")
        };
        require_token_hash(&expected, current_token)?;
        tx.execute("UPDATE cooperative_profiles SET token_hash=?,lease_identity=NULL,updated_at_ms=? WHERE name=?", params![token_hash(&token), now_ms(), name])?;
        tx.commit()?;
        Ok(ProfileCredential {
            name: name.into(),
            token,
        })
    }

    pub fn delete(&self, name: &str, token: &str) -> Result<()> {
        self.inspect(name, token)?;
        let changed = self.store.connection()?.execute(
            "DELETE FROM cooperative_profiles WHERE name=? AND token_hash=?",
            params![name, token_hash(token)],
        )?;
        if changed != 1 {
            bail!("profile_token_mismatch")
        }
        Ok(())
    }

    pub(crate) fn select_target(&self, name: &str, token: &str, target_id: &str) -> Result<()> {
        self.inspect(name, token)?;
        let changed = self.store.connection()?.execute(
            "UPDATE cooperative_profiles SET selected_target_id=?,updated_at_ms=? WHERE name=? AND token_hash=?",
            params![target_id, now_ms(), name, token_hash(token)],
        )?;
        if changed != 1 {
            bail!("profile_token_mismatch")
        }
        Ok(())
    }

    pub(crate) fn selected_target(&self, name: &str, token: &str) -> Result<Option<String>> {
        Ok(self.inspect(name, token)?.selected_target_id)
    }
}

fn validate_profile_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 80
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        bail!("invalid_profile_name");
    }
    Ok(())
}

fn normalized_label(label: Option<&str>) -> Option<&str> {
    label.map(str::trim).filter(|value| !value.is_empty())
}

fn fresh_token() -> String {
    format!("ajp_{}", Uuid::new_v4().simple())
}
pub(crate) fn token_hash(token: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(token.as_bytes()))
}
fn require_token_hash(expected: &str, token: &str) -> Result<()> {
    if expected != token_hash(token) {
        bail!("profile_token_mismatch")
    }
    Ok(())
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
