//! Resident-owned cooperative profiles, stable targets, and catalog snapshots.
//!
//! These are coordination identities, not security principals. The opaque
//! profile token prevents two local agents from accidentally inheriting one
//! another's ambient routing state; operating-system account boundaries remain
//! the security boundary.

use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result as AnyResult;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::state::{
    leases, revisions, DurableOperationJournal, LeaseGrant, LeaseStatus, MutationAdmission,
    MutationClaim, MutationCompletion, MutationNoticePage, OperationAcceptance, OperationStatus,
    ProfileCredential, ProfileListItem, ProfileStatus, ProfileStore, StateStore,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinationError {
    code: &'static str,
    message: String,
    details: Option<Value>,
}

impl CoordinationError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }
    fn with_details(
        code: &'static str,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details,
        }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn details(&self) -> Option<&Value> {
        self.details.as_ref()
    }
}

#[derive(Debug, Clone)]
pub struct MutationCaller {
    pub name: String,
    pub token: String,
}
impl MutationCaller {
    pub fn profile(name: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            token: token.into(),
        }
    }
}
impl fmt::Display for CoordinationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoordinationError {}
type Result<T> = std::result::Result<T, CoordinationError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveTargetObservation {
    pub client_instance_id: String,
    pub session_generation: String,
    pub tab_key: String,
    pub runtime_id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub catalog: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetSelector {
    TargetId(String),
    RuntimeId(String),
    Intent(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetStatus {
    pub target_id: String,
    pub target_generation: String,
    pub runtime_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub catalog_revision: String,
    pub live: bool,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CatalogOperation {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogListing {
    pub target_id: String,
    pub target_generation: String,
    pub catalog_revision: String,
    pub operations: Vec<CatalogOperation>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogDescription {
    pub target_id: String,
    pub target_generation: String,
    pub catalog_revision: String,
    pub operation: CatalogOperation,
}

#[derive(Clone)]
pub struct RuntimeAuthority {
    store: StateStore,
    profiles: ProfileStore,
    journal: DurableOperationJournal,
    mutation_notifiers: Arc<Mutex<HashMap<String, Weak<Notify>>>>,
}

impl RuntimeAuthority {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner(path).map_err(internal_error)
    }

    fn open_inner(path: impl AsRef<Path>) -> AnyResult<Self> {
        let store = StateStore::open(path)?;
        let profiles = ProfileStore::from_store(store.clone())?;
        let journal = DurableOperationJournal::from_store(store.clone())?;
        let authority = Self {
            store,
            profiles,
            journal,
            mutation_notifiers: Arc::new(Mutex::new(HashMap::new())),
        };
        authority.migrate()?;
        Ok(authority)
    }

    fn migrate(&self) -> AnyResult<()> {
        self.store.connection()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS resident_targets (\
               target_id TEXT PRIMARY KEY, target_generation TEXT NOT NULL,\
               client_instance_id TEXT NOT NULL, session_generation TEXT NOT NULL,\
               tab_key TEXT NOT NULL, runtime_id TEXT NOT NULL, url TEXT, title TEXT,\
               catalog_revision TEXT NOT NULL, live INTEGER NOT NULL,\
               first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);\
             CREATE INDEX IF NOT EXISTS resident_targets_live ON resident_targets(live,runtime_id);\
             CREATE INDEX IF NOT EXISTS resident_targets_generation ON resident_targets(client_instance_id,session_generation,tab_key);\
             CREATE TABLE IF NOT EXISTS catalog_snapshots (\
               target_id TEXT NOT NULL, target_generation TEXT NOT NULL, revision TEXT NOT NULL,\
               catalog_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,\
               PRIMARY KEY(target_id,revision));\
             INSERT INTO aj_schema_migrations(component,version) VALUES('targets_catalogs',1)\
               ON CONFLICT(component) DO UPDATE SET version=MAX(version,excluded.version);\
             CREATE TABLE IF NOT EXISTS resident_audit (\
               sequence INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL,\
               adapter TEXT NOT NULL, client_version TEXT, resident_version TEXT NOT NULL,\
               operation TEXT NOT NULL, request_id TEXT, target_generation TEXT,\
               catalog_revision TEXT, outcome TEXT NOT NULL);\
             CREATE INDEX IF NOT EXISTS resident_audit_created ON resident_audit(created_at_ms);",
        )?;
        let conn = self.store.connection()?;
        let has_operation_id = conn
            .prepare("PRAGMA table_info(resident_audit)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|column| column == "operation_id");
        if !has_operation_id {
            conn.execute(
                "ALTER TABLE resident_audit ADD COLUMN operation_id TEXT",
                [],
            )?;
        }
        leases::migrate(&conn)?;
        revisions::migrate(&conn)?;
        Ok(())
    }

    pub fn create_profile(&self, name: &str, label: Option<&str>) -> Result<ProfileCredential> {
        self.profiles.create(name, label).map_err(profile_error)
    }
    pub fn profile_status(&self, name: &str, token: &str) -> Result<ProfileStatus> {
        self.profiles.inspect(name, token).map_err(profile_error)
    }
    pub fn list_profiles(&self) -> Result<Vec<ProfileListItem>> {
        self.profiles.list().map_err(internal_error)
    }
    pub fn rotate_profile(&self, name: &str, token: &str) -> Result<ProfileCredential> {
        self.profiles.rotate(name, token).map_err(profile_error)
    }
    pub fn delete_profile(&self, name: &str, token: &str) -> Result<()> {
        self.profiles.delete(name, token).map_err(profile_error)
    }

    pub fn record_audit(
        &self,
        adapter: &str,
        client_version: Option<&str>,
        resident_version: &str,
        envelope: &Value,
        outcome: &str,
    ) -> Result<()> {
        let conn = self.store.connection().map_err(internal_error)?;
        conn.execute(
            "INSERT INTO resident_audit(created_at_ms,adapter,client_version,resident_version,operation,request_id,target_generation,catalog_revision,outcome,operation_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
            params![now_ms(),adapter,client_version,resident_version,envelope.get("name").and_then(Value::as_str).unwrap_or("unknown"),envelope.get("request_id").and_then(Value::as_str),envelope.get("target_generation").and_then(Value::as_str),envelope.get("catalog_revision").and_then(Value::as_str),outcome,envelope.get("operation_id").and_then(Value::as_str)],
        ).map_err(internal_error)?;
        conn.execute("DELETE FROM resident_audit WHERE sequence NOT IN (SELECT sequence FROM resident_audit ORDER BY sequence DESC LIMIT 1000)",[]).map_err(internal_error)?;
        Ok(())
    }

    pub fn audit_entries(&self, limit: usize) -> Result<Vec<Value>> {
        let conn = self.store.connection().map_err(internal_error)?;
        let mut statement=conn.prepare("SELECT created_at_ms,adapter,client_version,resident_version,operation,request_id,target_generation,catalog_revision,outcome,operation_id FROM resident_audit ORDER BY sequence DESC LIMIT ?").map_err(internal_error)?;
        let rows=statement.query_map([limit.clamp(1,100) as i64],|row|Ok(serde_json::json!({
            "created_at_ms":row.get::<_,i64>(0)?,"adapter":row.get::<_,String>(1)?,"client_version":row.get::<_,Option<String>>(2)?,
            "resident_version":row.get::<_,String>(3)?,"operation":row.get::<_,String>(4)?,"request_id":row.get::<_,Option<String>>(5)?,
            "target_generation":row.get::<_,Option<String>>(6)?,"catalog_revision":row.get::<_,Option<String>>(7)?,"outcome":row.get::<_,String>(8)?,
            "operation_id":row.get::<_,Option<String>>(9)?
        }))).map_err(internal_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_error)
    }

    pub fn inspect_lease(&self, selector: TargetSelector) -> Result<Option<LeaseStatus>> {
        let target = self.discover_target(selector)?;
        let conn = self.store.connection().map_err(internal_error)?;
        leases::inspect(&conn, &target.target_id, now_ms()).map_err(internal_error)
    }

    pub fn observe_target(&self, observation: &LiveTargetObservation) -> Result<TargetStatus> {
        validate_observation(observation)?;
        let target_generation = generation_for(observation);
        let target_id = format!(
            "ajt_{}",
            target_generation
                .trim_start_matches("sha256:")
                .chars()
                .take(32)
                .collect::<String>()
        );
        let canonical_catalog = canonicalize(&observation.catalog);
        let catalog_json = serde_json::to_string(&canonical_catalog).map_err(internal_error)?;
        let catalog_revision = format!("sha256:{:x}", Sha256::digest(catalog_json.as_bytes()));
        let now = now_ms();
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        // The same logical browser tab observed in a new browser/session
        // generation must never silently inherit an old binding.
        tx.execute(
            "UPDATE resident_targets SET live=0,last_seen_ms=? WHERE client_instance_id=? AND tab_key=? AND target_id<>?",
            params![now, observation.client_instance_id, observation.tab_key, target_id],
        ).map_err(internal_error)?;
        tx.execute(
            "UPDATE resident_targets SET live=0,last_seen_ms=? WHERE runtime_id=? AND target_id<>?",
            params![now, observation.runtime_id, target_id],
        )
        .map_err(internal_error)?;
        tx.execute(
            "INSERT INTO resident_targets(target_id,target_generation,client_instance_id,session_generation,tab_key,runtime_id,url,title,catalog_revision,live,first_seen_ms,last_seen_ms) \
             VALUES(?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(target_id) DO UPDATE SET \
             runtime_id=excluded.runtime_id,url=excluded.url,title=excluded.title,catalog_revision=excluded.catalog_revision,live=1,last_seen_ms=excluded.last_seen_ms",
            params![target_id, target_generation, observation.client_instance_id, observation.session_generation, observation.tab_key, observation.runtime_id, observation.url, observation.title, catalog_revision, now, now],
        ).map_err(internal_error)?;
        tx.execute(
            "INSERT OR IGNORE INTO catalog_snapshots(target_id,target_generation,revision,catalog_json,created_at_ms) VALUES(?,?,?,?,?)",
            params![target_id, target_generation, catalog_revision, catalog_json, now],
        ).map_err(internal_error)?;
        tx.commit().map_err(internal_error)?;
        drop(conn);
        self.target_by_id(&target_id)?
            .ok_or_else(|| CoordinationError::new("state_failure", "observed target disappeared"))
    }

    pub fn mark_session_offline(&self, session_generation: &str) -> Result<usize> {
        self.store.connection().map_err(internal_error)?.execute(
            "UPDATE resident_targets SET live=0,last_seen_ms=? WHERE session_generation=? AND live=1",
            params![now_ms(), session_generation],
        ).map_err(internal_error)
    }

    pub fn mark_runtime_offline(&self, runtime_id: &str) -> Result<usize> {
        self.store
            .connection()
            .map_err(internal_error)?
            .execute(
                "UPDATE resident_targets SET live=0,last_seen_ms=? WHERE runtime_id=? AND live=1",
                params![now_ms(), runtime_id],
            )
            .map_err(internal_error)
    }

    pub fn touch_runtime(&self, runtime_id: &str) -> Result<usize> {
        self.store
            .connection()
            .map_err(internal_error)?
            .execute(
                "UPDATE resident_targets SET last_seen_ms=? WHERE runtime_id=? AND live=1",
                params![now_ms(), runtime_id],
            )
            .map_err(internal_error)
    }

    pub fn list_targets(&self) -> Result<Vec<TargetStatus>> {
        self.load_targets(true)
    }

    pub fn target_for_runtime(&self, runtime_id: &str) -> Result<TargetStatus> {
        self.discover_target(TargetSelector::RuntimeId(runtime_id.to_string()))
    }

    /// Resident control operations consumed by U6's CLI adapter. They are
    /// deliberately ordinary JSON request/response shapes so no adapter owns a
    /// second profile or target implementation.
    pub fn handle_control_operation(&self, envelope: &Value) -> Result<Option<Value>> {
        let Some(name) = envelope.get("name").and_then(Value::as_str) else {
            return Ok(None);
        };
        if !name.starts_with("resident.") {
            return Ok(None);
        }
        let args = envelope
            .get("arguments")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                CoordinationError::new(
                    "invalid_input",
                    "resident control arguments must be an object",
                )
            })?;
        let required = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CoordinationError::new("invalid_input", format!("missing {key}")))
        };
        let value = match name {
            "resident.profile.create" => {
                let credential = self
                    .create_profile(required("name")?, args.get("label").and_then(Value::as_str))?;
                serde_json::json!({"ok":true,"profile":{"name":credential.name,"token":credential.token}})
            }
            "resident.profile.list" => {
                serde_json::json!({"ok":true,"profiles":self.list_profiles()?})
            }
            "resident.profile.status" => {
                serde_json::json!({"ok":true,"profile":self.profile_status(required("name")?, required("token")?)?})
            }
            "resident.profile.rotate" => {
                let credential = self.rotate_profile(required("name")?, required("token")?)?;
                serde_json::json!({"ok":true,"profile":{"name":credential.name,"token":credential.token}})
            }
            "resident.profile.delete" => {
                self.delete_profile(required("name")?, required("token")?)?;
                serde_json::json!({"ok":true,"deleted":true})
            }
            "resident.target.list" => serde_json::json!({"ok":true,"targets":self.list_targets()?}),
            "resident.target.select" => {
                let target = self.select_profile_target(
                    required("name")?,
                    required("token")?,
                    selector_from_args(args)?,
                )?;
                serde_json::json!({"ok":true,"target":target})
            }
            "resident.target.status" => {
                let target = self.discover_target(selector_from_args(args)?)?;
                serde_json::json!({"ok":true,"target":target})
            }
            "resident.catalog.list" => {
                serde_json::json!({"ok":true,"catalog":self.catalog_list(selector_from_args(args)?)?})
            }
            "resident.catalog.describe" => {
                serde_json::json!({"ok":true,"catalog":self.catalog_describe(selector_from_args(args)?, required("operation")?)?})
            }
            "resident.lease.acquire" => {
                let duration_ms =
                    args.get("duration_ms")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| {
                            CoordinationError::new("invalid_input", "missing duration_ms")
                        })?;
                let lease = self.acquire_lease(
                    MutationCaller::profile(required("profile")?, required("profile_token")?),
                    optional_selector_from_args(args)?,
                    duration_ms,
                )?;
                serde_json::json!({"ok":true,"lease":lease})
            }
            "resident.lease.release" => {
                self.release_lease(
                    MutationCaller::profile(required("profile")?, required("profile_token")?),
                    required("target_id")?,
                    required("lease_token")?,
                )?;
                serde_json::json!({"ok":true,"released":true})
            }
            "resident.lease.inspect" => {
                serde_json::json!({"ok":true,"lease":self.inspect_lease(selector_from_args(args)?)?})
            }
            "resident.mutation.notices" => {
                let page = self.mutation_notices(
                    MutationCaller::profile(required("profile")?, required("profile_token")?),
                    required("target_id")?,
                    args.get("cursor").and_then(Value::as_i64),
                    args.get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(revisions::DEFAULT_NOTICE_LIMIT as u64)
                        as usize,
                )?;
                serde_json::json!({"ok":true,"coordination":page})
            }
            "resident.operation.status" => {
                serde_json::json!({"ok":true,"operation":self.operation_status(required("operation_id")?)?})
            }
            "resident.audit.list" => {
                serde_json::json!({"ok":true,"entries":self.audit_entries(args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize)?,"bounded":true,"redacted":true})
            }
            "resident.mutation.accept" => {
                let request_id = required("request_id")?;
                let operation = required("operation")?;
                let acceptance = OperationAcceptance {
                    request_id: request_id.into(),
                    scope: "resident".into(),
                    normalized_request: serde_json::json!({"name":operation,"arguments":args.get("operation_arguments").cloned().unwrap_or_else(|| serde_json::json!({}))}),
                    profile_token: None,
                    target_generation: args
                        .get("target_generation")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    catalog_revision: args
                        .get("catalog_revision")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    lease_authority: None,
                    output_policy: args
                        .get("output_policy")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({"inline_limit":262144})),
                    is_mutation: true,
                };
                let caller = match (
                    args.get("profile").and_then(Value::as_str),
                    args.get("profile_token").and_then(Value::as_str),
                ) {
                    (Some(name), Some(token)) => Some(MutationCaller::profile(name, token)),
                    (None, None) => None,
                    _ => {
                        return Err(CoordinationError::new(
                            "invalid_input",
                            "profile and profile_token must be supplied together",
                        ))
                    }
                };
                let admission = self.admit_mutation(
                    &acceptance,
                    caller,
                    optional_selector_from_args(args)?,
                    args.get("lease_token").and_then(Value::as_str),
                )?;
                serde_json::json!({"ok":true,"admission":admission})
            }
            _ => {
                return Err(CoordinationError::new(
                    "unknown_control_operation",
                    "unknown resident control operation",
                ))
            }
        };
        Ok(Some(value))
    }

    pub fn discover_target(&self, selector: TargetSelector) -> Result<TargetStatus> {
        let targets = self.load_targets(true)?;
        let mut matches = targets
            .into_iter()
            .filter(|target| selector_matches(&selector, target))
            .collect::<Vec<_>>();
        matches.sort_by(|a, b| a.target_id.cmp(&b.target_id));
        match matches.len() {
            0 => Err(CoordinationError::new(
                "target_not_found",
                "no live target matched the selector",
            )),
            1 => Ok(matches.remove(0)),
            _ => Err(CoordinationError::new(
                "ambiguous_target",
                format!("{} live targets matched", matches.len()),
            )),
        }
    }

    pub fn select_profile_target(
        &self,
        name: &str,
        token: &str,
        selector: TargetSelector,
    ) -> Result<TargetStatus> {
        self.profiles.inspect(name, token).map_err(profile_error)?;
        let target = self.discover_target(selector)?;
        self.profiles
            .select_target(name, token, &target.target_id)
            .map_err(profile_error)?;
        Ok(target)
    }

    pub fn resolve_target(
        &self,
        profile: Option<(&str, &str)>,
        explicit: Option<TargetSelector>,
        expected_generation: Option<&str>,
        expected_catalog_revision: Option<&str>,
    ) -> Result<TargetStatus> {
        let target = if let Some(selector) = explicit {
            self.discover_target(selector)?
        } else if let Some((name, token)) = profile {
            let target_id = self
                .profiles
                .selected_target(name, token)
                .map_err(profile_error)?
                .ok_or_else(|| {
                    CoordinationError::new("target_not_selected", "profile has no selected target")
                })?;
            self.target_by_id(&target_id)?.ok_or_else(|| {
                CoordinationError::new("stale_target", "selected target no longer exists")
            })?
        } else {
            return Err(CoordinationError::new(
                "explicit_target_required",
                "anonymous operations require an explicit target",
            ));
        };
        if !target.live {
            return Err(CoordinationError::new(
                "stale_target",
                "target generation is no longer live",
            ));
        }
        if expected_generation.is_some_and(|generation| generation != target.target_generation) {
            return Err(CoordinationError::new(
                "stale_target",
                "target generation changed",
            ));
        }
        if expected_catalog_revision.is_some_and(|revision| revision != target.catalog_revision) {
            return Err(CoordinationError::new(
                "stale_catalog",
                "target catalog revision changed",
            ));
        }
        Ok(target)
    }

    pub fn acquire_lease(
        &self,
        caller: MutationCaller,
        explicit: Option<TargetSelector>,
        duration_ms: i64,
    ) -> Result<LeaseGrant> {
        self.acquire_lease_at(caller, explicit, duration_ms, now_ms())
    }

    #[doc(hidden)]
    pub fn acquire_lease_at(
        &self,
        caller: MutationCaller,
        explicit: Option<TargetSelector>,
        duration_ms: i64,
        clock_ms: i64,
    ) -> Result<LeaseGrant> {
        let profile = self.profile_context(&caller)?;
        let target = self.resolve_target(
            Some((&caller.name, &caller.token)),
            explicit.clone(),
            None,
            None,
        )?;
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        verify_live_target(&tx, &target).map_err(coordination_state_error)?;
        verify_profile_in_transaction(&tx, &caller, explicit.is_none(), &target.target_id)
            .map_err(coordination_state_error)?;
        let grant = leases::acquire(
            &tx,
            &target.target_id,
            &profile.key,
            &profile.label,
            duration_ms,
            clock_ms,
        )
        .map_err(lease_error)?;
        tx.commit().map_err(internal_error)?;
        Ok(grant)
    }

    pub fn release_lease(
        &self,
        caller: MutationCaller,
        target_id: &str,
        lease_token: &str,
    ) -> Result<()> {
        self.release_lease_at(caller, target_id, lease_token, now_ms())
    }

    #[doc(hidden)]
    pub fn release_lease_at(
        &self,
        caller: MutationCaller,
        target_id: &str,
        lease_token: &str,
        clock_ms: i64,
    ) -> Result<()> {
        let profile = self.profile_context(&caller)?;
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        verify_profile_in_transaction(&tx, &caller, false, target_id)
            .map_err(coordination_state_error)?;
        leases::release(&tx, target_id, &profile.key, lease_token, clock_ms)
            .map_err(lease_error)?;
        tx.commit().map_err(internal_error)
    }

    pub fn admit_mutation(
        &self,
        acceptance: &OperationAcceptance,
        caller: Option<MutationCaller>,
        explicit: Option<TargetSelector>,
        lease_token: Option<&str>,
    ) -> Result<MutationAdmission> {
        self.admit_mutation_at(acceptance, caller, explicit, lease_token, now_ms())
    }

    #[doc(hidden)]
    pub fn admit_mutation_at(
        &self,
        acceptance: &OperationAcceptance,
        caller: Option<MutationCaller>,
        explicit: Option<TargetSelector>,
        lease_token: Option<&str>,
        clock_ms: i64,
    ) -> Result<MutationAdmission> {
        if !acceptance.is_mutation {
            return Err(CoordinationError::new(
                "not_a_mutation",
                "mutation admission requires a mutation operation",
            ));
        }
        if caller.is_none() && explicit.is_none() {
            return Err(CoordinationError::new(
                "explicit_target_required",
                "anonymous mutations require an explicit target",
            ));
        }
        let profile = caller
            .as_ref()
            .map(|value| self.profile_context(value))
            .transpose()?;
        let target = self.resolve_target(
            caller
                .as_ref()
                .map(|value| (value.name.as_str(), value.token.as_str())),
            explicit.clone(),
            acceptance.target_generation.as_deref(),
            acceptance.catalog_revision.as_deref(),
        )?;
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        verify_live_target(&tx, &target).map_err(coordination_state_error)?;
        if let Some(caller) = caller.as_ref() {
            verify_profile_in_transaction(&tx, caller, explicit.is_none(), &target.target_id)
                .map_err(coordination_state_error)?;
        }
        let caller_key = profile.as_ref().map(|p| p.key.as_str());
        let lease_authority =
            leases::authorize_mutation(&tx, &target.target_id, caller_key, lease_token, clock_ms)
                .map_err(lease_error)?;
        let mut frozen = acceptance.clone();
        frozen.scope = caller_key
            .map(|v| format!("profile:{v}"))
            .unwrap_or_else(|| "anonymous".into());
        frozen.profile_token = caller_key.map(str::to_string);
        frozen.target_generation = Some(target.target_generation.clone());
        frozen.catalog_revision = Some(target.catalog_revision.clone());
        frozen.lease_authority = lease_authority.clone();
        let admission = revisions::admit(
            &tx,
            revisions::MutationInsert {
                acceptance: &frozen,
                target_id: &target.target_id,
                target_generation: &target.target_generation,
                catalog_revision: &target.catalog_revision,
                caller_key,
                caller_label: profile
                    .as_ref()
                    .map(|p| p.label.as_str())
                    .unwrap_or("anonymous"),
                lease_authority: lease_authority.as_deref(),
                now_ms: clock_ms,
            },
        )
        .map_err(coordination_state_error)?;
        tx.commit().map_err(internal_error)?;
        Ok(admission)
    }

    pub fn claim_next_mutation(&self, target_id: &str) -> Result<Option<MutationClaim>> {
        self.claim_next_mutation_at(target_id, now_ms())
    }

    pub fn claim_mutation(
        &self,
        target_id: &str,
        operation_id: &str,
    ) -> Result<Option<MutationClaim>> {
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        let claim = revisions::claim_specific(&tx, target_id, operation_id, now_ms())
            .map_err(coordination_state_error)?;
        tx.commit().map_err(internal_error)?;
        Ok(claim)
    }

    /// Wait without polling until the target lane may have advanced. Every
    /// wake and the deadline path finish with an authoritative transactional
    /// claim, so notifications are hints rather than state.
    pub async fn wait_to_claim_mutation(
        &self,
        target_id: &str,
        operation_id: &str,
        timeout: Duration,
    ) -> Result<Option<MutationClaim>> {
        let deadline = tokio::time::Instant::now() + timeout;
        let notify = self.mutation_notifier(target_id);
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            if let Some(claim) = self.claim_mutation(target_id, operation_id)? {
                return Ok(Some(claim));
            }
            if tokio::time::Instant::now() >= deadline {
                return self.claim_mutation(target_id, operation_id);
            }
            tokio::select! {
                _ = &mut notified => {},
                _ = tokio::time::sleep_until(deadline) => {
                    return self.claim_mutation(target_id, operation_id);
                }
            }
        }
    }

    pub fn known_operation_result(&self, operation_id: &str) -> Result<Option<Value>> {
        self.journal
            .get(operation_id)
            .map(|value| value.and_then(|operation| operation.result))
            .map_err(internal_error)
    }
    #[doc(hidden)]
    pub fn claim_next_mutation_at(
        &self,
        target_id: &str,
        clock_ms: i64,
    ) -> Result<Option<MutationClaim>> {
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        let claim = match revisions::claim_next(&tx, target_id, clock_ms) {
            Ok(claim) => claim,
            Err(error) if error.to_string() == "stale_mutation_authority" => {
                tx.commit().map_err(internal_error)?;
                return Err(coordination_state_error(error));
            }
            Err(error) => return Err(coordination_state_error(error)),
        };
        tx.commit().map_err(internal_error)?;
        Ok(claim)
    }

    pub fn complete_mutation(
        &self,
        operation_id: &str,
        result: &Value,
    ) -> Result<MutationCompletion> {
        self.complete_mutation_at(operation_id, result, now_ms())
    }
    #[doc(hidden)]
    pub fn complete_mutation_at(
        &self,
        operation_id: &str,
        result: &Value,
        clock_ms: i64,
    ) -> Result<MutationCompletion> {
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        let completion = revisions::complete(&tx, operation_id, result, clock_ms)
            .map_err(coordination_state_error)?;
        tx.commit().map_err(internal_error)?;
        self.notify_mutation_lane(&completion.target_id);
        Ok(completion)
    }

    pub fn mark_mutation_indeterminate(&self, operation_id: &str) -> Result<()> {
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        revisions::mark_indeterminate(&tx, operation_id, now_ms())
            .map_err(coordination_state_error)?;
        let target_id: Option<String> = tx
            .query_row(
                "SELECT target_id FROM mutation_queue WHERE operation_id=?",
                [operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(internal_error)?;
        tx.commit().map_err(internal_error)?;
        if let Some(target_id) = target_id {
            self.notify_mutation_lane(&target_id);
        }
        Ok(())
    }

    pub fn maintain_durable_state(&self, now_ms: i64, limit: usize) -> Result<(usize, usize)> {
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        let result = revisions::prune_completed(&tx, now_ms, limit).map_err(internal_error)?;
        tx.commit().map_err(internal_error)?;
        Ok(result)
    }

    fn mutation_notifier(&self, target_id: &str) -> Arc<Notify> {
        let mut notifiers = self
            .mutation_notifiers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        notifiers.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = notifiers.get(target_id).and_then(Weak::upgrade) {
            return existing;
        }
        let notify = Arc::new(Notify::new());
        notifiers.insert(target_id.to_string(), Arc::downgrade(&notify));
        notify
    }

    fn notify_mutation_lane(&self, target_id: &str) {
        if let Some(notify) = self
            .mutation_notifiers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(target_id)
            .and_then(Weak::upgrade)
        {
            notify.notify_waiters();
        }
    }

    pub fn mutation_notices(
        &self,
        caller: MutationCaller,
        target_id: &str,
        cursor: Option<i64>,
        limit: usize,
    ) -> Result<MutationNoticePage> {
        let profile = self.profile_context(&caller)?;
        let mut conn = self.store.connection().map_err(internal_error)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal_error)?;
        verify_profile_in_transaction(&tx, &caller, false, target_id)
            .map_err(coordination_state_error)?;
        let prior = cursor.unwrap_or_else(|| {
            tx.query_row(
                "SELECT cursor FROM profile_target_cursors WHERE profile_key=? AND target_id=?",
                params![profile.key, target_id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0)
        });
        let page = revisions::notices(
            &tx,
            Some(&profile.key),
            target_id,
            prior,
            limit,
            true,
            now_ms(),
        )
        .map_err(coordination_state_error)?;
        tx.commit().map_err(internal_error)?;
        Ok(page)
    }

    pub fn operation_status(&self, operation_id: &str) -> Result<Option<OperationStatus>> {
        self.journal.status(operation_id).map_err(internal_error)
    }

    pub fn catalog_list(&self, selector: TargetSelector) -> Result<CatalogListing> {
        let target = self.discover_target(selector)?;
        let mut operations = self.catalog_operations(&target)?;
        for operation in &mut operations {
            operation.input_schema = None;
            operation.examples.clear();
        }
        Ok(CatalogListing {
            target_id: target.target_id,
            target_generation: target.target_generation,
            catalog_revision: target.catalog_revision,
            operations,
        })
    }

    pub fn catalog_describe(
        &self,
        selector: TargetSelector,
        name: &str,
    ) -> Result<CatalogDescription> {
        let target = self.discover_target(selector)?;
        let operation = self
            .catalog_operations(&target)?
            .into_iter()
            .find(|operation| operation.name == name)
            .ok_or_else(|| {
                CoordinationError::new("operation_not_found", "operation absent from bound catalog")
            })?;
        Ok(CatalogDescription {
            target_id: target.target_id,
            target_generation: target.target_generation,
            catalog_revision: target.catalog_revision,
            operation,
        })
    }

    fn catalog_operations(&self, target: &TargetStatus) -> Result<Vec<CatalogOperation>> {
        let catalog_json: Option<String> = self
            .store
            .connection()
            .map_err(internal_error)?
            .query_row(
                "SELECT catalog_json FROM catalog_snapshots WHERE target_id=? AND revision=?",
                params![target.target_id, target.catalog_revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(internal_error)?;
        let catalog: Value = serde_json::from_str(&catalog_json.ok_or_else(|| {
            CoordinationError::new("stale_catalog", "catalog snapshot is unavailable")
        })?)
        .map_err(internal_error)?;
        parse_catalog_operations(&catalog)
    }

    fn target_by_id(&self, target_id: &str) -> Result<Option<TargetStatus>> {
        self.store.connection().map_err(internal_error)?.query_row(
            "SELECT target_id,target_generation,runtime_id,url,title,catalog_revision,live,last_seen_ms FROM resident_targets WHERE target_id=?",
            [target_id], row_to_target,
        ).optional().map_err(internal_error)
    }

    fn load_targets(&self, live_only: bool) -> Result<Vec<TargetStatus>> {
        let conn = self.store.connection().map_err(internal_error)?;
        let sql = if live_only {
            "SELECT target_id,target_generation,runtime_id,url,title,catalog_revision,live,last_seen_ms FROM resident_targets WHERE live=1 ORDER BY target_id"
        } else {
            "SELECT target_id,target_generation,runtime_id,url,title,catalog_revision,live,last_seen_ms FROM resident_targets ORDER BY target_id"
        };
        let mut statement = conn.prepare(sql).map_err(internal_error)?;
        let targets = statement
            .query_map([], row_to_target)
            .map_err(internal_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal_error)?;
        Ok(targets)
    }

    fn profile_context(&self, caller: &MutationCaller) -> Result<ProfileContext> {
        let status = self
            .profiles
            .inspect(&caller.name, &caller.token)
            .map_err(profile_error)?;
        Ok(ProfileContext {
            key: crate::state::profiles::token_hash(&caller.token),
            label: status.label.unwrap_or_else(|| caller.name.clone()),
        })
    }
}

struct ProfileContext {
    key: String,
    label: String,
}

fn verify_live_target(tx: &rusqlite::Transaction<'_>, target: &TargetStatus) -> AnyResult<()> {
    let matches: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM resident_targets WHERE target_id=? AND target_generation=? AND catalog_revision=? AND live=1)",
        params![target.target_id,target.target_generation,target.catalog_revision],
        |row| row.get(0),
    )?;
    if !matches {
        anyhow::bail!("stale_target");
    }
    let snapshot: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM catalog_snapshots WHERE target_id=? AND target_generation=? AND revision=?)",
        params![target.target_id,target.target_generation,target.catalog_revision],
        |row| row.get(0),
    )?;
    if !snapshot {
        anyhow::bail!("stale_catalog");
    }
    Ok(())
}

