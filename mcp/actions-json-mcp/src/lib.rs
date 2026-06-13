use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs as std_fs,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{
        header::{self, HeaderValue},
        Request, StatusCode,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    fs,
    io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{mpsc, oneshot, Mutex},
};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "actions-json-mcp")]
#[command(about = "actions.json MCP bridge for browser runtimes")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, default_value = "127.0.0.1:17345")]
        bind: SocketAddr,
        #[arg(
            long,
            default_value = "extensions/chrome-overlay-runtime/actions/overlay.actions.json"
        )]
        actions: PathBuf,
        #[arg(long = "map")]
        maps: Vec<PathBuf>,
        #[arg(long)]
        storage_root: Option<PathBuf>,
    },
    Mcp {
        #[arg(long, default_value = "127.0.0.1:17345")]
        bind: SocketAddr,
        #[arg(
            long,
            default_value = "extensions/chrome-overlay-runtime/actions/overlay.actions.json"
        )]
        actions: PathBuf,
        #[arg(long = "map")]
        maps: Vec<PathBuf>,
        #[arg(long)]
        storage_root: Option<PathBuf>,
        #[arg(long, default_value_t = DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES)]
        payload_inline_limit: usize,
        #[arg(long)]
        payload_dir: Option<PathBuf>,
    },
    OpenOverlay {
        #[arg(long, default_value = "http://127.0.0.1:17345")]
        bridge: String,
        #[arg(long)]
        html: PathBuf,
        #[arg(long, default_value = "actions.json overlay report")]
        title: String,
        #[arg(long, default_value_t = 980)]
        width: u32,
        #[arg(long, default_value_t = 760)]
        height: u32,
        #[arg(long)]
        target_runtime_id: Option<String>,
        #[arg(long)]
        target_url_contains: Option<String>,
    },
    ListTools {
        #[arg(long, default_value = "http://127.0.0.1:17345")]
        bridge: String,
    },
}

#[derive(Clone)]
struct AppState {
    catalog: Arc<Mutex<ActionCatalog>>,
    storage_root: Option<PathBuf>,
    runtimes: Arc<Mutex<HashMap<String, RuntimeClient>>>,
    pending: Arc<Mutex<HashMap<String, PendingCall>>>,
    last_replay_summary: Arc<Mutex<Option<Value>>>,
    last_credential_hydration: Arc<Mutex<Option<Value>>>,
    last_storage_hydration: Arc<Mutex<Option<Value>>>,
    pending_storage_hydrations: Arc<Mutex<HashMap<String, String>>>,
    payload: Arc<Mutex<PayloadSpillConfig>>,
}

const DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES: usize = 50_000;

#[derive(Clone)]
struct PayloadSpillConfig {
    inline_limit_bytes: usize,
    default_inline_limit_bytes: usize,
    payload_dir: PathBuf,
}

impl Default for PayloadSpillConfig {
    fn default() -> Self {
        PayloadSpillConfig {
            inline_limit_bytes: DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES,
            default_inline_limit_bytes: DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES,
            payload_dir: std::env::temp_dir()
                .join("actions-json-mcp")
                .join("payloads"),
        }
    }
}

#[derive(Clone)]
struct BridgeLaunchContext {
    bind: SocketAddr,
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
}

#[derive(Clone)]
struct ActionCatalog {
    base_manifest: Value,
    map_paths: Vec<PathBuf>,
    manifest: Value,
    site_manifest: Value,
    site_action_names: HashSet<String>,
}

#[derive(Clone)]
struct RuntimeClient {
    runtime_id: String,
    connection_id: String,
    runtime_key: Option<String>,
    authorization_id: Option<String>,
    extension_version: Option<String>,
    url: Option<String>,
    tab: Option<Value>,
    replay: Option<Value>,
    connected_at_ms: u128,
    last_seen_ms: u128,
    tx: mpsc::UnboundedSender<Message>,
}

struct PendingCall {
    runtime_id: String,
    tx: oneshot::Sender<Value>,
}

struct LocalOpenAiCredential {
    api_key: String,
    redacted: String,
    source: &'static str,
}

pub struct RuntimeSeed {
    pub runtime_id: String,
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolCallRequest {
    name: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    target_runtime_id: Option<String>,
    #[serde(default)]
    target_url_contains: Option<String>,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
}

#[derive(Debug, Serialize)]
struct ToolCallResponse {
    ok: bool,
    call_id: String,
    output: Option<Value>,
    error: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ResolvedToolCall {
    name: String,
    arguments: Value,
    target_runtime_id: Option<String>,
    target_url_contains: Option<String>,
    timeout_ms: u64,
    static_output: Option<Value>,
}

enum StoragePathError {
    PermissionDenied(String),
    InvalidInput(String),
}

fn default_timeout_ms() -> u64 {
    30_000
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn action_call_message(
    call_id: String,
    runtime_id: String,
    name: String,
    arguments: Value,
) -> Value {
    json!({
        "type": "action_call",
        "call_id": call_id,
        "runtime_id": runtime_id,
        "name": name,
        "arguments": arguments
    })
}

struct StateProjectionDispatch {
    mode: String,
    projection_name: String,
    summary_name: Option<String>,
    max_bytes: Option<u64>,
    map_path: String,
    projection: Value,
}

fn state_projection_call_message(
    call_id: String,
    runtime_id: String,
    dispatch: &StateProjectionDispatch,
) -> Value {
    json!({
        "type": "state_projection_call",
        "call_id": call_id,
        "runtime_id": runtime_id,
        "mode": dispatch.mode,
        "projection_name": dispatch.projection_name,
        "summary_name": dispatch.summary_name,
        "max_bytes": dispatch.max_bytes,
        "map_path": dispatch.map_path,
        "projection": dispatch.projection
    })
}

struct SiteActionDispatch {
    action: String,
    arguments: Value,
    map_path: String,
    map: Value,
}

fn site_action_call_message(
    call_id: String,
    runtime_id: String,
    dispatch: &SiteActionDispatch,
) -> Value {
    json!({
        "type": "site_action_call",
        "call_id": call_id,
        "runtime_id": runtime_id,
        "action": dispatch.action,
        "arguments": dispatch.arguments,
        "map_path": dispatch.map_path,
        "map": dispatch.map
    })
}

fn mark_bridge_hydration_bundle(mut bundle: Value) -> Value {
    if let Some(object) = bundle.as_object_mut() {
        object.insert(
            "x_actions_json_bridge_hydration".to_string(),
            Value::Bool(true),
        );
        object.insert(
            "x_actions_json_hydration_reason".to_string(),
            Value::String("runtime_ready".to_string()),
        );
    }
    bundle
}

async fn send_storage_hydration_to_runtime(
    state: AppState,
    runtime_id: String,
    tx: mpsc::UnboundedSender<Message>,
) {
    // Every exit path records state: a silent hydration failure is
    // indistinguishable from success and misleads incident diagnosis
    // (2026-06-12: an unobservable hydration path sent the investigation
    // toward a storage-wipe theory).
    let record = |value: Value| {
        let state = state.clone();
        async move {
            let mut status = state.last_storage_hydration.lock().await;
            *status = Some(value);
        }
    };
    let Some(storage_root) = state.storage_root.clone() else {
        record(json!({
            "status": "skipped",
            "reason": "no_storage_root",
            "runtime_id": runtime_id,
            "at_ms": now_ms(),
        }))
        .await;
        return;
    };
    let bundle = match storage_bundle_from_root(storage_root).await {
        Ok(bundle) => bundle,
        Err(error) => {
            record(json!({
                "status": "failed",
                "reason": "bundle_build_failed",
                "error": error.to_string(),
                "runtime_id": runtime_id,
                "at_ms": now_ms(),
            }))
            .await;
            return;
        }
    };
    let call_id = Uuid::new_v4().to_string();
    let item = action_call_message(
        call_id.clone(),
        runtime_id.clone(),
        "storage.import_bundle".to_string(),
        json!({ "bundle": mark_bridge_hydration_bundle(bundle) }),
    );
    {
        let mut pending = state.pending_storage_hydrations.lock().await;
        pending.insert(call_id.clone(), runtime_id.clone());
    }
    if tx.send(Message::Text(item.to_string())).is_err() {
        let mut pending = state.pending_storage_hydrations.lock().await;
        pending.remove(&call_id);
        record(json!({
            "status": "failed",
            "reason": "runtime_channel_closed",
            "runtime_id": runtime_id,
            "at_ms": now_ms(),
        }))
        .await;
        return;
    }
    record(json!({
        "status": "sent",
        "call_id": call_id,
        "runtime_id": runtime_id,
        "at_ms": now_ms(),
    }))
    .await;
}

fn redacted_openai_key(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() < 16 || !trimmed.starts_with("sk-") {
        return "configured".to_string();
    }
    let prefix = if trimmed.starts_with("sk-proj-") {
        "sk-proj"
    } else {
        "sk"
    };
    let suffix = &trimmed[trimmed.len().saturating_sub(4)..];
    format!("{prefix}...{suffix}")
}

fn openai_credential_from_local_config_file(path: &Path) -> Option<LocalOpenAiCredential> {
    let text = std_fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    let api_key = value
        .get("openai_api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())?
        .to_string();
    Some(LocalOpenAiCredential {
        redacted: redacted_openai_key(&api_key),
        api_key,
        source: "local_config_file",
    })
}

fn find_local_config_file_with_home(start: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let home_candidate = home.map(|home| home.join(".actions-json.local.json"));
    if let Some(path) = home_candidate.filter(|path| path.exists()) {
        return Some(path);
    }

    let mut cursor = if start.is_file() {
        start.parent()?
    } else {
        start
    };
    loop {
        let candidate = cursor.join(".actions-json.local.json");
        if candidate.exists() {
            return Some(candidate);
        }
        cursor = cursor.parent()?;
    }
}

fn find_local_config_file(start: &Path) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    find_local_config_file_with_home(start, home.as_deref())
}

fn load_local_openai_credential_from_sources(
    env_value: Option<String>,
    config_start: Option<&Path>,
) -> Option<LocalOpenAiCredential> {
    if let Some(api_key) = env_value
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
    {
        return Some(LocalOpenAiCredential {
            redacted: redacted_openai_key(&api_key),
            api_key,
            source: "environment",
        });
    }
    let start = config_start?;
    let config_path = find_local_config_file(start)?;
    openai_credential_from_local_config_file(&config_path)
}

#[cfg(test)]
fn load_local_openai_credential_from_sources_with_home(
    env_value: Option<String>,
    config_start: Option<&Path>,
    home: Option<&Path>,
) -> Option<LocalOpenAiCredential> {
    if let Some(api_key) = env_value
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
    {
        return Some(LocalOpenAiCredential {
            redacted: redacted_openai_key(&api_key),
            api_key,
            source: "environment",
        });
    }
    let start = config_start?;
    let config_path = find_local_config_file_with_home(start, home)?;
    openai_credential_from_local_config_file(&config_path)
}

fn load_local_openai_credential() -> Option<LocalOpenAiCredential> {
    let env_value = std::env::var("ACTIONS_JSON_OPENAI_API_KEY").ok();
    let cwd = std::env::current_dir().ok();
    load_local_openai_credential_from_sources(env_value, cwd.as_deref())
}

async fn send_credential_hydration_to_extension(
    state: AppState,
    tx: mpsc::UnboundedSender<Message>,
) {
    let Some(credential) = load_local_openai_credential() else {
        let mut status = state.last_credential_hydration.lock().await;
        *status = Some(json!({
            "configured": false,
            "sent": false,
            "status": "not_configured"
        }));
        return;
    };
    {
        let mut status = state.last_credential_hydration.lock().await;
        *status = Some(json!({
            "configured": true,
            "sent": true,
            "status": "sent",
            "source": credential.source,
            "redacted": credential.redacted.clone()
        }));
    }
    let item = json!({
        "type": "credential_hydration",
        "provider": "openai",
        "source": "mcp_bridge_local",
        "credential": {
            "api_key": credential.api_key
        },
        "redacted": credential.redacted
    });
    let _ = tx.send(Message::Text(item.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn action_call_message_includes_selected_runtime_id() {
        let item = action_call_message(
            "call-1".to_string(),
            "runtime-a".to_string(),
            "storage.list".to_string(),
            json!({}),
        );

        assert_eq!(item["type"].as_str(), Some("action_call"));
        assert_eq!(item["call_id"].as_str(), Some("call-1"));
        assert_eq!(item["runtime_id"].as_str(), Some("runtime-a"));
        assert_eq!(item["name"].as_str(), Some("storage.list"));
    }

    #[test]
    fn state_projection_call_message_carries_definition_and_routing() {
        let dispatch = StateProjectionDispatch {
            mode: "state_read".to_string(),
            projection_name: "trello.board".to_string(),
            summary_name: Some("agent_context".to_string()),
            max_bytes: Some(12_000),
            map_path: "scopes/private/sites/trello.com/board/actions.json".to_string(),
            projection: json!({ "name": "trello.board", "snapshot": { "version": 1 } }),
        };
        let item = state_projection_call_message(
            "call-2".to_string(),
            "runtime-b".to_string(),
            &dispatch,
        );

        assert_eq!(item["type"].as_str(), Some("state_projection_call"));
        assert_eq!(item["call_id"].as_str(), Some("call-2"));
        assert_eq!(item["runtime_id"].as_str(), Some("runtime-b"));
        assert_eq!(item["mode"].as_str(), Some("state_read"));
        assert_eq!(item["projection_name"].as_str(), Some("trello.board"));
        assert_eq!(item["summary_name"].as_str(), Some("agent_context"));
        assert_eq!(item["max_bytes"].as_u64(), Some(12_000));
        assert_eq!(
            item["map_path"].as_str(),
            Some("scopes/private/sites/trello.com/board/actions.json")
        );
        assert_eq!(item["projection"]["name"].as_str(), Some("trello.board"));
    }

    #[test]
    fn site_action_call_message_carries_map_and_routing() {
        let dispatch = SiteActionDispatch {
            action: "trello.board.add_card.open_composer".to_string(),
            arguments: json!({ "list_name": "Backlog" }),
            map_path: "scopes/private/sites/trello.com/board/actions.json".to_string(),
            map: json!({
                "protocol": "actions.json",
                "tools": [{ "name": "trello.board.add_card.open_composer", "workflow": { "version": 1 } }]
            }),
        };
        let item =
            site_action_call_message("call-3".to_string(), "runtime-c".to_string(), &dispatch);

        assert_eq!(item["type"].as_str(), Some("site_action_call"));
        assert_eq!(item["call_id"].as_str(), Some("call-3"));
        assert_eq!(item["runtime_id"].as_str(), Some("runtime-c"));
        assert_eq!(
            item["action"].as_str(),
            Some("trello.board.add_card.open_composer")
        );
        assert_eq!(item["arguments"]["list_name"].as_str(), Some("Backlog"));
        assert_eq!(
            item["map_path"].as_str(),
            Some("scopes/private/sites/trello.com/board/actions.json")
        );
        assert_eq!(
            item["map"]["tools"][0]["workflow"]["version"].as_u64(),
            Some(1)
        );
    }

    #[test]
    fn local_openai_credential_prefers_environment_value() {
        let root = tempdir().unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{ "openai_api_key": "sk-local-file-0000" }"#,
        )
        .unwrap();

        let credential = load_local_openai_credential_from_sources(
            Some("sk-env-value-1234567890".to_string()),
            Some(root.path()),
        )
        .unwrap();

        assert_eq!(credential.api_key, "sk-env-value-1234567890");
        assert_eq!(credential.source, "environment");
        assert_eq!(credential.redacted, "sk...7890");
    }

    #[test]
    fn local_openai_credential_loads_from_untracked_config_file() {
        let root = tempdir().unwrap();
        let nested = root.path().join("a/b/c");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{ "openai_api_key": "sk-local-file-1234567890" }"#,
        )
        .unwrap();

        let credential =
            load_local_openai_credential_from_sources_with_home(None, Some(&nested), None).unwrap();

        assert_eq!(credential.api_key, "sk-local-file-1234567890");
        assert_eq!(credential.source, "local_config_file");
        assert_eq!(credential.redacted, "sk...7890");
    }

    #[test]
    fn local_openai_credential_prefers_home_config_file_over_worktree_config() {
        let home = tempdir().unwrap();
        let root = tempdir().unwrap();
        let nested = root.path().join("a/b/c");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            home.path().join(".actions-json.local.json"),
            r#"{ "openai_api_key": "sk-home-file-1234567890" }"#,
        )
        .unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{ "openai_api_key": "sk-worktree-file-0000" }"#,
        )
        .unwrap();
        let credential = load_local_openai_credential_from_sources_with_home(
            None,
            Some(&nested),
            Some(home.path()),
        )
        .unwrap();

        assert_eq!(credential.api_key, "sk-home-file-1234567890");
        assert_eq!(credential.source, "local_config_file");
        assert_eq!(credential.redacted, "sk...7890");
    }

    #[tokio::test]
    async fn bridge_runtimes_resource_redacts_credential_hydration_status() {
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );
        {
            let mut status = state.last_credential_hydration.lock().await;
            *status = Some(json!({
                "configured": true,
                "sent": true,
                "status": "accepted",
                "redacted": "sk...7890"
            }));
        }

        let value = bridge_runtimes_resource(&state).await;

