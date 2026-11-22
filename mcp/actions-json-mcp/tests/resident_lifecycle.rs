#![cfg(unix)]

use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use actions_json_mcp::{
    resident::{
        begin_fenced_update, copy_on_write_migrate, ensure_resident, recover_accepted_operations,
        serve, Client, IpcRequest, ReceiptOracle, ReplayDispatcher, ReplayValidator,
        ResidentConfig, ResidentHandler, ResidentStatus, StartDisposition,
    },
    state::{DurableOperationJournal, OperationAcceptance, ReceiptState},
};
use anyhow::Result;
use serde_json::{json, Value};
use tempfile::tempdir;

struct Echo;
impl ResidentHandler for Echo {
    fn handle<'a>(
        &'a self,
        value: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
        Box::pin(async move { Ok(json!({"echo": value})) })
    }
}

#[tokio::test]
async fn owner_only_ipc_has_exact_version_handshake_and_operation_roundtrip() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let temp = tempdir().unwrap();
    let endpoint = temp.path().join("state/resident.sock");
    let status = ResidentStatus::current("0.1.264");
    let mut server = serve(&endpoint, status.clone(), Arc::new(Echo), None)
        .await
        .unwrap();
    assert!(
        serve(&endpoint, status.clone(), Arc::new(Echo), None)
            .await
            .is_err(),
        "a second direct resident must not unlink a live listener"
    );
    let metadata = std::fs::metadata(&endpoint).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });

    let client = Client::new(&endpoint, Duration::from_secs(1));
    assert_eq!(client.handshake("0.1.264").await.unwrap(), status);
    assert!(client.handshake("0.1.263").await.is_err());
    let response = client
        .request(&IpcRequest::Operation {
            envelope: json!({"operation":"catalog.list"}),
        })
        .await
        .unwrap();
    assert_eq!(
        response.result.unwrap()["echo"]["operation"],
        "catalog.list"
    );

    server.shutdown();
    server.wait_stopped().await;
    assert!(
        !endpoint.exists(),
        "shutdown must remove listener authority"
    );
}

#[tokio::test]
async fn probe_rejects_same_version_resident_with_different_configuration() {
    let temp = tempdir().unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "0.1.265".into(),
        configuration_id: Some("expected-config".into()),
        startup_timeout: Duration::from_secs(1),
    };
    let status =
        ResidentStatus::current("0.1.265").with_configuration_id(Some("other-config".into()));
    let mut server = serve(config.endpoint(), status, Arc::new(Echo), None)
        .await
        .unwrap();

    assert!(
        actions_json_mcp::resident::probe(&config)
            .await
            .unwrap()
            .is_none(),
        "same-version residents with different configuration must not be reused",
    );

    server.shutdown();
    server.wait_stopped().await;
}

#[tokio::test]
async fn ensure_never_displaces_a_live_resident_with_different_configuration() {
    let temp = tempdir().unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "0.1.268".into(),
        configuration_id: Some("requested-config".into()),
        startup_timeout: Duration::from_secs(1),
    };
    let status =
        ResidentStatus::current("0.1.268").with_configuration_id(Some("connected-config".into()));
    let mut server = serve(config.endpoint(), status.clone(), Arc::new(Echo), None)
        .await
        .unwrap();
    let starts = AtomicUsize::new(0);

    let error = ensure_resident(&config, || {
        starts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    })
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("resident_configuration_conflict"));
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        Client::new(config.endpoint(), Duration::from_secs(1))
            .handshake("0.1.268")
            .await
            .unwrap(),
        status,
        "the original resident must remain live after a mismatched CLI call",
    );

    server.shutdown();
    server.wait_stopped().await;
}

