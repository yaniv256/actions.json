use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};
use tempfile::TempDir;

#[test]
fn stream_ignores_blanks_continues_after_malformed_and_accepts_unterminated_final_line() {
    let state = TempDir::new().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .arg("stream")
        .env("ACTIONS_JSON_STATE_DIR", state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Both valid JSON records are protocol-invalid, which exercises ordered
    // continuation without depending on a live browser runtime.
    child.stdin.take().unwrap().write_all(b"\nnot-json\n{\"protocol_version\":2,\"operation\":\"a\",\"arguments\":{}}\n\n{\"protocol_version\":2,\"operation\":\"b\",\"arguments\":{}}").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let lines = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["error"]["code"], "invalid_envelope");
    assert_eq!(lines[1]["error"]["code"], "unsupported_protocol_version");
    assert_eq!(lines[2]["error"]["code"], "unsupported_protocol_version");
}

#[test]
fn stream_bounds_each_record_but_continues_with_later_records() {
    let state = TempDir::new().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .arg("stream")
        .env("ACTIONS_JSON_STATE_DIR", state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = vec![b'x'; actions_json_mcp::cli::MAX_CLI_RECORD_BYTES + 1];
    input.extend_from_slice(
        b"\n{\"protocol_version\":2,\"operation\":\"after-large\",\"arguments\":{}}\n",
    );
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let lines = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["error"]["code"], "payload_too_large");
    assert_eq!(lines[1]["error"]["code"], "unsupported_protocol_version");
}

#[test]
fn bare_run_rejects_an_oversized_record_with_a_stable_error() {
    let state = TempDir::new().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_actions-json-mcp"))
        .arg("run")
        .env("ACTIONS_JSON_STATE_DIR", state.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&vec![b'x'; actions_json_mcp::cli::MAX_CLI_RECORD_BYTES + 1])
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let payload: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(payload["error"]["code"], "payload_too_large");
}
