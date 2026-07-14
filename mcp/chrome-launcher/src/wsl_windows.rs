//! WSL -> Windows launch backend.
//!
//! A straight port of the Python `chrome_launcher.py` orchestration. Chrome runs on Windows;
//! the bridge runs in WSL. `schtasks /IT` lands Chrome in the interactive Console session so it
//! is VISIBLE to the user (a direct WSL->Windows spawn inherits invisible session 0). CDP is
//! reached over a `9223 -> 9222` portproxy.
//!
//! U3 implements `chrome_endpoint` / `chrome_kill` (+ launch/verify/kill/wslpath helpers).
//! `load_extension` / `start_extension_session` (U5) and `claim_tab` (U6) land later.

use crate::backend::{
    BackendFuture, ChromeEndpoint, ClaimResult, LaunchBackend, LauncherError, SessionResult,
};
use serde::Serialize;
use std::time::Duration;
use tokio::process::Command;

// ---- Configuration (mirrors chrome_launcher.py lines 22-42). ----

const CHROME_DEBUG_HOST: &str = "192.168.176.1";
const CHROME_DEBUG_PORT: u16 = 9223; // portproxy forwards 9223 -> 9222
const POWERSHELL_PATH: &str = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const SCHTASKS_PATH: &str = "/mnt/c/Windows/System32/schtasks.exe";
const TASKLIST_PATH: &str = "/mnt/c/Windows/System32/tasklist.exe";
const CHROME_PATH: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
const DEFAULT_USER_DATA: &str = r"C:\temp\chrome-debug";

#[derive(Serialize)]
struct ChromeLaunchRequest<'a> {
    chrome_exe: &'a str,
    user_data_dir: &'a str,
}

fn invalid_input(field: &'static str, message: impl Into<String>) -> LauncherError {
    LauncherError::Cdp {
        stage: "input_validation",
        message: format!("{field}: {}", message.into()),
    }
}

fn validate_task_literal(field: &'static str, value: &str) -> Result<(), LauncherError> {
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
            "contains characters that are unsafe in the trusted task wrapper",
        ));
    }
    Ok(())
}

fn chrome_launch_request_json(
    chrome_exe: &str,
    user_data_dir: &str,
) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&ChromeLaunchRequest {
        chrome_exe,
        user_data_dir,
    })
}

fn chrome_launch_task_action(script_win: &str) -> Result<String, LauncherError> {
    validate_task_literal("script_win", script_win)?;
    Ok(format!(
        r#""C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{script_win}""#
    ))
}

fn chrome_launch_script(request_win: &str, script_win: &str) -> String {
    format!(
        "$requestPath='{request_win}'; \
         $scriptPath='{script_win}'; \
         try {{ \
             $request=Get-Content -Raw -LiteralPath $requestPath | ConvertFrom-Json; \
             Remove-Item -Force -LiteralPath $requestPath -ErrorAction SilentlyContinue; \
             $chromeArgs=@('--remote-debugging-port=9222','--remote-allow-origins=*','--enable-unsafe-extension-debugging',('--user-data-dir='+[string]$request.user_data_dir),'--start-maximized'); \
             Start-Process -FilePath ([string]$request.chrome_exe) -ArgumentList $chromeArgs; \
         }} finally {{ \
             Remove-Item -Force -LiteralPath $scriptPath -ErrorAction SilentlyContinue; \
         }}"
    )
}