fn verify_profile_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    caller: &MutationCaller,
    require_selected_target: bool,
    target_id: &str,
) -> AnyResult<()> {
    let row: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT token_hash,selected_target_id FROM cooperative_profiles WHERE name=?",
            [&caller.name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((token_hash, selected_target)) = row else {
        anyhow::bail!("profile_not_found");
    };
    if token_hash != crate::state::profiles::token_hash(&caller.token) {
        anyhow::bail!("profile_token_mismatch");
    }
    if require_selected_target && selected_target.as_deref() != Some(target_id) {
        anyhow::bail!("stale_target");
    }
    Ok(())
}

fn row_to_target(row: &rusqlite::Row<'_>) -> rusqlite::Result<TargetStatus> {
    Ok(TargetStatus {
        target_id: row.get(0)?,
        target_generation: row.get(1)?,
        runtime_id: row.get(2)?,
        url: row.get(3)?,
        title: row.get(4)?,
        catalog_revision: row.get(5)?,
        live: row.get::<_, i64>(6)? != 0,
        last_seen_ms: row.get(7)?,
    })
}

fn parse_catalog_operations(catalog: &Value) -> Result<Vec<CatalogOperation>> {
    let rows = catalog
        .get("operations")
        .or_else(|| catalog.get("tools"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoordinationError::new(
                "invalid_catalog",
                "catalog must contain operations or tools",
            )
        })?;
    let mut operations = Vec::with_capacity(rows.len());
    for row in rows {
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                CoordinationError::new("invalid_catalog", "catalog operation needs a name")
            })?;
        operations.push(CatalogOperation {
            name: name.into(),
            description: row
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            input_schema: row
                .get("input_schema")
                .or_else(|| row.get("inputSchema"))
                .cloned(),
            safety: row.get("safety").cloned(),
            examples: row
                .get("examples")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        });
    }
    operations.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(operations)
}

