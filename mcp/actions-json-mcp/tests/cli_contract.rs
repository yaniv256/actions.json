use std::{
    io::Write,
    process::{Command, Stdio},
};

use serde_json::Value;
use tempfile::TempDir;

fn run(arguments: &[&str], stdin: &str) -> (i32, String, String) {
    let state = TempDir::new().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(state.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .args(arguments)
        .env("ACTIONS_JSON_STATE_DIR", state.path())
        .env("ACTIONS_JSON_RESIDENT_SUPERVISOR", "direct")
        .env("HOME", state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

fn run_in(
    state: &TempDir,
    manifest: &std::path::Path,
    arguments: &[&str],
    stdin: &str,
) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .args(arguments)
        .env("ACTIONS_JSON_STATE_DIR", state.path())
        .env("ACTIONS_JSON_ACTIONS", manifest)
        .env("ACTIONS_JSON_BIND", "127.0.0.1:0")
        .env("ACTIONS_JSON_RESIDENT_SUPERVISOR", "direct")
        .env("HOME", state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

#[cfg(target_os = "linux")]
fn run_in_managed(
    state: &TempDir,
    manifest: &std::path::Path,
    arguments: &[&str],
) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .args(arguments)
        .env("ACTIONS_JSON_STATE_DIR", state.path())
        .env("ACTIONS_JSON_ACTIONS", manifest)
        .env("ACTIONS_JSON_BIND", "127.0.0.1:0")
        .env_remove("ACTIONS_JSON_RESIDENT_SUPERVISOR")
        .env("HOME", state.path())
        .output()
        .unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

fn run_with_install_config(
    config_home: &std::path::Path,
    arguments: &[&str],
) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .args(arguments)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", config_home)
        .env("ACTIONS_JSON_RESIDENT_SUPERVISOR", "direct")
        .output()
        .unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

#[test]
fn malformed_bare_input_is_json_only_and_uses_invalid_input_exit() {
    let (code, stdout, stderr) = run(&[], "not json");
    assert_eq!(code, 2);
    assert!(stderr.is_empty());
    let value: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(value["protocol_version"], 1);
    assert_eq!(value["outcome"], "invalid_input");
    assert_eq!(value["operation_id"], Value::Null);
    assert_eq!(value["request_id"], Value::Null);
    assert_eq!(value["status"], "terminal");
}

#[test]
fn protocol_v1_rejects_unknown_fields_before_resident_start() {
    let input = r#"{"protocol_version":1,"operation":"browser.read","arguments":{},"future":true}"#;
    let (code, stdout, stderr) = run(&[], input);
    assert_eq!(code, 2);
    assert!(stderr.is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap()["error"]["code"],
        "invalid_envelope"
    );
}

#[test]
fn shorthand_requires_an_arguments_object() {
    let (code, stdout, stderr) = run(&["browser.read"], "[]");
    assert_eq!(code, 2);
    assert!(stderr.is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap()["error"]["code"],
        "invalid_arguments"
    );
}

#[test]
fn status_is_bounded_json_and_quiet() {
    let (code, stdout, stderr) = run(&["status"], "");
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["result"]["paired"], false);
    assert!(stdout.len() < 4096);
}

#[test]
fn doctor_is_distinct_bounded_redacted_and_reports_exact_check_codes() {
    let (code, stdout, stderr) = run(&["doctor"], "");
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    assert!(stdout.len() < 8192);
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(value["result"]["diagnostic"], "doctor");
    assert_eq!(value["result"]["bounded"], true);
    assert_eq!(value["result"]["redacted"], true);
    assert_eq!(value["result"]["healthy"], false);
    assert_eq!(
        value["result"]["installation"]["code"],
        "installed_executable_ready"
    );
    assert_eq!(value["result"]["state"]["code"], "state_directory_ready");
    assert_eq!(value["result"]["pairing"]["code"], "pairing_not_configured");
    assert_eq!(value["result"]["pairing"]["secret"], Value::Null);
    assert_eq!(value["result"]["resident"]["code"], "resident_not_running");
    assert_eq!(
        value["result"]["runtime"]["code"],
        "runtime_check_not_available"
    );
}

#[test]
fn installed_config_is_used_without_shell_environment_or_secret_disclosure() {
    let root = TempDir::new().unwrap();
    let config_dir = root.path().join(".actions-json");
    let state_dir = root.path().join("state");
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::create_dir_all(&state_dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(
        config_dir.join("config.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "state_dir": state_dir,
            "bind": "127.0.0.1:18456"
        }))
        .unwrap(),
    )
    .unwrap();

    let (code, stdout, stderr) = run_with_install_config(root.path(), &["doctor"]);
    assert_eq!(code, 0, "{stdout} {stderr}");
    assert!(stderr.is_empty());
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["result"]["configuration"]["ok"], true);
    assert_eq!(value["result"]["configuration"]["source"], "config_file");
    assert_eq!(value["result"]["configuration"]["bind"], "127.0.0.1:18456");
    assert_eq!(value["result"]["pairing"]["secret"], Value::Null);
}

#[test]
fn doctor_reports_ready_resident_without_exposing_runtime_urls_or_pairing_secret() {
    let state = TempDir::new().unwrap();
    let manifest = state.path().join("actions.json");
    std::fs::write(&manifest, r#"{"protocol":"actions.json","tools":[]}"#).unwrap();
    let (code, created, stderr) = run_in(
        &state,
        &manifest,
        &["pair", "create", "--reveal-secret"],
        "",
    );
    assert_eq!(code, 0, "{created} {stderr}");
    let secret = serde_json::from_str::<Value>(&created).unwrap()["result"]["secret"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, stdout, stderr) = run_in(
        &state,
        &manifest,
        &["profile", "create", "--name", "doctor-probe"],
        "",
    );
    assert_eq!(code, 0, "{stdout} {stderr}");

    let (code, stdout, stderr) = run_in(&state, &manifest, &["doctor"], "");
    assert_eq!(code, 0, "{stdout} {stderr}");
    assert!(stderr.is_empty());
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["result"]["pairing"]["code"], "pairing_configured");
    assert_eq!(value["result"]["resident"]["code"], "resident_ready");
    assert_eq!(value["result"]["runtime"]["code"], "runtime_not_connected");
    assert!(!stdout.contains(&secret));
    assert!(!stdout.contains("url"));

    let (code, _, _) = run_in(&state, &manifest, &["shutdown"], "");
    assert_eq!(code, 0);
}

#[test]
fn pairing_is_noninteractive_and_secret_is_explicitly_disclosed() {
    let (code, stdout, stderr) = run(&["pair", "create"], "");
    assert_eq!(code, 0);
    assert!(stderr.is_empty());
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["result"]["paired"], true);
    assert_eq!(value["result"]["secret"], Value::Null);

    let (code, stdout, _) = run(&["pair", "create", "--reveal-secret"], "");
    assert_eq!(code, 0);
    assert!(
        serde_json::from_str::<Value>(&stdout).unwrap()["result"]["secret"]
            .as_str()
            .unwrap()
            .starts_with("ajhs_")
    );
}