#[tokio::test]
async fn concurrent_cold_start_runs_one_starter_and_waiters_share_ready_resident() {
    let temp = tempdir().unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "0.1.264".into(),
        configuration_id: None,
        startup_timeout: Duration::from_secs(2),
    };
    let starts = Arc::new(AtomicUsize::new(0));
    let control = Arc::new(tokio::sync::Mutex::new(None));
    let launch = |config: ResidentConfig,
                  starts: Arc<AtomicUsize>,
                  control: Arc<
        tokio::sync::Mutex<Option<actions_json_mcp::resident::ServerControl>>,
    >| async move {
        ensure_resident(&config, || {
            starts.fetch_add(1, Ordering::SeqCst);
            let endpoint = config.endpoint();
            let control = control.clone();
            tokio::spawn(async move {
                let server = serve(
                    endpoint,
                    ResidentStatus::current("0.1.264"),
                    Arc::new(Echo),
                    None,
                )
                .await
                .unwrap();
                *control.lock().await = Some(server);
            });
            Ok(())
        })
        .await
    };
    let (a, b) = tokio::join!(
        launch(config.clone(), starts.clone(), control.clone()),
        launch(config.clone(), starts.clone(), control.clone())
    );
    let outcomes = [a.unwrap(), b.unwrap()];
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert!(outcomes.contains(&StartDisposition::Started));
    assert!(outcomes.iter().any(|value| matches!(
        value,
        StartDisposition::WaitedForConcurrentStart | StartDisposition::AlreadyRunning
    )));
    assert_eq!(
        actions_json_mcp::resident::read_status(&config)
            .unwrap()
            .unwrap()
            .executable_version,
        "0.1.264"
    );
    let mut server = control.lock().await.take().unwrap();
    server.shutdown();
    server.wait_stopped().await;
}

#[tokio::test]
async fn failed_start_releases_fence_and_next_invocation_can_start() {
    let temp = tempdir().unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "retry-version".into(),
        configuration_id: None,
        startup_timeout: Duration::from_millis(500),
    };
    let error = ensure_resident(&config, || anyhow::bail!("fault injected"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("start resident process"));
    assert!(!config.fence_path().exists());

    let endpoint = config.endpoint();
    let control = Arc::new(tokio::sync::Mutex::new(None));
    let control_for_start = control.clone();
    assert_eq!(
        ensure_resident(&config, || {
            tokio::spawn(async move {
                let server = serve(
                    endpoint,
                    ResidentStatus::current("retry-version"),
                    Arc::new(Echo),
                    None,
                )
                .await
                .unwrap();
                *control_for_start.lock().await = Some(server);
            });
            Ok(())
        })
        .await
        .unwrap(),
        StartDisposition::Started
    );
    let mut server = control.lock().await.take().unwrap();
    server.shutdown();
    server.wait_stopped().await;
}

#[tokio::test]
async fn stale_start_fence_is_taken_over_without_a_timeout_wedge() {
    let temp = tempdir().unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "takeover-version".into(),
        configuration_id: None,
        startup_timeout: Duration::from_millis(100),
    };
    std::fs::create_dir_all(&config.state_dir).unwrap();
    std::fs::write(
        config.fence_path(),
        json!({"pid": 999999u32, "created_at_ms": 1, "nonce":"abandoned"}).to_string(),
    )
    .unwrap();
    // A stale ready temp from this same PID cannot collide with the nonce-based
    // ready write used by the successful takeover.
    std::fs::write(
        config
            .state_dir
            .join(format!("resident.ready.{}.tmp", std::process::id())),
        b"stale",
    )
    .unwrap();
    let endpoint = config.endpoint();
    let control = Arc::new(tokio::sync::Mutex::new(None));
    let control_for_start = control.clone();
    assert_eq!(
        ensure_resident(&config, || {
            tokio::spawn(async move {
                let server = serve(
                    endpoint,
                    ResidentStatus::current("takeover-version"),
                    Arc::new(Echo),
                    None,
                )
                .await
                .unwrap();
                *control_for_start.lock().await = Some(server);
            });
            Ok(())
        })
        .await
        .unwrap(),
        StartDisposition::Started
    );
    assert!(!config.fence_path().exists());
    let mut server = control.lock().await.take().unwrap();
    server.shutdown();
    server.wait_stopped().await;
}

#[tokio::test]
async fn bounded_idle_policy_stops_and_removes_endpoint() {
    let temp = tempdir().unwrap();
    let endpoint = temp.path().join("resident.sock");
    let mut server = serve(
        &endpoint,
        ResidentStatus::current("test"),
        Arc::new(Echo),
        Some(Duration::from_millis(40)),
    )
    .await
    .unwrap();
    server.wait_stopped().await;
    assert!(!endpoint.exists());
}