fn selector_matches(selector: &TargetSelector, target: &TargetStatus) -> bool {
    match selector {
        TargetSelector::TargetId(id) => target.target_id == *id,
        TargetSelector::RuntimeId(id) => target.runtime_id == *id,
        TargetSelector::Intent(intent) => {
            let needle = intent.to_ascii_lowercase();
            !needle.is_empty()
                && [target.url.as_deref(), target.title.as_deref()]
                    .into_iter()
                    .flatten()
                    .any(|value| value.to_ascii_lowercase().contains(&needle))
        }
    }
}

fn selector_from_args(args: &serde_json::Map<String, Value>) -> Result<TargetSelector> {
    let selectors = [
        args.get("target_id")
            .and_then(Value::as_str)
            .map(|v| TargetSelector::TargetId(v.into())),
        args.get("runtime_id")
            .and_then(Value::as_str)
            .map(|v| TargetSelector::RuntimeId(v.into())),
        args.get("intent")
            .and_then(Value::as_str)
            .map(|v| TargetSelector::Intent(v.into())),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    match selectors.as_slice() {
        [selector] => Ok(selector.clone()),
        [] => Err(CoordinationError::new(
            "invalid_input",
            "one target selector is required",
        )),
        _ => Err(CoordinationError::new(
            "invalid_input",
            "target selectors are mutually exclusive",
        )),
    }
}

fn optional_selector_from_args(
    args: &serde_json::Map<String, Value>,
) -> Result<Option<TargetSelector>> {
    let present = ["target_id", "runtime_id", "intent"]
        .into_iter()
        .any(|key| args.get(key).and_then(Value::as_str).is_some());
    if present {
        selector_from_args(args).map(Some)
    } else {
        Ok(None)
    }
}

fn generation_for(observation: &LiveTargetObservation) -> String {
    let bytes = serde_json::to_vec(&[
        observation.client_instance_id.as_str(),
        observation.session_generation.as_str(),
        observation.tab_key.as_str(),
    ])
    .expect("string tuple serializes");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonicalize(&map[key])))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        _ => value.clone(),
    }
}