        assert_eq!(
            value["credential_hydration"]["redacted"].as_str(),
            Some("sk...7890")
        );
        assert!(!value.to_string().contains("sk-local-file-1234567890"));
    }

    fn test_launch() -> BridgeLaunchContext {
        BridgeLaunchContext {
            bind: "127.0.0.1:17345".parse().unwrap(),
            actions_path: PathBuf::from(
                "extensions/chrome-overlay-runtime/actions/overlay.actions.json",
            ),
            map_paths: Vec::new(),
            storage_root: None,
        }
    }

    #[tokio::test]
    async fn mcp_initialize_returns_server_capabilities() {
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );

        let response = mcp_handle_jsonrpc(
            state,
            test_launch(),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {}
            }),
        )
        .await
        .unwrap();

        assert_eq!(response["jsonrpc"].as_str(), Some("2.0"));
        assert_eq!(
            response["result"]["protocolVersion"].as_str(),
            Some("2025-06-18")
        );
        assert_eq!(
            response["result"]["serverInfo"]["name"].as_str(),
            Some("actions-json-mcp")
        );
        assert!(response["result"]["capabilities"]["tools"].is_object());
        assert!(response["result"]["capabilities"]["resources"].is_object());
    }

    #[tokio::test]
    async fn mcp_tools_list_uses_mcp_schema_names() {
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({
                    "protocol": "actions.json",
                    "tools": [{
                        "name": "storage.list",
                        "description": "List storage.",
                        "input_schema": { "type": "object" }
                    }]
                }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );

        let response = mcp_handle_jsonrpc(
            state,
            test_launch(),
            json!({
                "jsonrpc": "2.0",
                "id": "tools",
                "method": "tools/list",
                "params": {}
            }),
        )
        .await
        .unwrap();

        let tools = response["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|tool| {
            tool["name"].as_str() == Some("storage.list")
                && tool.get("inputSchema").is_some()
                && tool.get("input_schema").is_none()
        }));
    }

    fn payload_spill_test_state(blob_chars: usize) -> AppState {
        state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({
                    "protocol": "actions.json",
                    "tools": [{
                        "name": "test.static_blob",
                        "description": "Static blob for payload spill tests.",
                        "input_schema": { "type": "object" },
                        "x_actions": { "static_output": { "blob": "x".repeat(blob_chars) } }
                    }]
                }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        )
    }

    async fn mcp_call_tool(state: AppState, name: &str, arguments: Value) -> Value {
        mcp_handle_jsonrpc(
            state,
            test_launch(),
            json!({
                "jsonrpc": "2.0",
                "id": "call",
                "method": "tools/call",
                "params": { "name": name, "arguments": arguments }
            }),
        )
        .await
        .unwrap()
    }

    fn mcp_result_text(response: &Value) -> String {
        response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn bridge_payloads_configure_reads_sets_and_resets_limit() {
        let state = payload_spill_test_state(10);

        let read = mcp_call_tool(state.clone(), "bridge.payloads.configure", json!({})).await;
        let read_result: Value = serde_json::from_str(&mcp_result_text(&read)).unwrap();
        assert_eq!(
            read_result["output"]["inline_limit_bytes"],
            json!(DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES)
        );

        let set = mcp_call_tool(
            state.clone(),
            "bridge.payloads.configure",
            json!({ "inline_limit_bytes": 1000 }),
        )
        .await;
        let set_result: Value = serde_json::from_str(&mcp_result_text(&set)).unwrap();
        assert_eq!(set_result["output"]["inline_limit_bytes"], json!(1000));
        assert_eq!(
            set_result["output"]["default_inline_limit_bytes"],
            json!(DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES)
        );

        let reset = mcp_call_tool(
            state.clone(),
            "bridge.payloads.configure",
            json!({ "inline_limit_bytes": null }),
        )
        .await;
        let reset_result: Value = serde_json::from_str(&mcp_result_text(&reset)).unwrap();
        assert_eq!(
            reset_result["output"]["inline_limit_bytes"],
            json!(DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES)
        );

        let invalid = mcp_call_tool(
            state,
            "bridge.payloads.configure",
            json!({ "inline_limit_bytes": 0 }),
        )
        .await;
        assert_eq!(invalid["result"]["isError"], json!(true));
        let invalid_result: Value = serde_json::from_str(&mcp_result_text(&invalid)).unwrap();
        assert_eq!(
            invalid_result["error"]["error"]["code"],
            json!("invalid_input")
        );
    }

    #[tokio::test]
    async fn oversized_tool_result_spills_to_disk_and_returns_envelope() {
        let spill_dir = tempfile::tempdir().unwrap();
        let state = payload_spill_test_state(5000);
        state.payload.lock().await.payload_dir = spill_dir.path().to_path_buf();

        let inline = mcp_call_tool(state.clone(), "test.static_blob", json!({})).await;
        let full_text = mcp_result_text(&inline);
        assert!(full_text.contains("xxxx"));

        state.payload.lock().await.inline_limit_bytes = full_text.len();
        let at_limit = mcp_call_tool(state.clone(), "test.static_blob", json!({})).await;
        let at_limit_result: Value =
            serde_json::from_str(&mcp_result_text(&at_limit)).unwrap();
        assert!(at_limit_result.get("payload_spilled").is_none());
        assert!(at_limit_result["output"]["blob"].is_string());

        state.payload.lock().await.inline_limit_bytes = full_text.len() - 1;
        let spilled = mcp_call_tool(state.clone(), "test.static_blob", json!({})).await;
        assert_eq!(spilled["result"]["isError"], json!(false));
        let envelope: Value = serde_json::from_str(&mcp_result_text(&spilled)).unwrap();
        assert_eq!(envelope["payload_spilled"], json!(true));
        assert_eq!(envelope["tool"], json!("test.static_blob"));
        assert_eq!(envelope["ok"], json!(true));
        assert_eq!(envelope["payload_bytes"], json!(full_text.len()));
        assert_eq!(envelope["inline_limit_bytes"], json!(full_text.len() - 1));
        assert!(envelope["payload_hash"]
            .as_str()
            .unwrap()
            .starts_with("djb2:"));
        assert!(envelope["preview"].as_str().unwrap().chars().count() <= 800);
        let path = envelope["payload_path"].as_str().unwrap();
        assert!(path.starts_with(spill_dir.path().to_str().unwrap()));
        let spilled_content = std::fs::read_to_string(path).unwrap();
        assert_eq!(spilled_content.len(), full_text.len());
        let spilled_result: Value = serde_json::from_str(&spilled_content).unwrap();
        let inline_result: Value = serde_json::from_str(&full_text).unwrap();
        assert_eq!(spilled_result["output"], inline_result["output"]);
        assert_eq!(spilled_result["ok"], json!(true));
    }

    #[tokio::test]
    async fn spilled_error_result_keeps_is_error() {
        let spill_dir = tempfile::tempdir().unwrap();
        let state = payload_spill_test_state(10);
        {
            let mut config = state.payload.lock().await;
            config.payload_dir = spill_dir.path().to_path_buf();
            config.inline_limit_bytes = 1;
        }

        let response = mcp_call_tool(state, "tool.that.does.not.exist", json!({})).await;
        assert_eq!(response["result"]["isError"], json!(true));
        let envelope: Value = serde_json::from_str(&mcp_result_text(&response)).unwrap();
        assert_eq!(envelope["payload_spilled"], json!(true));
        assert_eq!(envelope["ok"], json!(false));
    }

    #[tokio::test]
    async fn spill_write_failure_degrades_to_inline_result() {
        let state = payload_spill_test_state(5000);
        {
            let mut config = state.payload.lock().await;
            config.payload_dir = PathBuf::from("/proc/definitely-not-writable/payloads");
            config.inline_limit_bytes = 1;
        }

        let response = mcp_call_tool(state, "test.static_blob", json!({})).await;
        assert_eq!(response["result"]["isError"], json!(false));
        let result: Value = serde_json::from_str(&mcp_result_text(&response)).unwrap();
        assert!(result.get("payload_spilled").is_none());
        assert!(result["payload_spill_error"].is_string());
        assert!(result["output"]["blob"].as_str().unwrap().len() >= 5000);
    }

    #[tokio::test]
    async fn mcp_tools_list_requires_policy_exception_report_for_direct_primitives() {
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({
                    "protocol": "actions.json",
                    "tools": [{
                        "name": "pointer.click",
                        "description": "Click a point.",
                        "input_schema": {
                            "type": "object",
                            "required": ["x", "y"],
                            "additionalProperties": false,
                            "properties": {
                                "x": { "type": "number" },
                                "y": { "type": "number" }
                            }
                        }
                    }, {
                        "name": "actions.site",
                        "description": "Site actions.",
                        "input_schema": { "type": "object" }
                    }]
                }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );

        let response = mcp_handle_jsonrpc(
            state,
            test_launch(),
            json!({
                "jsonrpc": "2.0",
                "id": "tools",
                "method": "tools/list",
                "params": {}
            }),
        )
        .await
        .unwrap();

        let tools = response["result"]["tools"].as_array().unwrap();
        let pointer_click = tools
            .iter()
            .find(|tool| tool["name"].as_str() == Some("pointer.click"))
            .unwrap();
        assert_eq!(
            pointer_click["inputSchema"]["properties"]["policy_exception_report"]["type"].as_str(),
            Some("object")
        );
        assert!(pointer_click["inputSchema"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item.as_str() == Some("policy_exception_report")));

        let actions_site = tools
            .iter()
            .find(|tool| tool["name"].as_str() == Some("actions.site"))
            .unwrap();
        assert!(actions_site["inputSchema"]["properties"]
            .get("policy_exception_report")
            .is_none());
    }

    #[tokio::test]
    async fn mcp_tools_list_exposes_runtime_agent_user_message_without_policy_report() {
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({
                    "protocol": "actions.json",
                    "tools": [{
                        "name": "runtime.agent.user_message",
                        "description": "Inject a developer test prompt into the hosted Realtime session.",
                        "input_schema": {
                            "type": "object",
                            "required": ["text"],
                            "additionalProperties": false,
                            "properties": {
                                "text": { "type": "string" }
                            }
                        }
                    }]
                }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );

        let response = mcp_handle_jsonrpc(
            state,
            test_launch(),
            json!({
                "jsonrpc": "2.0",
                "id": "tools",
                "method": "tools/list",
                "params": {}
            }),
        )
        .await
        .unwrap();

        let tools = response["result"]["tools"].as_array().unwrap();
        let user_message = tools
            .iter()
            .find(|tool| tool["name"].as_str() == Some("runtime.agent.user_message"))
            .unwrap();
        assert_eq!(
            user_message["inputSchema"]["required"],
            json!(["text"])
        );
        assert!(user_message["inputSchema"]["properties"]
            .get("policy_exception_report")
            .is_none());
    }

    #[test]
    fn direct_primitive_policy_exception_report_is_stripped_before_dispatch() {
        let manifest = json!({
            "protocol": "actions.json",
            "tools": [{
                "name": "pointer.click",
                "description": "Click a point.",
                "input_schema": {
                    "type": "object",
                    "required": ["x", "y"],
                    "additionalProperties": false,
                    "properties": {
                        "x": { "type": "number" },
                        "y": { "type": "number" }
                    }
                }
            }]
        });
        let request = ToolCallRequest {
            name: "pointer.click".to_string(),
            arguments: json!({
                "x": 12,
                "y": 34,
                "policy_exception_report": {
                    "kind": "generic",
                    "intended_tool": "pointer.click",
                    "actions_json_path": "none",
                    "reason": "No site-specific action matched this low-level test."
                }
            }),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };

        let resolved = resolve_tool_call(&manifest, &request).unwrap();

        assert_eq!(resolved.name, "pointer.click");
        assert_eq!(resolved.arguments, json!({ "x": 12, "y": 34 }));
    }

    #[test]
    fn direct_primitive_policy_exception_report_is_required() {
        let manifest = json!({
            "protocol": "actions.json",
            "tools": [{
                "name": "pointer.click",
                "description": "Click a point.",
                "input_schema": {
                    "type": "object",
                    "required": ["x", "y"],
                    "additionalProperties": false,
                    "properties": {
                        "x": { "type": "number" },
                        "y": { "type": "number" }
                    }
                }
            }]
        });
        let request = ToolCallRequest {
            name: "pointer.click".to_string(),
            arguments: json!({ "x": 12, "y": 34 }),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };

        let error = resolve_tool_call(&manifest, &request).unwrap_err();

        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            error.1["error"]["code"].as_str(),
            Some("policy_exception_report_required")
        );
    }

    #[test]
    fn actions_site_manifest_advertises_timeout_ms() {
        let manifest = site_actions_tool_manifest();
        let props = &manifest["input_schema"]["properties"];
        assert_eq!(props["timeout_ms"]["type"].as_str(), Some("integer"));
        assert_eq!(props["timeout_ms"]["minimum"].as_u64(), Some(1));
        assert_eq!(
            manifest["input_schema"]["additionalProperties"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn default_timeout_ms_is_thirty_seconds() {
        assert_eq!(default_timeout_ms(), 30_000);
    }

    #[tokio::test]
    async fn mcp_tools_call_threads_timeout_ms_from_arguments() {
        let state = payload_spill_test_state(10);
        let response = mcp_call_tool(
            state,
            "bridge.payloads.configure",
            json!({ "inline_limit_bytes": 4242 }),
        )
        .await;
        // sanity: the call path is exercised; timeout extraction is unit-checked below.
        assert_eq!(response["result"]["isError"], json!(false));

        // Directly exercise the extraction precedence used by mcp_tools_call.
        let args = json!({ "mode": "list", "timeout_ms": 45_000 });
        let extracted = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or_else(default_timeout_ms);
        assert_eq!(extracted, 45_000);
        let no_timeout = json!({ "mode": "list" });
        let defaulted = no_timeout
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or_else(default_timeout_ms);
        assert_eq!(defaulted, 30_000);
    }

    #[tokio::test]
    async fn mcp_resources_read_declared_storage_markdown() {
        let root = tempdir().unwrap();
        let site_dir = root.path().join("scopes/private/sites/example.com/page");
        std::fs::create_dir_all(&site_dir).unwrap();
        std::fs::write(
            site_dir.join("actions.json"),
            r#"{
              "protocol": "actions.json",
              "x_actions": {
                "files": [{
                  "id": "example-skill",
                  "path": "SKILL.md",
                  "kind": "skill",
                  "description": "Example skill."
                }]
              },
              "tools": []
            }"#,
        )
        .unwrap();
        std::fs::write(
            site_dir.join("SKILL.md"),
            "---\nname: example\n---\n\n# Example skill\n",
        )
        .unwrap();

        let manifest = json!({ "protocol": "actions.json", "tools": [] });
        let (catalog_manifest, site_manifest, site_action_names) =
            build_catalog_manifests(manifest.clone(), &[], Some(root.path()))
                .await
                .unwrap();
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: manifest,
                map_paths: Vec::new(),
                manifest: catalog_manifest,
                site_manifest,
                site_action_names,
            },
            Vec::new(),
            Some(root.path().to_path_buf()),
        );
        let launch = BridgeLaunchContext {
            storage_root: Some(root.path().to_path_buf()),
            ..test_launch()
        };
        let response = mcp_handle_jsonrpc(
            state,
            launch,
            json!({
                "jsonrpc": "2.0",
                "id": "read",
                "method": "resources/read",
                "params": {
                    "uri": "actions-json://storage/file/scopes/private/sites/example.com/page/SKILL.md"
                }
            }),
        )
        .await
        .unwrap();

        assert_eq!(
            response["result"]["contents"][0]["mimeType"].as_str(),
            Some("text/markdown")
        );
        assert!(response["result"]["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("# Example skill"));
    }

    #[tokio::test]
    async fn storage_site_actions_inherit_host_target_from_path() {
        let root = tempdir().unwrap();
        let trello_dir = root.path().join("scopes/private/sites/trello.com/board");
        let graphify_dir = root.path().join("scopes/private/sites/graphifymd.com/home");
        std::fs::create_dir_all(&trello_dir).unwrap();
        std::fs::create_dir_all(&graphify_dir).unwrap();
        std::fs::write(
            trello_dir.join("actions.json"),
            r#"{
              "protocol": "actions.json",
              "tools": [{
                "name": "trello.site.map",
                "description": "Trello site action without explicit binding.",
                "input_schema": { "type": "object" },
                "x_actions": { "static_output": { "ok": true, "site": "trello" } }
              }]
            }"#,
        )
        .unwrap();
        std::fs::write(
            graphify_dir.join("actions.json"),
            r#"{
              "protocol": "actions.json",
              "tools": [{
                "name": "graphifymd.site.map",
                "description": "Graphify site action without explicit binding.",
                "input_schema": { "type": "object" },
                "x_actions": { "static_output": { "ok": true, "site": "graphify" } }
              }]
            }"#,
        )
        .unwrap();

        let manifest = json!({ "protocol": "actions.json", "tools": [] });
        let (_, site_manifest, site_action_names) =
            build_catalog_manifests(manifest, &[], Some(root.path()))
                .await
                .unwrap();

        let actions = site_actions_for_target(
            &site_manifest,
            &site_action_names,
            Some("https://trello.com/b/example"),
        );
        let names = actions
            .iter()
            .filter_map(|action| action.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(names.contains(&"trello.site.map"));
        assert!(!names.contains(&"graphifymd.site.map"));
    }

    #[tokio::test]
    async fn bridge_runtimes_resource_includes_replay_metadata() {
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );
        {
            let mut runtimes = state.runtimes.lock().await;
            runtimes.insert(
                "runtime-101".to_string(),
                RuntimeClient {
                    runtime_id: "runtime-101".to_string(),
                    connection_id: "connection-1".to_string(),
                    runtime_key: Some("chrome-tab:101".to_string()),
                    authorization_id: Some("auth-101".to_string()),
                    extension_version: Some("0.1.87".to_string()),
                    url: Some("https://www.linkedin.com/messaging/".to_string()),
                    tab: Some(json!({
                        "tab_id": 101,
                        "title": "LinkedIn Messaging",
                        "active": true
                    })),
                    replay: Some(json!({
                        "bridge_session_id": "bridge-session-test",
                        "reason": "bridge_open",
                        "attempt": 1
                    })),
                    connected_at_ms: 100,
                    last_seen_ms: 200,
                    tx: mpsc::unbounded_channel().0,
                },
            );
        }
        {
            let mut summary = state.last_replay_summary.lock().await;
            *summary = Some(json!({
                "type": "bridge_runtime_replay_summary",
                "bridge_session_id": "bridge-session-test",
                "claimed_count": 2,
                "registered_count": 1,
                "failed_count": 1
            }));
        }

        let value = bridge_runtimes_resource(&state).await;

        assert_eq!(
            value["last_replay_summary"]["registered_count"].as_u64(),
            Some(1)
        );
        assert_eq!(value["runtimes"][0]["tab"]["tab_id"].as_u64(), Some(101));
        assert_eq!(
            value["runtimes"][0]["replay"]["bridge_session_id"].as_str(),
            Some("bridge-session-test")
        );
    }
}

