//! Bridge glue for the chrome-launcher crate: the 5 launch/control tools exposed as native
//! MCP tools of the actions.json MCP (U7, plan 2026-07-08-001). Tool names + arg shapes match
//! the former Python chrome-launcher MCP so consumers (the eval harness, agent configs) are
//! drop-in.
//!
//! The manifests are collected into `tools/list`; `dispatch` routes a `tools/call` for one of
//! these names to the crate's `WslWindowsBackend` and returns the JSON output. The heavy
//! launch/pipe logic lives in the crate — this file is thin wiring only.

use chrome_launcher::{LaunchBackend, WslWindowsBackend};
use serde_json::{json, Value};

/// Default Chrome profile for the self-install session when the caller omits user_data_dir.
/// Matches the former Python MCP's default; MUST be a real Windows path, never "".
const DEFAULT_SESSION_PROFILE: &str = r"C:\temp\chrome-debug-session";

/// The 5 tool manifests, for inclusion in `tools/list`.
pub fn tool_manifests() -> Vec<Value> {
    vec![
        json!({
            "name": "chrome_endpoint",
            "description": "Launch (or reuse) a VISIBLE Chrome with remote debugging and return its CDP webSocketDebuggerUrl. On WSL, lands Chrome in the interactive Console session (schtasks /IT) so the window is visible. No arguments.",
            "input_schema": { "type": "object", "additionalProperties": false, "properties": {} }
        }),
        json!({
            "name": "chrome_kill",
            "description": "Stop all Chrome processes the launcher controls. No arguments.",
            "input_schema": { "type": "object", "additionalProperties": false, "properties": {} }
        }),
        json!({
            "name": "load_extension",
            "description": "Install our unpacked extension into a Chrome profile via Extensions.loadUnpacked (no human click). Identity is verified by manifest name.",
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "extension_dir": { "type": "string", "description": "Unpacked extension dir (WSL posix or Windows path)." },
                    "user_data_dir": { "type": "string", "description": "Chrome profile to install into (default the visible driving profile)." }
                },
                "required": ["extension_dir"]
            }
        }),
        json!({
            "name": "start_extension_session",
            "description": "Launch a persistent, VISIBLE Chrome that already has our extension loaded and is driveable over CDP — the self-install + drive-same-instance flow, no human clicks. Returns webSocketDebuggerUrl + verified identity.",
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "extension_dir": { "type": "string", "description": "Unpacked extension dir (WSL posix or Windows path)." },
                    "user_data_dir": { "type": "string", "description": "Chrome profile for the session." }
                },
                "required": ["extension_dir"]
            }
        }),
        json!({
            "name": "claim_tab",
            "description": "Drive the extension's headless authorize path so a runtime registers on the bridge — take control of a tab with no popup click. Pass the exact extension id returned by start_extension_session/load_extension; unpacked ids are installation-specific.",
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "cdp_ws_url": { "type": "string", "description": "CDP WebSocket URL of the Chrome to drive." },
                    "extension_id": { "type": "string", "pattern": "^[a-p]{32}$", "description": "Exact installed extension id returned by start_extension_session or load_extension." },
                    "target_url_contains": { "type": "string", "description": "Substring of the tab URL to claim." },
                    "bridge_url": { "type": "string", "description": "Bridge WS the extension should connect to." }
                },
                "required": ["cdp_ws_url", "extension_id", "target_url_contains", "bridge_url"]
            }
        }),
    ]
}

/// True if `name` is one of the chrome-launcher tools.
pub fn is_chrome_launcher_tool(name: &str) -> bool {
    matches!(
        name,
        "chrome_endpoint" | "chrome_kill" | "load_extension" | "start_extension_session" | "claim_tab"
    )
}

/// Build a backend for a call. `helper_win` is the Windows path to chrome-launcher-helper.exe,
/// resolved from config/env by the caller. `user_data_dir` overrides the profile when provided.
fn backend(helper_win: Option<&str>, user_data_dir: Option<&str>) -> WslWindowsBackend {
    let mut b = match user_data_dir {
        Some(d) => WslWindowsBackend::with_user_data_dir(d),
        None => WslWindowsBackend::default(),
    };
    if let Some(h) = helper_win {
        b = b.with_helper(h);
    }
    b
}