fn validate_observation(observation: &LiveTargetObservation) -> Result<()> {
    if observation.client_instance_id.is_empty()
        || observation.session_generation.is_empty()
        || observation.tab_key.is_empty()
        || observation.runtime_id.is_empty()
    {
        return Err(CoordinationError::new(
            "invalid_target",
            "target identity components must be non-empty",
        ));
    }
    Ok(())
}

fn profile_error(error: anyhow::Error) -> CoordinationError {
    let message = error.to_string();
    let code = match message.as_str() {
        "profile_already_exists" => "profile_already_exists",
        "profile_not_found" => "profile_not_found",
        "profile_token_mismatch" => "profile_token_mismatch",
        "invalid_profile_name" => "invalid_profile_name",
        _ => "state_failure",
    };
    let safe_message = if code == "state_failure" {
        "profile state operation failed".to_string()
    } else {
        message
    };
    CoordinationError::new(code, safe_message)
}
fn lease_error(error: crate::state::LeaseError) -> CoordinationError {
    CoordinationError::with_details(error.code(), error.to_string(), error.details().cloned())
}
fn coordination_state_error(error: anyhow::Error) -> CoordinationError {
    let message = error.to_string();
    let code = match message.as_str() {
        "request_identity_conflict" => "request_identity_conflict",
        "stale_target" => "stale_target",
        "stale_catalog" => "stale_catalog",
        "profile_not_found" => "profile_not_found",
        "profile_token_mismatch" => "profile_token_mismatch",
        "mutation_not_dispatched" => "mutation_not_dispatched",
        "mutation_not_active" => "mutation_not_active",
        "stale_mutation_authority" => "stale_mutation_authority",
        _ => "state_failure",
    };
    if code == "state_failure" {
        eprintln!("actions-json mutation coordination failure: {error}");
    }
    CoordinationError::new(
        code,
        if code == "state_failure" {
            "resident mutation coordination failed"
        } else {
            message.as_str()
        },
    )
}
fn internal_error(error: impl fmt::Display) -> CoordinationError {
    eprintln!("actions-json resident coordination state failure: {error}");
    CoordinationError::new(
        "state_failure",
        "resident coordination state operation failed",
    )
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
