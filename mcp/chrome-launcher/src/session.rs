//! Extension self-install session: copy the extension to a Windows-local path, launch the
//! native pipe-helper in the INTERACTIVE session (schtasks /IT so the window is visible), and
//! poll for its ready line. Ported from chrome_launcher.py `_copy_extension_to_windows`,
//! `_run_windows_node_interactive`, `load_extension`, `start_extension_session`.
//!
//! Difference from the Python: the pipe owner is now `chrome-launcher-helper.exe` (a Rust bin),
//! not `node.exe pipe_session.mjs`. Everything else — schtasks /IT visibility, the log-file
//! sink, the 40s ready-line poll — is preserved. The schtasks path fires-and-forgets (no child
//! handle), so there is no `proc` to guard, unlike the Python fallback.

use crate::backend::{LauncherError, SessionResult};
use crate::wsl_windows::wslpath_w;
use serde::Serialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const POWERSHELL_PATH: &str = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const SCHTASKS_PATH: &str = "/mnt/c/Windows/System32/schtasks.exe";
const CHROME_PATH: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
const CHROME_DEBUG_HOST: &str = "192.168.176.1";
const CHROME_DEBUG_PORT: u16 = 9223;

/// The WSL-reachable CDP endpoint the relay exposes (via the 9223->9222 portproxy).
fn session_ws_url() -> String {
    format!("ws://{CHROME_DEBUG_HOST}:{CHROME_DEBUG_PORT}")
}

#[derive(Serialize)]
struct LaunchRequest<'a> {
    chrome_exe: &'a str,
    user_data_dir: &'a str,
    extension_path: &'a str,
    ws_port: u16,
}

fn launch_request_json(
    chrome_exe: &str,
    user_data_dir: &str,
    extension_path: &str,
) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&LaunchRequest {
        chrome_exe,
        user_data_dir,
        extension_path,
        ws_port: 9222,
    })
}

fn invalid_input(field: &'static str, message: impl Into<String>) -> LauncherError {
    LauncherError::Cdp {
        stage: "input_validation",
        message: format!("{field}: {}", message.into()),
    }
}

fn validate_batch_literal(field: &'static str, value: &str) -> Result<(), LauncherError> {
    if value.is_empty() {
        return Err(invalid_input(field, "must not be empty"));
    }
    if value.chars().any(|c| {
        matches!(
            c,
            '\r' | '\n' | '"' | '%' | '!' | '&' | '|' | '<' | '>' | '^'
        )
    }) {
        return Err(invalid_input(
            field,
            "contains characters that are unsafe in the trusted batch wrapper",
        ));
    }
    Ok(())
}

fn helper_batch_command(helper_win: &str, request_win: &str) -> Result<String, LauncherError> {
    validate_batch_literal("helper_win", helper_win)?;
    validate_batch_literal("request_win", request_win)?;
    Ok(format!("\"{helper_win}\" --request-file \"{request_win}\""))
}

fn copy_extension_script(request_win: &str) -> String {
    format!(
        "$request=Get-Content -Raw -LiteralPath '{request_win}' | ConvertFrom-Json; \
         $src=[string]$request.source; $dst=Join-Path $env:TEMP 'aj-ext-selfinstall'; \
         if (Test-Path -LiteralPath $dst) {{ Remove-Item -Recurse -Force -LiteralPath $dst }}; \
         Copy-Item -Recurse -Force -LiteralPath $src -Destination $dst; Write-Output $dst"
    )
}