async fn write_chrome_launch_files(
    stamp: &str,
    user_data_dir: &str,
) -> Result<(String, String, String, String), LauncherError> {
    let request_win = format!(r"C:\temp\aj-chrome-launch-request-{stamp}.json");
    let request_wsl = format!("/mnt/c/temp/aj-chrome-launch-request-{stamp}.json");
    let script_win = format!(r"C:\temp\aj-chrome-launch-{stamp}.ps1");
    let script_wsl = format!("/mnt/c/temp/aj-chrome-launch-{stamp}.ps1");
    tokio::fs::create_dir_all("/mnt/c/temp")
        .await
        .map_err(|e| LauncherError::Process {
            stage: "launch_request_dir",
            source: e,
        })?;
    let request = chrome_launch_request_json(CHROME_PATH, user_data_dir).map_err(|e| {
        invalid_input(
            "chrome_launch_request",
            format!("cannot serialize request: {e}"),
        )
    })?;
    tokio::fs::write(&request_wsl, request)
        .await
        .map_err(|e| LauncherError::Process {
            stage: "launch_request_write",
            source: e,
        })?;
    tokio::fs::write(&script_wsl, chrome_launch_script(&request_win, &script_win))
        .await
        .map_err(|e| LauncherError::Process {
            stage: "launch_script_write",
            source: e,
        })?;
    Ok((request_wsl, script_win, script_wsl, request_win))
}
/// The WSL -> Windows backend. Holds the Chrome profile dir it operates on and the Windows path
/// to the pipe helper binary (`chrome-launcher-helper.exe`).
pub struct WslWindowsBackend {
    user_data_dir: String,
    /// Windows path to chrome-launcher-helper.exe (used by load_extension/start_extension_session).
    helper_win: Option<String>,
}

impl Default for WslWindowsBackend {
    fn default() -> Self {
        Self {
            user_data_dir: DEFAULT_USER_DATA.to_string(),
            helper_win: None,
        }
    }
}

impl WslWindowsBackend {
    /// Backend using a specific Chrome `--user-data-dir` (Windows path).
    pub fn with_user_data_dir(user_data_dir: impl Into<String>) -> Self {
        Self {
            user_data_dir: user_data_dir.into(),
            helper_win: None,
        }
    }

    /// Set the Windows path to chrome-launcher-helper.exe (required for the session tools).
    pub fn with_helper(mut self, helper_win: impl Into<String>) -> Self {
        self.helper_win = Some(helper_win.into());
        self
    }

    /// GET /json/version off the debug endpoint. Returns None when Chrome isn't reachable.
    async fn get_endpoint_raw(&self) -> Option<serde_json::Value> {
        let url = format!("http://{CHROME_DEBUG_HOST}:{CHROME_DEBUG_PORT}/json/version");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;
        let resp = client.get(&url).send().await.ok()?;
        resp.json::<serde_json::Value>().await.ok()
    }

    /// tasklist /v -> is any chrome.exe in the interactive Console session?
    /// (chrome_launcher.py `_verify_visible_session`.)
    async fn verify_visible_session(&self) -> (bool, String) {
        let out = Command::new(TASKLIST_PATH)
            .args(["/v", "/fi", "IMAGENAME eq chrome.exe", "/fo", "csv", "/nh"])
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                if s.contains("Console") {
                    (true, "Console".into())
                } else if s.contains("Services") {
                    (false, "Services".into())
                } else {
                    (false, "no chrome found".into())
                }
            }
            Ok(_) => (false, "tasklist failed".into()),
            Err(e) => (false, format!("check failed: {e}")),
        }
    }

    /// Launch Chrome via schtasks /IT (visible, interactive session), Start-Process fallback.
    /// (chrome_launcher.py `_launch_chrome`.)
    async fn launch_chrome(&self) -> Result<String, LauncherError> {
        let stamp = short_stamp();
        let (request_wsl, script_win, script_wsl, _request_win) =
            write_chrome_launch_files(&stamp, &self.user_data_dir).await?;

        // Primary: schtasks /IT — runs in the logged-in user's interactive session.
        let task_name = format!("ChromeLauncher_{stamp}");
        let chrome_cmd = chrome_launch_task_action(&script_win)?;
        let create = Command::new(SCHTASKS_PATH)
            .args([
                "/Create",
                "/TN",
                &task_name,
                "/TR",
                &chrome_cmd,
                "/SC",
                "ONCE",
                "/ST",
                "23:59",
                "/F",
                "/RL",
                "LIMITED",
                "/IT",
            ])
            .output()
            .await
            .map_err(|e| LauncherError::Process {
                stage: "schtasks_create",
                source: e,
            })?;
        if create.status.success() {
            let run = Command::new(SCHTASKS_PATH)
                .args(["/Run", "/TN", &task_name])
                .output()
                .await
                .map_err(|e| LauncherError::Process {
                    stage: "schtasks_run",
                    source: e,
                })?;
            // Cleanup the task entry; chrome.exe keeps running independently.
            let _ = Command::new(SCHTASKS_PATH)
                .args(["/Delete", "/TN", &task_name, "/F"])
                .output()
                .await;
            if run.status.success() {
                return Ok("OK (schtasks /IT — interactive session)".into());
            }
        }

        // Fallback: Start-Process (session 0; only if no interactive desktop is logged in).
        let result = Command::new(POWERSHELL_PATH)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script_win,
            ])
            .output()
            .await
            .map_err(|e| LauncherError::Process {
                stage: "start_process",
                source: e,
            })?;
        if result.status.success() {
            return Ok("OK (Start-Process — fallback, may be session 0)".into());
        }
        let _ = tokio::fs::remove_file(&request_wsl).await;
        let _ = tokio::fs::remove_file(&script_wsl).await;
        Err(LauncherError::Process {
            stage: "launch_all_failed",
            source: std::io::Error::new(std::io::ErrorKind::Other, "all launch paths failed"),
        })
    }
}