pub async fn run_cli() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Serve {
            bind,
            actions,
            maps,
            storage_root,
        } => serve(bind, actions, maps, storage_root).await,
        Command::Mcp {
            bind,
            actions,
            maps,
            storage_root,
            payload_inline_limit,
            payload_dir,
        } => {
            mcp_stdio_server(
                bind,
                actions,
                maps,
                storage_root,
                payload_inline_limit,
                payload_dir,
            )
            .await
        }
        Command::OpenOverlay {
            bridge,
            html,
            title,
            width,
            height,
            target_runtime_id,
            target_url_contains,
        } => {
            open_overlay(
                bridge,
                html,
                title,
                width,
                height,
                target_runtime_id,
                target_url_contains,
            )
            .await
        }
        Command::ListTools { bridge } => list_tools(bridge).await,
    }
}

async fn serve(
    bind: SocketAddr,
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
) -> Result<()> {
    let state = state_from_actions_map_paths_and_storage_root(
        actions_path.clone(),
        map_paths.clone(),
        storage_root.clone(),
        Vec::new(),
    )
    .await?;
    let app = app_from_state(state, true);

    let listener = TcpListener::bind(bind).await?;
    println!("actions-json bridge listening on http://{bind}");
    println!("extension WebSocket: ws://{bind}/extension");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn mcp_stdio_server(
    bind: SocketAddr,
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
    payload_inline_limit: usize,
    payload_dir: Option<PathBuf>,
) -> Result<()> {
    let state = state_from_actions_map_paths_and_storage_root(
        actions_path.clone(),
        map_paths.clone(),
        storage_root.clone(),
        Vec::new(),
    )
    .await?;
    {
        let mut config = state.payload.lock().await;
        config.inline_limit_bytes = payload_inline_limit;
        config.default_inline_limit_bytes = payload_inline_limit;
        if let Some(dir) = payload_dir {
            config.payload_dir = dir;
        }
    }
    let app = app_from_state(state.clone(), false);
    let listener = TcpListener::bind(bind).await?;
    let actual_bind = listener.local_addr()?;
    let launch = BridgeLaunchContext {
        bind: actual_bind,
        actions_path: actions_path.clone(),
        map_paths: map_paths.clone(),
        storage_root: storage_root.clone(),
    };
    eprintln!("actions-json MCP bridge browser listener on http://{actual_bind}");
    eprintln!("extension WebSocket: ws://{actual_bind}/extension");
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            eprintln!("actions-json MCP bridge browser listener failed: {error}");
        }
    });
    mcp_stdio_loop(state, launch).await
}

pub fn app_from_manifest_value(manifest: Value) -> Router {
    app_from_manifest_value_with_runtimes(manifest, Vec::new())
}

pub async fn app_from_manifest_and_map_paths(
    manifest: Value,
    map_paths: Vec<PathBuf>,
) -> Result<Router> {
    app_from_manifest_map_paths_and_storage_root(manifest, map_paths, None).await
}

pub async fn app_from_manifest_map_paths_and_storage_root(
    manifest: Value,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
) -> Result<Router> {
    let (catalog_manifest, site_manifest, site_action_names) =
        build_catalog_manifests(manifest.clone(), &map_paths, storage_root.as_deref()).await?;

    Ok(app_from_state(
        state_from_catalog(
            ActionCatalog {
                base_manifest: manifest,
                map_paths,
                manifest: catalog_manifest,
                site_manifest,
                site_action_names,
            },
            Vec::new(),
            storage_root,
        ),
        true,
    ))
}

async fn state_from_actions_map_paths_and_storage_root(
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
    runtime_seeds: Vec<RuntimeSeed>,
) -> Result<AppState> {
    let manifest_text = fs::read_to_string(&actions_path).await.with_context(|| {
        format!(
            "failed to read actions manifest at {}",
            actions_path.display()
        )
    })?;
    let manifest: Value = serde_json::from_str(&manifest_text).with_context(|| {
        format!(
            "failed to parse actions manifest at {}",
            actions_path.display()
        )
    })?;
    let (catalog_manifest, site_manifest, site_action_names) =
        build_catalog_manifests(manifest.clone(), &map_paths, storage_root.as_deref()).await?;
    Ok(state_from_catalog(
        ActionCatalog {
            base_manifest: manifest,
            map_paths,
            manifest: catalog_manifest,
            site_manifest,
            site_action_names,
        },
        runtime_seeds,
        storage_root,
    ))
}

async fn build_catalog_manifests(
    manifest: Value,
    map_paths: &[PathBuf],
    storage_root: Option<&Path>,
) -> Result<(Value, Value, HashSet<String>)> {
    let mut advertised_manifest = manifest.clone();
    let mut site_manifest = manifest;
    let mut site_action_names = HashSet::new();
    ensure_primitive_dictionary_tools(&mut advertised_manifest)?;
    ensure_primitive_dictionary_tools(&mut site_manifest)?;
    for map_path in effective_map_paths(map_paths, storage_root).await? {
        let map_text = fs::read_to_string(&map_path)
            .await
            .with_context(|| format!("failed to read actions map at {}", map_path.display()))?;
        let map: Value = serde_json::from_str(&map_text)
            .with_context(|| format!("failed to parse actions map at {}", map_path.display()))?;
        let mut additional_tools = validated_map_tools(&map);
        if let Some(site_host) = storage_map_site_host(&map_path) {
            for tool in &mut additional_tools {
                stamp_default_target_url_contains(tool, &site_host);
            }
        }
        for tool in &additional_tools {
            if let Some(name) = tool.get("name").and_then(Value::as_str) {
                site_action_names.insert(name.to_string());
            }
        }
        site_manifest
            .as_object_mut()
            .ok_or_else(|| anyhow!("base manifest must be a JSON object"))?
            .entry("tools")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("base manifest tools must be an array"))?
            .extend(additional_tools);
    }

    if storage_root.is_some() || !map_paths.is_empty() {
        advertised_manifest
            .as_object_mut()
            .ok_or_else(|| anyhow!("base manifest must be a JSON object"))?
            .entry("tools")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("base manifest tools must be an array"))?
            .push(site_actions_tool_manifest());
    }

    ensure_advertised_tool(
        &mut advertised_manifest,
        runtime_session_log_tool_manifest(),
    )?;
    ensure_site_tool(&mut site_manifest, runtime_session_log_tool_manifest())?;

    if storage_root.is_some() {
        ensure_advertised_tool(&mut advertised_manifest, storage_read_file_tool_manifest())?;
        ensure_site_tool(&mut site_manifest, storage_read_file_tool_manifest())?;
        ensure_advertised_tool(
            &mut advertised_manifest,
            json!({
                "name": "storage.sync",
                "description": "Read the configured actions.json.storage root on the agent side and sync it into the authorized browser extension local storage.",
                "input_schema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }),
        )?;
    }

    Ok((advertised_manifest, site_manifest, site_action_names))
}

fn ensure_advertised_tool(manifest: &mut Value, tool: Value) -> Result<()> {
    let name = tool
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tool manifest requires name"))?;
    let tools = manifest
        .as_object_mut()
        .ok_or_else(|| anyhow!("base manifest must be a JSON object"))?
        .entry("tools")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| anyhow!("base manifest tools must be an array"))?;
    if !tools
        .iter()
        .any(|existing| existing.get("name").and_then(Value::as_str) == Some(name))
    {
        tools.push(tool);
    }
    Ok(())
}

fn ensure_site_tool(manifest: &mut Value, tool: Value) -> Result<()> {
    ensure_advertised_tool(manifest, tool)
}

fn ensure_primitive_dictionary_tools(manifest: &mut Value) -> Result<()> {
    let primitive_tools = manifest
        .get("primitive_dictionary")
        .and_then(|dictionary| dictionary.get("primitives"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|primitive| primitive_dictionary_tool_manifest(&primitive));

    for tool in primitive_tools {
        ensure_advertised_tool(manifest, tool)?;
    }
    Ok(())
}

fn primitive_dictionary_tool_manifest(primitive: &Value) -> Option<Value> {
    let name = primitive.get("name").and_then(Value::as_str)?;
    if !extension_executor_supports_primitive(name) {
        return None;
    }
    let support = primitive.get("support").and_then(Value::as_str);
    if support == Some("unsupported") {
        return None;
    }
    let description = primitive
        .get("summary")
        .or_else(|| primitive.get("description"))
        .cloned()
        .unwrap_or_else(|| json!(format!("Execute the {name} primitive.")));
    let input_schema = primitive
        .get("input_schema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));

    Some(json!({
        "name": name,
        "description": description,
        "input_schema": input_schema
    }))
}

fn policy_exception_report_schema() -> Value {
    json!({
        "type": "object",
        "required": ["kind", "intended_tool", "actions_json_path", "reason"],
        "additionalProperties": false,
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["generic", "debugger"],
                "description": "Whether this is a generic fallback tool or debugger-level fallback."
            },
            "intended_tool": {
                "type": "string",
                "description": "The direct tool being called, such as pointer.click or browser.screenshot."
            },
            "actions_json_path": {
                "type": "string",
                "description": "The relevant actions.json action considered, or none/missing when no site action exists."
            },
            "reason": {
                "type": "string",
                "description": "Short justification for using this fallback instead of a site-specific actions.json action."
            }
        }
    })
}

fn bridge_payloads_configure_tool_manifest() -> Value {
    json!({
        "name": "bridge.payloads.configure",
        "description": "Read or set the bridge's MCP payload spill threshold. Tool results that serialize larger than inline_limit_bytes are written to the payload directory and returned as a compact envelope (path, bytes, hash, preview) instead of inline context. Pass inline_limit_bytes as a positive integer to set it, null to reset to the startup default, or omit it to read the current configuration.",
        "input_schema": {
            "type": "object",
            "properties": {
                "inline_limit_bytes": {
                    "type": ["integer", "null"],
                    "minimum": 1,
                    "description": "Maximum serialized result bytes returned inline on the MCP surface. null resets to the startup default."
                }
            },
            "additionalProperties": false
        }
    })
}

async fn bridge_payloads_configure_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let call_id = Uuid::new_v4().to_string();
    let arguments = request
        .arguments
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(unexpected) = arguments.keys().find(|key| *key != "inline_limit_bytes") {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "bridge.payloads.configure accepts only inline_limit_bytes.",
                json!({ "unexpected_argument": unexpected }),
            ),
        ));
    }
    let mut config = state.payload.lock().await;
    if let Some(value) = arguments.get("inline_limit_bytes") {
        if value.is_null() {
            config.inline_limit_bytes = config.default_inline_limit_bytes;
        } else if let Some(limit) = value.as_u64().filter(|limit| *limit >= 1) {
            config.inline_limit_bytes = usize::try_from(limit).unwrap_or(usize::MAX);
        } else {
            return Err((
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "inline_limit_bytes must be a positive integer or null.",
                    json!({ "inline_limit_bytes": value }),
                ),
            ));
        }
    }
    Ok(Json(ToolCallResponse {
        ok: true,
        call_id,
        output: Some(json!({
            "ok": true,
            "inline_limit_bytes": config.inline_limit_bytes,
            "default_inline_limit_bytes": config.default_inline_limit_bytes,
            "payload_dir": config.payload_dir.display().to_string(),
        })),
        error: None,
    }))
}

fn djb2_hash_hex(text: &str) -> String {
    let mut hash: u32 = 5381;
    for byte in text.as_bytes() {
        hash = hash.wrapping_mul(33) ^ u32::from(*byte);
    }
    format!("djb2:{hash:08x}")
}

async fn spill_payload_to_disk(dir: &Path, tool: &str, text: &str) -> Result<PathBuf> {
    fs::create_dir_all(dir).await?;
    let sanitized: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let path = dir.join(format!("{}-{sanitized}.json", Uuid::new_v4()));
    fs::write(&path, text).await?;
    Ok(path)
}

fn payload_spill_envelope(tool: &str, result: &Value, text: &str, limit: usize, path: &Path) -> Value {
    let preview: String = text.chars().take(800).collect();
    json!({
        "payload_spilled": true,
        "tool": tool,
        "ok": result.get("ok").cloned().unwrap_or(Value::Null),
        "payload_bytes": text.len(),
        "inline_limit_bytes": limit,
        "payload_path": path.display().to_string(),
        "payload_hash": djb2_hash_hex(text),
        "preview": preview,
        "hint": "Result exceeded inline_limit_bytes and was written to payload_path. Read or grep that file for the full result. Adjust the threshold with bridge.payloads.configure."
    })
}

fn direct_mcp_tool_requires_policy_exception_report(name: &str) -> bool {
    extension_executor_supports_primitive(name)
        && name != "actions.site"
        && !name.starts_with("runtime.agent.")
        && !name.starts_with("runtime.session.")
}

fn schema_with_policy_exception_report(schema: Value) -> Value {
    let mut schema = schema;
    let Some(object) = schema.as_object_mut() else {
        return json!({
            "type": "object",
            "required": ["policy_exception_report"],
            "properties": {
                "policy_exception_report": policy_exception_report_schema()
            }
        });
    };
    object
        .entry("type".to_string())
        .or_insert_with(|| json!("object"));
    let properties = object
        .entry("properties".to_string())
        .or_insert_with(|| json!({}));
    if !properties.is_object() {
        *properties = json!({});
    }
    properties
        .as_object_mut()
        .expect("properties was normalized to object")
        .insert(
            "policy_exception_report".to_string(),
            policy_exception_report_schema(),
        );

    let required = object
        .entry("required".to_string())
        .or_insert_with(|| json!([]));
    if !required.is_array() {
        *required = json!([]);
    }
    let required = required
        .as_array_mut()
        .expect("required was normalized to array");
    if !required
        .iter()
        .any(|item| item.as_str() == Some("policy_exception_report"))
    {
        required.push(json!("policy_exception_report"));
    }
    schema
}

fn advertised_input_schema_for_tool(tool: &Value) -> Value {
    let schema = tool
        .get("input_schema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    let Some(name) = tool.get("name").and_then(Value::as_str) else {
        return schema;
    };
    if direct_mcp_tool_requires_policy_exception_report(name) {
        schema_with_policy_exception_report(schema)
    } else {
        schema
    }
}

fn extension_executor_supports_primitive(name: &str) -> bool {
    matches!(
        name,
        "browser.screenshot"
            | "browser.extract_elements"
            | "browser.run_javascript"
            | "debug.run_javascript"
            | "locator.element_info"
            | "locator.text_content"
            | "locator.wait_for"
            | "viewport.scroll"
            | "pointer.click"
            | "pointer.move"
            | "pointer.double_click"
            | "pointer.drag"
            | "text.insert"
            | "transfer.write"
            | "transfer.read"
            | "transfer.clear"
            | "transfer.insert"
            | "storage.read_file"
            | "keyboard.press"
            | "page.info"
            | "dom.observe.visible"
            | "dom.list_sections"
            | "dom.snapshot_text"
            | "storage.import_bundle"
            | "storage.list"
            | "runtime.agent.user_message"
            | "runtime.agent.start"
            | "runtime.agent.stop"
            | "runtime.session.log"
    )
}