/// Copy an unpacked extension dir to a Windows-local temp path (`%TEMP%\aj-ext-selfinstall`).
/// Chrome loads extensions unreliably from `\\wsl.localhost` UNC paths; a local copy is
/// reliable. Returns the Windows destination path. (chrome_launcher.py `_copy_extension_to_windows`.)
pub async fn copy_extension_to_windows(ext_dir_posix: &str) -> Result<String, LauncherError> {
    let is_windows_path = ext_dir_posix.starts_with("\\\\")
        || (ext_dir_posix.len() > 1 && ext_dir_posix.as_bytes()[1] == b':');
    let src_arg = if is_windows_path {
        ext_dir_posix.to_string()
    } else {
        wslpath_w(ext_dir_posix).await?
    };
    let stamp = short_stamp();
    let request_win = format!(r"C:\temp\aj-copy-request-{stamp}.json");
    let request_wsl = format!("/mnt/c/temp/aj-copy-request-{stamp}.json");
    tokio::fs::create_dir_all("/mnt/c/temp")
        .await
        .map_err(|e| LauncherError::Process {
            stage: "copy_request_dir",
            source: e,
        })?;
    let request = serde_json::to_vec(&serde_json::json!({ "source": src_arg }))
        .map_err(|e| invalid_input("extension_dir", format!("cannot serialize path: {e}")))?;
    tokio::fs::write(&request_wsl, request)
        .await
        .map_err(|e| LauncherError::Process {
            stage: "copy_request_write",
            source: e,
        })?;
    let ps = copy_extension_script(&request_win);
    let output = Command::new(POWERSHELL_PATH)
        .args(["-NoProfile", "-Command", &ps])
        .output()
        .await;
    let _ = tokio::fs::remove_file(&request_wsl).await;
    let out = output.map_err(|e| LauncherError::Process {
        stage: "copy_extension",
        source: e,
    })?;
    let dst = String::from_utf8_lossy(&out.stdout)
        .lines()
        .last()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if out.status.success() && !dst.is_empty() {
        Ok(dst)
    } else {
        Err(LauncherError::Process {
            stage: "copy_extension",
            source: std::io::Error::new(
                std::io::ErrorKind::Other,
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ),
        })
    }
}

/// Launch a Windows command in the INTERACTIVE Console session via schtasks /IT (so its child
/// Chrome is VISIBLE), redirecting output to `log_win`. (chrome_launcher.py
/// `_run_windows_node_interactive` — the schtasks visibility fix.)
async fn run_interactive(
    helper_win: &str,
    request_win: &str,
    log_win: &str,
) -> Result<(), LauncherError> {
    // Write the command to a .bat and point schtasks /TR at the .bat — NOT an inline
    // `cmd /c "..."`. The inline form triple-nests quotes (cmd /c "  helper.exe "chrome" ...  >
    // "log" 2>&1 ") which schtasks/cmd parse wrong, silently breaking the helper invocation or
    // the redirect (investigations/rust-helper-cdp-pipe-oneway.md — the .bat form works in every
    // manual repro, the inline form fails). The .bat holds the exact command + redirect verbatim.
    let cmdline = helper_batch_command(helper_win, request_win)?;
    let stamp = short_stamp();
    let bat_win = format!(r"C:\temp\aj-session-run-{stamp}.bat");
    let bat_wsl = format!("/mnt/c/temp/aj-session-run-{stamp}.bat");
    let _ = tokio::fs::create_dir_all("/mnt/c/temp").await;
    let bat_body = format!("@echo off\r\n{cmdline} > \"{log_win}\" 2>&1\r\n");
    tokio::fs::write(&bat_wsl, bat_body.as_bytes())
        .await
        .map_err(|e| LauncherError::Process {
            stage: "write_bat",
            source: e,
        })?;
    let task_name = format!("AjExtSession_{stamp}");
    let create = Command::new(SCHTASKS_PATH)
        .args([
            "/Create", "/TN", &task_name, "/TR", &bat_win, "/SC", "ONCE", "/ST", "23:59", "/F",
            "/RL", "LIMITED", "/IT",
        ])
        .output()
        .await
        .map_err(|e| LauncherError::Process {
            stage: "schtasks_create",
            source: e,
        })?;
    if !create.status.success() {
        return Err(LauncherError::Process {
            stage: "schtasks_create",
            source: std::io::Error::new(
                std::io::ErrorKind::Other,
                String::from_utf8_lossy(&create.stderr).trim().to_string(),
            ),
        });
    }
    let run = Command::new(SCHTASKS_PATH)
        .args(["/Run", "/TN", &task_name])
        .output()
        .await
        .map_err(|e| LauncherError::Process {
            stage: "schtasks_run",
            source: e,
        })?;
    let _ = Command::new(SCHTASKS_PATH)
        .args(["/Delete", "/TN", &task_name, "/F"])
        .output()
        .await;
    if run.status.success() {
        Ok(())
    } else {
        Err(LauncherError::Process {
            stage: "schtasks_run",
            source: std::io::Error::new(
                std::io::ErrorKind::Other,
                String::from_utf8_lossy(&run.stderr).trim().to_string(),
            ),
        })
    }
}