impl LaunchBackend for WslWindowsBackend {
    fn chrome_endpoint(&self) -> BackendFuture<'_, ChromeEndpoint> {
        Box::pin(async move {
            // Already running?
            if let Some(data) = self.get_endpoint_raw().await {
                return endpoint_from_raw(&data, true).ok_or_else(|| LauncherError::Cdp {
                    stage: "endpoint_parse",
                    message: "no webSocketDebuggerUrl in /json/version".into(),
                });
            }
            // Not running — launch, wait for Task Scheduler, re-query.
            self.launch_chrome().await?;
            tokio::time::sleep(Duration::from_secs(5)).await;
            let data = self
                .get_endpoint_raw()
                .await
                .ok_or_else(|| LauncherError::Timeout {
                    stage: "post_launch_connect",
                    message: "launched Chrome but cannot connect (check 9223->9222 portproxy)"
                        .into(),
                })?;
            let (visible, _session) = self.verify_visible_session().await;
            endpoint_from_raw(&data, visible).ok_or_else(|| LauncherError::Cdp {
                stage: "endpoint_parse",
                message: "no webSocketDebuggerUrl after launch".into(),
            })
        })
    }

    fn chrome_kill(&self) -> BackendFuture<'_, ()> {
        Box::pin(async move {
            let _ = Command::new(POWERSHELL_PATH)
                .args([
                    "-Command",
                    "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue",
                ])
                .output()
                .await
                .map_err(|e| LauncherError::Process {
                    stage: "kill",
                    source: e,
                })?;
            tokio::time::sleep(Duration::from_secs(1)).await;
            // Verify it's gone; if still responding, that's a soft warning, not an error.
            if self.get_endpoint_raw().await.is_some() {
                return Err(LauncherError::Cdp {
                    stage: "kill_verify",
                    message: "kill command sent but Chrome still responding".into(),
                });
            }
            Ok(())
        })
    }

    fn load_extension<'a>(
        &'a self,
        extension_dir: &'a str,
        user_data_dir: &'a str,
    ) -> BackendFuture<'a, SessionResult> {
        Box::pin(async move {
            let helper = self
                .helper_win
                .as_deref()
                .ok_or(LauncherError::MissingDependency(
                    "helper path not set (WslWindowsBackend::with_helper)".into(),
                ))?;
            crate::session::load_extension(extension_dir, user_data_dir, helper).await
        })
    }

    fn start_extension_session<'a>(
        &'a self,
        extension_dir: &'a str,
        user_data_dir: &'a str,
    ) -> BackendFuture<'a, SessionResult> {
        Box::pin(async move {
            let helper = self
                .helper_win
                .as_deref()
                .ok_or(LauncherError::MissingDependency(
                    "helper path not set (WslWindowsBackend::with_helper)".into(),
                ))?;
            crate::session::start_extension_session(extension_dir, user_data_dir, helper).await
        })
    }

    fn claim_tab<'a>(
        &'a self,
        cdp_ws_url: &'a str,
        extension_id: &'a str,
        target_url_contains: &'a str,
        bridge_url: &'a str,
    ) -> BackendFuture<'a, ClaimResult> {
        Box::pin(async move {
            crate::claim::claim_tab(cdp_ws_url, extension_id, target_url_contains, bridge_url).await
        })
    }
}