fn site_actions_tool_manifest() -> Value {
    json!({
        "name": "actions.site",
        "description": "List and invoke actions.json capabilities for the current or targeted website without advertising site-specific tools globally.",
        "input_schema": {
            "type": "object",
            "required": ["mode"],
            "additionalProperties": false,
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["list", "call", "state_read", "state_summary", "state_diff"],
                    "description": "Use list to inspect applicable site actions and state projections, call to invoke a listed action, or state_read/state_summary/state_diff to execute a listed state projection."
                },
                "action": {
                    "type": "string",
                    "description": "Site action name to invoke when mode is call."
                },
                "arguments": {
                    "type": "object",
                    "description": "Arguments forwarded to the selected site action when mode is call."
                },
                "projection_name": {
                    "type": "string",
                    "description": "State projection name required by state_read, state_summary, and state_diff modes."
                },
                "summary_name": {
                    "type": "string",
                    "description": "Optional declared summary name selected by state_summary mode."
                },
                "max_bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional response size budget forwarded to the state projection engine."
                },
                "target_url_contains": {
                    "type": "string",
                    "description": "Target page URL substring used to select the applicable site catalog and runtime."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional dispatch budget in milliseconds for the call. Defaults to 30000. Raise it for compound workflows that scroll the page to find an offscreen target."
                }
            }
        }
    })
}

fn storage_read_file_tool_manifest() -> Value {
    json!({
        "name": "storage.read_file",
        "description": "Read a declared text companion file from the configured actions.json.storage root. Use actions.site list first to discover declared files and skill front matter.",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Declared file id returned by actions.site list."
                },
                "path": {
                    "type": "string",
                    "description": "Declared storage-relative file path returned by actions.site list."
                },
                "max_bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Maximum text bytes to return. Defaults to 64000."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional dispatch budget in milliseconds for the call. Defaults to 30000."
                }
            }
        }
    })
}

fn runtime_session_log_tool_manifest() -> Value {
    json!({
        "name": "runtime.session.log",
        "description": "Return the extension-local hosted-agent session log, including recent transcript turns, tool calls, tool failures, Realtime errors, screenshots, and session lifecycle events.",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 80,
                    "default": 80
                }
            }
        }
    })
}

async fn effective_map_paths(
    explicit_map_paths: &[PathBuf],
    storage_root: Option<&Path>,
) -> Result<Vec<PathBuf>> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for path in explicit_map_paths {
        if seen.insert(path.clone()) {
            paths.push(path.clone());
        }
    }

    if let Some(storage_root) = storage_root {
        for path in discover_storage_action_maps(storage_root).await? {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }

    paths.sort();
    Ok(paths)
}

async fn discover_storage_action_maps(storage_root: &Path) -> Result<Vec<PathBuf>> {
    let mut stack = vec![storage_root.to_path_buf()];
    let mut maps = Vec::new();

    while let Some(directory) = stack.pop() {
        let mut entries = match fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to read actions storage directory {}",
                        directory.display()
                    )
                });
            }
        };

        while let Some(entry) = entries.next_entry().await.with_context(|| {
            format!(
                "failed to read actions storage directory entry in {}",
                directory.display()
            )
        })? {
            let path = entry.path();
            let file_type = entry.file_type().await.with_context(|| {
                format!("failed to inspect actions storage path {}", path.display())
            })?;
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if file_type.is_file()
                && path.file_name() == Some(OsStr::new("actions.json"))
                && path_has_sites_component(&path)
            {
                maps.push(path);
            }
        }
    }

    maps.sort();
    Ok(maps)
}

fn path_has_sites_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::Normal(name) if name == OsStr::new("sites")
        )
    })
}

fn validated_map_tools(map: &Value) -> Vec<Value> {
    if map.get("protocol").and_then(Value::as_str) != Some("actions.json") {
        return Vec::new();
    }

    map.get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(is_safe_tool_name)
                .unwrap_or(false)
                && tool
                    .get("input_schema")
                    .map(Value::is_object)
                    .unwrap_or(true)
        })
        .cloned()
        .collect()
}

fn is_safe_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
}

pub fn app_from_manifest_value_with_runtimes(
    manifest: Value,
    runtime_seeds: Vec<RuntimeSeed>,
) -> Router {
    app_from_state(
        state_from_catalog(
            ActionCatalog {
                base_manifest: manifest.clone(),
                map_paths: Vec::new(),
                manifest: manifest.clone(),
                site_manifest: manifest,
                site_action_names: HashSet::new(),
            },
            runtime_seeds,
            None,
        ),
        true,
    )
}

fn state_from_catalog(
    mut catalog: ActionCatalog,
    runtime_seeds: Vec<RuntimeSeed>,
    storage_root: Option<PathBuf>,
) -> AppState {
    ensure_advertised_tool(&mut catalog.manifest, runtime_session_log_tool_manifest())
        .expect("runtime.session.log tool must be insertable into advertised manifest");
    ensure_site_tool(
        &mut catalog.site_manifest,
        runtime_session_log_tool_manifest(),
    )
    .expect("runtime.session.log tool must be insertable into site manifest");
    ensure_advertised_tool(
        &mut catalog.manifest,
        bridge_payloads_configure_tool_manifest(),
    )
    .expect("bridge.payloads.configure tool must be insertable into advertised manifest");

    let timestamp = now_ms();
    let seeded_runtimes = runtime_seeds
        .into_iter()
        .map(|seed| {
            let (tx, _rx) = mpsc::unbounded_channel::<Message>();
            let runtime_id = seed.runtime_id;
            (
                runtime_id.clone(),
                RuntimeClient {
                    runtime_id,
                    connection_id: "test-connection".to_string(),
                    runtime_key: None,
                    authorization_id: None,
                    extension_version: None,
                    url: seed.url,
                    tab: None,
                    replay: None,
                    connected_at_ms: timestamp,
                    last_seen_ms: timestamp,
                    tx,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    AppState {
        catalog: Arc::new(Mutex::new(catalog)),
        storage_root,
        runtimes: Arc::new(Mutex::new(seeded_runtimes)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        last_replay_summary: Arc::new(Mutex::new(None)),
        last_credential_hydration: Arc::new(Mutex::new(None)),
        last_storage_hydration: Arc::new(Mutex::new(None)),
        pending_storage_hydrations: Arc::new(Mutex::new(HashMap::new())),
        payload: Arc::new(Mutex::new(PayloadSpillConfig::default())),
    }
}

fn app_from_state(state: AppState, include_legacy_tool_http_routes: bool) -> Router {
    let mut router = Router::new()
        .route("/health", get(health))
        .route("/runtimes", get(runtimes))
        .route("/extension", get(extension_ws));
    if include_legacy_tool_http_routes {
        router = router
            .route("/actions", get(actions))
            .route("/mcp/tools/list", get(tools_list).options(cors_preflight))
            .route(
                "/mcp/tools/resolve",
                post(tools_resolve).options(cors_preflight),
            )
            .route(
                "/mcp/tools/reload",
                post(tools_reload).options(cors_preflight),
            )
            .route("/mcp/tools/call", post(tools_call).options(cors_preflight));
    }
    router
        .layer(middleware::from_fn(add_cors_headers))
        .with_state(state)
}

async fn mcp_stdio_loop(state: AppState, launch: BridgeLaunchContext) -> Result<()> {
    let stdin = BufReader::new(io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = io::stdout();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => mcp_handle_jsonrpc(state.clone(), launch.clone(), request).await,
            Err(error) => Some(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": {
                    "code": -32700,
                    "message": "Parse error",
                    "data": { "message": error.to_string() }
                }
            })),
        };
        if let Some(response) = response {
            stdout
                .write_all(serde_json::to_string(&response)?.as_bytes())
                .await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
    }

    Ok(())
}

async fn mcp_handle_jsonrpc(
    state: AppState,
    launch: BridgeLaunchContext,
    request: Value,
) -> Option<Value> {
    let id = request.get("id").cloned();
    if id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return Some(mcp_error(id, -32600, "Invalid Request", json!({})));
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    let result = match method {
        "initialize" => Ok(mcp_initialize_result(&launch)),
        "notifications/initialized" => return None,
        "ping" => Ok(json!({})),
        "tools/list" => mcp_tools_list(&state).await,
        "tools/call" => mcp_tools_call(state, params).await,
        "resources/list" => mcp_resources_list(&state).await,
        "resources/read" => mcp_resources_read(&state, &launch, params).await,
        _ => Err(mcp_error_value(
            -32601,
            "Method not found",
            json!({ "method": method }),
        )),
    };

    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn mcp_initialize_result(launch: &BridgeLaunchContext) -> Value {
    json!({
        "protocolVersion": "2025-06-18",
        "capabilities": { "tools": {}, "resources": {} },
        "serverInfo": {
            "name": "actions-json-mcp",
            "title": "actions.json Browser Bridge",
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": format!(
            "This is the MCP interface for actions.json. Read actions-json://bridge/launch before operating. The browser extension must connect to ws://{}/extension. Agent tool calls should use MCP tools/list and tools/call, not legacy HTTP tool endpoints.",
            launch.bind
        )
    })
}

async fn mcp_tools_list(state: &AppState) -> Result<Value, Value> {
    let manifest = state.catalog.lock().await.manifest.clone();
    let tools = manifest
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.get("name").cloned().unwrap_or(Value::Null),
                "description": tool.get("description").cloned().unwrap_or(Value::String(String::new())),
                "inputSchema": advertised_input_schema_for_tool(&tool)
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "tools": tools }))
}

async fn mcp_tools_call(state: AppState, params: Value) -> Result<Value, Value> {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err(mcp_error_value(
            -32602,
            "Invalid params",
            json!({ "message": "tools/call requires params.name" }),
        ));
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let request = ToolCallRequest {
        name: name.to_string(),
        target_runtime_id: params
            .get("target_runtime_id")
            .and_then(Value::as_str)
            .or_else(|| arguments.get("target_runtime_id").and_then(Value::as_str))
            .map(str::to_string),
        target_url_contains: params
            .get("target_url_contains")
            .and_then(Value::as_str)
            .or_else(|| arguments.get("target_url_contains").and_then(Value::as_str))
            .map(str::to_string),
        timeout_ms: params
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .or_else(|| arguments.get("timeout_ms").and_then(Value::as_u64))
            .unwrap_or_else(default_timeout_ms),
        arguments,
    };

    let payload_config = state.payload.clone();
    let mut result = match tools_call(State(state), Json(request)).await {
        Ok(Json(response)) => json!(response),
        Err((status, Json(payload))) => json!({
            "ok": false,
            "status": status.as_u16(),
            "error": payload
        }),
    };
    let is_error = result.get("ok").and_then(Value::as_bool) == Some(false)
        || result
            .get("output")
            .and_then(|output| output.get("ok"))
            .and_then(Value::as_bool)
            == Some(false);
    let mut text =
        serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
    let (inline_limit, payload_dir) = {
        let config = payload_config.lock().await;
        (config.inline_limit_bytes, config.payload_dir.clone())
    };
    if text.len() > inline_limit {
        match spill_payload_to_disk(&payload_dir, name, &text).await {
            Ok(path) => {
                let envelope = payload_spill_envelope(name, &result, &text, inline_limit, &path);
                text = serde_json::to_string_pretty(&envelope)
                    .unwrap_or_else(|_| envelope.to_string());
            }
            Err(error) => {
                if let Some(object) = result.as_object_mut() {
                    object.insert(
                        "payload_spill_error".to_string(),
                        json!(error.to_string()),
                    );
                    text = serde_json::to_string_pretty(&result)
                        .unwrap_or_else(|_| result.to_string());
                }
            }
        }
    }
    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ],
        "isError": is_error
    }))
}

async fn mcp_resources_list(state: &AppState) -> Result<Value, Value> {
    let mut resources = vec![
        mcp_resource(
            "actions-json://bridge/launch",
            "Bridge launch context",
            "How this bridge was launched and how the extension should connect.",
            "application/json",
        ),
        mcp_resource(
            "actions-json://bridge/runtimes",
            "Connected browser runtimes",
            "Current extension runtimes and URLs.",
            "application/json",
        ),
        mcp_resource(
            "actions-json://bridge/tools",
            "Advertised MCP tools",
            "Current model-facing tool catalog.",
            "application/json",
        ),
        mcp_resource(
            "actions-json://storage/files",
            "Declared storage files",
            "Declared files and skill front matter from actions.json.storage.",
            "application/json",
        ),
    ];
    if let Some(storage_root) = state.storage_root.as_deref() {
        let (files, _) = site_storage_files_for_target(storage_root, None)
            .await
            .map_err(|(_, Json(payload))| {
                mcp_error_value(-32603, "Resource list failed", payload)
            })?;
        for file in files {
            if let Some(path) = file.get("path").and_then(Value::as_str) {
                resources.push(mcp_resource(
                    &format!("actions-json://storage/file/{}", percent_encode_path(path)),
                    file.get("title")
                        .and_then(Value::as_str)
                        .or_else(|| file.get("id").and_then(Value::as_str))
                        .unwrap_or(path),
                    file.get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("Declared actions.json storage file."),
                    if path.to_ascii_lowercase().ends_with(".md") {
                        "text/markdown"
                    } else {
                        "text/plain"
                    },
                ));
            }
        }
    }
    Ok(json!({ "resources": resources }))
}

fn mcp_resource(uri: &str, name: &str, description: &str, mime_type: &str) -> Value {
    json!({
        "uri": uri,
        "name": name,
        "description": description,
        "mimeType": mime_type
    })
}

async fn mcp_resources_read(
    state: &AppState,
    launch: &BridgeLaunchContext,
    params: Value,
) -> Result<Value, Value> {
    let Some(uri) = params.get("uri").and_then(Value::as_str) else {
        return Err(mcp_error_value(
            -32602,
            "Invalid params",
            json!({ "message": "resources/read requires params.uri" }),
        ));
    };
    let (mime_type, text) = match uri {
        "actions-json://bridge/launch" => (
            "application/json".to_string(),
            serde_json::to_string_pretty(&bridge_launch_resource(launch)).unwrap(),
        ),
        "actions-json://bridge/runtimes" => (
            "application/json".to_string(),
            serde_json::to_string_pretty(&bridge_runtimes_resource(state).await).unwrap(),
        ),
        "actions-json://bridge/tools" => (
            "application/json".to_string(),
            serde_json::to_string_pretty(&mcp_tools_list(state).await?).unwrap(),
        ),
        "actions-json://storage/files" => (
            "application/json".to_string(),
            serde_json::to_string_pretty(&storage_files_resource(state).await?).unwrap(),
        ),
        _ if uri.starts_with("actions-json://storage/file/") => {
            let encoded = uri.trim_start_matches("actions-json://storage/file/");
            let path = percent_decode_path(encoded).map_err(|message| {
                mcp_error_value(
                    -32602,
                    "Invalid resource URI",
                    json!({ "message": message }),
                )
            })?;
            let Some(storage_root) = state.storage_root.as_deref() else {
                return Err(mcp_error_value(
                    -32602,
                    "Storage root unavailable",
                    json!({ "uri": uri }),
                ));
            };
            let result = read_declared_storage_file(
                storage_root,
                None,
                &json!({ "path": path, "max_bytes": 128000 }),
            )
            .await
            .map_err(|(_, Json(payload))| {
                mcp_error_value(-32603, "Storage read failed", payload)
            })?;
            let value = result
                .map_err(|error| mcp_error_value(-32602, "Storage file unavailable", error))?;
            let mime_type = value
                .get("mime_type")
                .and_then(Value::as_str)
                .unwrap_or("text/plain")
                .to_string();
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            (mime_type, text)
        }
        _ => {
            return Err(mcp_error_value(
                -32602,
                "Unknown resource URI",
                json!({ "uri": uri }),
            ));
        }
    };
    Ok(json!({
        "contents": [
            {
                "uri": uri,
                "mimeType": mime_type,
                "text": text
            }
        ]
    }))
}

fn bridge_launch_resource(launch: &BridgeLaunchContext) -> Value {
    json!({
        "service": "actions-json-mcp",
        "mode": "mcp",
        "protocol_version": "2025-06-18",
        "bind": launch.bind.to_string(),
        "extension_websocket": format!("ws://{}/extension", launch.bind),
        "actions_manifest": launch.actions_path.display().to_string(),
        "map_paths": launch
            .map_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>(),
        "storage_root": launch
            .storage_root
            .as_ref()
            .map(|path| path.display().to_string()),
        "agent_interface": "MCP stdio. Use tools/list, tools/call, resources/list, and resources/read.",
        "browser_transport_routes": ["/health", "/runtimes", "/extension"],
        "local_openai_key_sources": [
            "ACTIONS_JSON_OPENAI_API_KEY",
            ".actions-json.local.json"
        ],
        "verification": [
            "Read actions-json://bridge/tools before site validation.",
            "Read actions-json://bridge/runtimes to confirm the browser tab is connected.",
            "Read actions-json://storage/files to discover neighboring skills and references."
        ]
    })
}

async fn bridge_runtimes_resource(state: &AppState) -> Value {
    let runtimes = state.runtimes.lock().await;
    let last_replay_summary = state.last_replay_summary.lock().await.clone();
    let credential_hydration = state.last_credential_hydration.lock().await.clone();
    let storage_hydration = state.last_storage_hydration.lock().await.clone();
    json!({
        "connected": !runtimes.is_empty(),
        "count": runtimes.len(),
        "runtimes": runtime_summaries(&runtimes),
        "last_replay_summary": last_replay_summary,
        "credential_hydration": credential_hydration,
        "storage_hydration": storage_hydration
    })
}