/// Dispatch a chrome-launcher tool call. Returns the JSON output (or an `{ok:false,error}`
/// value on failure — the bridge wraps this in a ToolCallResponse). `helper_win` comes from
/// the bridge config (the path to the cross-compiled helper).
pub async fn dispatch(name: &str, args: &Value, helper_win: Option<&str>) -> Value {
    let user_data_dir = args.get("user_data_dir").and_then(Value::as_str);
    let b = backend(helper_win, user_data_dir);
    match name {
        "chrome_endpoint" => match b.chrome_endpoint().await {
            Ok(ep) => json!({ "ok": true, "status": "ok", "browser": ep.browser, "webSocketDebuggerUrl": ep.web_socket_debugger_url, "visible": ep.visible }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
        "chrome_kill" => match b.chrome_kill().await {
            Ok(()) => json!({ "ok": true, "status": "ok", "message": "Chrome killed" }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
        "load_extension" => {
            let ext = args.get("extension_dir").and_then(Value::as_str).unwrap_or("");
            // Omitted user_data_dir must fall back to a real Windows profile path, never "" —
            // an empty --user-data-dir launches Chrome with no/locked profile and the helper hangs
            // (investigations/rust-helper-cdp-pipe-oneway.md, bug #3). The Python MCP defaulted this.
            let udd = user_data_dir.filter(|s| !s.is_empty()).unwrap_or(DEFAULT_SESSION_PROFILE);
            match b.load_extension(ext, udd).await {
                Ok(s) => json!({ "ok": true, "id": s.id, "name": s.name, "version": s.version }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "start_extension_session" => {
            let ext = args.get("extension_dir").and_then(Value::as_str).unwrap_or("");
            let udd = user_data_dir.filter(|s| !s.is_empty()).unwrap_or(DEFAULT_SESSION_PROFILE);
            match b.start_extension_session(ext, udd).await {
                Ok(s) => json!({ "ok": true, "id": s.id, "name": s.name, "version": s.version, "webSocketDebuggerUrl": s.web_socket_debugger_url, "launch": s.launch }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "claim_tab" => {
            let cdp = args.get("cdp_ws_url").and_then(Value::as_str).unwrap_or("");
            let extension_id = args.get("extension_id").and_then(Value::as_str).unwrap_or("");
            let target = args.get("target_url_contains").and_then(Value::as_str).unwrap_or("");
            let bridge = args.get("bridge_url").and_then(Value::as_str).unwrap_or("");
            match b.claim_tab(cdp, extension_id, target, bridge).await {
                Ok(c) => json!({ "ok": true, "tabId": c.tab_id, "runtimeKey": c.runtime_key, "authorizationId": c.authorization_id }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        other => json!({ "ok": false, "error": format!("unknown chrome-launcher tool: {other}") }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_five_tools_have_manifests() {
        let manifests = tool_manifests();
        let names: Vec<&str> = manifests
            .iter()
            .map(|m| m["name"].as_str().unwrap())
            .collect();
        for expected in ["chrome_endpoint", "chrome_kill", "load_extension", "start_extension_session", "claim_tab"] {
            assert!(names.contains(&expected), "missing manifest for {expected}");
        }
    }

    #[test]
    fn is_chrome_launcher_tool_recognizes_the_five() {
        assert!(is_chrome_launcher_tool("chrome_endpoint"));
        assert!(is_chrome_launcher_tool("claim_tab"));
        assert!(!is_chrome_launcher_tool("storage.list"));
    }

    #[test]
    fn claim_tab_requires_deployed_extension_id() {
        let claim = tool_manifests()
            .into_iter()
            .find(|manifest| manifest["name"] == "claim_tab")
            .expect("claim_tab manifest");
        let required = claim["input_schema"]["required"].as_array().expect("required fields");

        assert!(required.iter().any(|field| field == "extension_id"));
        assert_eq!(
            claim["input_schema"]["properties"]["extension_id"]["type"],
            "string"
        );
    }

    #[tokio::test]
    async fn unknown_tool_returns_error_value() {
        let v = dispatch("not_a_tool", &json!({}), None).await;
        assert_eq!(v["ok"], false);
    }
}