/// Poll `log_path` for the helper's first `{...}` ready line, up to `deadline_secs`.
async fn poll_ready_line(log_path: &str, deadline_secs: u64) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(deadline_secs);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Ok(text) = tokio::fs::read_to_string(log_path).await {
            if let Some(line) = text.lines().map(str::trim).find(|l| l.starts_with('{')) {
                return Some(line.to_string());
            }
        }
    }
    None
}

/// Start a persistent, visible Chrome that already has our extension loaded, driveable over CDP.
/// `helper_win` is the Windows path to `chrome-launcher-helper.exe`. (chrome_launcher.py
/// `start_extension_session`, with the pipe helper being the Rust bin instead of node+mjs.)
pub async fn start_extension_session(
    extension_dir: &str,
    user_data_dir: &str,
    helper_win: &str,
) -> Result<SessionResult, LauncherError> {
    let ext_win = copy_extension_to_windows(extension_dir).await?;

    // The helper runs on Windows in an schtasks Console session; it must redirect its output to
    // a WINDOWS-LOCAL path. A `\\wsl.localhost\...` UNC target is unwritable from a Windows
    // process ("UNC paths are not supported. Defaulting to Windows directory."), so the ready
    // line never lands and the poll times out. Write the log under C:\temp and poll it via the
    // /mnt/c mirror. (Same lesson as the U8 target-dir: never hand a Windows process a \\wsl path.)
    let stamp = short_stamp();
    let log_win = format!(r"C:\temp\aj-session-{stamp}.log");
    let log_path = format!("/mnt/c/temp/aj-session-{stamp}.log");
    let _ = tokio::fs::create_dir_all("/mnt/c/temp").await;
    let _ = tokio::fs::write(&log_path, b"").await; // ensure the file exists for polling

    // Caller-controlled values are serialized into JSON and parsed by the native helper. The
    // batch wrapper contains only the trusted helper path and a generated request-file path.
    let request_win = format!(r"C:\temp\aj-session-request-{stamp}.json");
    let request_path = format!("/mnt/c/temp/aj-session-request-{stamp}.json");
    let request = launch_request_json(CHROME_PATH, user_data_dir, &ext_win)
        .map_err(|e| invalid_input("session_request", format!("cannot serialize request: {e}")))?;
    tokio::fs::write(&request_path, request)
        .await
        .map_err(|e| LauncherError::Process {
            stage: "session_request_write",
            source: e,
        })?;
    if let Err(error) = run_interactive(helper_win, &request_win, &log_win).await {
        let _ = tokio::fs::remove_file(&request_path).await;
        return Err(error);
    }

    let line_result = poll_ready_line(&log_path, 40)
        .await
        .ok_or_else(|| LauncherError::Timeout {
            stage: "session",
            message: format!("no ready line from pipe helper (log: {log_path})"),
        });
    let _ = tokio::fs::remove_file(&request_path).await;
    let line = line_result?;
    let parsed: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| LauncherError::Cdp {
            stage: "session_parse",
            message: format!("bad ready line: {e}"),
        })?;
    if parsed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(LauncherError::Cdp {
            stage: "session",
            message: parsed
                .get("error")
                .map(|e| e.to_string())
                .unwrap_or_else(|| "helper reported not-ok".into()),
        });
    }
    Ok(SessionResult {
        web_socket_debugger_url: session_ws_url(),
        id: parsed["id"].as_str().unwrap_or("").to_string(),
        name: parsed["name"].as_str().unwrap_or("").to_string(),
        version: parsed["version"].as_str().unwrap_or("").to_string(),
        launch: "interactive (schtasks /IT)".to_string(),
    })
}