async fn storage_files_resource(state: &AppState) -> Result<Value, Value> {
    let Some(storage_root) = state.storage_root.as_deref() else {
        return Ok(json!({ "files": [], "skills": [] }));
    };
    let (files, skills) = site_storage_files_for_target(storage_root, None)
        .await
        .map_err(|(_, Json(payload))| mcp_error_value(-32603, "Storage files failed", payload))?;
    Ok(json!({ "files": files, "skills": skills }))
}

fn mcp_error(id: Value, code: i64, message: &str, data: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": mcp_error_value(code, message, data)
    })
}

fn mcp_error_value(code: i64, message: &str, data: Value) -> Value {
    json!({
        "code": code,
        "message": message,
        "data": data
    })
}

fn percent_encode_path(path: &str) -> String {
    let mut encoded = String::new();
    for byte in path.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~' | '/') {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn percent_decode_path(path: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    let path_bytes = path.as_bytes();
    let mut index = 0;
    while index < path_bytes.len() {
        if path_bytes[index] == b'%' {
            if index + 2 >= path_bytes.len() {
                return Err("incomplete percent escape".to_string());
            }
            let hex = std::str::from_utf8(&path_bytes[index + 1..index + 3])
                .map_err(|_| "invalid percent escape".to_string())?;
            let value =
                u8::from_str_radix(hex, 16).map_err(|_| "invalid percent escape".to_string())?;
            bytes.push(value);
            index += 3;
        } else {
            bytes.push(path_bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "resource path is not UTF-8".to_string())
}

#[allow(dead_code)]
fn app_from_manifest_value_with_storage_root(
    catalog: ActionCatalog,
    runtime_seeds: Vec<RuntimeSeed>,
    storage_root: Option<PathBuf>,
) -> Router {
    app_from_state(
        state_from_catalog(catalog, runtime_seeds, storage_root),
        true,
    )
}

async fn cors_preflight() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, cors_headers())
}

async fn add_cors_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in cors_headers() {
        response.headers_mut().insert(name, value);
    }
    response
}

fn cors_headers() -> [(header::HeaderName, HeaderValue); 5] {
    [
        (
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        ),
        (
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        ),
        (
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type"),
        ),
        (
            header::HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        ),
        (header::VARY, HeaderValue::from_static("Origin")),
    ]
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "actions-json-mcp", "version": env!("CARGO_PKG_VERSION") }))
}

async fn actions(State(state): State<AppState>) -> Json<Value> {
    Json(state.catalog.lock().await.manifest.clone())
}

async fn runtimes(State(state): State<AppState>) -> Json<Value> {
    let runtimes = state.runtimes.lock().await;
    let clients = runtime_summaries(&runtimes);
    Json(json!({
        "connected": !clients.is_empty(),
        "count": clients.len(),
        "runtimes": clients
    }))
}

async fn tools_list(State(state): State<AppState>) -> Json<Value> {
    let manifest = state.catalog.lock().await.manifest.clone();
    let tools = manifest
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.get("name").cloned().unwrap_or(Value::Null),
                "description": tool.get("description").cloned().unwrap_or(Value::Null),
                "input_schema": advertised_input_schema_for_tool(&tool)
            })
        })
        .collect::<Vec<_>>();

    Json(json!({ "tools": tools }))
}

async fn tools_reload(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let tool_count = reload_catalog(&state).await?;
    Ok(Json(json!({
        "ok": true,
        "reloaded": true,
        "tool_count": tool_count
    })))
}

async fn reload_catalog(state: &AppState) -> Result<usize, (StatusCode, Json<Value>)> {
    let (base_manifest, map_paths) = {
        let catalog = state.catalog.lock().await;
        (catalog.base_manifest.clone(), catalog.map_paths.clone())
    };
    let (manifest, site_manifest, site_action_names) =
        build_catalog_manifests(base_manifest, &map_paths, state.storage_root.as_deref())
            .await
            .map_err(|error| {
                (
                    StatusCode::BAD_REQUEST,
                    structured_error(
                        "invalid_input",
                        "Failed to reload actions catalog.",
                        json!({ "message": error.to_string() }),
                    ),
                )
            })?;
    let tool_count = manifest
        .get("tools")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    {
        let mut catalog = state.catalog.lock().await;
        catalog.manifest = manifest;
        catalog.site_manifest = site_manifest;
        catalog.site_action_names = site_action_names;
    }
    Ok(tool_count)
}

async fn tools_resolve(
    State(state): State<AppState>,
    Json(request): Json<ToolCallRequest>,
) -> Result<Json<ResolvedToolCall>, (StatusCode, Json<Value>)> {
    Ok(Json(
        resolve_tool_call_with_storage(&state, &request).await?,
    ))
}

async fn tools_call(
    State(state): State<AppState>,
    Json(mut request): Json<ToolCallRequest>,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    if request.name == "actions.site" {
        return site_actions_call(state, request).await;
    }
    if request.name == "storage.read_file" {
        request.arguments = validate_and_strip_policy_exception_report(&request.name, &request.arguments)?;
        return storage_read_file_call(state, request).await;
    }
    if request.name == "bridge.payloads.configure" {
        return bridge_payloads_configure_call(state, request).await;
    }

    let resolved = if request.name == "storage.sync" {
        reload_catalog(&state).await?;
        let storage_root = state.storage_root.clone().ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "storage.sync requires bridge --storage-root" })),
            )
        })?;
        let bundle = storage_bundle_from_root(storage_root)
            .await
            .map_err(|error| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "failed to build storage bundle",
                        "message": error.to_string()
                    })),
                )
            })?;
        ResolvedToolCall {
            name: "storage.import_bundle".to_string(),
            arguments: json!({ "bundle": bundle }),
            target_runtime_id: request.target_runtime_id.clone(),
            target_url_contains: request.target_url_contains.clone(),
            timeout_ms: request.timeout_ms,
            static_output: None,
        }
    } else {
        resolve_tool_call_with_storage(&state, &request).await?
    };
    dispatch_resolved_tool_call(&state, resolved).await
}

async fn dispatch_resolved_tool_call(
    state: &AppState,
    resolved: ResolvedToolCall,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let call_id = Uuid::new_v4().to_string();
    if let Some(output) = resolved.static_output {
        return Ok(Json(ToolCallResponse {
            ok: true,
            call_id,
            output: Some(output),
            error: None,
        }));
    }
    let runtime = select_runtime(state, &resolved).await?;

    let (response_tx, response_rx) = oneshot::channel::<Value>();
    state.pending.lock().await.insert(
        call_id.clone(),
        PendingCall {
            runtime_id: runtime.runtime_id.clone(),
            tx: response_tx,
        },
    );

    let item = action_call_message(
        call_id.clone(),
        runtime.runtime_id.clone(),
        resolved.name,
        resolved.arguments,
    );

    if runtime.tx.send(Message::Text(item.to_string())).is_err() {
        state.pending.lock().await.remove(&call_id);
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "failed to send action to extension runtime",
                "runtime_id": runtime.runtime_id
            })),
        ));
    }

    let result = tokio::time::timeout(Duration::from_millis(resolved.timeout_ms), response_rx)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "error": "action timed out", "call_id": call_id })),
            )
        })?
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "extension runtime dropped response", "call_id": call_id })),
            )
        })?;

    let is_error = result.get("type").and_then(Value::as_str) == Some("action_error");
    Ok(Json(ToolCallResponse {
        ok: !is_error,
        call_id,
        output: result.get("output").cloned(),
        error: result.get("error").cloned(),
    }))
}

fn resolve_tool_call(
    manifest: &Value,
    request: &ToolCallRequest,
) -> Result<ResolvedToolCall, (StatusCode, Json<Value>)> {
    let Some(tool) = find_tool(manifest, &request.name) else {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "unknown_action",
                "Requested tool is not declared in the loaded actions catalog.",
                json!({ "tool": request.name }),
            ),
        ));
    };
    let request_arguments = validate_and_prepare_direct_tool_arguments(tool, request)?;

    let handler = tool
        .get("x_actions")
        .and_then(|x_actions| x_actions.get("handler"))
        .and_then(Value::as_str);
    let Some(handler) = handler else {
        if let Some(output) = tool
            .get("x_actions")
            .and_then(|x_actions| x_actions.get("static_output"))
            .cloned()
        {
            return Ok(ResolvedToolCall {
                name: request.name.clone(),
                arguments: request_arguments.clone(),
                target_runtime_id: request.target_runtime_id.clone(),
                target_url_contains: request.target_url_contains.clone(),
                timeout_ms: request.timeout_ms,
                static_output: Some(output),
            });
        }
        if stored_tool_execution_mode(tool) == Some("state_machine") {
            return Ok(resolve_state_machine_tool(tool, request));
        }
        if stored_tool_execution_mode(tool) == Some("navigation") {
            return Err((
                StatusCode::NOT_IMPLEMENTED,
                structured_error(
                    "unsupported_execution_mode",
                    "Stored action declares navigation steps, but step execution is not enabled in this runtime slice.",
                    json!({
                        "tool": request.name,
                        "mode": "navigation"
                    }),
                ),
            ));
        }
        return Ok(ResolvedToolCall {
            arguments: request_arguments,
            ..unresolved_tool_call(request)
        });
    };

    if !tool_exists(manifest, handler) {
        return Ok(unresolved_tool_call(request));
    }

    let binding = tool
        .get("x_actions")
        .and_then(|x_actions| x_actions.get("binding"));
    let binding_arguments = binding
        .and_then(|binding| binding.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let target_url_contains = request.target_url_contains.clone().or_else(|| {
        binding
            .and_then(|binding| binding.get("target_url_contains"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });

    Ok(ResolvedToolCall {
        name: handler.to_string(),
        arguments: merge_object_values(binding_arguments, request_arguments).map_err(
            |error| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": error,
                        "tool": request.name
                    })),
                )
            },
        )?,
        target_runtime_id: request.target_runtime_id.clone(),
        target_url_contains,
        timeout_ms: request.timeout_ms,
        static_output: None,
    })
}

async fn resolve_tool_call_with_storage(
    state: &AppState,
    request: &ToolCallRequest,
) -> Result<ResolvedToolCall, (StatusCode, Json<Value>)> {
    let (manifest, site_manifest) = {
        let catalog = state.catalog.lock().await;
        (catalog.manifest.clone(), catalog.site_manifest.clone())
    };
    let mut resolved = match resolve_tool_call(&manifest, request) {
        Ok(resolved) => resolved,
        Err((status, payload))
            if status == StatusCode::BAD_REQUEST
                && payload["error"]["code"].as_str() == Some("unknown_action") =>
        {
            resolve_tool_call(&site_manifest, request)?
        }
        Err(error) => return Err(error),
    };
    if resolved.name == "overlay.open" || resolved.name == "overlay.register_launcher" {
        enrich_storage_overlay(state, &mut resolved).await?;
    }
    if resolved.name != request.name {
        if let Some(tool) = find_tool(&site_manifest, &resolved.name)
            .or_else(|| find_tool(&manifest, &resolved.name))
        {
            validate_tool_arguments(tool, &resolved.name, &resolved.arguments)?;
        }
    }
    Ok(resolved)
}

async fn site_actions_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let mode = request
        .arguments
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "actions.site requires arguments.mode.",
                    json!({ "tool": "actions.site" }),
                ),
            )
        })?;
    let target_url_contains = site_action_target_url_contains(&request);

    if mode == "list" {
        let (site_manifest, site_action_names) = {
            let catalog = state.catalog.lock().await;
            (
                catalog.site_manifest.clone(),
                catalog.site_action_names.clone(),
            )
        };
        let actions = site_actions_for_target(
            &site_manifest,
            &site_action_names,
            target_url_contains.as_deref(),
        );
        let (files, skills) = match state.storage_root.as_deref() {
            Some(storage_root) => {
                site_storage_files_for_target(storage_root, target_url_contains.as_deref()).await?
            }
            None => (Vec::new(), Vec::new()),
        };
        let state_projections = match state.storage_root.as_deref() {
            Some(storage_root) => state_projection_listing(
                &site_storage_state_projections_for_target(
                    storage_root,
                    target_url_contains.as_deref(),
                )
                .await?,
            ),
            None => Vec::new(),
        };
        return Ok(Json(ToolCallResponse {
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "ok": true,
                "target_url_contains": target_url_contains,
                "actions": actions,
                "state_projections": state_projections,
                "files": files,
                "skills": skills
            })),
            error: None,
        }));
    }

    if matches!(mode, "state_read" | "state_summary" | "state_diff") {
        let mode = mode.to_string();
        return site_actions_state_projection_call(state, request, mode, target_url_contains)
            .await;
    }

    if mode != "call" {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site mode must be list, call, state_read, state_summary, or state_diff.",
                json!({ "mode": mode }),
            ),
        ));
    }

    // Accept the canonical top-level `action`, the legacy `action_name`, and
    // the model-habitual `name` (the MCP tools/call convention models reach
    // for). A nested `arguments.action` is lifted out when nothing top-level
    // names the action, and a nested duplicate of the resolved action name is
    // stripped so it cannot collide with the action's own input schema.
    let nested_arguments = request
        .arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let top_level_action = ["action", "action_name", "name"]
        .iter()
        .find_map(|key| request.arguments.get(*key).and_then(Value::as_str))
        .map(str::to_string);
    let nested_action = nested_arguments
        .get("action")
        .and_then(Value::as_str)
        .map(str::to_string);
    let action = top_level_action
        .clone()
        .or_else(|| nested_action.clone())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "actions.site call mode needs the site action name in the top-level 'action' parameter, for example {\"mode\": \"call\", \"action\": \"site.do.thing\", \"arguments\": {}}. Get valid action names from actions.site with mode 'list'.",
                    json!({ "tool": "actions.site" }),
                ),
            )
        })?;
    let mut arguments = nested_arguments;
    let lifted_nested_only = top_level_action.is_none() && nested_action.is_some();
    let nested_duplicates_action = nested_action.as_deref() == Some(action.as_str());
    if lifted_nested_only || nested_duplicates_action {
        if let Some(map) = arguments.as_object_mut() {
            map.remove("action");
        }
    }
    {
        let catalog = state.catalog.lock().await;
        if !catalog.site_action_names.contains(&action) {
            return Err((
                StatusCode::BAD_REQUEST,
                structured_error(
                    "unknown_action",
                    "Requested site action is not declared in the loaded actions storage catalog.",
                    json!({ "tool": action }),
                ),
            ));
        }
    }
    let inner = ToolCallRequest {
        name: action,
        arguments,
        target_runtime_id: request.target_runtime_id.clone(),
        target_url_contains,
        timeout_ms: request.timeout_ms,
    };
    let site_manifest = state.catalog.lock().await.site_manifest.clone();
    let mut resolved = resolve_tool_call(&site_manifest, &inner)?;
    if resolved.name == "overlay.open" {
        enrich_storage_overlay(&state, &mut resolved).await?;
    }
    if resolved.name != inner.name {
        if let Some(tool) = find_tool(&site_manifest, &resolved.name) {
            validate_tool_arguments(tool, &resolved.name, &resolved.arguments)?;
        }
    }
    let unresolved_workflow_action = resolved.name == inner.name
        && resolved.static_output.is_none()
        && find_tool(&site_manifest, &inner.name)
            .map(|tool| {
                tool.get("workflow").is_some()
                    && tool
                        .get("x_actions")
                        .and_then(|x_actions| x_actions.get("handler"))
                        .is_none()
            })
            .unwrap_or(false);
    if unresolved_workflow_action {
        if let Some(storage_root) = state.storage_root.as_deref() {
            let mut maps = site_storage_workflow_maps_for_action(
                storage_root,
                &resolved.name,
                resolved.target_url_contains.as_deref(),
            )
            .await?;
            if maps.len() > 1 {
                let map_paths = maps.iter().map(|(path, _)| path.clone()).collect::<Vec<_>>();
                return Err((
                    StatusCode::CONFLICT,
                    structured_error(
                        "site_action_ambiguous",
                        "Multiple storage maps declare this workflow action; disambiguate with target_url_contains.",
                        json!({ "action": resolved.name, "map_paths": map_paths }),
                    ),
                ));
            }
            if let Some((map_path, map)) = maps.pop() {
                let dispatch = SiteActionDispatch {
                    action: resolved.name.clone(),
                    arguments: resolved.arguments.clone(),
                    map_path,
                    map,
                };
                return dispatch_site_action_call(&state, resolved, dispatch).await;
            }
        }
    }
    dispatch_resolved_tool_call(&state, resolved).await
}