#[tokio::test]
async fn exact_binary_resident_serves_canonical_read_and_stops_without_orphan() {
    use std::process::{Command, Stdio};

    let temp = tempdir().unwrap();
    let actions = temp.path().join("actions.json");
    std::fs::write(
        &actions,
        serde_json::to_vec(&json!({
            "protocol": "actions.json",
            "tools": [{
                "name": "proof.read",
                "description": "resident proof",
                "input_schema": {"type":"object"},
                "x_actions": {"static_output": {"proof":"resident"}}
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "proof-version".into(),
        configuration_id: None,
        startup_timeout: Duration::from_secs(3),
    };
    let stderr_path = temp.path().join("resident.stderr.log");
    let stderr = std::fs::File::create(&stderr_path).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .args([
            "resident",
            "--bind",
            "127.0.0.1:0",
            "--actions",
            actions.to_str().unwrap(),
            "--state-dir",
            config.state_dir.to_str().unwrap(),
            "--executable-version",
            &config.executable_version,
        ])
        .env(
            "ACTIONS_JSON_DURABLE_STATE_PATH",
            temp.path().join("durable.sqlite3"),
        )
        .env("HOME", temp.path())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr))
        .spawn()
        .unwrap();
    let deadline = tokio::time::Instant::now() + config.startup_timeout;
    while actions_json_mcp::resident::probe(&config)
        .await
        .unwrap()
        .is_none()
    {
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill();
            panic!("resident binary did not become ready");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let response = Client::new(config.endpoint(), Duration::from_secs(1))
        .request(&IpcRequest::Operation {
            envelope: json!({"name":"proof.read","arguments":{}}),
        })
        .await
        .unwrap();
    assert_eq!(response.result.unwrap()["output"]["proof"], "resident");
    actions_json_mcp::resident::stop_resident(&config)
        .await
        .unwrap();
    for _ in 0..100 {
        if child.try_wait().unwrap().is_some() {
            assert!(!config.endpoint().exists());
            let local_config =
                std::fs::read_to_string(temp.path().join(".actions-json/config.json")).unwrap();
            let secret = serde_json::from_str::<Value>(&local_config).unwrap()
                ["bridge_handshake_secret"]
                .as_str()
                .unwrap()
                .to_string();
            let stderr = std::fs::read_to_string(&stderr_path).unwrap();
            assert!(!stderr.contains(&secret), "resident leaked pairing secret");
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = child.kill();
    panic!("resident executable became an orphan after shutdown");
}

#[tokio::test]
async fn occupied_browser_port_fails_before_ipc_readiness_with_typed_error() {
    use std::process::{Command, Stdio};

    let temp = tempdir().unwrap();
    let actions = temp.path().join("actions.json");
    std::fs::write(
        &actions,
        serde_json::to_vec(&json!({"protocol":"actions.json","tools":[]})).unwrap(),
    )
    .unwrap();
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let bind = occupied.local_addr().unwrap();
    let config = ResidentConfig {
        state_dir: temp.path().join("state"),
        executable_version: "occupied-port-proof".into(),
        configuration_id: None,
        startup_timeout: Duration::from_secs(2),
    };

    let stderr_path = temp.path().join("resident.stderr.log");
    let stderr = std::fs::File::create(&stderr_path).unwrap();
    let started = std::time::Instant::now();
    let error = ensure_resident(&config, || {
        Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
            .args([
                "resident",
                "--bind",
                &bind.to_string(),
                "--actions",
                actions.to_str().unwrap(),
                "--state-dir",
                config.state_dir.to_str().unwrap(),
                "--executable-version",
                &config.executable_version,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()?;
        Ok(())
    })
    .await
    .unwrap_err();

    assert!(
        started.elapsed() < config.startup_timeout,
        "typed child failure should fail fast, not consume the readiness timeout"
    );
    assert!(error.to_string().contains("resident_browser_bind_failed"));
    assert!(
        actions_json_mcp::resident::probe(&config)
            .await
            .unwrap()
            .is_none(),
        "IPC must not report ready when the browser listener cannot bind"
    );
    assert!(!config.ready_path().exists());
    let stderr = std::fs::read_to_string(stderr_path).unwrap();
    assert!(
        stderr.contains("resident_browser_bind_failed") && stderr.contains(&bind.to_string()),
        "expected typed bind failure, got: {stderr}"
    );
}

#[test]
fn migration_is_copy_on_write_and_failure_preserves_active_store() {
    let temp = tempdir().unwrap();
    let active = temp.path().join("active.db");
    let candidate = temp.path().join("candidate.db");
    rusqlite::Connection::open(&active)
        .unwrap()
        .execute_batch("CREATE TABLE marker(version INTEGER); INSERT INTO marker VALUES(1);")
        .unwrap();
    let failed = copy_on_write_migrate(&active, &candidate, |path| {
        rusqlite::Connection::open(path)?.execute("UPDATE marker SET version=99", [])?;
        anyhow::bail!("fault injected")
    });
    assert!(failed.is_err());
    let active_version: i64 = rusqlite::Connection::open(&active)
        .unwrap()
        .query_row("SELECT version FROM marker", [], |row| row.get(0))
        .unwrap();
    assert_eq!(active_version, 1);
    assert!(!candidate.exists());
    copy_on_write_migrate(&active, &candidate, |path| {
        rusqlite::Connection::open(path)?.execute("UPDATE marker SET version=2", [])?;
        Ok(())
    })
    .unwrap();
    let candidate_version: i64 = rusqlite::Connection::open(&candidate)
        .unwrap()
        .query_row("SELECT version FROM marker", [], |row| row.get(0))
        .unwrap();
    assert_eq!(active_version, 1);
    assert_eq!(candidate_version, 2);
}

#[test]
fn fenced_update_switches_and_rolls_back_executable_and_store_as_one_pair() {
    let temp = tempdir().unwrap();
    let active_exe = temp.path().join("actions-json");
    let candidate_exe = temp.path().join("actions-json.candidate");
    let active_db = temp.path().join("resident.db");
    let candidate_db = temp.path().join("resident.candidate.db");
    std::fs::write(&active_exe, b"exe-v1").unwrap();
    std::fs::write(&candidate_exe, b"exe-v2").unwrap();
    std::fs::write(&active_db, b"db-v1").unwrap();
    std::fs::write(&candidate_db, b"db-v2").unwrap();
    {
        let _fence = begin_fenced_update(
            &active_exe,
            &candidate_exe,
            &active_db,
            &candidate_db,
            |exe, db| {
                assert_eq!(std::fs::read(exe)?, b"exe-v2");
                assert_eq!(std::fs::read(db)?, b"db-v2");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&active_exe).unwrap(), b"exe-v2");
        assert_eq!(std::fs::read(&active_db).unwrap(), b"db-v2");
        // Dropping before the candidate resident's ready proof rolls back.
    }
    assert_eq!(std::fs::read(&active_exe).unwrap(), b"exe-v1");
    assert_eq!(std::fs::read(&active_db).unwrap(), b"db-v1");
}

#[test]
fn fenced_update_can_retain_candidate_when_process_cleanup_is_unproven() {
    let temp = tempdir().unwrap();
    let active_exe = temp.path().join("actions-json");
    let candidate_exe = temp.path().join("actions-json.candidate");
    let active_db = temp.path().join("resident.db");
    let candidate_db = temp.path().join("resident.candidate.db");
    std::fs::write(&active_exe, b"exe-v1").unwrap();
    std::fs::write(&candidate_exe, b"exe-v2").unwrap();
    std::fs::write(&active_db, b"db-v1").unwrap();
    std::fs::write(&candidate_db, b"db-v2").unwrap();

    let fence = begin_fenced_update(
        &active_exe,
        &candidate_exe,
        &active_db,
        &candidate_db,
        |_, _| Ok(()),
    )
    .unwrap();
    fence.retain_candidate();

    assert_eq!(std::fs::read(&active_exe).unwrap(), b"exe-v2");
    assert_eq!(std::fs::read(&active_db).unwrap(), b"db-v2");
    assert_eq!(
        std::fs::read(active_exe.with_extension("rollback")).unwrap(),
        b"exe-v1"
    );
    assert_eq!(
        std::fs::read(temp.path().join("resident.db.rollback")).unwrap(),
        b"db-v1"
    );
}

fn acceptance(id: &str) -> OperationAcceptance {
    OperationAcceptance {
        request_id: id.into(),
        scope: "profile:test".into(),
        normalized_request: json!({"operation":"trello.card.update","arguments":{"title":"redacted"}}),
        profile_token: Some("token".into()),
        target_generation: Some("browser:session:tab".into()),
        catalog_revision: Some("catalog-1".into()),
        lease_authority: Some("lease-1".into()),
        output_policy: json!({"inline_limit": 1024}),
        is_mutation: true,
    }
}

struct Receipts(std::collections::HashMap<String, ReceiptState>);
impl ReceiptOracle for Receipts {
    fn receipt(&self, id: &str) -> Result<(ReceiptState, Option<Value>)> {
        Ok((*self.0.get(id).unwrap(), None))
    }
}
struct Validator(bool);
impl ReplayValidator for Validator {
    fn still_authorized(&self, acceptance: &OperationAcceptance) -> Result<bool> {
        assert!(acceptance.target_generation.is_some());
        assert!(acceptance.catalog_revision.is_some());
        assert!(acceptance.lease_authority.is_some());
        Ok(self.0)
    }
}
#[derive(Default)]
struct Dispatches(Mutex<Vec<String>>);
impl ReplayDispatcher for Dispatches {
    fn dispatch_with_receipt(&self, id: &str, _: &OperationAcceptance) -> Result<()> {
        self.0.lock().unwrap().push(id.into());
        Ok(())
    }
}

#[test]
fn recovery_replays_only_receipt_absent_and_revalidated_mutations() {
    let temp = tempdir().unwrap();
    let journal = DurableOperationJournal::open(temp.path().join("state.db")).unwrap();
    let accepted = ["absent-valid", "received", "absent-stale"].map(|request_id| {
        match journal.accept(&acceptance(request_id)).unwrap() {
            actions_json_mcp::state::AcceptOutcome::Accepted(operation) => operation,
            _ => panic!("expected acceptance"),
        }
    });
    let absent_valid = accepted[0].operation_id.clone();
    let received = accepted[1].operation_id.clone();
    let absent_stale = accepted[2].operation_id.clone();

    let dispatches = Dispatches::default();
    let receipts = Receipts(std::collections::HashMap::from([
        (absent_valid.clone(), ReceiptState::Absent),
        (received.clone(), ReceiptState::Received),
        (absent_stale.clone(), ReceiptState::Absent),
    ]));
    // First pass with authority valid demonstrates receipt-based suppression.
    let summary =
        recover_accepted_operations(&journal, &receipts, &Validator(true), &dispatches).unwrap();
    assert_eq!(
        summary.replayed,
        vec![absent_valid.clone(), absent_stale.clone()]
    );
    assert_eq!(summary.reconciled, vec![received]);
    assert_eq!(
        *dispatches.0.lock().unwrap(),
        vec![absent_valid, absent_stale]
    );
}

#[test]
fn stale_target_catalog_or_lease_defers_without_dispatch() {
    let temp = tempdir().unwrap();
    let journal = DurableOperationJournal::open(temp.path().join("state.db")).unwrap();
    let operation_id = match journal.accept(&acceptance("stale")).unwrap() {
        actions_json_mcp::state::AcceptOutcome::Accepted(operation) => operation.operation_id,
        _ => panic!("expected acceptance"),
    };
    let receipts = Receipts(std::collections::HashMap::from([(
        operation_id.clone(),
        ReceiptState::Absent,
    )]));
    let dispatches = Dispatches::default();
    let summary =
        recover_accepted_operations(&journal, &receipts, &Validator(false), &dispatches).unwrap();
    assert_eq!(summary.deferred, vec![operation_id]);
    assert!(dispatches.0.lock().unwrap().is_empty());
}