/// `load_extension` — install into a profile via a short-lived helper run. Same helper, invoked
/// non-interactively (it exits after loadUnpacked). Returns the identity. For U5 this shares the
/// session path's copy + helper invocation but does not need the visible interactive session.
pub async fn load_extension(
    extension_dir: &str,
    user_data_dir: &str,
    helper_win: &str,
) -> Result<SessionResult, LauncherError> {
    // load_extension differs from start_extension_session only in that it does not need to stay
    // alive / be visible — but reusing the same self-install helper keeps one code path. The
    // helper prints the same identity line; we return it.
    start_extension_session(extension_dir, user_data_dir, helper_win).await
}

fn short_stamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ws_url_uses_portproxy_host() {
        assert_eq!(session_ws_url(), "ws://192.168.176.1:9223");
    }

    #[test]
    fn short_stamp_is_hex() {
        assert!(short_stamp().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hostile_session_values_are_serialized_as_data_not_batch_syntax() {
        let hostile_profile = r#"C:\safe\" & echo AJ_CMD_INJECTION_SENTINEL & rem \""#;
        let hostile_extension = "C:\\safe'; Write-Output AJ_PS_INJECTION_SENTINEL; #";
        let request = launch_request_json(CHROME_PATH, hostile_profile, hostile_extension)
            .expect("serialize launch request");
        let decoded: serde_json::Value = serde_json::from_slice(&request).unwrap();
        assert_eq!(decoded["user_data_dir"], hostile_profile);
        assert_eq!(decoded["extension_path"], hostile_extension);

        let command = helper_batch_command(
            r"C:\temp\chrome-launcher-helper.exe",
            r"C:\temp\aj-session-request-deadbeef.json",
        )
        .expect("safe internal command");
        assert!(!command.contains("AJ_CMD_INJECTION_SENTINEL"));
        assert!(!command.contains("AJ_PS_INJECTION_SENTINEL"));
        assert!(command.contains("--request-file"));
    }

    #[test]
    fn helper_batch_command_rejects_command_language_characters() {
        for unsafe_path in [
            "C:\\helper.exe\r\necho injected",
            "C:\\helper.exe\" & echo injected & rem \"",
            "C:\\%COMSPEC%\\helper.exe",
        ] {
            assert!(
                helper_batch_command(unsafe_path, r"C:\temp\aj-session-request-deadbeef.json")
                    .is_err()
            );
        }
    }

    #[test]
    fn helper_batch_command_allows_common_windows_path_characters() {
        let command = helper_batch_command(
            r"C:\Program Files (x86)\actions.json\chrome-launcher-helper.exe",
            r"C:\temp\aj-session-request-deadbeef.json",
        )
        .expect("parentheses are valid in a quoted batch path outside block syntax");
        assert!(command.contains("Program Files (x86)"));
    }

    #[test]
    fn copy_script_reads_caller_path_from_json_request() {
        let script = copy_extension_script(r"C:\temp\aj-copy-request-deadbeef.json");
        assert!(script.contains("ConvertFrom-Json"));
        assert!(script.contains("$request.source"));
        assert!(!script.contains("AJ_PS_INJECTION_SENTINEL"));
    }

    #[tokio::test]
    async fn poll_ready_line_finds_json_line() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("s.log");
        tokio::fs::write(&log, "starting...\n{\"ok\":true,\"id\":\"x\"}\n")
            .await
            .unwrap();
        let line = poll_ready_line(log.to_str().unwrap(), 2).await;
        assert_eq!(line.as_deref(), Some("{\"ok\":true,\"id\":\"x\"}"));
    }

    #[tokio::test]
    async fn poll_ready_line_times_out_when_no_json() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("s.log");
        tokio::fs::write(&log, "no json here\n").await.unwrap();
        assert!(poll_ready_line(log.to_str().unwrap(), 1).await.is_none());
    }
}