async fn site_actions_state_projection_call(
    state: AppState,
    request: ToolCallRequest,
    mode: String,
    target_url_contains: Option<String>,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let Some(storage_root) = state.storage_root.clone() else {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site state modes require a configured actions.json storage root.",
                json!({ "mode": mode }),
            ),
        ));
    };
    let projection_name = request
        .arguments
        .get("projection_name")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "actions.site state modes require arguments.projection_name.",
                    json!({ "mode": mode }),
                ),
            )
        })?
        .to_string();
    let summary_name = request
        .arguments
        .get("summary_name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let max_bytes = request.arguments.get("max_bytes").and_then(Value::as_u64);

    let projections =
        site_storage_state_projections_for_target(&storage_root, target_url_contains.as_deref())
            .await?;
    let matches: Vec<&(String, Value)> = projections
        .iter()
        .filter(|(_, projection)| {
            projection.get("name").and_then(Value::as_str) == Some(projection_name.as_str())
        })
        .collect();
    if matches.is_empty() {
        let known: Vec<Value> = projections
            .iter()
            .filter_map(|(_, projection)| projection.get("name").cloned())
            .collect();
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "state_projection_not_found",
                "Requested state projection is not declared in the loaded actions storage maps.",
                json!({
                    "projection_name": projection_name,
                    "known_projections": known
                }),
            ),
        ));
    }
    if matches.len() > 1 {
        let map_paths: Vec<&String> = matches.iter().map(|(map_path, _)| map_path).collect();
        return Err((
            StatusCode::CONFLICT,
            structured_error(
                "state_projection_ambiguous",
                "Multiple storage maps declare this state projection name.",
                json!({
                    "projection_name": projection_name,
                    "map_paths": map_paths
                }),
            ),
        ));
    }
    let (map_path, projection) = matches[0].clone();
    let routing = ResolvedToolCall {
        name: format!("actions.site.{mode}"),
        arguments: json!({}),
        target_runtime_id: request.target_runtime_id.clone(),
        target_url_contains,
        timeout_ms: request.timeout_ms,
        static_output: None,
    };
    let dispatch = StateProjectionDispatch {
        mode,
        projection_name,
        summary_name,
        max_bytes,
        map_path,
        projection,
    };
    dispatch_state_projection_call(&state, routing, dispatch).await
}

async fn dispatch_state_projection_call(
    state: &AppState,
    routing: ResolvedToolCall,
    dispatch: StateProjectionDispatch,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let call_id = Uuid::new_v4().to_string();
    let runtime = select_runtime(state, &routing).await?;

    let (response_tx, response_rx) = oneshot::channel::<Value>();
    state.pending.lock().await.insert(
        call_id.clone(),
        PendingCall {
            runtime_id: runtime.runtime_id.clone(),
            tx: response_tx,
        },
    );

    let item = state_projection_call_message(call_id.clone(), runtime.runtime_id.clone(), &dispatch);

    if runtime.tx.send(Message::Text(item.to_string())).is_err() {
        state.pending.lock().await.remove(&call_id);
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "failed to send state projection call to extension runtime",
                "runtime_id": runtime.runtime_id
            })),
        ));
    }

    let result = tokio::time::timeout(Duration::from_millis(routing.timeout_ms), response_rx)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "error": "state projection call timed out", "call_id": call_id })),
            )
        })?
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "extension runtime dropped response", "call_id": call_id })),
            )
        })?;

    let is_error = result.get("type").and_then(Value::as_str) == Some("action_error");
    Ok(Json(ToolCallResponse {
        ok: !is_error,
        call_id,
        output: result.get("output").cloned(),
        error: result.get("error").cloned(),
    }))
}

async fn storage_read_file_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let Some(storage_root) = state.storage_root.as_deref() else {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "storage.read_file requires bridge --storage-root.",
                json!({ "tool": "storage.read_file" }),
            ),
        ));
    };
    let target_url_contains = site_action_target_url_contains(&request);
    let result = read_declared_storage_file(
        storage_root,
        target_url_contains.as_deref(),
        &request.arguments,
    )
    .await?;

    Ok(Json(ToolCallResponse {
        ok: true,
        call_id: Uuid::new_v4().to_string(),
        output: Some(match result {
            Ok(value) => json!({
                "ok": true,
                "primitive": "storage.read_file",
                "adapter": "bridge",
                "value": value
            }),
            Err(error) => json!({
                "ok": false,
                "primitive": "storage.read_file",
                "adapter": "bridge",
                "error": error
            }),
        }),
        error: None,
    }))
}

fn site_action_target_url_contains(request: &ToolCallRequest) -> Option<String> {
    request.target_url_contains.clone().or_else(|| {
        request
            .arguments
            .get("target_url_contains")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

async fn site_storage_files_for_target(
    storage_root: &Path,
    target_url_contains: Option<&str>,
) -> Result<(Vec<Value>, Vec<Value>), (StatusCode, Json<Value>)> {
    let maps = effective_map_paths(&[], Some(storage_root))
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "Failed to inspect actions.json storage maps.",
                    json!({ "message": error.to_string() }),
                ),
            )
        })?;
    let mut files = Vec::new();
    let mut skills = Vec::new();
    for map_path in maps {
        if !storage_map_matches_target(&map_path, target_url_contains) {
            continue;
        }
        let text = fs::read_to_string(&map_path).await.map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "Failed to read actions.json storage map.",
                    json!({ "path": map_path.display().to_string(), "message": error.to_string() }),
                ),
            )
        })?;
        let map: Value = serde_json::from_str(&text).map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "Failed to parse actions.json storage map.",
                    json!({ "path": map_path.display().to_string(), "message": error.to_string() }),
                ),
            )
        })?;
        if map.get("protocol").and_then(Value::as_str) != Some("actions.json") {
            continue;
        }
        let declarations = map
            .get("x_actions")
            .and_then(|x_actions| x_actions.get("files"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for declaration in declarations {
            let Some(file) = declared_storage_file(storage_root, &map_path, declaration).await?
            else {
                continue;
            };
            if is_skill_file(&file) {
                let content = read_storage_text(storage_root, file["path"].as_str().unwrap_or(""))
                    .await
                    .unwrap_or_default();
                skills.push(json!({
                    "id": file.get("id").cloned().unwrap_or(Value::Null),
                    "path": file.get("path").cloned().unwrap_or(Value::Null),
                    "relative_path": file.get("relative_path").cloned().unwrap_or(Value::Null),
                    "kind": "skill",
                    "description": file.get("description").cloned().unwrap_or(Value::Null),
                    "read_when": file.get("read_when").cloned().unwrap_or(Value::Null),
                    "front_matter": parse_markdown_front_matter(&content)
                }));
            }
            files.push(file);
        }
    }
    Ok((files, skills))
}

async fn site_storage_workflow_maps_for_action(
    storage_root: &Path,
    action: &str,
    target_url_contains: Option<&str>,
) -> Result<Vec<(String, Value)>, (StatusCode, Json<Value>)> {
    let maps = effective_map_paths(&[], Some(storage_root))
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "Failed to inspect actions.json storage maps.",
                    json!({ "message": error.to_string() }),
                ),
            )
        })?;
    let mut matches = Vec::new();
    for map_path in maps {
        if !storage_map_matches_target(&map_path, target_url_contains) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&map_path).await else {
            continue;
        };
        let Ok(map) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if map.get("protocol").and_then(Value::as_str) != Some("actions.json") {
            continue;
        }
        let declares_workflow_action = map
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|tool| {
                tool.get("name").and_then(Value::as_str) == Some(action)
                    && tool.get("workflow").is_some()
            });
        if !declares_workflow_action {
            continue;
        }
        let relative_path = map_path
            .strip_prefix(storage_root)
            .unwrap_or(&map_path)
            .to_string_lossy()
            .to_string();
        matches.push((relative_path, map));
    }
    Ok(matches)
}

async fn dispatch_site_action_call(
    state: &AppState,
    routing: ResolvedToolCall,
    dispatch: SiteActionDispatch,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let call_id = Uuid::new_v4().to_string();
    let runtime = select_runtime(state, &routing).await?;

    let (response_tx, response_rx) = oneshot::channel::<Value>();
    state.pending.lock().await.insert(
        call_id.clone(),
        PendingCall {
            runtime_id: runtime.runtime_id.clone(),
            tx: response_tx,
        },
    );

    let item = site_action_call_message(call_id.clone(), runtime.runtime_id.clone(), &dispatch);

    if runtime.tx.send(Message::Text(item.to_string())).is_err() {
        state.pending.lock().await.remove(&call_id);
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "failed to send site action call to extension runtime",
                "runtime_id": runtime.runtime_id
            })),
        ));
    }

    let result = tokio::time::timeout(Duration::from_millis(routing.timeout_ms), response_rx)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "error": "site action call timed out", "call_id": call_id })),
            )
        })?
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "extension runtime dropped response", "call_id": call_id })),
            )
        })?;

    let is_error = result.get("type").and_then(Value::as_str) == Some("action_error");
    Ok(Json(ToolCallResponse {
        ok: !is_error,
        call_id,
        output: result.get("output").cloned(),
        error: result.get("error").cloned(),
    }))
}

async fn site_storage_state_projections_for_target(
    storage_root: &Path,
    target_url_contains: Option<&str>,
) -> Result<Vec<(String, Value)>, (StatusCode, Json<Value>)> {
    let maps = effective_map_paths(&[], Some(storage_root))
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "Failed to inspect actions.json storage maps.",
                    json!({ "message": error.to_string() }),
                ),
            )
        })?;
    let mut projections = Vec::new();
    for map_path in maps {
        if !storage_map_matches_target(&map_path, target_url_contains) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&map_path).await else {
            continue;
        };
        let Ok(map) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if map.get("protocol").and_then(Value::as_str) != Some("actions.json") {
            continue;
        }
        let relative_path = map_path
            .strip_prefix(storage_root)
            .unwrap_or(&map_path)
            .to_string_lossy()
            .to_string();
        let declared = map
            .get("state_projections")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for projection in declared {
            if projection.get("name").and_then(Value::as_str).is_none() {
                continue;
            }
            projections.push((relative_path.clone(), projection.clone()));
        }
    }
    Ok(projections)
}

fn state_projection_listing(projections: &[(String, Value)]) -> Vec<Value> {
    projections
        .iter()
        .map(|(map_path, projection)| {
            let summaries = projection
                .get("summaries")
                .and_then(Value::as_array)
                .map(|summaries| {
                    summaries
                        .iter()
                        .map(|summary| {
                            json!({
                                "name": summary.get("name").cloned().unwrap_or(Value::Null),
                                "description": summary.get("description").cloned().unwrap_or(Value::Null),
                                "max_bytes": summary.get("max_bytes").cloned().unwrap_or(Value::Null)
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "name": projection.get("name").cloned().unwrap_or(Value::Null),
                "description": projection.get("description").cloned().unwrap_or(Value::Null),
                "summaries": summaries,
                "map_path": map_path
            })
        })
        .collect()
}

async fn declared_storage_file(
    storage_root: &Path,
    map_path: &Path,
    declaration: &Value,
) -> Result<Option<Value>, (StatusCode, Json<Value>)> {
    let Some(relative_path) = declaration.get("path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(storage_path) = declared_storage_relative_path(storage_root, map_path, relative_path)
    else {
        return Ok(None);
    };
    let path = safe_storage_path(storage_root, &storage_path)
        .map_err(|error| storage_path_error_response(&storage_path, error))?;
    if !path.is_file() {
        return Ok(None);
    }
    let size_bytes = std_fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(Some(json!({
        "id": declaration.get("id").cloned().unwrap_or(Value::Null),
        "path": storage_path,
        "relative_path": relative_path,
        "kind": declaration.get("kind").and_then(Value::as_str).unwrap_or("reference"),
        "title": declaration.get("title").cloned().unwrap_or(Value::Null),
        "description": declaration.get("description").cloned().unwrap_or(Value::Null),
        "read_when": declaration.get("read_when").cloned().unwrap_or(Value::Null),
        "size_bytes": size_bytes
    })))
}

fn declared_storage_relative_path(
    storage_root: &Path,
    map_path: &Path,
    declared_path: &str,
) -> Option<String> {
    let normalized = declared_path
        .trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    if normalized.is_empty()
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    if normalized.starts_with("scopes/") {
        return Some(normalized);
    }
    let candidate = map_path.parent()?.join(normalized);
    let root = storage_root.canonicalize().ok()?;
    let parent = candidate.parent()?.canonicalize().ok()?;
    if !parent.starts_with(&root) {
        return None;
    }
    Some(
        candidate
            .strip_prefix(&root)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/"),
    )
}

fn storage_map_matches_target(map_path: &Path, target_url_contains: Option<&str>) -> bool {
    let Some(target) = target_url_contains else {
        return true;
    };
    let Some(host) = storage_map_site_host(map_path) else {
        return true;
    };
    target.contains(host.as_str()) || host.contains(target)
}

fn storage_map_site_host(map_path: &Path) -> Option<String> {
    let mut components = map_path.components();
    while let Some(component) = components.next() {
        if matches!(component, Component::Normal(name) if name == OsStr::new("sites")) {
            let Some(Component::Normal(host)) = components.next() else {
                return None;
            };
            return Some(host.to_string_lossy().to_string());
        }
    }
    None
}

fn stamp_default_target_url_contains(tool: &mut Value, site_host: &str) {
    let Some(tool_object) = tool.as_object_mut() else {
        return;
    };
    let x_actions = tool_object.entry("x_actions").or_insert_with(|| json!({}));
    let Some(x_actions_object) = x_actions.as_object_mut() else {
        return;
    };
    let binding = x_actions_object
        .entry("binding")
        .or_insert_with(|| json!({}));
    let Some(binding_object) = binding.as_object_mut() else {
        return;
    };
    binding_object
        .entry("target_url_contains".to_string())
        .or_insert_with(|| json!(site_host));
}

async fn read_declared_storage_file(
    storage_root: &Path,
    target_url_contains: Option<&str>,
    arguments: &Value,
) -> Result<Result<Value, Value>, (StatusCode, Json<Value>)> {
    let id = arguments.get("id").and_then(Value::as_str);
    let path = arguments.get("path").and_then(Value::as_str);
    if id.is_some() == path.is_some() {
        return Ok(Err(json!({
            "code": "invalid_input",
            "message": "storage.read_file requires exactly one of id or path.",
            "recoverable": true
        })));
    }
    let (files, _) = site_storage_files_for_target(storage_root, target_url_contains).await?;
    let matches = files
        .into_iter()
        .filter(|file| {
            id.map(|id| file.get("id").and_then(Value::as_str) == Some(id))
                .unwrap_or_else(|| path == file.get("path").and_then(Value::as_str))
        })
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Ok(Err(json!({
            "code": "storage_file_ambiguous_id",
            "message": "Multiple storage files matched the requested id.",
            "recoverable": true
        })));
    }
    let Some(file) = matches.into_iter().next() else {
        return Ok(Err(json!({
            "code": "storage_file_not_found",
            "message": "No declared storage file matched the request.",
            "recoverable": true
        })));
    };
    let file_path = file.get("path").and_then(Value::as_str).unwrap_or("");
    let text = read_storage_text(storage_root, file_path).await?;
    let bytes = text.as_bytes().len();
    let max_bytes = arguments
        .get("max_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(64_000) as usize;
    let truncated = bytes > max_bytes;
    let text = if truncated {
        String::from_utf8_lossy(&text.as_bytes()[..max_bytes]).to_string()
    } else {
        text
    };
    Ok(Ok(json!({
        "path": file.get("path").cloned().unwrap_or(Value::Null),
        "relative_path": file.get("relative_path").cloned().unwrap_or(Value::Null),
        "id": file.get("id").cloned().unwrap_or(Value::Null),
        "kind": file.get("kind").cloned().unwrap_or(Value::Null),
        "mime_type": if file_path.to_ascii_lowercase().ends_with(".md") { "text/markdown" } else { "text/plain" },
        "bytes": bytes,
        "truncated": truncated,
        "front_matter": parse_markdown_front_matter(&text),
        "text": text
    })))
}

fn is_skill_file(file: &Value) -> bool {
    file.get("kind").and_then(Value::as_str) == Some("skill")
        || file
            .get("path")
            .and_then(Value::as_str)
            .map(|path| path.to_ascii_lowercase().ends_with("/skill.md"))
            .unwrap_or(false)
}

fn parse_markdown_front_matter(text: &str) -> Value {
    if !text.starts_with("---\n") {
        return json!({});
    }
    let Some(end) = text[4..].find("\n---") else {
        return json!({});
    };
    let block = &text[4..4 + end];
    let mut fields = serde_json::Map::new();
    for line in block.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
        {
            continue;
        }
        let mut value = value.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len() - 1].to_string();
        }
        fields.insert(key.to_string(), Value::String(value));
    }
    Value::Object(fields)
}

fn site_actions_for_target(
    manifest: &Value,
    site_action_names: &HashSet<String>,
    target_url_contains: Option<&str>,
) -> Vec<Value> {
    manifest
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(|name| site_action_names.contains(name))
                .unwrap_or(false)
        })
        .filter(|tool| {
            let binding_target = tool
                .get("x_actions")
                .and_then(|x_actions| x_actions.get("binding"))
                .and_then(|binding| binding.get("target_url_contains"))
                .and_then(Value::as_str);
            match (target_url_contains, binding_target) {
                (Some(target), Some(binding_target)) => {
                    target.contains(binding_target) || binding_target.contains(target)
                }
                (Some(_), None) => true,
                (None, _) => true,
            }
        })
        .map(|tool| {
            json!({
                "name": tool.get("name").cloned().unwrap_or(Value::Null),
                "description": tool.get("description").cloned().unwrap_or(Value::Null),
                "input_schema": tool.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                "target_url_contains": tool
                    .get("x_actions")
                    .and_then(|x_actions| x_actions.get("binding"))
                    .and_then(|binding| binding.get("target_url_contains"))
                    .cloned()
                    .unwrap_or(Value::Null)
            })
        })
        .collect()
}

