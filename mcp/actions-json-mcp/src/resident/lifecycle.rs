use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{ipc::Client, IPC_PROTOCOL_VERSION};

const STARTUP_ERROR_FILE: &str = "resident.startup-error.json";

#[derive(Debug, Clone)]
pub struct ResidentConfig {
    pub state_dir: PathBuf,
    pub executable_version: String,
    pub configuration_id: Option<String>,
    pub startup_timeout: Duration,
}

/// Produce one canonical identity for every entry point that can launch the
/// per-user resident. Keeping this here prevents the CLI and MCP adapters from
/// describing the same runtime with different hashes.
pub fn configuration_id(
    actions: Option<&Path>,
    bind: Option<&str>,
    map_paths: &[PathBuf],
    storage_root: Option<&Path>,
) -> String {
    let bytes = serde_json::to_vec(&json!({
        "actions": actions,
        "bind": bind,
        "maps": map_paths,
        "storage_root": storage_root,
    }))
    .expect("resident configuration serializes");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

impl ResidentConfig {
    pub fn endpoint(&self) -> PathBuf {
        endpoint_for(&self.state_dir)
    }
    pub fn ready_path(&self) -> PathBuf {
        self.state_dir.join("resident.ready.json")
    }
    pub fn fence_path(&self) -> PathBuf {
        self.state_dir.join("resident.starting")
    }
    pub fn startup_error_path(&self) -> PathBuf {
        self.state_dir.join(STARTUP_ERROR_FILE)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StartupFailure {
    code: String,
    message: String,
}

pub(crate) fn record_startup_failure(state_dir: &Path, code: &str, message: &str) -> Result<()> {
    fs::create_dir_all(state_dir)?;
    let path = state_dir.join(STARTUP_ERROR_FILE);
    if path.exists() {
        return Ok(());
    }
    write_atomic_json(
        &path,
        &StartupFailure {
            code: code.to_string(),
            message: message.to_string(),
        },
    )
}

fn take_startup_failure(config: &ResidentConfig) -> Result<Option<StartupFailure>> {
    let path = config.startup_error_path();
    match fs::read(&path) {
        Ok(bytes) => {
            let failure = serde_json::from_slice(&bytes)?;
            fs::remove_file(path)?;
            Ok(Some(failure))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResidentStatus {
    pub protocol: u32,
    pub executable_version: String,
    pub pid: u32,
    pub started_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_id: Option<String>,
}

impl ResidentStatus {
    pub fn current(executable_version: impl Into<String>) -> Self {
        Self {
            protocol: IPC_PROTOCOL_VERSION,
            executable_version: executable_version.into(),
            pid: std::process::id(),
            started_at_ms: now_ms(),
            configuration_id: None,
        }
    }

    pub fn with_configuration_id(mut self, configuration_id: Option<String>) -> Self {
        self.configuration_id = configuration_id;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartDisposition {
    AlreadyRunning,
    Started,
    WaitedForConcurrentStart,
}

pub fn endpoint_for(state_dir: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        state_dir.join("resident.sock")
    }
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let digest = format!(
            "{:x}",
            Sha256::digest(state_dir.to_string_lossy().as_bytes())
        );
        PathBuf::from(format!(r"\\.\pipe\actions-json-{}", &digest[..24]))
    }
}

pub async fn probe(config: &ResidentConfig) -> Result<Option<ResidentStatus>> {
    let client = Client::new(config.endpoint(), Duration::from_millis(400));
    match client.handshake(&config.executable_version).await {
        Ok(status) if status.configuration_id == config.configuration_id => Ok(Some(status)),
        Ok(_) => Ok(None),
        Err(_) => Ok(None),
    }
}

pub async fn probe_status_any(config: &ResidentConfig) -> Result<Option<ResidentStatus>> {
    let client = Client::new(config.endpoint(), Duration::from_millis(400));
    match client.request(&super::ipc::IpcRequest::Status).await {
        Ok(response) if response.ok => Ok(response.status),
        _ => Ok(None),
    }
}

pub fn read_status(config: &ResidentConfig) -> Result<Option<ResidentStatus>> {
    let path = config.ready_path();
    match fs::read_to_string(path) {
        Ok(value) => Ok(Some(serde_json::from_str(&value)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Race-safe autostart handshake. `start` must spawn the same installed
/// executable in resident mode and return only after it has begun startup.
pub async fn ensure_resident<F>(config: &ResidentConfig, start: F) -> Result<StartDisposition>
where
    F: FnOnce() -> Result<()>,
{
    protect_state_dir(&config.state_dir)?;
    if let Some(running) = probe_status_any(config).await? {
        if running.protocol == IPC_PROTOCOL_VERSION
            && running.executable_version == config.executable_version
            && running.configuration_id == config.configuration_id
        {
            return Ok(StartDisposition::AlreadyRunning);
        }
        bail!(
            "resident_configuration_conflict: a live resident has a different version or configuration; use the explicit update/restart lifecycle instead of replacing it implicitly"
        );
    }
    let acquisition_deadline = tokio::time::Instant::now() + config.startup_timeout;
    let fence = loop {
        match StartupFence::try_acquire(config)? {
            Some(fence) => break Some(fence),
            None => {
                if let Some(running) = probe_status_any(config).await? {
                    if running.protocol == IPC_PROTOCOL_VERSION
                        && running.executable_version == config.executable_version
                        && running.configuration_id == config.configuration_id
                    {
                        return Ok(StartDisposition::WaitedForConcurrentStart);
                    }
                    bail!(
                        "resident_configuration_conflict: a concurrently started resident has a different version or configuration"
                    );
                }
                if stale_fence_can_be_reclaimed(config)? {
                    reclaim_stale_fence(config)?;
                    continue;
                }
                if tokio::time::Instant::now() >= acquisition_deadline {
                    bail!("resident startup fence remained live before timeout");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };
    let mut fence = fence.expect("acquired startup fence");
    let _ = fs::remove_file(config.startup_error_path());
    if let Err(error) = start() {
        fence.release();
        return Err(error).context("start resident process");
    }
    let deadline = tokio::time::Instant::now() + config.startup_timeout;
    loop {
        if let Some(failure) = take_startup_failure(config)? {
            fence.release();
            bail!("{}: {}", failure.code, failure.message);
        }
        if let Some(status) = probe(config).await? {
            fence.release();
            write_ready(config, &status)?;
            return Ok(StartDisposition::Started);
        }
        if tokio::time::Instant::now() >= deadline {
            fence.release();
            bail!("resident did not become ready before startup timeout");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub async fn stop_resident(config: &ResidentConfig) -> Result<Option<ResidentStatus>> {
    let client = Client::new(config.endpoint(), config.startup_timeout);
    let status = probe_status_any(config).await?;
    if status.is_none() {
        let _ = fs::remove_file(config.ready_path());
        return Ok(None);
    }
    let response = client.request(&super::ipc::IpcRequest::Shutdown).await?;
    if !response.ok {
        bail!("resident refused shutdown");
    }
    let deadline = tokio::time::Instant::now() + config.startup_timeout;
    loop {
        let current = probe_status_any(config).await?;
        let old_is_gone = match current {
            None => true,
            Some(ref current) => {
                current.pid != status.as_ref().unwrap().pid
                    || current.started_at_ms != status.as_ref().unwrap().started_at_ms
            }
        };
        if old_is_gone {
            remove_ready_if_matches(config, status.as_ref().unwrap())?;
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("resident shutdown timed out");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(status)
}

pub async fn restart_resident<F>(config: &ResidentConfig, start: F) -> Result<StartDisposition>
where
    F: FnOnce() -> Result<()>,
{
    stop_resident(config).await?;
    ensure_resident(config, start).await
}

fn write_ready(config: &ResidentConfig, status: &ResidentStatus) -> Result<()> {
    write_atomic_json(&config.ready_path(), status)
}

fn write_atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, value)?;
        file.sync_all()?;
        crate::state::store::refuse_symlink(path)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct StartupFenceRecord {
    pid: u32,
    created_at_ms: i64,
    nonce: String,
}

struct StartupFence {
    path: PathBuf,
    nonce: String,
    released: bool,
}

impl StartupFence {
    fn try_acquire(config: &ResidentConfig) -> Result<Option<Self>> {
        let record = StartupFenceRecord {
            pid: std::process::id(),
            created_at_ms: now_ms(),
            nonce: Uuid::new_v4().simple().to_string(),
        };
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(config.fence_path())
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let written = (|| -> Result<()> {
            serde_json::to_writer(&mut file, &record)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = fs::remove_file(config.fence_path());
            return Err(error);
        }
        Ok(Some(Self {
            path: config.fence_path(),
            nonce: record.nonce,
            released: false,
        }))
    }

    fn release(&mut self) {
        if fence_nonce(&self.path).as_deref() == Some(self.nonce.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
        self.released = true;
    }
}

impl Drop for StartupFence {
    fn drop(&mut self) {
        if !self.released {
            self.release();
        }
    }
}

fn fence_nonce(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str::<StartupFenceRecord>(&value).ok())
        .map(|record| record.nonce)
}

fn stale_fence_can_be_reclaimed(config: &ResidentConfig) -> Result<bool> {
    let value = match fs::read_to_string(config.fence_path()) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    let record: StartupFenceRecord = match serde_json::from_str(&value) {
        Ok(record) => record,
        Err(_) => {
            // Another process may have won create_new but not yet flushed its
            // record. Never steal a newly created, temporarily empty fence.
            let age = fs::metadata(config.fence_path())?
                .modified()?
                .elapsed()
                .unwrap_or_default();
            return Ok(age > config.startup_timeout);
        }
    };
    let max_age = config.startup_timeout.as_millis().min(i64::MAX as u128) as i64;
    Ok(now_ms().saturating_sub(record.created_at_ms) > max_age)
}

fn reclaim_stale_fence(config: &ResidentConfig) -> Result<()> {
    let quarantine = config.state_dir.join(format!(
        "resident.starting.stale.{}",
        Uuid::new_v4().simple()
    ));
    match fs::rename(config.fence_path(), &quarantine) {
        Ok(()) => {
            let _ = fs::remove_file(quarantine);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn remove_ready_if_matches(config: &ResidentConfig, stopped: &ResidentStatus) -> Result<()> {
    if read_status(config)?.as_ref() == Some(stopped) {
        let _ = fs::remove_file(config.ready_path());
    }
    Ok(())
}

/// Prepare an update candidate without touching the active database. The
/// caller switches executable and database pointers only after the candidate
/// resident proves its exact version/protocol; failure leaves the original
/// executable/store pair untouched.
pub fn copy_on_write_migrate<F>(active: &Path, candidate: &Path, migrate: F) -> Result<()>
where
    F: FnOnce(&Path) -> Result<()>,
{
    if candidate.exists() {
        bail!("migration candidate already exists");
    }
    let source =
        rusqlite::Connection::open_with_flags(active, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("open active resident database for snapshot")?;
    let mut destination =
        rusqlite::Connection::open(candidate).context("create candidate resident database")?;
    rusqlite::backup::Backup::new(&source, &mut destination)?
        .run_to_completion(16, Duration::from_millis(5), None)
        .context("snapshot active resident database")?;
    drop(destination);
    drop(source);
    let result = migrate(candidate);
    if let Err(error) = result {
        let _ = fs::remove_file(candidate);
        return Err(error).context("candidate database migration failed");
    }
    let file = fs::OpenOptions::new().read(true).open(candidate)?;
    file.sync_all()?;
    Ok(())
}

/// Fenced executable+database handoff. The candidate pair is proven before
/// either active pointer moves. The returned guard rolls both artifacts back
/// together unless the candidate resident reaches readiness and the caller
/// explicitly commits.
pub fn begin_fenced_update<F>(
    active_executable: &Path,
    candidate_executable: &Path,
    active_store: &Path,
    candidate_store: &Path,
    prove_candidate: F,
) -> Result<FencedUpdate>
where
    F: FnOnce(&Path, &Path) -> Result<()>,
{
    prove_candidate(candidate_executable, candidate_store)?;
    let rollback_executable = rollback_path(active_executable);
    let rollback_store = rollback_path(active_store);
    if rollback_executable.exists() || rollback_store.exists() {
        bail!("stale rollback fence blocks resident update");
    }
    fs::rename(active_executable, &rollback_executable)?;
    if let Err(error) = fs::rename(active_store, &rollback_store) {
        let _ = fs::rename(&rollback_executable, active_executable);
        return Err(error).context("fence active resident store");
    }
    if let Err(error) = fs::rename(candidate_executable, active_executable) {
        let _ = fs::rename(&rollback_store, active_store);
        let _ = fs::rename(&rollback_executable, active_executable);
        return Err(error).context("activate candidate executable");
    }
    if let Err(error) = fs::rename(candidate_store, active_store) {
        let _ = fs::rename(active_executable, candidate_executable);
        let _ = fs::rename(&rollback_store, active_store);
        let _ = fs::rename(&rollback_executable, active_executable);
        return Err(error).context("activate candidate resident store");
    }
    Ok(FencedUpdate {
        active_executable: active_executable.to_owned(),
        active_store: active_store.to_owned(),
        rollback_executable,
        rollback_store,
        committed: false,
    })
}

pub struct FencedUpdate {
    active_executable: PathBuf,
    active_store: PathBuf,
    rollback_executable: PathBuf,
    rollback_store: PathBuf,
    committed: bool,
}

impl FencedUpdate {
    pub fn commit(mut self) -> Result<()> {
        self.committed = true;
        // Backups are no longer authoritative after the candidate resident's
        // ready proof. Cleanup is best-effort and never re-enters rollback with
        // only half a pair remaining.
        let _ = fs::remove_file(&self.rollback_executable);
        let _ = fs::remove_file(&self.rollback_store);
        Ok(())
    }

    pub fn rollback(mut self) -> Result<()> {
        self.restore()?;
        self.committed = true;
        Ok(())
    }

    /// Keep the activated candidate and its rollback pair untouched when the
    /// candidate process could not be stopped safely. Restoring files beneath
    /// a possibly-live process would create a split executable/store state.
    pub fn retain_candidate(mut self) {
        self.committed = true;
    }

    fn restore(&self) -> Result<()> {
        let failed_executable = self.active_executable.with_extension("failed-update");
        let failed_store = self.active_store.with_extension("failed-update");
        let _ = fs::remove_file(&failed_executable);
        let _ = fs::remove_file(&failed_store);
        fs::rename(&self.active_executable, &failed_executable)?;
        fs::rename(&self.active_store, &failed_store)?;
        fs::rename(&self.rollback_executable, &self.active_executable)?;
        fs::rename(&self.rollback_store, &self.active_store)?;
        let _ = fs::remove_file(failed_executable);
        let _ = fs::remove_file(failed_store);
        Ok(())
    }
}

impl Drop for FencedUpdate {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.restore();
        }
    }
}

fn rollback_path(active: &Path) -> PathBuf {
    let mut name = active.as_os_str().to_owned();
    name.push(".rollback");
    PathBuf::from(name)
}

fn protect_state_dir(path: &Path) -> Result<()> {
    crate::state::store::create_protected_dir(path)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