/// WSL posix path -> Windows path via `wslpath -w` (chrome_launcher.py `_wslpath_w`).
pub async fn wslpath_w(posix_path: &str) -> Result<String, LauncherError> {
    let out = Command::new("wslpath")
        .args(["-w", posix_path])
        .output()
        .await
        .map_err(|e| LauncherError::Process {
            stage: "wslpath",
            source: e,
        })?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Build a `ChromeEndpoint` from a raw `/json/version` JSON body.
fn endpoint_from_raw(data: &serde_json::Value, visible: bool) -> Option<ChromeEndpoint> {
    let ws = data.get("webSocketDebuggerUrl")?.as_str()?.to_string();
    let browser = data
        .get("Browser")
        .and_then(|b| b.as_str())
        .unwrap_or("unknown")
        .to_string();
    Some(ChromeEndpoint {
        web_socket_debugger_url: ws,
        browser,
        visible,
    })
}

/// A short unique-ish stamp for task names (chrome_launcher.py used uuid4 hex[:8]).
fn short_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
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
    fn endpoint_from_raw_parses_ws_and_browser() {
        let raw = serde_json::json!({
            "Browser": "Chrome/150.0.7871.100",
            "webSocketDebuggerUrl": "ws://192.168.176.1:9223/devtools/browser/abc"
        });
        let ep = endpoint_from_raw(&raw, true).expect("parse");
        assert_eq!(ep.browser, "Chrome/150.0.7871.100");
        assert!(ep.web_socket_debugger_url.contains("/devtools/browser/"));
        assert!(ep.visible);
    }

    #[test]
    fn endpoint_from_raw_missing_ws_is_none() {
        let raw = serde_json::json!({ "Browser": "Chrome/1" });
        assert!(endpoint_from_raw(&raw, true).is_none());
    }

    #[test]
    fn endpoint_from_raw_defaults_unknown_browser() {
        let raw = serde_json::json!({ "webSocketDebuggerUrl": "ws://x" });
        let ep = endpoint_from_raw(&raw, false).unwrap();
        assert_eq!(ep.browser, "unknown");
        assert!(!ep.visible);
    }

    #[test]
    fn short_stamp_is_hex() {
        let s = short_stamp();
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn chrome_launch_task_action_keeps_profile_path_out_of_command_source() {
        let hostile_profile = r#"C:\safe\" & echo AJ_WSL_CMD_INJECTION_SENTINEL & rem \""#;
        let request = chrome_launch_request_json(CHROME_PATH, hostile_profile)
            .expect("serialize chrome launch request");
        let decoded: serde_json::Value = serde_json::from_slice(&request).unwrap();
        assert_eq!(decoded["user_data_dir"], hostile_profile);

        let action = chrome_launch_task_action(r"C:\temp\aj-launch-deadbeef.ps1")
            .expect("trusted generated script path");
        assert!(action.contains("powershell.exe"));
        assert!(action.contains("-File"));
        assert!(!action.contains(hostile_profile));
        assert!(!action.contains("AJ_WSL_CMD_INJECTION_SENTINEL"));
    }

    #[test]
    fn chrome_launch_task_action_allows_common_windows_path_characters() {
        let action = chrome_launch_task_action(r"C:\Program Files (x86)\actions.json\launch.ps1")
            .expect("parentheses are valid in a quoted task action path");
        assert!(action.contains("Program Files (x86)"));
    }

    #[test]
    fn chrome_launch_script_reads_profile_path_from_json_request() {
        let script = chrome_launch_script(
            r"C:\temp\aj-launch-request-deadbeef.json",
            r"C:\temp\aj-launch-deadbeef.ps1",
        );
        assert!(script.contains("ConvertFrom-Json"));
        assert!(script.contains("$request.user_data_dir"));
        assert!(!script.contains("AJ_WSL_CMD_INJECTION_SENTINEL"));
    }
}