async fn enrich_storage_overlay(
    state: &AppState,
    resolved: &mut ResolvedToolCall,
) -> Result<(), (StatusCode, Json<Value>)> {
    if resolved
        .arguments
        .get("html")
        .and_then(Value::as_str)
        .is_some()
    {
        return Ok(());
    }

    let overlay_source = resolved
        .arguments
        .get("overlay_source")
        .and_then(Value::as_str)
        .map(str::to_string);
    let items_source = resolved
        .arguments
        .get("items_source")
        .and_then(Value::as_str)
        .map(str::to_string);
    if overlay_source.is_none() && items_source.is_none() {
        return Ok(());
    }

    let Some(storage_root) = state.storage_root.as_ref() else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "stored overlay rendering requires bridge --storage-root" })),
        ));
    };

    let overlay = if let Some(source) = overlay_source.as_deref() {
        read_storage_json(storage_root, source).await?
    } else {
        json!({})
    };
    let overlay_open_arguments = overlay
        .get("overlay_open")
        .and_then(|overlay_open| overlay_open.get("arguments"));
    let html_source = resolved
        .arguments
        .get("html_source")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            overlay
                .get("html_source")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            overlay
                .get("source")
                .and_then(|source| source.get("html"))
                .and_then(Value::as_str)
                .map(|source| resolve_storage_sibling_source(overlay_source.as_deref(), source))
        });
    if let Some(html_source) = html_source {
        let mut html = read_storage_text(storage_root, &html_source).await?;
        let css_sources = resolved
            .arguments
            .get("css_sources")
            .and_then(Value::as_array)
            .or_else(|| overlay.get("css_sources").and_then(Value::as_array))
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        for css_source in css_sources {
            let css = read_storage_text(storage_root, &css_source).await?;
            html = inline_css_source(&html, &css_source, &css);
        }

        let title = resolved
            .arguments
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| {
                overlay_open_arguments
                    .and_then(|arguments| arguments.get("title"))
                    .and_then(Value::as_str)
            })
            .or_else(|| overlay.get("title").and_then(Value::as_str))
            .unwrap_or("Stored overlay")
            .to_string();
        let width = resolved
            .arguments
            .get("width")
            .and_then(Value::as_u64)
            .or_else(|| {
                overlay_open_arguments
                    .and_then(|arguments| arguments.get("width"))
                    .and_then(Value::as_u64)
            })
            .or_else(|| {
                overlay
                    .get("rendering")
                    .and_then(|rendering| rendering.get("width"))
                    .and_then(Value::as_u64)
            })
            .unwrap_or(980);
        let height = resolved
            .arguments
            .get("height")
            .and_then(Value::as_u64)
            .or_else(|| {
                overlay_open_arguments
                    .and_then(|arguments| arguments.get("height"))
                    .and_then(Value::as_u64)
            })
            .or_else(|| {
                overlay
                    .get("rendering")
                    .and_then(|rendering| rendering.get("height"))
                    .and_then(Value::as_u64)
            })
            .unwrap_or(760);

        let Some(arguments) = resolved.arguments.as_object_mut() else {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "overlay.open arguments must be an object" })),
            ));
        };
        arguments.insert("html".to_string(), Value::String(html));
        arguments.insert("title".to_string(), Value::String(title));
        arguments.insert("width".to_string(), json!(width));
        arguments.insert("height".to_string(), json!(height));
        arguments.remove("overlay_source");
        arguments.remove("html_source");
        arguments.remove("css_sources");
        return Ok(());
    }

    let items_source = items_source
        .or_else(|| {
            overlay
                .get("source_items")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "stored overlay requires items_source or overlay source_items" })),
            )
        })?;
    let items = read_storage_json(storage_root, &items_source).await?;
    let rendered = render_stored_overlay(&overlay, &items);

    let Some(arguments) = resolved.arguments.as_object_mut() else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "overlay.open arguments must be an object" })),
        ));
    };

    arguments.insert("html".to_string(), Value::String(rendered.html));
    arguments.insert("title".to_string(), Value::String(rendered.title));
    arguments.insert("width".to_string(), json!(rendered.width));
    arguments.insert("height".to_string(), json!(rendered.height));
    arguments.remove("overlay_source");
    arguments.remove("items_source");
    Ok(())
}

fn resolve_storage_sibling_source(overlay_source: Option<&str>, source: &str) -> String {
    let source_path = Path::new(source);
    if source_path.components().count() > 1 || overlay_source.is_none() {
        return source.to_string();
    }

    Path::new(overlay_source.unwrap())
        .parent()
        .map(|parent| parent.join(source).to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| source.to_string())
}

fn inline_css_source(html: &str, css_source: &str, css: &str) -> String {
    let style = format!(
        "<style data-actions-json-source=\"{}\">\n{}\n</style>",
        escape_attr(css_source),
        css
    );
    let lower_html = html.to_ascii_lowercase();
    if let Some(index) = lower_html.find("</head>") {
        let mut output = String::with_capacity(html.len() + style.len() + 1);
        output.push_str(&html[..index]);
        output.push_str(&style);
        output.push('\n');
        output.push_str(&html[index..]);
        output
    } else {
        format!("{style}\n{html}")
    }
}

struct RenderedOverlay {
    title: String,
    width: u64,
    height: u64,
    html: String,
}

fn render_stored_overlay(overlay: &Value, item_index: &Value) -> RenderedOverlay {
    let title = overlay
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Stored overlay")
        .to_string();
    let width = overlay
        .get("rendering")
        .and_then(|rendering| rendering.get("width"))
        .and_then(Value::as_u64)
        .unwrap_or(980);
    let height = overlay
        .get("rendering")
        .and_then(|rendering| rendering.get("height"))
        .and_then(Value::as_u64)
        .unwrap_or(760);

    let mut items = item_index
        .get("items")
        .and_then(Value::as_object)
        .map(|object| object.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    items.sort_by(|left, right| {
        let left_category = left.get("category").and_then(Value::as_str).unwrap_or("");
        let right_category = right.get("category").and_then(Value::as_str).unwrap_or("");
        let left_title = left.get("title").and_then(Value::as_str).unwrap_or("");
        let right_title = right.get("title").and_then(Value::as_str).unwrap_or("");
        left_category
            .cmp(right_category)
            .then_with(|| left_title.cmp(right_title))
    });

    let mut categories = overlay
        .get("categories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    for item in &items {
        let category = item
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("Uncategorized");
        if !categories.iter().any(|known| known == category) {
            categories.push(category.to_string());
        }
    }

    let mut sections = String::new();
    for category in categories {
        let category_items = items
            .iter()
            .filter(|item| {
                item.get("category")
                    .and_then(Value::as_str)
                    .unwrap_or("Uncategorized")
                    == category
            })
            .collect::<Vec<_>>();
        if category_items.is_empty() {
            continue;
        }

        let section_class = if category_items.len() > 2 {
            "aj-section aj-section-wide"
        } else {
            "aj-section"
        };
        sections.push_str(&format!(
            "<section class=\"{}\" data-count=\"{}\"><h2>{}</h2><div class=\"aj-grid\">",
            section_class,
            category_items.len(),
            escape_html(&category)
        ));
        for item in category_items {
            let item_title = item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled");
            let url = item.get("url").and_then(Value::as_str).unwrap_or("#");
            let cover = item
                .get("latest_cover_url")
                .and_then(Value::as_str)
                .unwrap_or("");
            let image = if cover.is_empty() {
                format!(
                    "<div class=\"aj-cover aj-cover-empty\" role=\"img\" aria-label=\"No cover available for {}\"><span>No cover</span></div>",
                    escape_attr(item_title)
                )
            } else {
                format!(
                    "<img class=\"aj-cover\" src=\"{}\" alt=\"{}\" loading=\"lazy\">",
                    escape_attr(cover),
                    escape_attr(item_title)
                )
            };
            sections.push_str(&format!(
                "<a class=\"aj-card\" href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\">{}<span class=\"aj-title\">{}</span></a>",
                escape_attr(url),
                image,
                escape_html(item_title)
            ));
        }
        sections.push_str("</div></section>");
    }

    if sections.is_empty() {
        sections.push_str("<p class=\"aj-empty\">No stored items found.</p>");
    }

    let html = format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
html, body {{ margin: 0; width: 100%; min-height: 100%; background: #0f1218; color: #f7f9ff; }}
body {{ overflow: hidden; }}
* {{ box-sizing: border-box; }}
.aj-shell {{ box-sizing: border-box; width: 100%; height: 100vh; overflow-y: auto; padding: 18px 20px 28px; background: #0f1218; color: #f7f9ff; scrollbar-color: #536078 #141923; }}
.aj-header {{ display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin: 0 0 18px; }}
.aj-count {{ color: #c8d0df; font-size: 13px; font-weight: 650; }}
.aj-sections {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px 18px; align-items: start; }}
.aj-section {{ min-width: 0; margin: 0; }}
.aj-section-wide {{ grid-column: 1 / -1; }}
.aj-section h2 {{ margin: 0 0 10px; font-size: 15px; line-height: 1.25; letter-spacing: 0; color: #f0f4ff; font-weight: 760; }}
.aj-grid {{ display: flex; flex-wrap: wrap; gap: 14px; align-items: start; }}
.aj-card {{ display: block; width: min(210px, 100%); min-width: 0; color: #f7f9ff; text-decoration: none; border: 1px solid #30394a; background: #171c25; border-radius: 8px; overflow: hidden; box-shadow: 0 8px 22px rgba(0, 0, 0, .18); }}
.aj-card:hover {{ border-color: #78b5ff; box-shadow: 0 10px 28px rgba(0, 0, 0, .34); transform: translateY(-1px); }}
.aj-cover {{ display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: #232a35; }}
.aj-cover-empty {{ display: grid; place-items: center; color: #d9e3f7; font-size: 12px; font-weight: 760; letter-spacing: .02em; text-transform: uppercase; background: linear-gradient(135deg, #263142, #171b23); border-bottom: 1px solid #30394a; }}
.aj-cover-empty span {{ opacity: .86; }}
.aj-title {{ display: block; min-height: 46px; padding: 10px 11px 12px; color: #f7f9ff; background: #171c25; font-size: 13px; line-height: 1.35; font-weight: 700; overflow-wrap: anywhere; }}
.aj-empty {{ color: #c8d0df; }}
@media (max-width: 640px) {{ .aj-sections {{ grid-template-columns: 1fr; }} .aj-section-wide {{ grid-column: auto; }} }}
</style>
</head>
<body>
<main class="aj-shell">
<header class="aj-header"><span class="aj-count">{} items</span></header>
<div class="aj-sections">{}</div>
</main>
</body>
</html>"#,
        items.len(),
        sections
    );

    RenderedOverlay {
        title,
        width,
        height,
        html,
    }
}

async fn read_storage_json(
    root: &Path,
    relative_path: &str,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let content = read_storage_text(root, relative_path).await?;
    serde_json::from_str(&content).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "Failed to parse storage JSON",
                json!({
                    "path": relative_path,
                    "message": error.to_string()
                }),
            ),
        )
    })
}

async fn read_storage_text(
    root: &Path,
    relative_path: &str,
) -> Result<String, (StatusCode, Json<Value>)> {
    let path = safe_storage_path(root, relative_path)
        .map_err(|error| storage_path_error_response(relative_path, error))?;
    fs::read_to_string(&path).await.map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "Failed to read storage path",
                json!({
                    "path": relative_path,
                    "message": error.to_string()
                }),
            ),
        )
    })
}

fn safe_storage_path(root: &Path, relative_path: &str) -> Result<PathBuf, StoragePathError> {
    let requested = Path::new(relative_path);
    if requested.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return Err(StoragePathError::PermissionDenied(
            "storage paths must be relative and cannot contain parent-directory escapes"
                .to_string(),
        ));
    }

    let root = root.canonicalize().map_err(|error| {
        StoragePathError::InvalidInput(format!(
            "failed to canonicalize storage root {}: {error}",
            root.display()
        ))
    })?;
    let mut candidates = vec![root.join(relative_path)];
    let scopes = root.join("scopes");
    if scopes.is_dir() {
        let scopes = std_fs::read_dir(&scopes).map_err(|error| {
            StoragePathError::InvalidInput(format!(
                "failed to read storage scopes {}: {error}",
                scopes.display()
            ))
        })?;
        for scope in scopes {
            let scope = scope.map_err(|error| {
                StoragePathError::InvalidInput(format!(
                    "failed to read storage scope entry: {error}"
                ))
            })?;
            if scope.path().is_dir() {
                candidates.push(scope.path().join(relative_path));
            }
        }
    }

    for candidate in candidates {
        let Some(parent) = candidate.parent() else {
            continue;
        };
        let Ok(parent) = parent.canonicalize() else {
            continue;
        };
        if parent.starts_with(&root) && candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(StoragePathError::InvalidInput(format!(
        "storage path not found under configured root: {relative_path}"
    )))
}

fn storage_path_error_response(
    relative_path: &str,
    error: StoragePathError,
) -> (StatusCode, Json<Value>) {
    match error {
        StoragePathError::PermissionDenied(message) => (
            StatusCode::FORBIDDEN,
            structured_error(
                "permission_denied",
                message,
                json!({ "path": relative_path }),
            ),
        ),
        StoragePathError::InvalidInput(message) => (
            StatusCode::BAD_REQUEST,
            structured_error("invalid_input", message, json!({ "path": relative_path })),
        ),
    }
}

fn structured_error(code: &str, message: impl Into<String>, evidence: Value) -> Json<Value> {
    Json(json!({
        "error": {
            "code": code,
            "message": message.into(),
            "recoverable": true,
            "evidence": evidence
        }
    }))
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(value: &str) -> String {
    escape_html(value)
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn unresolved_tool_call(request: &ToolCallRequest) -> ResolvedToolCall {
    ResolvedToolCall {
        name: request.name.clone(),
        arguments: request.arguments.clone(),
        target_runtime_id: request.target_runtime_id.clone(),
        target_url_contains: request.target_url_contains.clone(),
        timeout_ms: request.timeout_ms,
        static_output: None,
    }
}

fn resolve_state_machine_tool(tool: &Value, request: &ToolCallRequest) -> ResolvedToolCall {
    let x_actions = tool.get("x_actions").unwrap_or(&Value::Null);
    let mut arguments = request.arguments.clone();
    if !arguments.is_object() {
        arguments = json!({});
    }
    let arguments_object = arguments.as_object_mut().expect("arguments object");

    if let Some(scope) = x_actions
        .get("source")
        .and_then(|source| source.get("scope"))
        .cloned()
    {
        arguments_object.entry("scope".to_string()).or_insert(scope);
    } else {
        arguments_object
            .entry("scope".to_string())
            .or_insert_with(|| state_machine_default_scope(tool));
    }

    if let Some(item_selector) = x_actions
        .get("source")
        .and_then(|source| source.get("item_selector"))
        .cloned()
    {
        arguments_object
            .entry("item_selector".to_string())
            .or_insert(item_selector);
    }
    if let Some(fields) = x_actions
        .get("source")
        .and_then(|source| source.get("fields"))
        .cloned()
    {
        arguments_object
            .entry("fields".to_string())
            .or_insert(fields);
    }

    ResolvedToolCall {
        name: "browser.extract_elements".to_string(),
        arguments,
        target_runtime_id: request.target_runtime_id.clone(),
        target_url_contains: request.target_url_contains.clone(),
        timeout_ms: request.timeout_ms,
        static_output: None,
    }
}

fn state_machine_default_scope(tool: &Value) -> Value {
    json!({
        "selectors": ["h1", "h2", "h3", "h4", "[role='heading']"],
        "text_equals": state_machine_scope_text(tool),
        "root_strategy": "nearest_ancestor_containing_items",
        "max_ancestor_depth": 4
    })
}

fn state_machine_scope_text(tool: &Value) -> String {
    let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
    if name.contains("continue_watching") {
        return "Continue Watching".to_string();
    }

    tool.get("x_actions")
        .and_then(|x_actions| x_actions.get("source"))
        .and_then(|source| source.get("component"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .filter(|component| !component.is_empty())
        .unwrap_or_else(|| "Document".to_string())
}

fn find_tool<'a>(manifest: &'a Value, name: &str) -> Option<&'a Value> {
    manifest
        .get("tools")
        .and_then(Value::as_array)?
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
}

fn tool_exists(manifest: &Value, name: &str) -> bool {
    find_tool(manifest, name).is_some()
}

fn stored_tool_execution_mode(tool: &Value) -> Option<&'static str> {
    let x_actions = tool.get("x_actions")?;
    if x_actions.get("state_machine").is_some() {
        return Some("state_machine");
    }
    if x_actions
        .get("navigation")
        .and_then(Value::as_array)
        .is_some_and(|steps| !steps.is_empty())
    {
        return Some("navigation");
    }
    None
}

fn validate_tool_arguments(
    tool: &Value,
    tool_name: &str,
    arguments: &Value,
) -> Result<(), (StatusCode, Json<Value>)> {
    let schema = tool.get("input_schema").unwrap_or(&Value::Null);
    validate_value_against_schema(arguments, schema, "").map_err(|message| {
        (
            StatusCode::BAD_REQUEST,
            structured_error("invalid_input", message, json!({ "tool": tool_name })),
        )
    })
}

fn validate_and_prepare_direct_tool_arguments(
    tool: &Value,
    request: &ToolCallRequest,
) -> Result<Value, (StatusCode, Json<Value>)> {
    if direct_mcp_tool_requires_policy_exception_report(&request.name) {
        let stripped =
            validate_and_strip_policy_exception_report(&request.name, &request.arguments)?;
        validate_tool_arguments(tool, &request.name, &stripped)?;
        return Ok(stripped);
    }

    validate_tool_arguments(tool, &request.name, &request.arguments)?;
    Ok(request.arguments.clone())
}

fn validate_and_strip_policy_exception_report(
    tool_name: &str,
    arguments: &Value,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let Some(object) = arguments.as_object() else {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "arguments must be an object",
                json!({ "tool": tool_name }),
            ),
        ));
    };
    let Some(report) = object.get("policy_exception_report") else {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "policy_exception_report_required",
                "Direct primitive calls require policy_exception_report. Check actions.site first, then retry with a diagnostic justification.",
                json!({ "tool": tool_name }),
            ),
        ));
    };
    validate_policy_exception_report(tool_name, report)?;
    let mut stripped = object.clone();
    stripped.remove("policy_exception_report");
    Ok(Value::Object(stripped))
}

fn validate_policy_exception_report(
    tool_name: &str,
    report: &Value,
) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(object) = report.as_object() else {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "policy_exception_report must be an object.",
                json!({ "tool": tool_name }),
            ),
        ));
    };
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
    let intended_tool = object
        .get("intended_tool")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let actions_json_path = object
        .get("actions_json_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let reason = object
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if kind != "generic" && kind != "debugger" {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "policy_exception_report.kind must be generic or debugger.",
                json!({ "tool": tool_name }),
            ),
        ));
    }
    if intended_tool.is_empty() || actions_json_path.is_empty() || reason.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "policy_exception_report requires intended_tool, actions_json_path, and reason.",
                json!({ "tool": tool_name }),
            ),
        ));
    }
    Ok(())
}