#[test]
fn resident_backed_profile_lifecycle_and_redacted_audit_use_cli_adapter() {
    let state = TempDir::new().unwrap();
    let manifest = state.path().join("actions.json");
    std::fs::write(&manifest, r#"{"protocol":"actions.json","tools":[]}"#).unwrap();
    let (code, stdout, stderr) = run_in(
        &state,
        &manifest,
        &[
            "profile",
            "create",
            "--name",
            "alice",
            "--label",
            "test caller",
        ],
        "",
    );
    assert_eq!(code, 0, "{stdout} {stderr}");
    assert!(stderr.is_empty());
    let created: Value = serde_json::from_str(&stdout).unwrap();
    let token = created
        .pointer("/result/profile/token")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();

    #[cfg(unix)]
    {
        let ready: Value = serde_json::from_str(
            &std::fs::read_to_string(state.path().join("resident.ready.json")).unwrap(),
        )
        .unwrap();
        let pid = ready["pid"].as_u64().unwrap() as libc::pid_t;
        // A durable resident owns a new session. This is the lifecycle boundary
        // that lets it survive the CLI caller and its process-group cleanup.
        assert_eq!(unsafe { libc::getsid(pid) }, pid);
    }

    let (code, stdout, stderr) = run_in(
        &state,
        &manifest,
        &["profile", "inspect", "--name", "alice", "--token", &token],
        "",
    );
    assert_eq!(code, 0, "{stdout} {stderr}");
    assert!(stderr.is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(&stdout)
            .unwrap()
            .pointer("/result/profile/name")
            .and_then(Value::as_str),
        Some("alice")
    );

    let (code, stdout, stderr) = run_in(&state, &manifest, &["logs"], "");
    assert_eq!(code, 0, "{stdout} {stderr}");
    assert!(stderr.is_empty());
    let logs: Value = serde_json::from_str(&stdout).unwrap();
    assert!(logs
        .pointer("/result/bounded")
        .and_then(Value::as_bool)
        .unwrap());
    assert!(logs
        .pointer("/result/entries")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .any(|entry| entry["adapter"] == "cli"));
    assert!(!stdout.contains(&token));

    let (code, _, _) = run_in(&state, &manifest, &["shutdown"], "");
    assert_eq!(code, 0);
}

#[cfg(target_os = "linux")]
#[test]
fn default_linux_supervisor_survives_across_cli_invocations() {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() }))
        });
    if !runtime_dir.join("bus").exists() {
        return;
    }

    let state = TempDir::new().unwrap();
    let manifest = state.path().join("actions.json");
    std::fs::write(&manifest, r#"{"protocol":"actions.json","tools":[]}"#).unwrap();
    let (code, stdout, stderr) = run_in_managed(
        &state,
        &manifest,
        &["profile", "create", "--name", "managed"],
    );
    assert_eq!(code, 0, "{stdout} {stderr}");
    let ready_path = state.path().join("resident.ready.json");
    let first_ready: Value =
        serde_json::from_str(&std::fs::read_to_string(&ready_path).unwrap()).unwrap();
    let first_pid = first_ready["pid"].as_u64().unwrap();
    let cgroup = std::fs::read_to_string(format!("/proc/{first_pid}/cgroup")).unwrap();
    assert!(cgroup.contains("actions-json-resident-"), "{cgroup}");

    let (code, stdout, stderr) = run_in_managed(&state, &manifest, &["doctor"]);
    assert_eq!(code, 0, "{stdout} {stderr}");
    let second_ready: Value =
        serde_json::from_str(&std::fs::read_to_string(&ready_path).unwrap()).unwrap();
    assert_eq!(second_ready["pid"].as_u64(), Some(first_pid));

    let (code, stdout, stderr) = run_in_managed(&state, &manifest, &["shutdown"]);
    assert_eq!(code, 0, "{stdout} {stderr}");
}
