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
    net::TcpListener,
    sync::{mpsc, oneshot, Mutex},
};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "actions-json-mcp")]
#[command(about = "Experimental actions.json MCP-shaped bridge")]
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
    connected_at_ms: u128,
    last_seen_ms: u128,
    tx: mpsc::UnboundedSender<Message>,
}

struct PendingCall {
    runtime_id: String,
    tx: oneshot::Sender<Value>,
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
    15_000
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

#[cfg(test)]
mod tests {
    use super::*;

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

    let app =
        app_from_manifest_map_paths_and_storage_root(manifest, map_paths, storage_root).await?;

    let listener = TcpListener::bind(bind).await?;
    println!("actions-json bridge listening on http://{bind}");
    println!("extension WebSocket: ws://{bind}/extension");
    axum::serve(listener, app).await?;
    Ok(())
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

    Ok(app_from_manifest_value_with_storage_root(
        ActionCatalog {
            base_manifest: manifest,
            map_paths,
            manifest: catalog_manifest,
            site_manifest,
            site_action_names,
        },
        Vec::new(),
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
    for map_path in effective_map_paths(map_paths, storage_root).await? {
        let map_text = fs::read_to_string(&map_path)
            .await
            .with_context(|| format!("failed to read actions map at {}", map_path.display()))?;
        let map: Value = serde_json::from_str(&map_text)
            .with_context(|| format!("failed to parse actions map at {}", map_path.display()))?;
        let additional_tools = validated_map_tools(&map);
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
        advertised_manifest
            .as_object_mut()
            .ok_or_else(|| anyhow!("base manifest must be a JSON object"))?
            .entry("tools")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("base manifest tools must be an array"))?
            .push(json!({
                "name": "storage.sync",
                "description": "Read the configured actions.json.storage root on the agent side and sync it into the authorized browser extension local storage.",
                "input_schema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }));
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
                    "enum": ["list", "call"],
                    "description": "Use list to inspect applicable site actions, or call to invoke a listed action."
                },
                "action": {
                    "type": "string",
                    "description": "Site action name to invoke when mode is call."
                },
                "arguments": {
                    "type": "object",
                    "description": "Arguments forwarded to the selected site action when mode is call."
                },
                "target_url_contains": {
                    "type": "string",
                    "description": "Target page URL substring used to select the applicable site catalog and runtime."
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
    app_from_manifest_value_with_storage_root(
        ActionCatalog {
            base_manifest: manifest.clone(),
            map_paths: Vec::new(),
            manifest: manifest.clone(),
            site_manifest: manifest,
            site_action_names: HashSet::new(),
        },
        runtime_seeds,
        None,
    )
}

fn app_from_manifest_value_with_storage_root(
    mut catalog: ActionCatalog,
    runtime_seeds: Vec<RuntimeSeed>,
    storage_root: Option<PathBuf>,
) -> Router {
    ensure_advertised_tool(&mut catalog.manifest, runtime_session_log_tool_manifest())
        .expect("runtime.session.log tool must be insertable into advertised manifest");
    ensure_site_tool(
        &mut catalog.site_manifest,
        runtime_session_log_tool_manifest(),
    )
    .expect("runtime.session.log tool must be insertable into site manifest");

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
                    connected_at_ms: timestamp,
                    last_seen_ms: timestamp,
                    tx,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    let state = AppState {
        catalog: Arc::new(Mutex::new(catalog)),
        storage_root,
        runtimes: Arc::new(Mutex::new(seeded_runtimes)),
        pending: Arc::new(Mutex::new(HashMap::new())),
    };

    Router::new()
        .route("/health", get(health))
        .route("/actions", get(actions))
        .route("/runtimes", get(runtimes))
        .route("/extension", get(extension_ws))
        .route("/mcp/tools/list", get(tools_list).options(cors_preflight))
        .route(
            "/mcp/tools/resolve",
            post(tools_resolve).options(cors_preflight),
        )
        .route(
            "/mcp/tools/reload",
            post(tools_reload).options(cors_preflight),
        )
        .route("/mcp/tools/call", post(tools_call).options(cors_preflight))
        .layer(middleware::from_fn(add_cors_headers))
        .with_state(state)
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
                "input_schema": tool.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object" }))
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
    Json(request): Json<ToolCallRequest>,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    if request.name == "actions.site" {
        return site_actions_call(state, request).await;
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
    validate_tool_arguments(tool, &request.name, &request.arguments)?;

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
                arguments: request.arguments.clone(),
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
        return Ok(unresolved_tool_call(request));
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
        arguments: merge_object_values(binding_arguments, request.arguments.clone()).map_err(
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
        return Ok(Json(ToolCallResponse {
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "ok": true,
                "target_url_contains": target_url_contains,
                "actions": actions
            })),
            error: None,
        }));
    }

    if mode != "call" {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site mode must be list or call.",
                json!({ "mode": mode }),
            ),
        ));
    }

    let action = request
        .arguments
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "actions.site call mode requires arguments.action.",
                    json!({ "tool": "actions.site" }),
                ),
            )
        })?
        .to_string();
    let arguments = request
        .arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
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
    dispatch_resolved_tool_call(&state, resolved).await
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
        entries.push(json!({
            "path": relative_path,
            "content": content,
            "content_type": content_type_for_path(&path),
            "bytes": std_fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0)
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
                connection_runtime_ids
                    .lock()
                    .await
                    .insert(runtime_id.clone());
                let timestamp = now_ms();
                let mut runtimes = state.runtimes.lock().await;
                if let Some(key) = runtime_key.as_deref() {
                    let superseded = runtimes
                        .iter()
                        .filter(|(id, client)| {
                            id.as_str() != runtime_id && client.runtime_key.as_deref() == Some(key)
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
                        runtime_id,
                        connection_id: connection_id.clone(),
                        runtime_key,
                        authorization_id,
                        extension_version,
                        url,
                        connected_at_ms: timestamp,
                        last_seen_ms: timestamp,
                        tx: tx.clone(),
                    },
                );
            }
            Some("action_call_output") | Some("action_error") => {
                if let Some(call_id) = item.get("call_id").and_then(Value::as_str) {
                    let item_runtime_id = item.get("runtime_id").and_then(Value::as_str);
                    if let Some(runtime_id) = item_runtime_id {
                        if let Some(runtime) = state.runtimes.lock().await.get_mut(runtime_id) {
                            runtime.last_seen_ms = now_ms();
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