fn validate_value_against_schema(value: &Value, schema: &Value, path: &str) -> Result<(), String> {
    let Some(schema_object) = schema.as_object() else {
        return Ok(());
    };
    if let Some(schema_type) = schema_object.get("type").and_then(Value::as_str) {
        validate_json_type(value, schema_type, path)?;
    }

    if schema_object.get("type").and_then(Value::as_str) == Some("object") {
        let Some(object) = value.as_object() else {
            return Err(format!(
                "{} must be an object",
                if path.is_empty() { "arguments" } else { path }
            ));
        };

        if let Some(required) = schema_object.get("required").and_then(Value::as_array) {
            for required_key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(required_key) {
                    return Err(format!(
                        "{} is required",
                        schema_path_join(path, required_key)
                    ));
                }
            }
        }

        let properties = schema_object.get("properties").and_then(Value::as_object);
        if schema_object
            .get("additionalProperties")
            .and_then(Value::as_bool)
            == Some(false)
        {
            for key in object.keys() {
                if properties
                    .map(|properties| !properties.contains_key(key))
                    .unwrap_or(true)
                {
                    return Err(format!(
                        "{} is not declared in input_schema",
                        schema_path_join(path, key)
                    ));
                }
            }
        }

        if let Some(properties) = properties {
            for (key, property_schema) in properties {
                if let Some(child) = object.get(key) {
                    validate_value_against_schema(
                        child,
                        property_schema,
                        &schema_path_join(path, key),
                    )?;
                }
            }
        }
    }

    if schema_object.get("type").and_then(Value::as_str) == Some("array") {
        if let (Some(items), Some(values)) = (schema_object.get("items"), value.as_array()) {
            for (index, item) in values.iter().enumerate() {
                validate_value_against_schema(
                    item,
                    items,
                    &format!(
                        "{}[{}]",
                        if path.is_empty() { "arguments" } else { path },
                        index
                    ),
                )?;
            }
        }
    }

    Ok(())
}

fn validate_json_type(value: &Value, schema_type: &str, path: &str) -> Result<(), String> {
    let valid = match schema_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    };

    if valid {
        Ok(())
    } else {
        Err(format!(
            "{} must be {}",
            if path.is_empty() { "arguments" } else { path },
            schema_type
        ))
    }
}

fn schema_path_join(base: &str, key: &str) -> String {
    if base.is_empty() {
        format!("arguments.{key}")
    } else {
        format!("{base}.{key}")
    }
}

fn merge_object_values(mut base: Value, overlay: Value) -> Result<Value, &'static str> {
    if !base.is_object() {
        return Err("stored binding arguments must be an object");
    }
    if !overlay.is_object() {
        return Err("tool arguments must be an object");
    }

    let base_object = base.as_object_mut().unwrap();
    for (key, value) in overlay.as_object().unwrap() {
        base_object.insert(key.clone(), value.clone());
    }
    Ok(base)
}

pub async fn storage_bundle_from_root(root: PathBuf) -> Result<Value> {
    let root = root
        .canonicalize()
        .with_context(|| format!("failed to canonicalize storage root {}", root.display()))?;
    let mut entries = Vec::new();
    collect_storage_entries(&root, &root, &mut entries)?;
    entries.sort_by(|left, right| {
        left["path"]
            .as_str()
            .unwrap_or("")
            .cmp(right["path"].as_str().unwrap_or(""))
    });

    Ok(json!({
        "protocol": "actions.json.storage.bundle",
        "version": 1,
        "synced_at_ms": now_ms(),
        "entries": entries
    }))
}

fn collect_storage_entries(root: &Path, current: &Path, entries: &mut Vec<Value>) -> Result<()> {
    let mut children = std_fs::read_dir(current)
        .with_context(|| format!("failed to read directory {}", current.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("failed to read directory entry under {}", current.display()))?;
    children.sort_by_key(|entry| entry.path());

    for child in children {
        let path = child.path();
        let file_name = child.file_name();
        let file_name = file_name.to_string_lossy();
        if file_name == ".git" || file_name == "node_modules" || file_name == "dist" {
            continue;
        }
        if path.is_dir() {
            collect_storage_entries(root, &path, entries)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Ok(content) = std_fs::read_to_string(&path) else {
            continue;
        };
        let relative_path = path
            .strip_prefix(root)
            .with_context(|| format!("failed to relativize {}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = std_fs::metadata(&path).ok();
        let modified_at_ms = metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());
        entries.push(json!({
            "path": relative_path,
            "content": content,
            "content_type": content_type_for_path(&path),
            "bytes": metadata.as_ref().map(|metadata| metadata.len()).unwrap_or(0),
            "modified_at_ms": modified_at_ms
        }));
    }

    Ok(())
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("json") => "application/json",
        Some("html") | Some("htm") => "text/html",
        Some("md") => "text/markdown",
        Some("css") => "text/css",
        Some("js") | Some("mjs") => "text/javascript",
        _ => "text/plain",
    }
}

async fn select_runtime(
    state: &AppState,
    request: &ResolvedToolCall,
) -> Result<RuntimeClient, (StatusCode, Json<Value>)> {
    let runtimes = state.runtimes.lock().await;

    if runtimes.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "no extension runtime connected",
                "routing_trace": runtime_routing_trace(&runtimes, request, "no_runtimes")
            })),
        ));
    }

    if let Some(runtime_id) = request.target_runtime_id.as_deref() {
        return runtimes.get(runtime_id).cloned().ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": "target runtime not connected",
                    "target_runtime_id": runtime_id,
                    "runtimes": runtime_summaries(&runtimes),
                    "routing_trace": runtime_routing_trace(&runtimes, request, "runtime_id_not_found")
                })),
            )
        });
    }

    if let Some(needle) = request.target_url_contains.as_deref() {
        let matches = runtimes
            .values()
            .filter(|client| client.url.as_deref().unwrap_or("").contains(needle))
            .cloned()
            .collect::<Vec<_>>();

        return match matches.as_slice() {
            [client] => Ok(client.clone()),
            [] => Err((
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": "no runtime URL matched target_url_contains",
                    "target_url_contains": needle,
                    "runtimes": runtime_summaries(&runtimes),
                    "routing_trace": runtime_routing_trace(&runtimes, request, "no_match")
                })),
            )),
            _ => Err((
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "target_url_contains matched multiple runtimes",
                    "target_url_contains": needle,
                    "matches": matches.iter().map(runtime_summary).collect::<Vec<_>>(),
                    "routing_trace": runtime_routing_trace(&runtimes, request, "multiple_matches")
                })),
            )),
        };
    }

    if runtimes.len() == 1 {
        return Ok(runtimes.values().next().unwrap().clone());
    }

    Err((
        StatusCode::CONFLICT,
        Json(json!({
            "error": "multiple extension runtimes connected; specify target_runtime_id or target_url_contains",
            "runtimes": runtime_summaries(&runtimes),
            "routing_trace": runtime_routing_trace(&runtimes, request, "ambiguous_without_target")
        })),
    ))
}

fn runtime_routing_trace(
    runtimes: &HashMap<String, RuntimeClient>,
    request: &ResolvedToolCall,
    decision: &str,
) -> Value {
    let target_runtime_id = request.target_runtime_id.as_deref();
    let target_url_contains = request.target_url_contains.as_deref();
    let candidates = runtimes
        .values()
        .map(|client| {
            let url = client.url.as_deref().unwrap_or("");
            json!({
                "runtime_id": client.runtime_id,
                "runtime_key": client.runtime_key,
                "url": client.url,
                "runtime_id_match": target_runtime_id
                    .map(|target| target == client.runtime_id)
                    .unwrap_or(false),
                "url_contains_match": target_url_contains
                    .map(|needle| url.contains(needle))
                    .unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "decision": decision,
        "requested": {
            "tool": request.name,
            "target_runtime_id": request.target_runtime_id,
            "target_url_contains": request.target_url_contains,
        },
        "candidate_count": candidates.len(),
        "candidates": candidates,
    })
}

fn runtime_summaries(runtimes: &HashMap<String, RuntimeClient>) -> Vec<Value> {
    runtimes.values().map(runtime_summary).collect()
}

fn runtime_summary(client: &RuntimeClient) -> Value {
    json!({
        "runtime_id": client.runtime_id,
        "runtime_key": client.runtime_key,
        "authorization_id": client.authorization_id,
        "extension_version": client.extension_version,
        "connected_at_ms": client.connected_at_ms,
        "last_seen_ms": client.last_seen_ms,
        "tab": client.tab,
        "replay": client.replay,
        "url": client.url
    })
}

async fn extension_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_extension_socket(socket, state))
}

async fn handle_extension_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let connection_id = Uuid::new_v4().to_string();
    let connection_runtime_ids = Arc::new(Mutex::new(HashSet::<String>::new()));

    let send_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sender.send(message).await.is_err() {
                break;
            }
        }
    });

    let heartbeat_tx = tx.clone();
    let heartbeat_state = state.clone();
    let heartbeat_connection_id = connection_id.clone();
    let heartbeat_runtime_ids = connection_runtime_ids.clone();
    let heartbeat_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            if heartbeat_tx
                .send(Message::Text(
                    json!({ "type": "runtime_status" }).to_string(),
                ))
                .is_err()
            {
                remove_runtimes_for_connection(
                    &heartbeat_state,
                    &heartbeat_runtime_ids,
                    &heartbeat_connection_id,
                )
                .await;
                break;
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(item) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        match item.get("type").and_then(Value::as_str) {
            Some("runtime_ready") => {
                let runtime_id = item
                    .get("runtime_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown-runtime")
                    .to_string();
                let runtime_key = item
                    .get("runtime_key")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let authorization_id = item
                    .get("authorization_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let extension_version = item
                    .get("extension_version")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let url = item.get("url").and_then(Value::as_str).map(str::to_string);
                let tab = item.get("tab").cloned();
                let replay = item.get("replay").cloned();
                connection_runtime_ids
                    .lock()
                    .await
                    .insert(runtime_id.clone());
                let timestamp = now_ms();
                {
                    let mut runtimes = state.runtimes.lock().await;
                    if let Some(key) = runtime_key.as_deref() {
                        let superseded = runtimes
                            .iter()
                            .filter(|(id, client)| {
                                id.as_str() != runtime_id
                                    && client.runtime_key.as_deref() == Some(key)
                            })
                            .map(|(id, client)| (id.clone(), client.tx.clone()))
                            .collect::<Vec<_>>();
                        for (id, old_tx) in superseded {
                            runtimes.remove(&id);
                            let _ = old_tx.send(Message::Close(None));
                        }
                    }
                    runtimes.insert(
                        runtime_id.clone(),
                        RuntimeClient {
                            runtime_id: runtime_id.clone(),
                            connection_id: connection_id.clone(),
                            runtime_key,
                            authorization_id,
                            extension_version,
                            url,
                            tab,
                            replay,
                            connected_at_ms: timestamp,
                            last_seen_ms: timestamp,
                            tx: tx.clone(),
                        },
                    );
                }
                tokio::spawn(send_storage_hydration_to_runtime(
                    state.clone(),
                    runtime_id.clone(),
                    tx.clone(),
                ));
                tokio::spawn(send_credential_hydration_to_extension(
                    state.clone(),
                    tx.clone(),
                ));
            }
            Some("bridge_runtime_replay_summary") => {
                let mut last_replay_summary = state.last_replay_summary.lock().await;
                *last_replay_summary = Some(item);
            }
            Some("credential_hydration_result") => {
                let mut last_credential_hydration = state.last_credential_hydration.lock().await;
                *last_credential_hydration = Some(json!({
                    "configured": item
                        .get("configured")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "sent": true,
                    "status": if item.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                        "accepted"
                    } else {
                        "rejected"
                    },
                    "provider": item.get("provider").and_then(Value::as_str).unwrap_or("openai"),
                    "redacted": item.get("redacted").and_then(Value::as_str)
                }));
            }
            Some("action_call_output") | Some("action_error") => {
                if let Some(call_id) = item.get("call_id").and_then(Value::as_str) {
                    let item_runtime_id = item.get("runtime_id").and_then(Value::as_str);
                    if let Some(runtime_id) = item_runtime_id {
                        if let Some(runtime) = state.runtimes.lock().await.get_mut(runtime_id) {
                            runtime.last_seen_ms = now_ms();
                        }
                    }
                    {
                        let mut hydrations = state.pending_storage_hydrations.lock().await;
                        if hydrations.remove(call_id).is_some() {
                            let ok = item
                                .get("output")
                                .and_then(|output| output.get("ok"))
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            let imported = item
                                .get("output")
                                .and_then(|output| output.get("value"))
                                .cloned()
                                .unwrap_or(Value::Null);
                            let mut status = state.last_storage_hydration.lock().await;
                            *status = Some(json!({
                                "status": if ok { "imported" } else { "import_failed" },
                                "call_id": call_id,
                                "runtime_id": item_runtime_id,
                                "result": imported,
                                "at_ms": now_ms(),
                            }));
                        }
                    }
                    let mut pending = state.pending.lock().await;
                    let should_deliver = pending
                        .get(call_id)
                        .map(|pending| Some(pending.runtime_id.as_str()) == item_runtime_id)
                        .unwrap_or(false);
                    if should_deliver {
                        if let Some(pending) = pending.remove(call_id) {
                            let _ = pending.tx.send(item);
                        }
                    }
                }
            }
            Some("dom_event") => {
                if let Some(runtime_id) = item.get("runtime_id").and_then(Value::as_str) {
                    if let Some(runtime) = state.runtimes.lock().await.get_mut(runtime_id) {
                        runtime.last_seen_ms = now_ms();
                    }
                }
                println!("dom_event: {item}");
            }
            Some("runtime_status") => {
                if let Some(runtime_id) = item.get("runtime_id").and_then(Value::as_str) {
                    if let Some(runtime) = state.runtimes.lock().await.get_mut(runtime_id) {
                        runtime.last_seen_ms = now_ms();
                    }
                }
            }
            _ => {}
        }
    }

    heartbeat_task.abort();
    send_task.abort();
    remove_runtimes_for_connection(&state, &connection_runtime_ids, &connection_id).await;
}

async fn remove_runtimes_for_connection(
    state: &AppState,
    runtime_ids: &Arc<Mutex<HashSet<String>>>,
    connection_id: &str,
) {
    let runtime_ids = runtime_ids.lock().await.clone();
    let mut runtimes = state.runtimes.lock().await;
    for runtime_id in runtime_ids {
        if runtimes
            .get(&runtime_id)
            .map(|client| client.connection_id == connection_id)
            .unwrap_or(false)
        {
            runtimes.remove(&runtime_id);
        }
    }
}

async fn list_tools(bridge: String) -> Result<()> {
    let url = format!("{}/mcp/tools/list", bridge.trim_end_matches('/'));
    let body = reqwest::get(url).await?.text().await?;
    println!("{body}");
    Ok(())
}

async fn open_overlay(
    bridge: String,
    html_path: PathBuf,
    title: String,
    width: u32,
    height: u32,
    target_runtime_id: Option<String>,
    target_url_contains: Option<String>,
) -> Result<()> {
    let html = fs::read_to_string(&html_path)
        .await
        .with_context(|| format!("failed to read {}", html_path.display()))?;
    let url = format!("{}/mcp/tools/call", bridge.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .json(&json!({
            "name": "overlay.open",
            "target_runtime_id": target_runtime_id,
            "target_url_contains": target_url_contains,
            "arguments": {
                "html": html,
                "title": title,
                "width": width,
                "height": height
            }
        }))
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(anyhow!("bridge returned {status}: {body}"));
    }
    println!("{body}");
    Ok(())
}
