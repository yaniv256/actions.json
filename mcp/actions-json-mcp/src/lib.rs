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
        Query, State,
    },
    http::{header, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::{mpsc, oneshot, Mutex},
};
use uuid::Uuid;

/// Native chrome-launcher tools (browser launch / self-install / claim) merged into this MCP.
mod chrome_launcher_tools;
pub mod cli;
pub mod mcp_adapter;
pub mod operation;
pub mod resident;
pub mod runtime;
pub mod state;

#[derive(Parser)]
#[command(name = "actions-json-mcp")]
#[command(about = "actions.json MCP bridge for browser runtimes")]
struct LegacyCli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Internal unitary resident mode. U6 supplies the ordinary client surface.
    Resident {
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
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long)]
        executable_version: String,
        #[arg(long)]
        configuration_id: Option<String>,
        #[arg(long, default_value_t = 0)]
        idle_seconds: u64,
    },
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
    operation_journal: Option<Arc<state::DurableOperationJournal>>,
    /// Resident-only authority for cooperative profiles, stable browser
    /// generations, and catalog snapshots. Legacy serve/MCP adapters leave it
    /// absent and retain their historical active-tab behavior.
    runtime_authority: Option<Arc<runtime::RuntimeAuthority>>,
    /// Present only in compatibility adapter processes. Browser and mutable
    /// coordination state remain in the resident; this process keeps schemas
    /// and JSON-RPC framing only.
    mcp_resident: Option<mcp_adapter::ResidentMcpClient>,
    // U12: who may open /extension, and with what proof. Resolved once at
    // startup so every upgrade attempt is checked against the same policy.
    extension_auth: Arc<ExtensionAuthConfig>,
    runtimes: Arc<Mutex<HashMap<String, RuntimeClient>>>,
    // The agent-manageable default tab. When more than one runtime is connected
    // and a call carries no explicit target, routing falls back to this runtime
    // instead of erroring. Set by browser.active_tab.set and
    // browser.claimed_tabs.activate; defaulted to the first runtime to connect.
    active_runtime_id: Arc<Mutex<Option<String>>>,
    pending: Arc<Mutex<HashMap<String, PendingCall>>>,
    // Runtime ids that have gone away, mapped to the runtime_key (the TAB) they
    // lived on. Ids rotate on every cross-document navigation — eleven for one
    // tab in two hours, measured 2026-07-27 — so a caller's id is stale within a
    // turn. runtime_key is "chrome-tab:<tabId>" and survives the navigation, so
    // a refusal can name the successor rather than sending the caller back to
    // enumerate. Bounded by remember_stale_runtime; a miss here just means a
    // plainer refusal, never a guess.
    stale_runtime_keys: Arc<Mutex<HashMap<String, String>>>,
    // Latest content-script phase for direct action calls. A handler can mutate
    // the page and then wedge; retain this side-channel until the caller-side
    // deadline so dispatch_timeout identifies the last safe retry boundary.
    action_progress: Arc<Mutex<HashMap<String, Value>>>,
    // U3: in-flight liveness probes keyed by probe_id. A stale-but-unswept
    // runtime is probed (extension chrome.tabs.get) before dispatch; the
    // extension's runtime_probe_result resolves the matching oneshot here.
    pending_probes: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    last_replay_summary: Arc<Mutex<Option<Value>>>,
    last_credential_hydration: Arc<Mutex<Option<Value>>>,
    last_storage_hydration: Arc<Mutex<Option<Value>>>,
    pending_storage_hydrations: Arc<Mutex<HashMap<String, String>>>,
    payload: Arc<Mutex<PayloadSpillConfig>>,
    // Spec 038: per-runtime queue of hosted-agent OUTPUT events (responses,
    // tool calls/results, refusals, lifecycle) forwarded by the extension over
    // the WebSocket. runtime.agent.await_event drains this so the supervising
    // MCP client learns each event event-driven instead of polling the log.
    agent_event_queues: Arc<Mutex<HashMap<String, AgentEventQueue>>>,
    // a11y phase 1 (U6): announcement store — speech history + inject queue +
    // per-(subscriber, tab) delivery config. See docs/a11y-shim-spec.md §6 and
    // the plan's R4/R4a/R5.
    a11y: Arc<Mutex<A11yStore>>,
}

const AGENT_EVENT_QUEUE_CAP: usize = 1000;
const FILE_TRANSFER_MAX_BYTES: usize = 25 * 1024 * 1024;
const FILE_TRANSFER_CHUNK_BYTES: usize = 192 * 1024;

// --- a11y announcement store (U6) ---------------------------------------
// Policy per the phase-1 plan: default profile `normal` maps the site's own
// urgency (assertive -> inject, polite -> buffer); modes inject/buffer/off,
// keyed per (subscriber, tab) with subscriber-wide fallback (R4a). History is
// a speech history (R5): timestamped, identical-burst dedupe, windowed
// last-wins per region — additive regions (role=log, aria-relevant=additions)
// exempt so history is preserved where history matters.

const A11Y_HISTORY_CAP: usize = 300;
const A11Y_DEDUPE_WINDOW_MS: u64 = 2000;
const A11Y_LASTWINS_WINDOW_MS: u64 = 5000;
const A11Y_PIGGYBACK_MAX_RECORDS: usize = 5;
const A11Y_PIGGYBACK_MAX_CHARS: usize = 1200;

#[derive(Debug, Clone, Serialize)]
struct A11yAnnouncement {
    seq: u64,
    ts_ms: u64,
    text: String,
    politeness: String,
    region: Option<String>,
    region_role: Option<String>,
    relevant: Option<String>,
    interrupt: bool,
    tab: Option<i64>,
    runtime_key: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct A11ySubscriptionConfig {
    assertive: Option<String>, // inject | buffer | off (None -> default)
    polite: Option<String>,
}

#[derive(Debug, Default)]
struct A11yStore {
    next_seq: u64,
    history: std::collections::VecDeque<A11yAnnouncement>,
    inject: std::collections::VecDeque<u64>, // seqs pending MCP piggyback
    // key: "<subscriber>" or "<subscriber>|<tab>" (tab-specific overrides win)
    config: HashMap<String, A11ySubscriptionConfig>,
}

impl A11yStore {
    fn is_additive(region_role: &Option<String>, relevant: &Option<String>) -> bool {
        if region_role.as_deref() == Some("log") {
            return true;
        }
        matches!(relevant.as_deref().map(str::trim), Some("additions"))
    }

    fn mode_for(&self, subscriber: &str, tab: Option<i64>, politeness: &str) -> String {
        let lookup = |key: &str| -> Option<String> {
            self.config.get(key).and_then(|c| {
                if politeness == "assertive" {
                    c.assertive.clone()
                } else {
                    c.polite.clone()
                }
            })
        };
        let tab_key = tab.map(|t| format!("{subscriber}|{t}"));
        tab_key
            .as_deref()
            .and_then(lookup)
            .or_else(|| lookup(subscriber))
            .unwrap_or_else(|| {
                if politeness == "assertive" {
                    "inject".to_string()
                } else {
                    "buffer".to_string()
                }
            })
    }

    fn configure(
        &mut self,
        subscriber: &str,
        tab: Option<i64>,
        assertive: Option<String>,
        polite: Option<String>,
    ) {
        let key = match tab {
            Some(t) => format!("{subscriber}|{t}"),
            None => subscriber.to_string(),
        };
        let entry = self.config.entry(key).or_default();
        if assertive.is_some() {
            entry.assertive = assertive;
        }
        if polite.is_some() {
            entry.polite = polite;
        }
    }

    /// Ingest one announcement record (already parsed). Applies dedupe,
    /// last-wins coalescing (non-additive), and the MCP subscriber's mode.
    fn ingest(&mut self, mut rec: A11yAnnouncement) {
        // Identical-burst dedupe: same region + text within the window.
        if let Some(last) = self.history.back() {
            if last.region == rec.region
                && last.text == rec.text
                && rec.ts_ms.saturating_sub(last.ts_ms) < A11Y_DEDUPE_WINDOW_MS
            {
                return;
            }
        }
        let mode = self.mode_for("mcp", rec.tab, &rec.politeness);
        if mode == "off" {
            return;
        }
        // Windowed last-wins per region, additive regions exempt.
        if !Self::is_additive(&rec.region_role, &rec.relevant) {
            if let Some(last) = self.history.back() {
                if last.region.is_some()
                    && last.region == rec.region
                    && rec.ts_ms.saturating_sub(last.ts_ms) < A11Y_LASTWINS_WINDOW_MS
                {
                    let old = self.history.pop_back().unwrap();
                    self.inject.retain(|s| *s != old.seq);
                }
            }
        }
        rec.seq = self.next_seq;
        self.next_seq += 1;
        if mode == "inject" {
            self.inject.push_back(rec.seq);
        }
        self.history.push_back(rec);
        while self.history.len() > A11Y_HISTORY_CAP {
            if let Some(dropped) = self.history.pop_front() {
                self.inject.retain(|s| *s != dropped.seq);
            }
        }
    }

    /// Drain pending inject-mode announcements under the piggyback budget.
    fn drain_inject(&mut self) -> Vec<A11yAnnouncement> {
        let mut out = Vec::new();
        let mut chars = 0usize;
        while let Some(seq) = self.inject.front().copied() {
            let Some(rec) = self.history.iter().find(|r| r.seq == seq).cloned() else {
                self.inject.pop_front();
                continue;
            };
            if !out.is_empty()
                && (out.len() >= A11Y_PIGGYBACK_MAX_RECORDS
                    || chars + rec.text.len() > A11Y_PIGGYBACK_MAX_CHARS)
            {
                break;
            }
            chars += rec.text.len();
            self.inject.pop_front();
            out.push(rec);
            if out.len() >= A11Y_PIGGYBACK_MAX_RECORDS {
                break;
            }
        }
        out
    }

    /// Read history after a cursor (speech history / review — R5).
    fn read(&self, since: Option<u64>, limit: usize) -> (Vec<A11yAnnouncement>, u64) {
        let items: Vec<A11yAnnouncement> = self
            .history
            .iter()
            .filter(|r| match since {
                Some(c) => r.seq > c,
                None => true,
            })
            .take(limit)
            .cloned()
            .collect();
        let next = items.last().map(|r| r.seq).or(since).unwrap_or(0);
        (items, next)
    }
}

/// Parse + ingest an inbound `a11y_announcement` WebSocket item.
async fn ingest_a11y_announcement(state: &AppState, item: &Value) {
    let Some(record) = item.get("record") else {
        return;
    };
    let text = record
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return;
    }
    let rec = A11yAnnouncement {
        seq: 0,
        ts_ms: now_ms() as u64,
        text,
        politeness: record
            .get("politeness")
            .and_then(Value::as_str)
            .unwrap_or("polite")
            .to_string(),
        region: record
            .get("region")
            .and_then(Value::as_str)
            .map(str::to_string),
        region_role: record
            .get("region_role")
            .and_then(Value::as_str)
            .map(str::to_string),
        relevant: record
            .get("relevant")
            .and_then(Value::as_str)
            .map(str::to_string),
        interrupt: record
            .get("interrupt")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        tab: record.get("tab").and_then(Value::as_i64),
        runtime_key: item
            .get("runtime_key")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    state.a11y.lock().await.ingest(rec);
}

#[derive(Clone)]
struct AgentEvent {
    seq: u64,
    ts: String,
    kind: String,
    payload: Value,
}

struct AgentEventQueue {
    events: std::collections::VecDeque<AgentEvent>,
    next_seq: u64,
    notify: Arc<tokio::sync::Notify>,
}

impl Default for AgentEventQueue {
    fn default() -> Self {
        AgentEventQueue {
            events: std::collections::VecDeque::new(),
            next_seq: 0,
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

impl AppState {
    /// Append one agent-output event to a runtime's queue and wake any waiter.
    async fn push_agent_event(&self, runtime_id: &str, ts: String, kind: String, payload: Value) {
        let notify = {
            let mut map = self.agent_event_queues.lock().await;
            let queue = map.entry(runtime_id.to_string()).or_default();
            let seq = queue.next_seq;
            queue.next_seq += 1;
            queue.events.push_back(AgentEvent {
                seq,
                ts,
                kind,
                payload,
            });
            // Evict oldest to fit the cap, then record ONE marker summarizing
            // how many were dropped. (The marker itself is bounded by the cap:
            // we reserve a slot for it, so a full queue keeps CAP-1 real events
            // plus the marker — no runaway growth.)
            if queue.events.len() > AGENT_EVENT_QUEUE_CAP {
                let overflow = queue.events.len() - AGENT_EVENT_QUEUE_CAP;
                // Drop `overflow` oldest, plus one more to leave room for the marker.
                let to_drop = overflow + 1;
                let mut dropped = 0u64;
                for _ in 0..to_drop {
                    if queue.events.pop_front().is_some() {
                        dropped += 1;
                    }
                }
                let dropped_seq = queue.next_seq;
                queue.next_seq += 1;
                queue.events.push_back(AgentEvent {
                    seq: dropped_seq,
                    ts: String::new(),
                    kind: "events_dropped".to_string(),
                    payload: json!({ "count": dropped }),
                });
            }
            queue.notify.clone()
        };
        notify.notify_waiters();
    }
}

/// Handle an inbound `agent_event` WebSocket item from the extension.
async fn ingest_agent_event(state: &AppState, item: &Value) {
    let Some(runtime_id) = item.get("runtime_id").and_then(Value::as_str) else {
        return;
    };
    let ts = item
        .get("ts")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let kind = item
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let payload = item.get("payload").cloned().unwrap_or(Value::Null);
    state.push_agent_event(runtime_id, ts, kind, payload).await;
}

/// Drain events with seq > cursor, blocking up to timeout_ms, then reporting
/// idle. cursor = -1 means "from the start of the retained queue".
async fn await_agent_event(
    state: &AppState,
    runtime_id: &str,
    cursor: i64,
    timeout_ms: u64,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    // Grab the notify handle once up front; the Notify is stable per runtime.
    let notify = {
        let mut map = state.agent_event_queues.lock().await;
        map.entry(runtime_id.to_string())
            .or_default()
            .notify
            .clone()
    };
    loop {
        // Register the wait future BEFORE the ready-check, so a push that fires
        // notify_waiters() between the check and the await is not lost (tokio
        // Notify only wakes futures already registered at notify time). If an
        // event is already ready we return without ever awaiting `notified`.
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        {
            let map = state.agent_event_queues.lock().await;
            let queue = map.get(runtime_id).expect("queue ensured above");
            let ready: Vec<Value> = queue
                .events
                .iter()
                .filter(|e| (e.seq as i64) > cursor)
                .map(|e| {
                    json!({
                        "seq": e.seq,
                        "ts": e.ts,
                        "kind": e.kind,
                        "payload": e.payload,
                    })
                })
                .collect();
            if !ready.is_empty() {
                let new_cursor = queue.events.iter().map(|e| e.seq).max().unwrap_or(0);
                return json!({
                    "events": ready,
                    "cursor": new_cursor,
                    "idle": false,
                });
            }
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return json!({
                "events": [],
                "cursor": cursor,
                "idle": true,
                "silent_ms": timeout_ms,
            });
        }
        if tokio::time::timeout(remaining, notified).await.is_err() {
            return json!({
                "events": [],
                "cursor": cursor,
                "idle": true,
                "silent_ms": timeout_ms,
            });
        }
    }
}

const DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES: usize = 50_000;

#[derive(Clone)]
struct PayloadSpillConfig {
    inline_limit_bytes: usize,
    default_inline_limit_bytes: usize,
    payload_dir: PathBuf,
}

fn process_scoped_payload_dir(temp_root: &Path, process_id: u32, instance_id: Uuid) -> PathBuf {
    temp_root
        .join(format!("actions-json-mcp-{process_id}-{instance_id}"))
        .join("payloads")
}

impl Default for PayloadSpillConfig {
    fn default() -> Self {
        PayloadSpillConfig {
            inline_limit_bytes: DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES,
            default_inline_limit_bytes: DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES,
            payload_dir: process_scoped_payload_dir(
                &std::env::temp_dir(),
                std::process::id(),
                Uuid::new_v4(),
            ),
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

/// A runtime is considered live only while its heartbeat is fresh. The
/// extension pings on a 10s interval (see `handle_extension_socket`'s heartbeat
/// task); this TTL is three missed pings' worth of slack, so a merely-slow ping
/// does not evict a healthy tab, but a tab that has actually gone (closed, or a
/// wedged socket) ages out within ~30s. This is the single liveness knob (KTD1).
const RUNTIME_LIVENESS_TTL_MS: u128 = 30_000;

/// Dispatch freshness window (KTD2), tighter than the liveness TTL. A runtime
/// seen within this window is trusted for direct dispatch; a staler one — still
/// inside the TTL, so not yet swept — is suspect and gets a liveness probe
/// before we dispatch into it. Smaller than the TTL so the probe path engages
/// well before the sweep would evict.
const RUNTIME_DISPATCH_FRESHNESS_MS: u128 = 5_000;

/// How long to wait for the extension's runtime_probe_result before treating the
/// runtime as dead. Short: a live tab answers a chrome.tabs.get near-instantly,
/// and we would rather evict a slow one than block a dispatch on it.
const RUNTIME_PROBE_TIMEOUT_MS: u64 = 1_500;

#[derive(Clone)]
struct RuntimeClient {
    runtime_id: String,
    connection_id: String,
    runtime_key: Option<String>,
    authorization_id: Option<String>,
    extension_version: Option<String>,
    /// U8 (R6-for-real): the MACHINE/BROWSER this runtime lives on, e.g.
    /// "mac · 7c19" — OS plus a stable per-install id. Distinct from the site
    /// `host` (derived from the url): two browsers on the same page share a
    /// host but differ by device. Absent for extensions that don't report it.
    device: Option<String>,
    url: Option<String>,
    tab: Option<Value>,
    replay: Option<Value>,
    connected_at_ms: u128,
    last_seen_ms: u128,
    tx: mpsc::UnboundedSender<Message>,
}

impl RuntimeClient {
    /// Ground-truth liveness: the heartbeat is within the TTL. A dead runtime
    /// (stopped heartbeat) is never live, so it is never listed, counted, or
    /// dispatched to — the runtime liveness invariant, enforced at the read
    /// path rather than trusting a non-empty registry.
    fn is_live(&self, now_ms: u128) -> bool {
        now_ms.saturating_sub(self.last_seen_ms) <= RUNTIME_LIVENESS_TTL_MS
    }

    /// Whether a dispatch to this runtime must be liveness-probed first (KTD2).
    /// A recently-seen runtime is trusted for direct dispatch; a staler one —
    /// still inside the TTL, so the sweep has not evicted it — is suspect and
    /// must be probed before we send a real call into it.
    fn needs_dispatch_probe(&self, now_ms: u128) -> bool {
        now_ms.saturating_sub(self.last_seen_ms) > RUNTIME_DISPATCH_FRESHNESS_MS
    }
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

struct LocalProtofaceCredentials {
    protoface_api_key: String,
    livekit_url: String,
    livekit_api_key: String,
    livekit_api_secret: String,
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

impl From<operation::OperationRequest> for ToolCallRequest {
    fn from(request: operation::OperationRequest) -> Self {
        Self {
            name: request.name,
            arguments: request.arguments,
            target_runtime_id: request.target_runtime_id,
            target_url_contains: request.target_url_contains,
            timeout_ms: request.timeout_ms,
        }
    }
}

#[derive(Debug, Serialize)]
struct ToolCallResponse {
    ok: bool,
    call_id: String,
    output: Option<Value>,
    error: Option<Value>,
    // U6: inject-mode a11y announcements piggybacked onto this result (KTD5).
    #[serde(skip_serializing_if = "Option::is_none")]
    announcements: Option<Vec<Value>>,
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

/// Append one JSON line describing a runtime connection lifecycle event to a
/// persistent log under the storage root. This survives browser page reloads and
/// bridge restarts, so a disconnect can be investigated after the fact — the
/// live `/runtimes` view keeps no history of *why* a tab dropped.
///
/// Best-effort: any IO error is reported to stderr and swallowed so logging can
/// never break the connection lifecycle.
fn append_lifecycle_log(storage_root: Option<&std::path::Path>, entry: Value) {
    let Some(root) = storage_root else {
        return;
    };
    let dir = root.join("logs");
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!("lifecycle log: failed to create {}: {error}", dir.display());
        return;
    }
    let path = dir.join("bridge-lifecycle.jsonl");
    let mut line = entry.to_string();
    line.push('\n');
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Write as _;
            if let Err(error) = file.write_all(line.as_bytes()) {
                eprintln!("lifecycle log: failed to write {}: {error}", path.display());
            }
        }
        Err(error) => {
            eprintln!("lifecycle log: failed to open {}: {error}", path.display());
        }
    }
}

fn action_call_message(
    call_id: String,
    runtime_id: String,
    name: String,
    arguments: Value,
) -> Value {
    let operation_id = call_id.clone();
    json!({
        "type": "action_call",
        "call_id": call_id,
        "operation_id": operation_id,
        "runtime_id": runtime_id,
        "name": name,
        "arguments": arguments
    })
}

struct StateProjectionDispatch {
    mode: String,
    projection_name: Option<String>,
    summary_name: Option<String>,
    summary_arguments: Value,
    max_bytes: Option<u64>,
    map_path: Option<String>,
    projection: Option<Value>,
    snapshot_id: Option<String>,
    node_ref: Option<String>,
    operation: Option<String>,
    direction: Option<String>,
    edge_types: Option<Value>,
    max_depth: Option<u64>,
    measure_filter: Option<Value>,
    measure_order: Option<Value>,
    query: Option<String>,
    scope: Option<Value>,
    cursor: Option<String>,
    page_size: Option<u64>,
    search_mode: Option<String>,
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
        "summary_arguments": dispatch.summary_arguments,
        "max_bytes": dispatch.max_bytes,
        "map_path": dispatch.map_path,
        "projection": dispatch.projection,
        "snapshot_id": dispatch.snapshot_id,
        "node_ref": dispatch.node_ref,
        "operation": dispatch.operation,
        "direction": dispatch.direction,
        "edge_types": dispatch.edge_types,
        "max_depth": dispatch.max_depth,
        "measure_filter": dispatch.measure_filter,
        "measure_order": dispatch.measure_order,
        "query": dispatch.query,
        "scope": dispatch.scope,
        "cursor": dispatch.cursor,
        "page_size": dispatch.page_size,
        "search_mode": dispatch.search_mode
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
    let operation_id = call_id.clone();
    json!({
        "type": "site_action_call",
        "call_id": call_id,
        "operation_id": operation_id,
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

fn local_config_string(value: &Value, canonical: &str, alias: &str) -> Option<String> {
    [canonical, alias].into_iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
    })
}

fn local_protoface_credentials_from_config_file(path: &Path) -> Option<LocalProtofaceCredentials> {
    let text = std_fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    let protoface_api_key = local_config_string(
        &value,
        "protoface_api_key",
        "ACTIONS_JSON_PROTOFACE_API_KEY",
    )?;
    let livekit_url = local_config_string(&value, "livekit_url", "ACTIONS_JSON_LIVEKIT_URL")?;
    if !(livekit_url.starts_with("wss://") || livekit_url.starts_with("https://")) {
        return None;
    }
    let livekit_api_key =
        local_config_string(&value, "livekit_api_key", "ACTIONS_JSON_LIVEKIT_API_KEY")?;
    let livekit_api_secret = local_config_string(
        &value,
        "livekit_api_secret",
        "ACTIONS_JSON_LIVEKIT_API_SECRET",
    )?;
    Some(LocalProtofaceCredentials {
        protoface_api_key,
        livekit_url,
        livekit_api_key,
        livekit_api_secret,
        redacted: "configured".to_string(),
        source: "local_config_file",
    })
}

fn find_local_config_file_with_home(start: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let home_candidate = home.map(|home| home.join(".actions-json/config.json"));
    if let Some(path) = home_candidate.filter(|path| path.exists()) {
        return Some(path);
    }

    let legacy_home_candidate = home.map(|home| home.join(".actions-json.local.json"));
    if let Some(path) = legacy_home_candidate.filter(|path| path.exists()) {
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

/// The extension id Chrome assigns a PACKED install of this extension. An
/// unpacked dev load gets a different, machine-derived id, which is exactly why
/// `extension_ids` in `.actions-json.local.json` overrides this — see
/// `ExtensionAuthConfig::load`.
/// The extension's stable id, derived from the `key` pinned in
/// `extensions/chrome-overlay-runtime/manifest.json`.
///
/// An unpacked extension's id is normally derived from its INSTALL PATH, so it
/// differs per machine — which made the origin allow-list unusable in practice:
/// every user would have had to find their own id and hand-edit
/// `.actions-json.local.json` before the extension could connect at all. Chrome
/// derives the id deterministically from a manifest `key` instead, so pinning
/// one makes this constant true for every install. `extension_ids` in the local
/// config still overrides, for a fork or a differently-keyed build.
const DEFAULT_EXTENSION_ID: &str = "hpfhjegmjhbagbabohjemenfnnjdmhdl";

/// Why the `/extension` socket refused an upgrade. One DISTINCT string per
/// cause, deliberately: this machine runs five agents on five bridge versions,
/// and a mismatched bridge/extension pair must fail LOUDLY and SPECIFICALLY.
/// A generic close would put every one of them on the same wrong trail
/// Keep distinct failure causes explicit; one error string over many causes routes callers wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExtensionAuthRejection {
    OriginRejected,
    HandshakeSecretMissing,
    HandshakeSecretMismatch,
}

impl ExtensionAuthRejection {
    fn reason(self) -> &'static str {
        match self {
            Self::OriginRejected => "origin_rejected",
            Self::HandshakeSecretMissing => "handshake_secret_missing",
            Self::HandshakeSecretMismatch => "handshake_secret_mismatch",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::OriginRejected => "The browser Origin is not an allowed actions.json extension.",
            Self::HandshakeSecretMissing => {
                "No bridge handshake secret was provided by the extension."
            }
            Self::HandshakeSecretMismatch => {
                "The extension's saved bridge handshake secret does not match this bridge."
            }
        }
    }
}

/// U12b. Why the legacy HTTP tool routes refused a request.
///
/// DELIBERATELY NOT the `/extension` vocabulary. The semantics differ: the
/// WebSocket names an `Origin` the browser attests and a page cannot forge,
/// while an HTTP caller here is typically a LOCAL PROCESS with no meaningful
/// origin at all — which is exactly why the origin check is not part of this
/// gate. Reusing `handshake_secret_missing` on both surfaces would make
/// "your extension is not paired" and "your local script forgot the header"
/// read identically, and this machine's five agents would chase the wrong one
/// Keep distinct failure causes explicit; one error string over many causes routes callers wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeHttpAuthRejection {
    SecretMissing,
    SecretMismatch,
}

impl BridgeHttpAuthRejection {
    fn reason(self) -> &'static str {
        match self {
            Self::SecretMissing => "bridge_secret_missing",
            Self::SecretMismatch => "bridge_secret_mismatch",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::SecretMissing => {
                "This bridge route requires the per-installation handshake secret. \
                 Send it as `Authorization: Bearer <secret>` or `?secret=<secret>`. \
                 It is `bridge_handshake_secret` in ~/.actions-json/config.json; \
                 `actions-json pair inspect --reveal-secret` shows it."
            }
            Self::SecretMismatch => {
                "The presented handshake secret does not match this installation's. \
                 It is per-installation, not per-process: re-read \
                 `bridge_handshake_secret` from ~/.actions-json/config.json \
                 (`actions-json pair inspect --reveal-secret`)."
            }
        }
    }
}

/// Who may open `/extension`, and with what proof.
///
/// The bridge binds loopback, but loopback is NOT a boundary for WebSockets:
/// unlike XHR, a `new WebSocket("ws://127.0.0.1:17345/extension")` from any page
/// the user has open is not blocked by the same-origin policy, and the bridge
/// used to answer it with raw OpenAI and Protoface keys. Two independent checks
/// close that: the browser-attested `Origin` header (Chrome sets
/// `chrome-extension://<id>` for extension-originated sockets and a page cannot
/// forge it), and a per-installation secret a page has no way to read.
#[derive(Clone, Debug)]
pub struct ExtensionAuthConfig {
    extension_ids: Vec<String>,
    handshake_secret: String,
}

impl ExtensionAuthConfig {
    /// Read the allowed extension ids and handshake secret from the canonical
    /// per-user `.actions-json/config.json` configuration.
    /// `config_start` is the directory to start the upward search in; `None`
    /// means the process cwd, matching `load_local_openai_credential`.
    ///
    /// The secret is generated on first run and PERSISTED, so it is stable
    /// across bridge restarts — an extension paired once stays paired.
    pub fn load(config_start: Option<&Path>) -> Self {
        // An EXPLICIT root names one installation's config file directly. It
        // must not fall through to `find_local_config_file`, which prefers
        // `$HOME/.actions-json.local.json` over the start directory — that
        // preference would silently read the ambient machine config instead of
        // the installation the caller named.
        let config_path = match config_start {
            Some(root) => {
                let explicit = root.join("config.json");
                let legacy = root.join(".actions-json.local.json");
                explicit
                    .exists()
                    .then_some(explicit)
                    .or_else(|| legacy.exists().then_some(legacy))
                    .or_else(|| {
                        std::env::var_os("HOME")
                            .map(PathBuf::from)
                            .map(|home| home.join(".actions-json/config.json"))
                            .filter(|path| path.exists())
                    })
            }
            None => std::env::current_dir()
                .ok()
                .as_deref()
                .and_then(find_local_config_file),
        };
        let start = config_start
            .map(Path::to_path_buf)
            .or_else(|| std::env::current_dir().ok());
        // Narrow permissions on EVERY load, not only on the write that
        // generates a secret. A caller-review of an earlier version caught this:
        // the chmod hung off `persist_handshake_secret`, which runs only when
        // the secret is ABSENT — so steady state (every run after the first)
        // never narrowed anything. The dangerous case is a user who edits an
        // already-paired config to add their OpenAI key: `$EDITOR` or a `>`
        // redirect resets the mode to the umask default and nothing would ever
        // narrow it again. This file holds the OpenAI key, the Protoface
        // credentials, and the handshake secret whose entire purpose is to stop
        // a local process — a world-readable copy does not need to be guessed.
        if let Some(path) = config_path.as_deref() {
            restrict_local_config_permissions(path);
        }
        let value = config_path
            .as_deref()
            .and_then(|path| std_fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());

        let extension_ids = value
            .as_ref()
            .and_then(|value| value.get("extension_ids"))
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| vec![DEFAULT_EXTENSION_ID.to_string()]);

        let existing_secret = value
            .as_ref()
            .and_then(|value| value.get("bridge_handshake_secret"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
            .map(str::to_string);
        let pairing_revoked = value
            .as_ref()
            .and_then(|value| value.get("bridge_pairing_revoked"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let handshake_secret = match existing_secret {
            Some(secret) => secret,
            // Revocation deliberately leaves no reusable secret on disk. The
            // bridge still needs an unguessable comparison value, so use an
            // ephemeral one without silently re-pairing this installation.
            None if pairing_revoked => generate_handshake_secret(),
            None => {
                // First run for this installation. Generate once, write it back
                // beside the credentials, and reuse it forever after. Writing
                // where the config already lives (or, if there is none yet, in
                // the start directory) keeps this inside the existing local-config
                // system rather than inventing a second one.
                let secret = generate_handshake_secret();
                let target = config_path
                    .clone()
                    .or_else(|| {
                        std::env::var_os("HOME")
                            .map(PathBuf::from)
                            .map(|home| home.join(".actions-json/config.json"))
                    })
                    .or_else(|| start.map(|start| start.join("config.json")));
                if let Some(target) = target {
                    persist_handshake_secret(&target, &secret);
                }
                secret
            }
        };

        Self {
            extension_ids,
            handshake_secret,
        }
    }

    pub fn handshake_secret(&self) -> &str {
        &self.handshake_secret
    }

    /// The single origin CORS may name. `Access-Control-Allow-Origin` takes one
    /// value, not a list, so the first configured id wins; the WebSocket origin
    /// check below still accepts every configured id.
    pub fn primary_origin(&self) -> String {
        let id = self
            .extension_ids
            .first()
            .map(String::as_str)
            .unwrap_or(DEFAULT_EXTENSION_ID);
        format!("chrome-extension://{id}")
    }

    fn origin_allowed(&self, origin: &str) -> bool {
        self.extension_ids
            .iter()
            .any(|id| origin == format!("chrome-extension://{id}"))
    }

    /// Origin first, then secret — so a hostile page is refused on the header it
    /// cannot forge, and never gets to probe the secret at all.
    fn authorize(
        &self,
        origin: Option<&str>,
        presented_secret: Option<&str>,
    ) -> Result<(), ExtensionAuthRejection> {
        let Some(origin) = origin.map(str::trim).filter(|origin| !origin.is_empty()) else {
            return Err(ExtensionAuthRejection::OriginRejected);
        };
        if !self.origin_allowed(origin) {
            return Err(ExtensionAuthRejection::OriginRejected);
        }
        let Some(presented) = presented_secret
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
        else {
            return Err(ExtensionAuthRejection::HandshakeSecretMissing);
        };
        if !constant_time_eq(presented.as_bytes(), self.handshake_secret.as_bytes()) {
            return Err(ExtensionAuthRejection::HandshakeSecretMismatch);
        }
        Ok(())
    }

    /// Validate the diagnostic HTTP preflight used by the extension service
    /// worker before it opens the WebSocket.
    ///
    /// Chrome omits `Origin` from extension service-worker `fetch()` requests,
    /// so this endpoint can attest only possession of the installation secret.
    /// The subsequent `/extension` WebSocket upgrade still calls `authorize`
    /// and requires both the browser-attested extension origin and this secret
    /// before any runtime or credential hydration is available.
    fn authorize_preflight(
        &self,
        presented_secret: Option<&str>,
    ) -> Result<(), ExtensionAuthRejection> {
        let Some(presented) = presented_secret
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
        else {
            return Err(ExtensionAuthRejection::HandshakeSecretMissing);
        };
        if !constant_time_eq(presented.as_bytes(), self.handshake_secret.as_bytes()) {
            return Err(ExtensionAuthRejection::HandshakeSecretMismatch);
        }
        Ok(())
    }

    /// U12b. The secret half alone, for the HTTP tool routes.
    ///
    /// No origin check here, and that is a decision rather than an omission: the
    /// intended callers are LOCAL PROCESSES (the eval harness, curl, the
    /// extension's service worker `fetch`), which either send no `Origin` or
    /// send one the caller controls. Requiring an unforgeable origin would lock
    /// out every legitimate caller while stopping nobody, since an attacker who
    /// can open a socket can also write any header it likes. What an attacker
    /// CANNOT do is read a 256-bit secret out of the user's config file, so the
    /// secret is the whole boundary on this surface.
    fn authorize_http(
        &self,
        presented_secret: Option<&str>,
    ) -> Result<(), BridgeHttpAuthRejection> {
        let Some(presented) = presented_secret
            .map(str::trim)
            .filter(|secret| !secret.is_empty())
        else {
            return Err(BridgeHttpAuthRejection::SecretMissing);
        };
        if !constant_time_eq(presented.as_bytes(), self.handshake_secret.as_bytes()) {
            return Err(BridgeHttpAuthRejection::SecretMismatch);
        }
        Ok(())
    }
}

/// 256 bits of v4 UUID randomness, hex, no dashes — long enough that guessing is
/// not a strategy and printable enough to paste into extension storage.
fn generate_handshake_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Merge the secret into the existing local config rather than rewriting it.
/// The same file holds the OpenAI and Protoface credentials; clobbering it to
/// store a secret would break the very hydration this guard protects.
fn persist_handshake_secret(path: &Path, secret: &str) {
    let mut root = std_fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    root.insert("bridge_handshake_secret".to_string(), json!(secret));
    let Ok(text) = serde_json::to_string_pretty(&Value::Object(root)) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std_fs::create_dir_all(parent);
    }
    if let Err(error) = std_fs::write(path, format!("{text}\n")) {
        eprintln!(
            "actions-json bridge could not persist the handshake secret to {}: {error}",
            path.display()
        );
        // Nothing was written, so there is nothing to narrow. Returning here
        // also keeps the chmod warning below honest: it can only ever describe
        // a file that really exists.
        return;
    }
    restrict_local_config_permissions(path);
}

/// Make the local config readable only by its owner.
///
/// The handshake secret's entire purpose is to stop a LOCAL process — another
/// account on a shared machine, a hostile postinstall script. A secret written
/// world-readable therefore defeats the gate outright: the attacker does not
/// need to guess it, it just opens the file. The same file has always held the
/// OpenAI and Protoface keys, so this predates the handshake secret and is a
/// fix for all three.
///
/// Applied on EVERY write, not only on create, because the file that matters
/// most is the one an earlier release already left at 0644.
///
/// A chmod failure is reported but never fatal: the write is what preserves the
/// installation's pairing and credentials, and losing that to a permissions
/// quirk (an exotic filesystem, a mount without ownership semantics) would be a
/// worse outcome than a warning the operator can act on.
#[cfg(unix)]
fn restrict_local_config_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Err(error) = std_fs::set_permissions(path, std_fs::Permissions::from_mode(0o600)) {
        eprintln!(
            "actions-json bridge could not restrict permissions on {} ({error}); \
             it may be readable by other accounts on this machine.",
            path.display()
        );
    }
}

/// Windows has no POSIX mode bits. The file inherits the parent directory's ACL,
/// which for a user profile directory is already owner-scoped, so there is no
/// equivalent narrowing to perform here.
#[cfg(not(unix))]
fn restrict_local_config_permissions(_path: &Path) {}

/// Compare without leaking the matching-prefix length through timing. The secret
/// is long and local, so this is belt-and-braces, but a secret comparison that
/// short-circuits is the kind of detail a security review flags.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
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

fn load_local_protoface_credentials() -> Option<LocalProtofaceCredentials> {
    let cwd = std::env::current_dir().ok()?;
    let config_path = find_local_config_file(&cwd)?;
    local_protoface_credentials_from_config_file(&config_path)
}

fn record_credential_hydration_status(
    status: &mut Option<Value>,
    provider: &str,
    provider_status: Value,
) {
    let mut root = status
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    {
        let providers = root
            .entry("providers".to_string())
            .or_insert_with(|| json!({}));
        if !providers.is_object() {
            *providers = json!({});
        }
        providers
            .as_object_mut()
            .expect("providers was normalized to an object")
            .insert(provider.to_string(), provider_status.clone());
    }

    // Keep the historical top-level OpenAI summary stable for existing
    // consumers while exposing every provider under `providers`.
    if provider == "openai" || !root.contains_key("provider") {
        if let Some(fields) = provider_status.as_object() {
            for (key, value) in fields {
                root.insert(key.clone(), value.clone());
            }
        }
    }
    *status = Some(Value::Object(root));
}

async fn send_protoface_credential_hydration(
    state: AppState,
    tx: mpsc::UnboundedSender<Message>,
    credentials: Option<LocalProtofaceCredentials>,
) {
    let Some(credentials) = credentials else {
        let mut status = state.last_credential_hydration.lock().await;
        record_credential_hydration_status(
            &mut status,
            "protoface",
            json!({
                "configured": false,
                "sent": false,
                "status": "not_configured",
                "provider": "protoface"
            }),
        );
        return;
    };
    {
        let mut status = state.last_credential_hydration.lock().await;
        record_credential_hydration_status(
            &mut status,
            "protoface",
            json!({
                "configured": true,
                "sent": true,
                "status": "sent",
                "provider": "protoface",
                "source": credentials.source,
                "redacted": credentials.redacted.clone()
            }),
        );
    }
    let item = json!({
        "type": "credential_hydration",
        "provider": "protoface",
        "source": "mcp_bridge_local",
        "credential": {
            "protoface_api_key": credentials.protoface_api_key,
            "livekit_url": credentials.livekit_url,
            "livekit_api_key": credentials.livekit_api_key,
            "livekit_api_secret": credentials.livekit_api_secret
        },
        "redacted": credentials.redacted
    });
    let _ = tx.send(Message::Text(item.to_string()));
}

async fn send_credential_hydration_to_extension(
    state: AppState,
    tx: mpsc::UnboundedSender<Message>,
) {
    if let Some(credential) = load_local_openai_credential() {
        {
            let mut status = state.last_credential_hydration.lock().await;
            record_credential_hydration_status(
                &mut status,
                "openai",
                json!({
                    "configured": true,
                    "sent": true,
                    "status": "sent",
                    "provider": "openai",
                    "source": credential.source,
                    "redacted": credential.redacted.clone()
                }),
            );
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
    } else {
        let mut status = state.last_credential_hydration.lock().await;
        record_credential_hydration_status(
            &mut status,
            "openai",
            json!({
                "configured": false,
                "sent": false,
                "status": "not_configured",
                "provider": "openai"
            }),
        );
    }
    send_protoface_credential_hydration(state, tx, load_local_protoface_credentials()).await;
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

    #[tokio::test]
    async fn action_timeout_context_reports_the_last_content_mutation_boundary() {
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
        let (tx, _rx) = oneshot::channel::<Value>();
        state.pending.lock().await.insert(
            "call-progress".to_string(),
            PendingCall {
                runtime_id: "runtime-a".to_string(),
                tx,
            },
        );

        let accepted = ingest_action_progress(
            &state,
            &json!({
                "type": "action_progress",
                "call_id": "call-progress",
                "runtime_id": "runtime-a",
                "action": "text.type",
                "last_entered_content_phase": "editable_handlers_settled",
                "last_completed_content_phase": "synthetic_paste_dispatched",
                "observed_at": "2026-07-13T00:00:00Z",
            }),
        )
        .await;
        assert!(accepted);

        let context = take_action_timeout_context(&state, "call-progress", true).await;
        assert_eq!(
            context["last_entered_content_phase"].as_str(),
            Some("editable_handlers_settled")
        );
        assert_eq!(
            context["last_completed_content_phase"].as_str(),
            Some("synthetic_paste_dispatched")
        );
        assert_eq!(context["pending_cleanup"].as_str(), Some("completed"));
        assert!(state.action_progress.lock().await.is_empty());
    }

    #[test]
    fn state_projection_call_message_carries_definition_and_routing() {
        let dispatch = StateProjectionDispatch {
            mode: "state_read".to_string(),
            projection_name: Some("trello.board".to_string()),
            summary_name: Some("agent_context".to_string()),
            summary_arguments: json!({ "list_name": "Next", "offset": 10, "limit": 10 }),
            max_bytes: Some(12_000),
            map_path: Some("scopes/private/sites/trello.com/board/actions.json".to_string()),
            projection: Some(json!({ "name": "trello.board", "snapshot": { "version": 1 } })),
            snapshot_id: None,
            node_ref: None,
            operation: None,
            direction: None,
            edge_types: None,
            max_depth: None,
            measure_filter: None,
            measure_order: None,
            query: None,
            scope: None,
            cursor: None,
            page_size: None,
            search_mode: None,
        };
        let item =
            state_projection_call_message("call-2".to_string(), "runtime-b".to_string(), &dispatch);

        assert_eq!(item["type"].as_str(), Some("state_projection_call"));
        assert_eq!(item["call_id"].as_str(), Some("call-2"));
        assert_eq!(item["runtime_id"].as_str(), Some("runtime-b"));
        assert_eq!(item["mode"].as_str(), Some("state_read"));
        assert_eq!(item["projection_name"].as_str(), Some("trello.board"));
        assert_eq!(item["summary_name"].as_str(), Some("agent_context"));
        assert_eq!(
            item["summary_arguments"]["list_name"].as_str(),
            Some("Next")
        );
        assert_eq!(item["summary_arguments"]["offset"].as_u64(), Some(10));
        assert_eq!(item["max_bytes"].as_u64(), Some(12_000));
        assert_eq!(
            item["map_path"].as_str(),
            Some("scopes/private/sites/trello.com/board/actions.json")
        );
        assert_eq!(item["projection"]["name"].as_str(), Some("trello.board"));
    }

    #[test]
    fn graph_query_call_message_carries_only_bounded_snapshot_arguments() {
        let dispatch = StateProjectionDispatch {
            mode: "search".to_string(),
            projection_name: None,
            summary_name: None,
            summary_arguments: json!({}),
            max_bytes: Some(4_096),
            map_path: None,
            projection: None,
            snapshot_id: Some("snapshot-opaque-1".to_string()),
            node_ref: None,
            operation: None,
            direction: None,
            edge_types: None,
            max_depth: None,
            measure_filter: None,
            measure_order: None,
            query: Some("brainstorm".to_string()),
            scope: Some(json!({ "node_ref": "node-list-next", "edge_types": ["contains"] })),
            cursor: Some("cursor-opaque-2".to_string()),
            page_size: Some(5),
            search_mode: Some("lexical".to_string()),
        };
        let item = state_projection_call_message(
            "call-search".to_string(),
            "runtime-trello".to_string(),
            &dispatch,
        );

        assert_eq!(item["type"], "state_projection_call");
        assert_eq!(item["mode"], "search");
        assert_eq!(item["snapshot_id"], "snapshot-opaque-1");
        assert_eq!(item["query"], "brainstorm");
        assert_eq!(item["scope"]["node_ref"], "node-list-next");
        assert_eq!(item["cursor"], "cursor-opaque-2");
        assert_eq!(item["page_size"], 5);
        assert_eq!(item["search_mode"], "lexical");
        assert!(item["projection"].is_null());
        assert!(item["map_path"].is_null());
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

    #[test]
    fn local_protoface_credentials_load_complete_lowercase_bundle() {
        let root = tempdir().unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{
                "protoface_api_key": "pf-secret-value",
                "livekit_url": "wss://livekit.example",
                "livekit_api_key": "lk-key",
                "livekit_api_secret": "lk-secret"
            }"#,
        )
        .unwrap();

        let credentials = local_protoface_credentials_from_config_file(
            &root.path().join(".actions-json.local.json"),
        )
        .unwrap();

        assert_eq!(credentials.protoface_api_key, "pf-secret-value");
        assert_eq!(credentials.livekit_url, "wss://livekit.example");
        assert_eq!(credentials.livekit_api_key, "lk-key");
        assert_eq!(credentials.livekit_api_secret, "lk-secret");
        assert_eq!(credentials.source, "local_config_file");
        assert_eq!(credentials.redacted, "configured");
    }

    #[test]
    fn local_protoface_credentials_accept_uppercase_aliases() {
        let root = tempdir().unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{
                "ACTIONS_JSON_PROTOFACE_API_KEY": "pf-alias",
                "ACTIONS_JSON_LIVEKIT_URL": "https://livekit.example",
                "ACTIONS_JSON_LIVEKIT_API_KEY": "lk-alias",
                "ACTIONS_JSON_LIVEKIT_API_SECRET": "lk-alias-secret"
            }"#,
        )
        .unwrap();

        let credentials = local_protoface_credentials_from_config_file(
            &root.path().join(".actions-json.local.json"),
        )
        .unwrap();

        assert_eq!(credentials.protoface_api_key, "pf-alias");
        assert_eq!(credentials.livekit_url, "https://livekit.example");
    }

    #[test]
    fn local_protoface_credentials_reject_partial_bundle() {
        let root = tempdir().unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{
                "protoface_api_key": "pf-secret-value",
                "livekit_url": "wss://livekit.example"
            }"#,
        )
        .unwrap();

        assert!(local_protoface_credentials_from_config_file(
            &root.path().join(".actions-json.local.json"),
        )
        .is_none());
    }

    /// The handshake secret exists to stop a LOCAL process, so a world-readable
    /// config file defeats the gate entirely: any other account on the machine
    /// just reads the secret and presents it. The same file also carries the
    /// OpenAI and Protoface keys, so this is the narrowest place to fix all three.
    #[cfg(unix)]
    #[test]
    fn persisted_handshake_secret_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let path = root.path().join(".actions-json.local.json");

        persist_handshake_secret(&path, "secret-value");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "a freshly created local config must not be readable by other accounts"
        );
        // The narrowing must not cost the write: the secret is still there.
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["bridge_handshake_secret"], "secret-value");
    }

    /// A config file that ALREADY exists — carrying the OpenAI key from an
    /// earlier release, created before this fix with default permissions — must
    /// be narrowed too, not merely left as found. This is the case that actually
    /// occurs on upgrade, and the one a create-only chmod would silently miss.
    #[cfg(unix)]
    #[test]
    fn persisting_narrows_an_existing_world_readable_config() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let path = root.path().join(".actions-json.local.json");
        std::fs::write(&path, r#"{ "openai_api_key": "sk-pre-existing-000" }"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        persist_handshake_secret(&path, "secret-value");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "an existing config must be narrowed on write");
        // Merging, not clobbering: the pre-existing credential survives.
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["openai_api_key"], "sk-pre-existing-000");
        assert_eq!(value["bridge_handshake_secret"], "secret-value");
    }

    // The steady-state case, and the one the two tests above could NOT catch:
    // both drive `persist_handshake_secret`, which only runs when the secret is
    // ABSENT. A config that ALREADY has a secret never reached the chmod, so
    // every run after the first left the file exactly as it found it — while
    // SECURITY.md claimed narrowing happened "on every write." A security
    // reviewer caught the gap by counting call sites; these tests could not,
    // because they exercised the one path that was already correct.
    #[cfg(unix)]
    #[test]
    fn loading_an_already_paired_config_still_narrows_it() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let path = root.path().join(".actions-json.local.json");
        // Already paired: `persist_handshake_secret` will NOT fire.
        std::fs::write(
            &path,
            r#"{ "openai_api_key": "sk-pre-existing-000", "bridge_handshake_secret": "already-set" }"#,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let config = ExtensionAuthConfig::load(Some(root.path()));

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "loading an already-paired config must narrow it; the chmod cannot \
             hang off the generate path alone"
        );
        // And the load still did its actual job.
        assert_eq!(config.handshake_secret, "already-set");
    }

    #[tokio::test]
    async fn local_protoface_credentials_hydration_is_provider_scoped_and_redacted() {
        let root = tempdir().unwrap();
        std::fs::write(
            root.path().join(".actions-json.local.json"),
            r#"{
                "protoface_api_key": "pf-secret-value",
                "livekit_url": "wss://livekit.example",
                "livekit_api_key": "lk-key",
                "livekit_api_secret": "lk-secret"
            }"#,
        )
        .unwrap();
        let credentials = local_protoface_credentials_from_config_file(
            &root.path().join(".actions-json.local.json"),
        )
        .unwrap();
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
        let (tx, mut rx) = mpsc::unbounded_channel();

        send_protoface_credential_hydration(state.clone(), tx, Some(credentials)).await;

        let message = rx.recv().await.unwrap().into_text().unwrap();
        let payload: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(payload["provider"], "protoface");
        assert_eq!(
            payload["credential"]["protoface_api_key"],
            "pf-secret-value"
        );
        assert_eq!(payload["credential"]["livekit_api_secret"], "lk-secret");
        let resource = bridge_runtimes_resource(&state).await;
        assert_eq!(resource["credential_hydration"]["provider"], "protoface");
        assert_eq!(resource["credential_hydration"]["redacted"], "configured");
        assert!(!resource.to_string().contains("pf-secret-value"));
        assert!(!resource.to_string().contains("lk-secret"));
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

    #[test]
    fn credential_hydration_status_preserves_each_provider_and_legacy_openai_summary() {
        let mut status = None;
        record_credential_hydration_status(
            &mut status,
            "openai",
            json!({
                "configured": true,
                "sent": true,
                "status": "accepted",
                "provider": "openai",
                "redacted": "sk...7890"
            }),
        );
        record_credential_hydration_status(
            &mut status,
            "protoface",
            json!({
                "configured": true,
                "sent": true,
                "status": "accepted",
                "provider": "protoface",
                "redacted": "configured"
            }),
        );

        let status = status.unwrap();
        assert_eq!(status["provider"], "openai");
        assert_eq!(status["status"], "accepted");
        assert_eq!(status["providers"]["openai"]["redacted"], "sk...7890");
        assert_eq!(status["providers"]["protoface"]["redacted"], "configured");
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

    #[test]
    fn default_payload_directory_is_unique_per_bridge_instance() {
        let first = PayloadSpillConfig::default().payload_dir;
        let second = PayloadSpillConfig::default().payload_dir;
        let legacy = std::env::temp_dir().join("actions-json-mcp");

        assert_ne!(first, second);
        assert!(!first.starts_with(&legacy));
        assert!(!second.starts_with(&legacy));
        assert_eq!(first.file_name(), Some(OsStr::new("payloads")));
        assert_eq!(second.file_name(), Some(OsStr::new("payloads")));
        let expected_prefix = format!("actions-json-mcp-{}-", std::process::id());
        assert!(first
            .parent()
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with(&expected_prefix)));
    }

    #[tokio::test]
    async fn process_scoped_spill_ignores_hostile_legacy_shared_path() {
        let temp_root = tempfile::tempdir().unwrap();
        let legacy = temp_root.path().join("actions-json-mcp");
        std_fs::write(&legacy, b"not a directory").unwrap();
        let scoped =
            process_scoped_payload_dir(temp_root.path(), std::process::id(), Uuid::new_v4());

        let path = spill_payload_to_disk(&scoped, "test.static_blob", "payload")
            .await
            .unwrap();

        assert!(path.path.starts_with(&scoped));
        assert_eq!(std_fs::read_to_string(path.path).unwrap(), "payload");
        assert!(legacy.is_file());
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
        let at_limit_result: Value = serde_json::from_str(&mcp_result_text(&at_limit)).unwrap();
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
            .starts_with("sha256:"));
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
    async fn spill_write_failure_returns_bounded_error_without_inline_payload() {
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
        assert_eq!(result["error"]["code"], "payload_spill_failed");
        assert_eq!(result["bounded"], true);
        assert!(result.get("output").is_none());
    }

    #[test]
    fn successful_socket_enqueue_marks_durable_operation_nonreplayable_before_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Arc::new(
            state::DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap(),
        );
        let mut app_state = empty_state();
        app_state.operation_journal = Some(journal.clone());
        let call_id = "dispatch-boundary-1";
        let operation = match journal
            .accept(&state::OperationAcceptance {
                request_id: call_id.into(),
                scope: "test".into(),
                normalized_request: json!({"name":"test.mutation","arguments":{}}),
                profile_token: None,
                target_generation: Some("browser/session/tab".into()),
                catalog_revision: Some("catalog-1".into()),
                lease_authority: None,
                output_policy: json!({}),
                is_mutation: true,
            })
            .unwrap()
        {
            state::AcceptOutcome::Accepted(operation) => operation,
            _ => panic!("expected acceptance"),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(Message::Text("sent".into())).unwrap();
        mark_durable_dispatch_enqueued(&app_state, &operation.operation_id).unwrap();
        assert_eq!(
            journal.get(&operation.operation_id).unwrap().unwrap().state,
            state::LifecycleState::Dispatched
        );
        assert!(journal.replayable().unwrap().is_empty());
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn reconnect_queries_outstanding_receipts_and_absence_fails_conservatively() {
        let dir = tempfile::tempdir().unwrap();
        let journal =
            state::DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
        let call_id = "reconnect-query-1";
        let operation = match journal
            .accept(&state::OperationAcceptance {
                request_id: call_id.into(),
                scope: "test".into(),
                normalized_request: json!({"name":"test.mutation","arguments":{}}),
                profile_token: None,
                target_generation: Some("old/browser/tab".into()),
                catalog_revision: Some("catalog-1".into()),
                lease_authority: None,
                output_policy: json!({}),
                is_mutation: true,
            })
            .unwrap()
        {
            state::AcceptOutcome::Accepted(operation) => operation,
            _ => panic!("expected acceptance"),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert_eq!(
            send_outstanding_operation_receipt_queries(&journal, &tx).unwrap(),
            1
        );
        let Message::Text(query) = rx.try_recv().unwrap() else {
            panic!("expected text query")
        };
        let query: Value = serde_json::from_str(&query).unwrap();
        assert_eq!(query["type"], "operation_receipt_query");
        assert_eq!(query["operation_id"], operation.operation_id);
        assert_eq!(
            reconcile_extension_operation_receipt(
                &journal,
                &json!({
                    "type":"operation_receipt","operation_id":operation.operation_id,"receipt":null
                })
            )
            .unwrap(),
            state::LifecycleState::Indeterminate
        );
        assert!(journal.replayable().unwrap().is_empty());
    }

    #[test]
    fn remote_file_tool_manifests_are_bounded_and_metadata_oriented() {
        let upload = file_upload_tool_manifest();
        let download = file_download_tool_manifest();
        let status = file_transfer_status_tool_manifest();
        let cancel = file_transfer_cancel_tool_manifest();

        assert_eq!(upload["name"], json!("file.upload"));
        assert_eq!(download["name"], json!("file.download"));
        assert_eq!(status["name"], json!("file.transfer.status"));
        assert_eq!(cancel["name"], json!("file.transfer.cancel"));
        assert_eq!(
            upload["input_schema"]["properties"]["local_path"]["type"],
            json!("string")
        );
        assert_eq!(
            download["input_schema"]["properties"]["url"]["type"],
            json!("string")
        );
        assert!(upload.to_string().contains("25 MiB"));
        assert!(download.to_string().contains("private payload directory"));
        assert!(!status.to_string().contains("base64"));
        assert!(!cancel.to_string().contains("base64"));
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
        assert_eq!(user_message["inputSchema"]["required"], json!(["text"]));
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

    // --- Multi-runtime routing: active tab + per-command override ---

    fn two_runtime_state() -> AppState {
        state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            vec![
                RuntimeSeed {
                    runtime_id: "rt-lab".to_string(),
                    url: Some("https://lab651.com/".to_string()),
                },
                RuntimeSeed {
                    runtime_id: "rt-trello".to_string(),
                    url: Some("https://trello.com/b/abc".to_string()),
                },
            ],
            None,
        )
    }

    #[tokio::test]
    async fn site_action_target_url_derives_from_exact_runtime_id() {
        let state = two_runtime_state();
        let request = ToolCallRequest {
            name: "actions.site".to_string(),
            arguments: json!({ "mode": "list" }),
            target_runtime_id: Some("rt-trello".to_string()),
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };

        let target = site_action_target_url_contains(&state, &request)
            .await
            .expect("the exact runtime should resolve");

        assert_eq!(target.as_deref(), Some("https://trello.com/b/abc"));
    }

    #[tokio::test]
    async fn site_action_target_url_derives_from_active_runtime() {
        let state = two_runtime_state();
        *state.active_runtime_id.lock().await = Some("rt-lab".to_string());
        let request = ToolCallRequest {
            name: "actions.site".to_string(),
            arguments: json!({ "mode": "list" }),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };

        let target = site_action_target_url_contains(&state, &request)
            .await
            .expect("the active runtime should resolve");

        assert_eq!(target.as_deref(), Some("https://lab651.com/"));
    }

    #[tokio::test]
    async fn site_action_explicit_url_scope_precedes_runtime_derivation() {
        let state = two_runtime_state();
        let request = ToolCallRequest {
            name: "actions.site".to_string(),
            arguments: json!({ "mode": "list" }),
            target_runtime_id: Some("rt-trello".to_string()),
            target_url_contains: Some("trello.com/card-scope".to_string()),
            timeout_ms: default_timeout_ms(),
        };

        let target = site_action_target_url_contains(&state, &request)
            .await
            .expect("the explicit URL scope should be preserved");

        assert_eq!(target.as_deref(), Some("trello.com/card-scope"));
    }

    #[tokio::test]
    async fn site_action_target_url_allows_global_listing_without_runtimes() {
        let state = two_runtime_state();
        state.runtimes.lock().await.clear();
        let request = ToolCallRequest {
            name: "actions.site".to_string(),
            arguments: json!({ "mode": "list" }),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };

        let target = site_action_target_url_contains(&state, &request)
            .await
            .expect("offline global discovery should remain available");

        assert_eq!(target, None);
    }

    #[tokio::test]
    async fn site_action_target_url_rejects_selected_runtime_without_url() {
        let state = two_runtime_state();
        state
            .runtimes
            .lock()
            .await
            .get_mut("rt-trello")
            .expect("fixture runtime")
            .url = None;
        let request = ToolCallRequest {
            name: "actions.site".to_string(),
            arguments: json!({ "mode": "list" }),
            target_runtime_id: Some("rt-trello".to_string()),
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };

        let (_, payload) = site_action_target_url_contains(&state, &request)
            .await
            .expect_err("a selected runtime without a URL must not widen scope");

        assert_eq!(payload["error"]["code"], "runtime_url_missing");
    }

    fn empty_state() -> AppState {
        state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        )
    }

    // ---- Spec 038: agent-event queue + await_event ----

    #[tokio::test]
    async fn agent_event_push_assigns_monotonic_seq() {
        let state = empty_state();
        state
            .push_agent_event(
                "rt-1",
                "t0".into(),
                "transcript".into(),
                json!({"text":"a"}),
            )
            .await;
        state
            .push_agent_event(
                "rt-1",
                "t1".into(),
                "tool".into(),
                json!({"name":"x","ok":true}),
            )
            .await;
        let map = state.agent_event_queues.lock().await;
        let queue = map.get("rt-1").expect("queue exists");
        let seqs: Vec<u64> = queue.events.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![0, 1]);
        assert_eq!(queue.next_seq, 2);
    }

    #[tokio::test]
    async fn agent_event_queue_cap_evicts_with_marker() {
        let state = empty_state();
        for i in 0..(AGENT_EVENT_QUEUE_CAP + 5) {
            state
                .push_agent_event(
                    "rt-1",
                    format!("t{i}"),
                    "transcript".into(),
                    json!({"i": i}),
                )
                .await;
        }
        let map = state.agent_event_queues.lock().await;
        let queue = map.get("rt-1").unwrap();
        assert!(queue.events.len() <= AGENT_EVENT_QUEUE_CAP + 1);
        assert!(queue.events.iter().any(|e| e.kind == "events_dropped"));
    }

    fn a11y_rec(
        text: &str,
        politeness: &str,
        region: &str,
        role: Option<&str>,
        relevant: &str,
        ts: u64,
    ) -> A11yAnnouncement {
        A11yAnnouncement {
            seq: 0,
            ts_ms: ts,
            text: text.to_string(),
            politeness: politeness.to_string(),
            region: Some(region.to_string()),
            region_role: role.map(str::to_string),
            relevant: Some(relevant.to_string()),
            interrupt: politeness == "assertive",
            tab: Some(7),
            runtime_key: None,
        }
    }

    #[test]
    fn a11y_default_policy_maps_site_urgency() {
        let mut store = A11yStore::default();
        store.ingest(a11y_rec(
            "urgent",
            "assertive",
            "#a",
            None,
            "additions text",
            1000,
        ));
        store.ingest(a11y_rec(
            "calm",
            "polite",
            "#b",
            None,
            "additions text",
            1100,
        ));
        assert_eq!(store.history.len(), 2);
        assert_eq!(store.inject.len(), 1, "assertive injects, polite buffers");
        let drained = store.drain_inject();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].text, "urgent");
        assert!(store.drain_inject().is_empty(), "drain is consuming");
    }

    #[test]
    fn a11y_per_tab_config_overrides_and_isolates_subscribers() {
        let mut store = A11yStore::default();
        store.configure("mcp", Some(7), Some("off".to_string()), None);
        assert_eq!(store.mode_for("mcp", Some(7), "assertive"), "off");
        assert_eq!(
            store.mode_for("mcp", Some(8), "assertive"),
            "inject",
            "other tab keeps default"
        );
        assert_eq!(
            store.mode_for("hosted", Some(7), "assertive"),
            "inject",
            "one agent's configure cannot mutate another's (R4a)"
        );
        store.ingest(a11y_rec(
            "dropped",
            "assertive",
            "#a",
            None,
            "additions text",
            1000,
        ));
        assert_eq!(store.history.len(), 0, "off drops cleanly");
    }

    #[test]
    fn a11y_dedupes_identical_bursts() {
        let mut store = A11yStore::default();
        store.ingest(a11y_rec(
            "same",
            "assertive",
            "#a",
            None,
            "additions text",
            1000,
        ));
        store.ingest(a11y_rec(
            "same",
            "assertive",
            "#a",
            None,
            "additions text",
            1200,
        ));
        assert_eq!(store.history.len(), 1);
    }

    #[test]
    fn a11y_last_wins_per_region_but_log_regions_are_additive() {
        let mut store = A11yStore::default();
        store.ingest(a11y_rec(
            "v1",
            "polite",
            "#status",
            None,
            "additions text",
            1000,
        ));
        store.ingest(a11y_rec(
            "v2",
            "polite",
            "#status",
            None,
            "additions text",
            2000,
        ));
        assert_eq!(
            store.history.len(),
            1,
            "windowed last-wins replaces the stale entry"
        );
        assert_eq!(store.history.back().unwrap().text, "v2");

        let mut log_store = A11yStore::default();
        log_store.ingest(a11y_rec(
            "m1",
            "polite",
            "#log",
            Some("log"),
            "additions",
            1000,
        ));
        log_store.ingest(a11y_rec(
            "m2",
            "polite",
            "#log",
            Some("log"),
            "additions",
            1500,
        ));
        log_store.ingest(a11y_rec(
            "m3",
            "polite",
            "#log",
            Some("log"),
            "additions",
            2000,
        ));
        assert_eq!(
            log_store.history.len(),
            3,
            "three distinct log messages yield three history entries"
        );
    }

    #[test]
    fn a11y_drain_respects_budget_and_fifo() {
        let mut store = A11yStore::default();
        for i in 0..8 {
            store.ingest(a11y_rec(
                &format!("msg {i}"),
                "assertive",
                &format!("#r{i}"),
                None,
                "additions text",
                1000 + i * 3000,
            ));
        }
        let first = store.drain_inject();
        assert_eq!(first.len(), A11Y_PIGGYBACK_MAX_RECORDS);
        assert_eq!(first[0].text, "msg 0", "FIFO");
        let rest = store.drain_inject();
        assert_eq!(rest.len(), 3);
    }

    #[test]
    fn a11y_read_pages_by_cursor() {
        let mut store = A11yStore::default();
        for i in 0..4 {
            store.ingest(a11y_rec(
                &format!("m{i}"),
                "polite",
                &format!("#r{i}"),
                None,
                "additions text",
                1000 + i * 3000,
            ));
        }
        let (page1, cursor) = store.read(None, 2);
        assert_eq!(page1.len(), 2);
        let (page2, _) = store.read(Some(cursor), 10);
        assert_eq!(page2.len(), 2);
        assert_eq!(page2[0].text, "m2");
    }

    #[tokio::test]
    async fn ingest_agent_event_lands_in_runtime_queue() {
        let state = empty_state();
        ingest_agent_event(
            &state,
            &json!({
                "type": "agent_event", "runtime_id": "rt-9", "ts": "2026-07-04T00:00:00Z",
                "kind": "transcript", "payload": {"role":"assistant","text":"done"}
            }),
        )
        .await;
        let map = state.agent_event_queues.lock().await;
        let event = &map.get("rt-9").unwrap().events[0];
        assert_eq!(event.kind, "transcript");
        assert_eq!(event.payload["text"], "done");
    }

    #[tokio::test]
    async fn ingest_agent_event_ignores_missing_runtime_id() {
        let state = empty_state();
        ingest_agent_event(&state, &json!({ "type": "agent_event" })).await;
        assert!(state.agent_event_queues.lock().await.is_empty());
    }

    #[tokio::test]
    async fn await_event_returns_backlog_immediately() {
        let state = empty_state();
        state
            .push_agent_event(
                "rt-1",
                "t0".into(),
                "transcript".into(),
                json!({"text":"a"}),
            )
            .await;
        state
            .push_agent_event(
                "rt-1",
                "t1".into(),
                "transcript".into(),
                json!({"text":"b"}),
            )
            .await;
        let out = await_agent_event(&state, "rt-1", -1, 5000).await;
        assert_eq!(out["events"].as_array().unwrap().len(), 2);
        assert_eq!(out["cursor"], 1);
        assert_eq!(out["idle"], false);
    }

    #[tokio::test]
    async fn await_event_respects_cursor() {
        let state = empty_state();
        for i in 0..3 {
            state
                .push_agent_event(
                    "rt-1",
                    format!("t{i}"),
                    "transcript".into(),
                    json!({"i": i}),
                )
                .await;
        }
        // Already saw seq 0 and 1; only seq 2 should return.
        let out = await_agent_event(&state, "rt-1", 1, 5000).await;
        let events = out["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["seq"], 2);
        assert_eq!(out["cursor"], 2);
    }

    #[tokio::test]
    async fn await_event_blocks_then_wakes_on_push() {
        let state = empty_state();
        let waiter_state = state.clone();
        let handle =
            tokio::spawn(async move { await_agent_event(&waiter_state, "rt-1", -1, 5000).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        state
            .push_agent_event(
                "rt-1",
                "t0".into(),
                "tool".into(),
                json!({"name":"x","ok":true}),
            )
            .await;
        let out = handle.await.unwrap();
        assert_eq!(out["events"].as_array().unwrap().len(), 1);
        assert_eq!(out["idle"], false);
    }

    #[tokio::test]
    async fn await_event_does_not_miss_a_push_racing_the_wait() {
        // Regression: a push firing notify_waiters() in the window between the
        // ready-check and the await must still wake the waiter. Repeat to make a
        // lost-wakeup flake surface.
        for _ in 0..50 {
            let state = empty_state();
            let waiter_state = state.clone();
            let handle =
                tokio::spawn(
                    async move { await_agent_event(&waiter_state, "rt-1", -1, 3000).await },
                );
            // No sleep — race the push against the waiter's first ready-check.
            state
                .push_agent_event(
                    "rt-1",
                    "t".into(),
                    "tool".into(),
                    json!({"name":"x","ok":true}),
                )
                .await;
            let out = handle.await.unwrap();
            assert_eq!(
                out["idle"], false,
                "waiter must observe the racing push, not time out"
            );
            assert_eq!(out["events"].as_array().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn await_event_times_out_idle() {
        let state = empty_state();
        state
            .push_agent_event(
                "rt-1",
                "t0".into(),
                "transcript".into(),
                json!({"text":"a"}),
            )
            .await;
        // Caller is caught up (cursor = last seq 0), no new events → idle.
        let out = await_agent_event(&state, "rt-1", 0, 1000).await;
        assert_eq!(out["idle"], true);
        assert_eq!(out["events"].as_array().unwrap().len(), 0);
        assert!(out["silent_ms"].as_u64().unwrap() >= 900);
    }

    #[tokio::test]
    async fn await_event_advertised_on_both_surfaces() {
        let state = empty_state();
        let catalog = state.catalog.lock().await;
        let advertised = catalog.manifest["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "runtime.agent.await_event");
        let site = catalog.site_manifest["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "runtime.agent.await_event");
        assert!(advertised, "await_event must be in the advertised manifest");
        assert!(site, "await_event must be in the site manifest");
    }

    #[tokio::test]
    async fn await_event_end_to_end_burst_gap_wake() {
        let state = empty_state();
        // Burst of 3 while nobody is awaiting.
        for i in 0..3 {
            ingest_agent_event(
                &state,
                &json!({"type":"agent_event","runtime_id":"rt-1","ts":format!("t{i}"),
                        "kind":"transcript","payload":{"i":i}}),
            )
            .await;
        }
        let out = await_agent_event(&state, "rt-1", -1, 1000).await;
        assert_eq!(out["events"].as_array().unwrap().len(), 3);
        let cursor = out["cursor"].as_i64().unwrap();

        // Caught up → idle.
        let idle = await_agent_event(&state, "rt-1", cursor, 1000).await;
        assert_eq!(idle["idle"], true);

        // A blocked waiter wakes on the next event.
        let waiter_state = state.clone();
        let handle =
            tokio::spawn(
                async move { await_agent_event(&waiter_state, "rt-1", cursor, 5000).await },
            );
        tokio::time::sleep(Duration::from_millis(20)).await;
        ingest_agent_event(
            &state,
            &json!({"type":"agent_event","runtime_id":"rt-1","ts":"t3",
                    "kind":"refusal","payload":{"tool":"x","reason":"y"}}),
        )
        .await;
        let woke = handle.await.unwrap();
        assert_eq!(woke["events"].as_array().unwrap().len(), 1);
        assert_eq!(woke["events"][0]["kind"], "refusal");
    }

    fn bare_call(name: &str) -> ResolvedToolCall {
        ResolvedToolCall {
            name: name.to_string(),
            arguments: json!({}),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
            static_output: None,
        }
    }

    #[test]
    fn routing_meta_args_are_stripped_before_schema_validation() {
        // A generic tool with additionalProperties:false must accept a routed
        // call carrying target_url_contains inside arguments (the only carrier
        // an MCP client has) without rejecting it as undeclared.
        let tool = json!({
            "name": "dom.snapshot_text",
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": { "selector": { "type": "string" } }
            }
        });
        let request = ToolCallRequest {
            name: "dom.snapshot_text".to_string(),
            arguments: json!({
                "selector": "main",
                "target_url_contains": "lab651.com",
                "policy_exception_report": {
                    "kind": "generic",
                    "intended_tool": "dom.snapshot_text",
                    "actions_json_path": "none",
                    "reason": "Routed exploration during map authoring."
                }
            }),
            target_runtime_id: None,
            target_url_contains: Some("lab651.com".to_string()),
            timeout_ms: default_timeout_ms(),
        };
        let prepared = validate_and_prepare_direct_tool_arguments(&tool, &request).unwrap();
        // Both the routing key and the policy report are gone; the real argument survives.
        assert_eq!(prepared, json!({ "selector": "main" }));
    }

    #[test]
    fn advertised_schema_declares_routing_meta_fields() {
        let tool = json!({
            "name": "dom.snapshot_text",
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": { "selector": { "type": "string" } }
            }
        });
        let schema = advertised_input_schema_for_tool(&tool);
        let props = &schema["properties"];
        assert_eq!(props["target_runtime_id"]["type"].as_str(), Some("string"));
        assert_eq!(
            props["target_url_contains"]["type"].as_str(),
            Some("string")
        );
        // The original property is preserved.
        assert_eq!(props["selector"]["type"].as_str(), Some("string"));
    }

    #[test]
    fn advertised_schema_does_not_clobber_existing_target_url_contains() {
        // actions.site already declares target_url_contains with its own wording.
        let manifest = site_actions_tool_manifest();
        let advertised = advertised_input_schema_for_tool(&manifest);
        let desc = advertised["properties"]["target_url_contains"]["description"]
            .as_str()
            .unwrap_or("");
        assert!(desc.contains("site catalog"));
    }

    #[test]
    fn schema_validation_aggregates_independent_missing_required_fields() {
        let tool = json!({
            "name": "browser.extract_elements",
            "input_schema": {
                "type": "object",
                "required": ["item_selector", "fields"],
                "properties": {
                    "item_selector": { "type": "string" },
                    "fields": { "type": "array" }
                }
            }
        });
        let error = validate_tool_arguments(&tool, "browser.extract_elements", &json!({}))
            .expect_err("both missing fields must be reported");
        let body = (error.1).0;
        assert_eq!(body["error"]["code"], "invalid_input");
        assert_eq!(
            body["error"]["evidence"]["missing_required"],
            json!(["arguments.item_selector", "arguments.fields"])
        );
        assert_eq!(
            body["error"]["evidence"]["validation_errors"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn schema_validation_reports_siblings_but_stops_at_wrong_parent_type() {
        let tool = json!({
            "name": "example",
            "input_schema": {
                "type": "object",
                "required": ["options"],
                "properties": {
                    "options": {
                        "type": "object",
                        "required": ["mode", "limit"],
                        "properties": {
                            "mode": { "type": "string" },
                            "limit": { "type": "integer" }
                        }
                    },
                    "query": { "type": "string" }
                }
            }
        });
        let error =
            validate_tool_arguments(&tool, "example", &json!({"options": "wrong", "query": 4}))
                .expect_err("invalid siblings must be reported");
        let body = (error.1).0;
        let errors = body["error"]["evidence"]["validation_errors"]
            .as_array()
            .unwrap();
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0]["keyword"], "type");
        assert_eq!(errors[0]["path"], "arguments.options");
        assert_eq!(errors[1]["keyword"], "type");
        assert_eq!(errors[1]["path"], "arguments.query");
    }

    #[tokio::test]
    async fn select_runtime_falls_back_to_active_tab_when_ambiguous() {
        let state = two_runtime_state();
        // Default active tab is the first-seeded runtime.
        let chosen = select_runtime(&state, &bare_call("storage.list"))
            .await
            .unwrap();
        assert!(chosen.runtime_id == "rt-lab" || chosen.runtime_id == "rt-trello");

        // Explicitly make Trello active; a bare call now routes there.
        *state.active_runtime_id.lock().await = Some("rt-trello".to_string());
        let chosen = select_runtime(&state, &bare_call("storage.list"))
            .await
            .unwrap();
        assert_eq!(chosen.runtime_id, "rt-trello");
    }

    #[tokio::test]
    async fn explicit_target_overrides_active_tab() {
        let state = two_runtime_state();
        *state.active_runtime_id.lock().await = Some("rt-trello".to_string());
        let mut call = bare_call("storage.list");
        call.target_url_contains = Some("lab651.com".to_string());
        let chosen = select_runtime(&state, &call).await.unwrap();
        assert_eq!(chosen.runtime_id, "rt-lab");
    }

    #[tokio::test]
    async fn select_runtime_errors_when_ambiguous_and_no_active() {
        let state = two_runtime_state();
        *state.active_runtime_id.lock().await = None;
        let result = select_runtime(&state, &bare_call("storage.list")).await;
        let error = match result {
            Ok(client) => panic!(
                "expected ambiguity error, got runtime {}",
                client.runtime_id
            ),
            Err(error) => error,
        };
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert_eq!(
            error.1["routing_trace"]["decision"].as_str(),
            Some("ambiguous_without_target")
        );
    }

    #[tokio::test]
    async fn disconnecting_active_runtime_adopts_remaining_runtime() {
        let state = two_runtime_state();
        {
            let mut runtimes = state.runtimes.lock().await;
            runtimes
                .get_mut("rt-lab")
                .expect("seeded lab runtime")
                .connection_id = "connection-2".to_string();
            let (tx, _rx) = mpsc::unbounded_channel::<Message>();
            runtimes.insert(
                "rt-docs".to_string(),
                RuntimeClient {
                    runtime_id: "rt-docs".to_string(),
                    connection_id: "connection-2".to_string(),
                    runtime_key: None,
                    authorization_id: None,
                    extension_version: None,
                    device: None,
                    url: Some("https://docs.example.com/".to_string()),
                    tab: None,
                    replay: None,
                    connected_at_ms: now_ms(),
                    last_seen_ms: now_ms(),
                    tx,
                },
            );
        }
        *state.active_runtime_id.lock().await = Some("rt-trello".to_string());

        let disconnected_runtime_ids =
            Arc::new(Mutex::new(HashSet::from(["rt-trello".to_string()])));
        remove_runtimes_for_connection(
            &state,
            &disconnected_runtime_ids,
            "test-connection",
            "test",
        )
        .await;

        let chosen = select_runtime(&state, &bare_call("storage.list"))
            .await
            .expect("bare calls should route to an adopted active runtime");
        assert!(chosen.runtime_id == "rt-lab" || chosen.runtime_id == "rt-docs");
        let active = state.active_runtime_id.lock().await.clone();
        assert!(active.as_deref() == Some("rt-lab") || active.as_deref() == Some("rt-docs"));
    }

    #[tokio::test]
    async fn disconnect_writes_persistent_lifecycle_log() {
        // A dropped tab is invisible in /runtimes after the fact; the persistent
        // JSONL log is the only durable record of which tab dropped and why.
        let root = tempdir().unwrap();
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            vec![RuntimeSeed {
                runtime_id: "rt-trello".to_string(),
                url: Some("https://trello.com/b/abc".to_string()),
            }],
            Some(root.path().to_path_buf()),
        );
        // Seed matches the default connection id used by state_from_catalog seeds.
        let connection_id = state
            .runtimes
            .lock()
            .await
            .get("rt-trello")
            .expect("seeded runtime")
            .connection_id
            .clone();

        let dropped = Arc::new(Mutex::new(HashSet::from(["rt-trello".to_string()])));
        remove_runtimes_for_connection(&state, &dropped, &connection_id, "receive_loop_ended")
            .await;

        let log_path = root.path().join("logs").join("bridge-lifecycle.jsonl");
        let contents = std::fs::read_to_string(&log_path)
            .expect("lifecycle log file should exist after a disconnect");
        let last = contents
            .lines()
            .last()
            .expect("at least one lifecycle log line");
        let entry: Value = serde_json::from_str(last).expect("log line is valid JSON");
        assert_eq!(entry["event"], "disconnect");
        assert_eq!(entry["reason"], "receive_loop_ended");
        assert_eq!(entry["remaining_runtimes"], 0);
        assert_eq!(
            entry["runtimes"][0]["tab_url"], "https://trello.com/b/abc",
            "the dropped tab's url must be recorded"
        );
    }

    // ---- U1: registry liveness core (TTL staleness + sweep + live-only view) ----
    //
    // The lying-liveness failure the invariant exists to kill: a runtime whose
    // heartbeat stopped (its tab is gone) must never be advertised as connected
    // or listed. `connected` and the runtime list are derived from *live*
    // runtimes only, and a periodic sweep evicts the dead ones with a lifecycle
    // log — enforced in depth, not by one signal.

    /// Directly age a seeded runtime's heartbeat so it reads as stale, without
    /// waiting real time. Sets `last_seen_ms` to `age_ms` in the past.
    async fn age_runtime_last_seen(state: &AppState, runtime_id: &str, age_ms: u128) {
        let mut runtimes = state.runtimes.lock().await;
        let client = runtimes
            .get_mut(runtime_id)
            .expect("runtime should be seeded before ageing it");
        client.last_seen_ms = now_ms().saturating_sub(age_ms);
    }

    #[tokio::test]
    async fn fresh_runtime_is_listed_and_counts_as_connected() {
        // A runtime whose heartbeat is within the TTL is live: listed, counted,
        // connected: true. (Covers SC1.)
        let state = two_runtime_state();
        let resource = bridge_runtimes_resource(&state).await;
        assert_eq!(resource["connected"], json!(true));
        assert_eq!(resource["count"], json!(2));
        let ids: Vec<&str> = resource["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["runtime_id"].as_str())
            .collect();
        assert!(ids.contains(&"rt-lab") && ids.contains(&"rt-trello"));
    }

    #[tokio::test]
    async fn stale_runtime_is_absent_from_list_and_not_connected() {
        // A runtime whose heartbeat is older than the TTL is dead: never listed,
        // never counted, and `connected` is false when it was the only one.
        let state = two_runtime_state();
        // Age BOTH past the TTL — the whole registry is stale.
        age_runtime_last_seen(&state, "rt-lab", RUNTIME_LIVENESS_TTL_MS + 1_000).await;
        age_runtime_last_seen(&state, "rt-trello", RUNTIME_LIVENESS_TTL_MS + 1_000).await;

        let resource = bridge_runtimes_resource(&state).await;
        assert_eq!(
            resource["connected"],
            json!(false),
            "an all-stale registry must not advertise connected"
        );
        assert_eq!(resource["count"], json!(0));
        assert_eq!(resource["runtimes"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn one_stale_one_live_lists_only_the_live_one() {
        // Mixed registry: the live runtime is listed and connected: true; the
        // stale one is filtered out of the advertised view.
        let state = two_runtime_state();
        age_runtime_last_seen(&state, "rt-lab", RUNTIME_LIVENESS_TTL_MS + 1_000).await;

        let resource = bridge_runtimes_resource(&state).await;
        assert_eq!(resource["connected"], json!(true));
        assert_eq!(resource["count"], json!(1));
        let ids: Vec<&str> = resource["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["runtime_id"].as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["rt-trello"],
            "only the live runtime is advertised"
        );
    }

    #[tokio::test]
    async fn sweep_evicts_stale_runtimes_and_is_idempotent() {
        // The sweep physically evicts dead runtimes (so the registry shrinks,
        // not just the view) and is idempotent — a second sweep is a no-op and
        // an empty registry does not panic.
        let root = tempdir().unwrap();
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            vec![
                RuntimeSeed {
                    runtime_id: "rt-live".to_string(),
                    url: Some("https://live.example.com/".to_string()),
                },
                RuntimeSeed {
                    runtime_id: "rt-dead".to_string(),
                    url: Some("https://dead.example.com/".to_string()),
                },
            ],
            Some(root.path().to_path_buf()),
        );
        age_runtime_last_seen(&state, "rt-dead", RUNTIME_LIVENESS_TTL_MS + 1_000).await;

        let evicted = sweep_stale_runtimes(&state).await;
        assert_eq!(evicted, 1, "one stale runtime evicted");
        {
            let runtimes = state.runtimes.lock().await;
            assert!(runtimes.contains_key("rt-live"), "live runtime survives");
            assert!(!runtimes.contains_key("rt-dead"), "dead runtime is gone");
        }

        // Idempotent: a second sweep evicts nothing.
        let evicted_again = sweep_stale_runtimes(&state).await;
        assert_eq!(evicted_again, 0, "second sweep is a no-op");

        // The eviction is recorded in the persistent lifecycle log.
        let log_path = root.path().join("logs").join("bridge-lifecycle.jsonl");
        let contents = std::fs::read_to_string(&log_path)
            .expect("lifecycle log should record the sweep eviction");
        assert!(
            contents.lines().any(|line| {
                serde_json::from_str::<Value>(line)
                    .map(|e| e["event"] == "disconnect" && e["reason"] == "liveness_sweep")
                    .unwrap_or(false)
            }),
            "sweep eviction is logged with reason liveness_sweep"
        );
    }

    // ---- U6: intent routing — resolve "the <description> runtime" to one live match ----
    //
    // The agent should route by intent (a board name, a host, a title fragment)
    // instead of hand-copying a runtime_id. The existing url_contains resolver is
    // widened to match url OR title OR host (case-insensitively), still errors on
    // zero (runtime_not_found) and >1 (ambiguity naming candidates), and is
    // live-only via select_runtime's registry.

    #[test]
    fn runtime_matches_intent_spans_url_title_and_host() {
        let client = seed_client_with_tab(
            "rt",
            "https://trello.com/b/abc/quarterly-roadmap",
            "Quarterly Roadmap | Trello",
        );
        assert!(
            runtime_matches_intent(&client, "quarterly-roadmap"),
            "url path"
        );
        assert!(
            runtime_matches_intent(&client, "Quarterly Roadmap"),
            "title"
        );
        assert!(
            runtime_matches_intent(&client, "TRELLO.COM"),
            "host, case-insensitive"
        );
        assert!(
            runtime_matches_intent(&client, "roadmap"),
            "title fragment, case-insensitive"
        );
        assert!(!runtime_matches_intent(&client, "gmail"), "non-match");
    }

    #[tokio::test]
    async fn intent_phrase_matching_one_runtime_resolves_to_it() {
        let state = empty_state();
        {
            let mut runtimes = state.runtimes.lock().await;
            runtimes.insert(
                "rt-trello".into(),
                seed_client_with_tab("rt-trello", "https://trello.com/b/x", "Board X"),
            );
            runtimes.insert(
                "rt-docs".into(),
                seed_client_with_tab("rt-docs", "https://docs.google.com/d/y", "Doc Y"),
            );
        }
        let mut call = bare_call("storage.list");
        call.target_url_contains = Some("Doc Y".to_string()); // title-based intent
        let chosen = select_runtime(&state, &call).await.unwrap();
        assert_eq!(chosen.runtime_id, "rt-docs");
    }

    #[tokio::test]
    async fn intent_phrase_matching_none_returns_runtime_not_found() {
        let state = two_runtime_state();
        let mut call = bare_call("storage.list");
        call.target_url_contains = Some("nonexistent-site".to_string());
        let err = select_runtime(&state, &call).await.err().unwrap();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert_eq!(err.1 .0["error"]["code"], "runtime_not_found");
        assert!(err.1 .0["error"]["next_step"].is_string());
    }

    #[tokio::test]
    async fn intent_phrase_matching_two_runtimes_is_an_ambiguity_naming_candidates() {
        let state = empty_state();
        {
            let mut runtimes = state.runtimes.lock().await;
            runtimes.insert(
                "rt-a".into(),
                seed_client_with_tab("rt-a", "https://trello.com/b/a", "Team Alpha"),
            );
            runtimes.insert(
                "rt-b".into(),
                seed_client_with_tab("rt-b", "https://trello.com/b/b", "Team Beta"),
            );
        }
        let mut call = bare_call("storage.list");
        call.target_url_contains = Some("trello.com".to_string()); // matches both
        let err = select_runtime(&state, &call).await.err().unwrap();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert_eq!(err.1 .0["error"]["code"], "ambiguous_intent");
        // The candidates are named by the agent-facing shape so the agent can pick.
        let candidates = err.1 .0["error"]["evidence"]["candidates"]
            .as_array()
            .unwrap();
        assert_eq!(candidates.len(), 2);
        for c in candidates {
            assert!(c["runtime_id"].is_string() && c["host"].is_string());
        }
    }

    // ---- U5: unified live-runtime view — one id, url/title/host, no dead field ----
    //
    // One authoritative "your live runtimes" view: live-only, one agent-facing
    // id, human-meaningful labels (url + title + host so two Chromes are
    // unambiguous), an explicit is_live, and NO vestigial runtime_key /
    // chrome-tab: id and NO always-null claimed_at_ms.

    fn seed_client_with_tab(runtime_id: &str, url: &str, title: &str) -> RuntimeClient {
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        RuntimeClient {
            runtime_id: runtime_id.to_string(),
            connection_id: "c".into(),
            runtime_key: Some("chrome-tab:99".into()),
            authorization_id: Some("auth".into()),
            extension_version: Some("0.1.99".into()),
            device: None,
            url: Some(url.to_string()),
            tab: Some(json!({ "id": 99, "title": title, "url": url, "active": true })),
            replay: None,
            connected_at_ms: now_ms(),
            last_seen_ms: now_ms(),
            tx,
        }
    }

    // ---- U8: machine/browser label (R6-for-real) ----
    //
    // LIVE-CAUGHT (2026-07-09, the product owner ran 0.1.187 on Windows AND Mac): U5's `host`
    // is the SITE host (host_from_url), so two runtimes on the SAME url across two
    // BROWSERS collapse to the same label and are indistinguishable. R6's real
    // intent is a machine/browser label. The extension reports `device` at
    // runtime_ready; the bridge surfaces it as a field DISTINCT from `host`.

    fn seed_client_on_device(runtime_id: &str, url: &str, device: &str) -> RuntimeClient {
        let mut client = seed_client_with_tab(runtime_id, url, "Same Page");
        client.device = Some(device.to_string());
        client
    }

    #[test]
    fn two_runtimes_on_the_same_site_are_distinguished_by_device() {
        // The exact scenario the live 2-machine test could not resolve: same url,
        // same site host, two different browsers.
        let win = seed_client_on_device("rt-win", "https://trello.com/b/x", "win · a3f2");
        let mac = seed_client_on_device("rt-mac", "https://trello.com/b/x", "mac · 7c19");

        let win_row = runtime_summary(&win);
        let mac_row = runtime_summary(&mac);

        // Site host is identical — that's the ambiguity.
        assert_eq!(win_row["host"], mac_row["host"]);
        assert_eq!(win_row["host"], "trello.com");

        // `device` is what disambiguates them, and it is NOT the site host.
        assert_eq!(win_row["device"], "win · a3f2");
        assert_eq!(mac_row["device"], "mac · 7c19");
        assert_ne!(win_row["device"], mac_row["device"]);
        assert_ne!(win_row["device"], win_row["host"]);
    }

    #[test]
    fn device_is_absent_not_null_when_the_extension_does_not_report_it() {
        // Older extensions don't send `device`. Never serialize a constant null
        // (R10) — omit the field instead.
        let client = seed_client_with_tab("rt", "https://x.com/a", "X");
        let row = runtime_summary(&client);
        if let Some(device) = row.get("device") {
            assert!(!device.is_null(), "device is real or absent, never null");
        }
    }

    #[test]
    fn host_from_url_extracts_the_site_label() {
        assert_eq!(
            host_from_url("https://trello.com/b/abc"),
            Some("trello.com".into())
        );
        assert_eq!(
            host_from_url("https://docs.google.com/document/d/1"),
            Some("docs.google.com".into())
        );
        assert_eq!(
            host_from_url("http://localhost:9223/x"),
            Some("localhost".into())
        );
        assert_eq!(
            host_from_url("https://user@example.com:8080/p"),
            Some("example.com".into())
        );
        assert_eq!(host_from_url(""), None);
        assert_eq!(host_from_url("/relative/path"), None);
    }

    #[test]
    fn runtime_summary_is_the_agent_facing_shape_without_dead_fields() {
        let client = seed_client_with_tab(
            "rt-1",
            "https://trello.com/b/abc/my-board",
            "My Board | Trello",
        );
        let summary = runtime_summary(&client);
        // The agent-facing identity is exactly runtime_id.
        assert_eq!(summary["runtime_id"], "rt-1");
        // Human-meaningful labels.
        assert_eq!(summary["url"], "https://trello.com/b/abc/my-board");
        assert_eq!(summary["title"], "My Board | Trello");
        assert_eq!(summary["host"], "trello.com", "host derived from url");
        assert_eq!(summary["is_live"], json!(true));
        // The vestigial id spaces are gone from the agent surface.
        assert!(summary.get("runtime_key").is_none(), "no runtime_key");
        assert!(summary.get("tab").is_none(), "no raw chrome tab object");
        // claimed_at_ms is never serialized as a constant null.
        if let Some(claimed) = summary.get("claimed_at_ms") {
            assert!(
                !claimed.is_null(),
                "claimed_at_ms is real or absent, never null"
            );
        }
    }

    #[tokio::test]
    async fn bridge_runtimes_view_labels_two_browsers_distinctly() {
        // SC3: two live runtimes on different hosts each carry enough per-row
        // labeling (host + title) to pick the intended one with no other tool.
        let state = empty_state();
        {
            let mut runtimes = state.runtimes.lock().await;
            runtimes.insert(
                "rt-trello".into(),
                seed_client_with_tab("rt-trello", "https://trello.com/b/x", "Board X"),
            );
            runtimes.insert(
                "rt-docs".into(),
                seed_client_with_tab("rt-docs", "https://docs.google.com/document/d/y", "Doc Y"),
            );
        }
        let resource = bridge_runtimes_resource(&state).await;
        let rows = resource["runtimes"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let hosts: Vec<&str> = rows.iter().filter_map(|r| r["host"].as_str()).collect();
        assert!(hosts.contains(&"trello.com") && hosts.contains(&"docs.google.com"));
        // No row leaks a runtime_key / chrome-tab: id.
        for row in rows {
            assert!(row.get("runtime_key").is_none());
        }
    }

    #[tokio::test]
    async fn bridge_claimed_tabs_view_is_global_across_extension_instances() {
        let state = empty_state();
        {
            let mut runtimes = state.runtimes.lock().await;
            let mut mac = seed_client_on_device("rt-mac", "https://trello.com/b/x", "mac · 7c19");
            mac.tab = Some(json!({
                "tab_id": 7,
                "window_id": 11,
                "title": "Board X",
                "active": true
            }));
            let mut win = seed_client_on_device(
                "rt-win",
                "https://docs.google.com/document/d/y",
                "win · a3f2",
            );
            // Raw Chrome tab ids may collide across browser sessions. The global
            // view must retain both rows and make runtime_id the address.
            win.tab = Some(json!({
                "tab_id": 7,
                "window_id": 22,
                "title": "Doc Y",
                "active": true
            }));
            runtimes.insert(mac.runtime_id.clone(), mac);
            runtimes.insert(win.runtime_id.clone(), win);
        }
        *state.active_runtime_id.lock().await = Some("rt-mac".into());

        // Even a runtime-targeted MCP call must be answered by the bridge;
        // dispatching it would collapse the inventory back to one browser.
        let request = ToolCallRequest {
            name: "browser.claimed_tabs.list".into(),
            arguments: json!({}),
            target_runtime_id: Some("rt-mac".into()),
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };
        let response = tools_call_inner(State(state.clone()), Json(request))
            .await
            .expect("bridge-owned inventory succeeds")
            .0;
        let view = response.output.expect("inventory output");
        assert_eq!(view["scope"], "bridge");
        assert_eq!(view["complete"], true);
        assert_eq!(view["count"], 2);

        let rows = view["tabs"].as_array().unwrap();
        assert_eq!(rows.iter().filter(|row| row["tab_id"] == 7).count(), 2);
        assert!(rows.iter().any(|row| {
            row["runtime_id"] == "rt-mac" && row["device"] == "mac · 7c19" && row["active"] == true
        }));
        assert!(rows.iter().any(|row| {
            row["runtime_id"] == "rt-win" && row["device"] == "win · a3f2" && row["active"] == false
        }));
        assert!(rows.iter().all(|row| row.get("bridge_url").is_none()));

        let ambiguous_activate = ToolCallRequest {
            name: "browser.claimed_tabs.activate".into(),
            arguments: json!({"tab_id": 7}),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        };
        let (status, Json(error)) =
            tools_call_inner(State(state.clone()), Json(ambiguous_activate))
                .await
                .expect_err("colliding browser-local tab id must not route implicitly");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"]["code"], "owner_runtime_required");
        assert_eq!(error["error"]["evidence"]["tab_id"], 7);
    }

    #[test]
    fn global_tab_lifecycle_calls_require_the_owner_runtime_for_explicit_tab_ids() {
        for name in [
            "browser.claimed_tabs.activate",
            "browser.navigate",
            "browser.close_tab",
            "browser.dismiss_dialog",
        ] {
            let ambiguous = ToolCallRequest {
                name: name.into(),
                arguments: json!({"tab_id": 7}),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            };
            let (status, Json(error)) =
                validate_owner_qualified_lifecycle_target(&ambiguous).unwrap_err();
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(error["error"]["code"], "owner_runtime_required");

            let owner_bound = ToolCallRequest {
                target_runtime_id: Some("rt-win".into()),
                ..ambiguous
            };
            validate_owner_qualified_lifecycle_target(&owner_bound)
                .expect("runtime + local tab id is owner-qualified");
        }
    }

    #[test]
    fn active_tab_lifecycle_calls_preserve_extension_local_behavior() {
        for name in [
            "browser.navigate",
            "browser.close_tab",
            "browser.dismiss_dialog",
        ] {
            let active_tab = ToolCallRequest {
                name: name.into(),
                arguments: json!({}),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            };
            validate_owner_qualified_lifecycle_target(&active_tab)
                .expect("omitting tab_id keeps active-runtime behavior");
        }
    }

    // ---- U3: probe-at-dispatch — freshness-gated hard guarantee ----
    //
    // A real call must never reach a runtime whose tab is gone, even inside the
    // TTL window before the sweep runs. Fresh runtimes dispatch directly; a
    // stale one is probed (extension chrome.tabs.get) and only dispatched on a
    // positive result — a negative/timeout returns tab_closed and evicts.

    #[test]
    fn needs_dispatch_probe_only_when_staler_than_freshness_window() {
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        let now = now_ms();
        let mut client = RuntimeClient {
            runtime_id: "rt".into(),
            connection_id: "c".into(),
            runtime_key: None,
            authorization_id: None,
            extension_version: None,
            device: None,
            url: None,
            tab: None,
            replay: None,
            connected_at_ms: now,
            last_seen_ms: now,
            tx,
        };
        assert!(!client.needs_dispatch_probe(now), "just-seen: no probe");
        client.last_seen_ms = now - (RUNTIME_DISPATCH_FRESHNESS_MS + 1_000);
        assert!(client.needs_dispatch_probe(now), "stale: must probe");
    }

    #[tokio::test]
    async fn fresh_runtime_is_dispatchable_without_a_probe() {
        // A fresh runtime passes the dispatch gate directly; no probe is armed.
        let state = two_runtime_state();
        let client = state.runtimes.lock().await.get("rt-lab").unwrap().clone();
        ensure_dispatchable(&state, &client)
            .await
            .expect("fresh runtime dispatches");
        assert!(
            state.pending_probes.lock().await.is_empty(),
            "no probe was needed for a fresh runtime"
        );
    }

    #[tokio::test]
    async fn stale_runtime_with_dead_probe_returns_tab_closed_and_evicts() {
        // The drag-504 guarantee: a stale-but-unswept runtime whose tab is gone
        // must NOT be dispatched to. Probe comes back dead → tab_closed + evict.
        let root = tempdir().unwrap();
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            vec![RuntimeSeed {
                runtime_id: "rt-stale".to_string(),
                url: Some("https://trello.com/b/stale".to_string()),
            }],
            Some(root.path().to_path_buf()),
        );
        age_runtime_last_seen(&state, "rt-stale", RUNTIME_DISPATCH_FRESHNESS_MS + 2_000).await;
        // Give the runtime a live receiver so probe_runtime's send succeeds and a
        // probe is actually registered (the seed drops its receiver).
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        state.runtimes.lock().await.get_mut("rt-stale").unwrap().tx = tx;
        let client = state.runtimes.lock().await.get("rt-stale").unwrap().clone();

        // Spawn the gated dispatch; feed a DEAD probe result to its oneshot.
        let state_for_probe = state.clone();
        let gate =
            tokio::spawn(async move { ensure_dispatchable(&state_for_probe, &client).await });
        let probe_id = await_single_probe_id(&state).await;
        resolve_runtime_probe(&state, &probe_id, false).await;

        let result = gate.await.unwrap();
        assert!(result.is_err(), "a dead-probe runtime is not dispatchable");
        let (status, body) = result.err().unwrap();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body.0["error"]["code"], "tab_closed");
        assert!(
            !state.runtimes.lock().await.contains_key("rt-stale"),
            "the dead runtime is evicted, not left to time out"
        );
    }

    #[tokio::test]
    async fn stale_runtime_with_live_probe_dispatches_and_survives() {
        // Stale but the tab still exists: probe positive → dispatchable, kept.
        let state = two_runtime_state();
        age_runtime_last_seen(&state, "rt-lab", RUNTIME_DISPATCH_FRESHNESS_MS + 2_000).await;
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        state.runtimes.lock().await.get_mut("rt-lab").unwrap().tx = tx;
        let client = state.runtimes.lock().await.get("rt-lab").unwrap().clone();

        let state_for_probe = state.clone();
        let gate =
            tokio::spawn(async move { ensure_dispatchable(&state_for_probe, &client).await });
        let probe_id = await_single_probe_id(&state).await;
        resolve_runtime_probe(&state, &probe_id, true).await;

        gate.await
            .unwrap()
            .expect("a live-probe runtime is dispatchable");
        assert!(
            state.runtimes.lock().await.contains_key("rt-lab"),
            "a live runtime survives the probe"
        );
    }

    /// Test helper: block until exactly one probe is registered, return its id.
    async fn await_single_probe_id(state: &AppState) -> String {
        for _ in 0..200 {
            {
                let probes = state.pending_probes.lock().await;
                if let Some(id) = probes.keys().next().cloned() {
                    return id;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no probe was registered within the timeout");
    }

    // ---- U4: honest routing error codes with a recovery next_step ----
    //
    // The opaque `no_claimed_tab` conflated four distinct failures. Each now
    // names its cause and carries a next_step in the agent's terms, so a wrong
    // route self-corrects in one read instead of leaving the agent guessing.

    #[test]
    fn route_error_codes_each_carry_a_distinct_next_step() {
        for code in [
            "tab_closed",
            "claim_missing",
            "runtime_not_found",
            "dispatch_timeout",
        ] {
            let step = route_error_next_step(code);
            assert!(!step.is_empty(), "{code} must carry a next_step");
        }
        // The four next-steps are distinct — each failure points somewhere
        // different, which is the whole point of splitting the opaque code.
        let steps = [
            route_error_next_step("tab_closed"),
            route_error_next_step("claim_missing"),
            route_error_next_step("runtime_not_found"),
            route_error_next_step("dispatch_timeout"),
        ];
        for i in 0..steps.len() {
            for j in (i + 1)..steps.len() {
                assert_ne!(steps[i], steps[j], "next_steps must differ per cause");
            }
        }
    }

    #[test]
    fn route_error_payload_names_code_and_next_step() {
        let payload = route_error(
            "runtime_not_found",
            "Routed to a runtime id that is not in the live registry.",
            json!({ "runtime_id": "rt-gone" }),
        );
        assert_eq!(payload.0["error"]["code"], "runtime_not_found");
        assert_eq!(
            payload.0["error"]["next_step"],
            json!(route_error_next_step("runtime_not_found"))
        );
        assert_eq!(payload.0["error"]["evidence"]["runtime_id"], "rt-gone");
        assert_eq!(payload.0["error"]["recoverable"], json!(true));
    }

    // ---- U2: per-runtime reap on tab-close (extension → bridge runtime_removed) ----
    //
    // The exact drag-504 gap: one tab closes but the browser (and its WS) stays
    // alive, so `remove_runtimes_for_connection` never fires and the dead
    // runtime lingers. `remove_single_runtime` reaps precisely that one id,
    // immediately, leaving sibling runtimes on the same connection untouched.

    #[tokio::test]
    async fn runtime_removed_reaps_only_that_runtime_leaving_siblings() {
        // Two runtimes on the SAME connection (one browser, two tabs). Reaping
        // one leaves the other listed and connected — the WS stays open.
        let root = tempdir().unwrap();
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            vec![
                RuntimeSeed {
                    runtime_id: "rt-closing".to_string(),
                    url: Some("https://trello.com/b/closing".to_string()),
                },
                RuntimeSeed {
                    runtime_id: "rt-staying".to_string(),
                    url: Some("https://trello.com/b/staying".to_string()),
                },
            ],
            Some(root.path().to_path_buf()),
        );

        let reaped = remove_single_runtime(&state, "rt-closing", "tab_closed").await;
        assert!(reaped, "the targeted runtime was present and reaped");

        let resource = bridge_runtimes_resource(&state).await;
        assert_eq!(
            resource["connected"],
            json!(true),
            "sibling keeps it connected"
        );
        let ids: Vec<&str> = resource["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r["runtime_id"].as_str())
            .collect();
        assert_eq!(ids, vec!["rt-staying"], "only the closed tab is reaped");

        // The reap is recorded in the lifecycle log with the given reason.
        let log_path = root.path().join("logs").join("bridge-lifecycle.jsonl");
        let contents = std::fs::read_to_string(&log_path).expect("lifecycle log written");
        assert!(
            contents.lines().any(|line| {
                serde_json::from_str::<Value>(line)
                    .map(|e| {
                        e["event"] == "disconnect"
                            && e["reason"] == "tab_closed"
                            && e["runtimes"][0]["runtime_id"] == "rt-closing"
                    })
                    .unwrap_or(false)
            }),
            "the tab-close reap is logged"
        );
    }

    #[tokio::test]
    async fn runtime_removed_for_unknown_id_is_a_noop() {
        // An unknown / already-removed id must not panic, must not error, and
        // must not touch the surviving runtimes.
        let state = two_runtime_state();
        let reaped = remove_single_runtime(&state, "rt-nonexistent", "tab_closed").await;
        assert!(!reaped, "nothing to reap returns false");
        let resource = bridge_runtimes_resource(&state).await;
        assert_eq!(resource["count"], json!(2), "surviving runtimes untouched");
    }

    #[tokio::test]
    async fn reaping_the_active_runtime_reassigns_active() {
        // If the reaped runtime was the active one, active is reassigned to a
        // surviving runtime (mirrors remove_runtimes_for_connection).
        let state = two_runtime_state();
        *state.active_runtime_id.lock().await = Some("rt-lab".to_string());
        remove_single_runtime(&state, "rt-lab", "tab_closed").await;
        let active = state.active_runtime_id.lock().await.clone();
        assert_eq!(
            active.as_deref(),
            Some("rt-trello"),
            "active moved to survivor"
        );
    }

    #[tokio::test]
    async fn browser_active_tab_set_selects_by_url_and_reads_back() {
        let state = two_runtime_state();
        let set = browser_active_tab_set_call(
            state.clone(),
            ToolCallRequest {
                name: "browser.active_tab.set".to_string(),
                arguments: json!({ "url_contains": "trello.com" }),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            },
        )
        .await
        .unwrap();
        let set_out = set.0.output.clone().unwrap();
        assert_eq!(set_out["active_runtime_id"].as_str(), Some("rt-trello"));

        // A bare read (no selector) returns the current active tab.
        let read = browser_active_tab_set_call(
            state.clone(),
            ToolCallRequest {
                name: "browser.active_tab.set".to_string(),
                arguments: json!({}),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            },
        )
        .await
        .unwrap();
        let read_out = read.0.output.clone().unwrap();
        assert_eq!(read_out["active_runtime_id"].as_str(), Some("rt-trello"));
    }

    #[tokio::test]
    async fn a_stale_runtime_id_refusal_names_its_successor_on_the_same_tab() {
        // Runtime ids rotate on EVERY cross-document navigation: the content
        // script is destroyed and a new one registers. a tester measured ELEVEN
        // distinct ids for ONE tab in under two hours, every rotation on a
        // browser.navigate, none on reconnect or heartbeat (I9, 2026-07-27).
        //
        // The rotation itself is correct — the old runtime genuinely ceased to
        // exist. But it means any id a caller holds is stale within one turn, so
        // a bare 404 sends them back to enumerate runtimes on nearly every
        // navigation. runtime_key is "chrome-tab:<tabId>" and survives the
        // navigation, so the refusal can name the successor instead of just
        // reporting the death.
        let mut state = two_runtime_state();
        {
            let mut runtimes = state.runtimes.lock().await;
            let successor = {
                let lab = runtimes.get("rt-lab").expect("seeded runtime");
                let mut successor = lab.clone();
                successor.runtime_id = "rt-lab-after-navigate".to_string();
                successor.runtime_key = Some("chrome-tab:77".to_string());
                successor
            };
            // The old runtime is gone; only its successor on the same tab remains.
            runtimes.remove("rt-lab");
            runtimes.insert(successor.runtime_id.clone(), successor);
        }
        state.stale_runtime_keys = Arc::new(Mutex::new(
            [("rt-lab".to_string(), "chrome-tab:77".to_string())]
                .into_iter()
                .collect(),
        ));

        let mut call = bare_call("storage.list");
        call.target_runtime_id = Some("rt-lab".to_string());
        let error = match select_runtime(&state, &call).await {
            Ok(client) => panic!("expected a refusal, got {}", client.runtime_id),
            Err(error) => error,
        };
        assert_eq!(
            error.0,
            StatusCode::NOT_FOUND,
            "a dead id must still REFUSE"
        );
        let body = error.1 .0;
        assert_eq!(
            body["successor_runtime_id"].as_str(),
            Some("rt-lab-after-navigate"),
            "the refusal must name the live runtime on the same tab, or the caller \
             re-enumerates on every navigation",
        );
        assert_eq!(
            body["successor_reason"].as_str(),
            Some("runtime_replaced_by_navigation"),
        );
    }

    #[tokio::test]
    async fn a_stale_runtime_id_with_no_successor_still_refuses_plainly() {
        // No successor must NOT become a guess. A tab that is really gone gets a
        // plain refusal — inventing a neighbour here would be the misroute this
        // whole change removes.
        let state = two_runtime_state();
        let mut call = bare_call("storage.list");
        call.target_runtime_id = Some("rt-vanished".to_string());
        let error = match select_runtime(&state, &call).await {
            Ok(client) => panic!("expected a refusal, got {}", client.runtime_id),
            Err(error) => error,
        };
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        let body = error.1 .0;
        assert!(
            body["successor_runtime_id"].is_null(),
            "no successor must read as null, never as a nearby runtime",
        );
    }

    #[tokio::test]
    async fn a_bare_read_never_installs_an_arbitrary_active_tab() {
        // A READ WAS SILENTLY WRITING. With the stored active stale (or unset)
        // and several runtimes connected, the no-selector branch used to install
        // `runtimes.keys().next()` as the new active tab. HashMap order is
        // arbitrary, so the winner could be any tab — including one on a
        // DIFFERENT MACHINE.
        //
        // Nothing announced it. The read returned ok, and every later BARE call
        // (no target_runtime_id) then routed to that tab via select_runtime's
        // active-tab fallback. Observed twice as "the agent navigated the human's
        // live tab away", and once by a tester as active_runtime_id drifting to a
        // Gmail tab mid-conversation. One cause, three symptoms, and no call ever
        // named a wrong target (2026-07-27).
        let state = two_runtime_state();
        *state.active_runtime_id.lock().await = Some("rt-vanished".to_string());

        let read = browser_active_tab_set_call(
            state.clone(),
            ToolCallRequest {
                name: "browser.active_tab.set".to_string(),
                arguments: json!({}),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            },
        )
        .await
        .unwrap();

        let stored = state.active_runtime_id.lock().await.clone();
        assert_eq!(
            stored.as_deref(),
            Some("rt-vanished"),
            "a read must not mutate routing state; the stale id is the caller's to resolve",
        );

        let out = read.0.output.clone().unwrap();
        assert_eq!(
            out["active_runtime_id"],
            Value::Null,
            "a stale active must READ as null, not as some arbitrary survivor",
        );
        assert_eq!(
            out["active_runtime_stale_id"].as_str(),
            Some("rt-vanished"),
            "the response must NAME the id that went away, or the caller cannot tell \
             'never set' from 'the tab you were using is gone'",
        );
    }

    #[tokio::test]
    async fn a_bare_read_with_no_active_set_stays_unset() {
        // The never-set case must also stay unset. Defaulting here is what made
        // the first bare call after startup pick a tab at random.
        let state = two_runtime_state();
        *state.active_runtime_id.lock().await = None;

        let _ = browser_active_tab_set_call(
            state.clone(),
            ToolCallRequest {
                name: "browser.active_tab.set".to_string(),
                arguments: json!({}),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            state.active_runtime_id.lock().await.clone(),
            None,
            "a read must not choose an active tab on the caller's behalf",
        );
    }

    #[tokio::test]
    async fn browser_active_tab_set_rejects_unknown_url() {
        let state = two_runtime_state();
        let error = browser_active_tab_set_call(
            state,
            ToolCallRequest {
                name: "browser.active_tab.set".to_string(),
                arguments: json!({ "url_contains": "example.org" }),
                target_runtime_id: None,
                target_url_contains: None,
                timeout_ms: default_timeout_ms(),
            },
        )
        .await;
        let error = match error {
            Ok(_) => panic!("expected NOT_FOUND for unknown url_contains"),
            Err(error) => error,
        };
        assert_eq!(error.0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn actions_site_manifest_advertises_timeout_ms() {
        let manifest = site_actions_tool_manifest();
        let props = &manifest["input_schema"]["properties"];
        assert_eq!(props["timeout_ms"]["type"].as_str(), Some("integer"));
        assert_eq!(props["timeout_ms"]["minimum"].as_u64(), Some(1));
        assert_eq!(props["summary_arguments"]["type"].as_str(), Some("object"));
        assert_eq!(props["snapshot_id"]["type"].as_str(), Some("string"));
        assert_eq!(props["node_ref"]["type"].as_str(), Some("string"));
        assert_eq!(
            props["operation"]["enum"],
            json!(["roots", "node", "neighbors", "traverse"])
        );
        assert_eq!(
            props["direction"]["enum"],
            json!(["outgoing", "incoming", "both"])
        );
        assert_eq!(props["edge_types"]["type"], "array");
        assert_eq!(props["max_depth"]["type"], "integer");
        assert_eq!(props["measure_filter"]["type"], "object");
        assert_eq!(props["measure_order"]["type"], "object");
        assert_eq!(props["query"]["type"].as_str(), Some("string"));
        assert_eq!(props["scope"]["type"].as_str(), Some("object"));
        assert_eq!(props["cursor"]["type"].as_str(), Some("string"));
        assert_eq!(props["continuation"]["type"].as_str(), Some("string"));
        assert_eq!(props["page_size"]["maximum"].as_u64(), Some(5));
        assert_eq!(props["search_mode"]["enum"], json!(["semantic", "lexical"]));
        let modes = props["mode"]["enum"].as_array().unwrap();
        assert!(modes.iter().any(|mode| mode == "navigate"));
        assert!(modes.iter().any(|mode| mode == "search"));
        assert_eq!(
            manifest["input_schema"]["additionalProperties"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn bounded_site_action_listing_filters_pages_and_rejects_drift() {
        let actions = (0..7)
            .map(|index| {
                json!({
                    "name": format!("trello.card.{index}"),
                    "description": if index % 2 == 0 { "card finder" } else { "board reader" }
                })
            })
            .collect::<Vec<_>>();
        let first = bounded_site_action_listing(actions.clone(), "card", 2, None, 4_096)
            .expect("first page");
        assert_eq!(first["actions"].as_array().unwrap().len(), 2);
        assert_eq!(first["page"]["page_size"], 2);
        assert_eq!(first["page"]["has_more"], true);
        let continuation = first["page"]["continuation"].as_str().unwrap();
        let second =
            bounded_site_action_listing(actions.clone(), "card", 2, Some(continuation), 4_096)
                .expect("second page");
        assert_ne!(first["actions"], second["actions"]);

        let mut changed = actions;
        changed.push(json!({ "name": "trello.card.new", "description": "card finder" }));
        let error = bounded_site_action_listing(changed, "card", 2, Some(continuation), 4_096)
            .expect_err("content-bound continuation must reject catalog drift");
        assert_eq!(error.0, StatusCode::CONFLICT);
        assert_eq!(error.1["error"]["code"], "catalog_continuation_invalid");
    }

    #[test]
    fn state_projection_listing_exposes_summary_input_schema() {
        let projections = vec![(
            "scopes/public/sites/trello.com/board/actions.json".to_string(),
            json!({
                "name": "trello.board",
                "summaries": [{
                    "name": "list_page",
                    "description": "Read one list page.",
                    "max_bytes": 16000,
                    "input_schema": {
                        "type": "object",
                        "required": ["list_name"],
                        "properties": { "list_name": { "type": "string" } }
                    }
                }]
            }),
        )];

        let listed = state_projection_listing(&projections);
        let summary = &listed[0]["summaries"][0];
        assert_eq!(summary["name"].as_str(), Some("list_page"));
        assert_eq!(summary["input_schema"]["type"].as_str(), Some("object"));
        assert_eq!(summary["input_schema"]["required"], json!(["list_name"]));
    }

    #[test]
    fn default_timeout_ms_is_thirty_seconds() {
        assert_eq!(default_timeout_ms(), 30_000);
    }

    #[tokio::test]
    async fn screenshot_data_url_becomes_image_block_and_png_file_not_json_spill() {
        // 1x1 transparent PNG.
        const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let data_url = format!("data:image/png;base64,{PNG_B64}");
        let state = state_from_catalog(
            ActionCatalog {
                base_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                map_paths: Vec::new(),
                manifest: json!({
                    "protocol": "actions.json",
                    "tools": [{
                        "name": "test.static_screenshot",
                        "description": "Static screenshot for image extraction tests.",
                        "input_schema": { "type": "object" },
                        "x_actions": { "static_output": { "data_url": data_url, "width": 1 } }
                    }]
                }),
                site_manifest: json!({ "protocol": "actions.json", "tools": [] }),
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
        );
        let scoped = tempfile::tempdir().unwrap();
        {
            let mut config = state.payload.lock().await;
            config.inline_limit_bytes = 50_000;
            config.payload_dir = scoped.path().join("payloads");
        }
        let response = mcp_call_tool(state, "test.static_screenshot", json!({})).await;
        let content = response["result"]["content"].as_array().unwrap();
        let text = content[0]["text"].as_str().unwrap();
        assert!(
            !text.contains(PNG_B64),
            "base64 must not stay in the JSON text: {text}"
        );
        assert!(text.contains("<image written to "), "{text}");
        let image = content
            .iter()
            .find(|block| block["type"] == json!("image"))
            .expect("an MCP image content block");
        assert_eq!(image["mimeType"], json!("image/png"));
        assert_eq!(image["data"], json!(PNG_B64));
        let body: Value = serde_json::from_str(text).unwrap();
        let path = body["image_paths"][0]
            .as_str()
            .expect("image path recorded");
        assert!(path.ends_with(".png"), "{path}");
        let written = std_fs::read(path).unwrap();
        assert_eq!(written, BASE64_STANDARD.decode(PNG_B64).unwrap());
    }

    #[tokio::test]
    async fn mcp_tools_call_reports_resident_failure_as_visible_tool_error() {
        let mut state = payload_spill_test_state(10);
        state.mcp_resident = Some(mcp_adapter::ResidentMcpClient::new(
            resident::Client::new(
                std::env::temp_dir().join("actions-json-no-such-resident.sock"),
                Duration::from_millis(500),
            ),
            "test",
        ));
        let response = mcp_call_tool(state, "page.info", json!({})).await;
        assert!(
            response.get("error").is_none(),
            "a resident failure must not be a JSON-RPC protocol error (clients hide error.data): {response}"
        );
        assert_eq!(response["result"]["isError"], json!(true));
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        let body: Value = serde_json::from_str(text).expect("json body");
        assert_eq!(body["error"]["code"], json!("resident_operation_failed"));
        let detail = body["error"]["detail"].as_str().unwrap_or_default();
        assert!(
            !detail.is_empty(),
            "the underlying reason must be visible: {text}"
        );
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains(detail),
            "message must carry the reason, not only the generic prefix: {text}"
        );
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
    async fn mcp_resources_list_ignores_pipeline_proof_packages() {
        let root = tempdir().unwrap();
        let site_dir = root.path().join("scopes/private/sites/example.com/page");
        let proof_dir = site_dir.join("proof/validated-2026-07-14");
        std::fs::create_dir_all(&proof_dir).unwrap();
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
        std::fs::write(site_dir.join("SKILL.md"), "# Example skill\n").unwrap();
        std::fs::copy(
            site_dir.join("actions.json"),
            proof_dir.join("actions.json"),
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
        let response = mcp_resources_list(&state).await.unwrap();
        let uris = response["resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|resource| resource["uri"].as_str())
            .collect::<Vec<_>>();

        assert!(uris.contains(
            &"actions-json://storage/file/scopes/private/sites/example.com/page/SKILL.md"
        ));
        assert!(!uris.iter().any(|uri| uri.contains("/proof/")));
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
    async fn actions_site_refreshes_storage_catalog_before_listing() {
        let root = tempdir().unwrap();
        let site_dir = root.path().join("scopes/public/sites/actionsjson.com/book");
        std::fs::create_dir_all(&site_dir).unwrap();

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

        let map_path = site_dir.join("actions.json");
        std::fs::write(
            &map_path,
            r#"{
              "protocol": "actions.json",
              "tools": [{
                "name": "book.tutor.session.start",
                "input_schema": { "type": "object" },
                "workflow": {
                  "version": 1,
                  "steps": [{ "id": "click", "primitive": "pointer.click", "args": { "x": 1, "y": 1 } }]
                }
              }],
              "state_projections": [{
                "name": "book.tutor",
                "scope": { "selector": "body" },
                "schema": { "type": "object" },
                "fields": { "status": { "selector": "body", "attribute": "text" } }
              }]
            }"#,
        )
        .unwrap();

        let list = |state: AppState| async move {
            site_actions_call(
                state,
                ToolCallRequest {
                    name: "actions.site".to_string(),
                    arguments: json!({ "mode": "list" }),
                    target_runtime_id: None,
                    target_url_contains: Some(
                        "https://actionsjson.com/book/chapters/02-positioning-and-profile/"
                            .to_string(),
                    ),
                    timeout_ms: default_timeout_ms(),
                },
            )
            .await
            .unwrap()
            .0
            .output
            .unwrap()
        };

        let after_add = list(state.clone()).await;
        assert_eq!(
            after_add["actions"][0]["name"].as_str(),
            Some("book.tutor.session.start")
        );
        assert_eq!(
            after_add["state_projections"][0]["name"].as_str(),
            Some("book.tutor")
        );

        std::fs::remove_file(map_path).unwrap();
        let after_remove = list(state.clone()).await;
        assert_eq!(after_remove["actions"], json!([]));
        assert_eq!(after_remove["state_projections"], json!([]));

        let (status, payload) = site_actions_call(
            state,
            ToolCallRequest {
                name: "actions.site".to_string(),
                arguments: json!({
                    "mode": "call",
                    "action": "book.tutor.session.start",
                    "arguments": {}
                }),
                target_runtime_id: None,
                target_url_contains: Some("https://actionsjson.com/book/".to_string()),
                timeout_ms: default_timeout_ms(),
            },
        )
        .await
        .expect_err("removed storage action must not dispatch from a stale catalog");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(payload["error"]["code"].as_str(), Some("unknown_action"));
    }

    #[tokio::test]
    async fn storage_map_discovery_ignores_pipeline_proof_packages() {
        let root = tempdir().unwrap();
        let site_dir = root.path().join("scopes/private/sites/example.com/page");
        let proof_dir = site_dir.join("proof/validated-2026-07-14");
        std::fs::create_dir_all(&proof_dir).unwrap();
        std::fs::write(
            site_dir.join("actions.json"),
            r#"{
              "protocol": "actions.json",
              "tools": [{
                "name": "example.site.map",
                "input_schema": { "type": "object" },
                "x_actions": { "static_output": { "ok": true } }
              }]
            }"#,
        )
        .unwrap();
        std::fs::copy(
            site_dir.join("actions.json"),
            proof_dir.join("actions.json"),
        )
        .unwrap();

        let maps = discover_storage_action_maps(root.path()).await.unwrap();

        assert_eq!(maps, vec![site_dir.join("actions.json")]);
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
                    device: None,
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
                    connected_at_ms: now_ms(),
                    // A fresh heartbeat: this fixture asserts replay/tab metadata
                    // is surfaced, so the runtime must be live to be advertised.
                    last_seen_ms: now_ms(),
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
        // U5: the per-runtime row is the agent-facing shape — url/title/host,
        // one runtime_id, no raw chrome `tab` object and no `replay` internals.
        // The replay metadata lives at the top-level last_replay_summary instead.
        let row = &value["runtimes"][0];
        assert_eq!(row["runtime_id"].as_str(), Some("runtime-101"));
        assert_eq!(
            row["url"].as_str(),
            Some("https://www.linkedin.com/messaging/")
        );
        assert_eq!(row["host"].as_str(), Some("www.linkedin.com"));
        assert_eq!(row["title"].as_str(), Some("LinkedIn Messaging"));
        assert!(
            row.get("tab").is_none(),
            "no raw chrome tab in the agent view"
        );
        assert!(
            row.get("replay").is_none(),
            "no replay internals in the agent view"
        );
    }

    #[test]
    fn resident_catalog_snapshot_is_target_specific() {
        let manifest = json!({
            "protocol":"actions.json",
            "tools":[
                {"name":"browser.read","input_schema":{"type":"object"}},
                {"name":"trello.card.read","x_actions":{"binding":{"target_url_contains":"trello.com","url_matches":"https://trello.com/b/*"}}},
                {"name":"linkedin.post.read","x_actions":{"binding":{"target_url_contains":"linkedin.com"}}}
            ]
        });
        let trello = catalog_snapshot_for_target(&manifest, Some("https://trello.com/b/board"));
        let names = trello["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["browser.read", "trello.card.read"]);
        let options_page = catalog_snapshot_for_target(&manifest, None);
        let names = options_page["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["browser.read"]);
    }
}

pub async fn run_cli() -> Result<()> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let is_legacy = arguments
        .first()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value,
                "resident" | "serve" | "mcp" | "open-overlay" | "list-tools"
            )
        });
    if !is_legacy {
        let exit = cli::run_process(arguments).await;
        if exit != 0 {
            std::process::exit(exit);
        }
        return Ok(());
    }
    let cli = LegacyCli::parse();

    match cli.command {
        Command::Resident {
            bind,
            actions,
            maps,
            storage_root,
            state_dir,
            executable_version,
            configuration_id,
            idle_seconds,
        } => {
            let failure_state_dir = state_dir.clone();
            let result = run_resident(
                bind,
                actions,
                maps,
                storage_root,
                state_dir,
                executable_version,
                configuration_id,
                idle_seconds,
            )
            .await;
            if let Err(error) = &result {
                let _ = resident::lifecycle::record_startup_failure(
                    &failure_state_dir,
                    "resident_startup_failed",
                    &error.to_string(),
                );
            }
            result
        }
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

#[derive(Clone)]
struct CanonicalResidentHandler {
    state: AppState,
}

fn coordination_error_result(error: &runtime::CoordinationError) -> Value {
    json!({
        "ok": false,
        "error": {
            "code": error.code(),
            "message": error.to_string(),
            "details": error.details(),
        }
    })
}

impl CanonicalResidentHandler {
    async fn execute(
        &self,
        mut envelope: Value,
        adapter: resident::IngressAdapter,
    ) -> Result<Value> {
        // Attribution belongs to the transport boundary. These legacy fields
        // are stripped even when a caller forges them; they can never select
        // audit scope or canonical admission semantics.
        if let Some(object) = envelope.as_object_mut() {
            object.remove("_adapter");
            object.remove("_client_version");
        }
        let adapter = adapter.as_str();
        let operation_name = envelope
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut resolved_target = None;
        let mut explicit_selector = None;
        if operation_name == "resident.system.status" {
            let runtimes = self.state.runtimes.lock().await;
            let active = self.state.active_runtime_id.lock().await.clone();
            let connected=runtimes.values().map(|runtime|json!({"runtime_id":runtime.runtime_id,"extension_version":runtime.extension_version,"url":runtime.url,"connected_at_ms":runtime.connected_at_ms,"last_seen_ms":runtime.last_seen_ms})).collect::<Vec<_>>();
            return Ok(
                json!({"ok":true,"extension":{"connected":!connected.is_empty(),"runtimes":connected,"active_runtime_id":active},"bounded":true,"redacted":true}),
            );
        }
        if let Some(authority) = &self.state.runtime_authority {
            match authority.handle_control_operation(&envelope) {
                Ok(Some(result)) => return Ok(result),
                Err(error) => return Ok(coordination_error_result(&error)),
                Ok(None) => {}
            }
            let has_canonical_routing = [
                "profile",
                "profile_token",
                "target_id",
                "target_runtime_id",
                "target_url_contains",
                "target_generation",
                "catalog_revision",
            ]
            .into_iter()
            .any(|key| envelope.get(key).is_some());
            if has_canonical_routing {
                let profile_name = envelope.get("profile").and_then(Value::as_str);
                let profile_token = envelope.get("profile_token").and_then(Value::as_str);
                let profile = match (profile_name, profile_token) {
                    (Some(name), Some(token)) => Some((name, token)),
                    (None, None) => None,
                    _ => {
                        return Ok(
                            json!({"ok":false,"error":{"code":"invalid_input","message":"profile and profile_token must be supplied together"}}),
                        )
                    }
                };
                let explicit = envelope
                    .get("target_id")
                    .and_then(Value::as_str)
                    .map(|value| runtime::TargetSelector::TargetId(value.to_string()))
                    .or_else(|| {
                        envelope
                            .get("target_runtime_id")
                            .and_then(Value::as_str)
                            .map(|value| runtime::TargetSelector::RuntimeId(value.to_string()))
                    })
                    .or_else(|| {
                        envelope
                            .get("target_url_contains")
                            .and_then(Value::as_str)
                            .map(|value| runtime::TargetSelector::Intent(value.to_string()))
                    });
                explicit_selector = explicit.clone();
                let target = match authority.resolve_target(
                    profile,
                    explicit,
                    envelope.get("target_generation").and_then(Value::as_str),
                    envelope.get("catalog_revision").and_then(Value::as_str),
                ) {
                    Ok(target) => target,
                    Err(error) => return Ok(coordination_error_result(&error)),
                };
                envelope["target_runtime_id"] = json!(target.runtime_id.clone());
                resolved_target = Some(target);
            } else if matches!(adapter, "mcp" | "http") && !operation_is_read_only(&operation_name)
            {
                // Preserve the established compatibility contract for MCP and
                // authenticated HTTP callers: a targetless mutation follows
                // the bridge's active runtime. Convert that ambient choice to
                // a stable target before durable admission; CLI callers remain
                // explicit/profile-scoped because they may run concurrently.
                if let Some(runtime_id) = self.state.active_runtime_id.lock().await.clone() {
                    let selector = runtime::TargetSelector::RuntimeId(runtime_id);
                    let target =
                        match authority.resolve_target(None, Some(selector.clone()), None, None) {
                            Ok(target) => target,
                            Err(error) => return Ok(coordination_error_result(&error)),
                        };
                    envelope["target_runtime_id"] = json!(target.runtime_id.clone());
                    explicit_selector = Some(selector);
                    resolved_target = Some(target);
                }
            }
        }
        if matches!(adapter, "cli" | "mcp" | "http") && !operation_is_read_only(&operation_name) {
            let Some(authority) = self.state.runtime_authority.as_ref() else {
                return Ok(
                    json!({"ok":false,"error":{"code":"resident_authority_unavailable","message":"canonical mutation authority is unavailable"}}),
                );
            };
            let Some(target) = resolved_target.as_ref() else {
                return Ok(explicit_target_required_result(authority));
            };
            let request_id = envelope
                .get("request_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("CLI mutation omitted request_id"))?
                .to_string();
            let caller = match (
                envelope.get("profile").and_then(Value::as_str),
                envelope.get("profile_token").and_then(Value::as_str),
            ) {
                (Some(name), Some(token)) => Some(runtime::MutationCaller::profile(name, token)),
                (None, None) => None,
                _ => {
                    return Ok(
                        json!({"ok":false,"error":{"code":"invalid_input","message":"profile and profile_token must be supplied together"}}),
                    )
                }
            };
            let acceptance = state::OperationAcceptance {
                request_id: request_id.clone(),
                scope: "canonical".into(),
                normalized_request: json!({"name":operation_name,"arguments":envelope.get("arguments").cloned().unwrap_or_else(||json!({}))}),
                profile_token: None,
                target_generation: Some(target.target_generation.clone()),
                catalog_revision: Some(target.catalog_revision.clone()),
                lease_authority: None,
                output_policy: envelope.get("output_policy").cloned().unwrap_or_else(
                    || json!({"max_inline_bytes":DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES}),
                ),
                is_mutation: true,
            };
            let admission = match authority.admit_mutation(
                &acceptance,
                caller,
                explicit_selector,
                envelope.get("lease_token").and_then(Value::as_str),
            ) {
                Ok(value) => value,
                Err(error) => return Ok(coordination_error_result(&error)),
            };
            if let Some(previous) = authority
                .known_operation_result(&admission.operation_id)
                .map_err(|error| anyhow!(error.to_string()))?
            {
                return Ok(
                    json!({"ok":true,"operation_id":admission.operation_id,"request_id":request_id,"status":"terminal","result":previous,"target_generation":admission.target_generation,"catalog_revision":admission.catalog_revision}),
                );
            }
            let queue_timeout = Duration::from_millis(
                envelope
                    .get("timeout_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(default_timeout_ms()),
            );
            if authority
                .wait_to_claim_mutation(
                    &admission.target_id,
                    &admission.operation_id,
                    queue_timeout,
                )
                .await
                .map_err(|error| anyhow!(error.to_string()))?
                .is_none()
            {
                return Ok(
                    json!({"ok":false,"status":"accepted","operation_id":admission.operation_id,"request_id":request_id,"error":{"code":"mutation_queue_wait_timeout","message":"mutation remains durably accepted behind earlier work"}}),
                );
            }
            let request: operation::OperationRequest =
                serde_json::from_value(envelope).context("decode canonical operation envelope")?;
            let mut dispatch_state = self.state.clone();
            dispatch_state.operation_journal = None;
            let raw =
                match tools_call_inner(State(dispatch_state), Json(ToolCallRequest::from(request)))
                    .await
                {
                    Ok(Json(response)) => serde_json::to_value(response)?,
                    Err((status, Json(error))) => {
                        json!({"ok":false,"status":status.as_u16(),"error":error})
                    }
                };
            if raw.get("status").and_then(Value::as_u64) == Some(504)
                || raw.pointer("/error/failure_class").and_then(Value::as_str)
                    == Some("mutation_outcome_indeterminate")
            {
                authority
                    .mark_mutation_indeterminate(&admission.operation_id)
                    .map_err(|error| anyhow!(error.to_string()))?;
                return Ok(
                    json!({"ok":false,"status":"indeterminate","operation_id":admission.operation_id,"request_id":request_id,"error":raw.get("error").cloned().unwrap_or(raw)}),
                );
            }
            let completion = authority
                .complete_mutation(&admission.operation_id, &raw)
                .map_err(|error| anyhow!(error.to_string()))?;
            return Ok(
                json!({"ok":raw.get("ok").and_then(Value::as_bool).unwrap_or(false),"status":"terminal","operation_id":admission.operation_id,"request_id":request_id,"result":raw,"target_generation":admission.target_generation,"catalog_revision":admission.catalog_revision,"mutation_revision":completion.mutation_revision,"interference":completion.interference}),
            );
        }
        let request: operation::OperationRequest =
            serde_json::from_value(envelope).context("decode canonical operation envelope")?;
        match tools_call_inner(
            State(self.state.clone()),
            Json(ToolCallRequest::from(request)),
        )
        .await
        {
            Ok(Json(response)) => Ok(serde_json::to_value(response)?),
            Err((status, Json(error))) => {
                Ok(json!({ "ok": false, "status": status.as_u16(), "error": error }))
            }
        }
    }
}

fn operation_is_read_only(name: &str) -> bool {
    name.starts_with("resident.")
        || [
            ".read",
            ".list",
            ".get",
            ".status",
            ".inspect",
            ".search",
            ".describe",
            ".project",
            ".map",
        ]
        .iter()
        .any(|marker| name.ends_with(marker))
}

#[cfg(test)]
mod canonical_cli_mutation_tests {
    use super::*;
    use crate::resident::ResidentHandler;
    use tempfile::tempdir;

    #[tokio::test]
    async fn every_adapter_mutation_traverses_the_same_canonical_lifecycle() {
        let root = tempdir().unwrap();
        let manifest = json!({"protocol":"actions.json","tools":[{
            "name":"trello.card.create","description":"fixture mutation","input_schema":{"type":"object"},
            "x_actions":{"static_output":{"created":true}}
        }]});
        let catalog = ActionCatalog {
            base_manifest: manifest.clone(),
            map_paths: vec![],
            manifest: manifest.clone(),
            site_manifest: json!({"protocol":"actions.json","tools":[]}),
            site_action_names: HashSet::new(),
        };
        let mut state = state_from_catalog(catalog, vec![], None);
        let authority =
            Arc::new(runtime::RuntimeAuthority::open(root.path().join("state.sqlite3")).unwrap());
        let target = authority
            .observe_target(&runtime::LiveTargetObservation {
                client_instance_id: "client-one".into(),
                session_generation: "session-one".into(),
                tab_key: "tab-one".into(),
                runtime_id: "runtime-one".into(),
                url: Some("https://trello.com/b/example".into()),
                title: Some("Board".into()),
                catalog: json!({"operations":[{"name":"trello.card.create"}]}),
            })
            .unwrap();
        authority
            .observe_target(&runtime::LiveTargetObservation {
                client_instance_id: "client-two".into(),
                session_generation: "session-two".into(),
                tab_key: "tab-two".into(),
                runtime_id: "runtime-two".into(),
                url: Some("https://www.linkedin.com/feed/".into()),
                title: Some("Feed".into()),
                catalog: json!({"operations":[{"name":"trello.card.create"}]}),
            })
            .unwrap();
        state.runtime_authority = Some(authority.clone());
        let handler = CanonicalResidentHandler { state };
        for (index, adapter) in [
            resident::IngressAdapter::Cli,
            resident::IngressAdapter::Mcp,
            resident::IngressAdapter::Http,
        ]
        .into_iter()
        .enumerate()
        {
            let request_id = format!("adapter-proof-{index}");
            let value=handler.handle_ingress(json!({
                "_adapter":"forged-other","_client_version":"forged","name":"trello.card.create","arguments":{"title":"owned fixture"},
                "request_id":request_id,"target_url_contains":"trello.com","target_generation":target.target_generation,"catalog_revision":target.catalog_revision
            }), resident::IngressContext { adapter, client_version: Some(env!("CARGO_PKG_VERSION").into()) }).await.unwrap();
            assert_eq!(value["ok"], true, "{}", value);
            assert_eq!(value["status"], "terminal");
            assert_eq!(value["mutation_revision"], (index + 1) as u64);
            assert_eq!(value["target_generation"], target.target_generation);
            assert!(value["operation_id"].as_str().unwrap().starts_with("ajo_"));
            assert_eq!(
                value["interference"]["current_revision"],
                (index + 1) as u64
            );
            let status = authority
                .operation_status(value["operation_id"].as_str().unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(status.state, state::LifecycleState::Terminal);
        }
        let audit = authority.audit_entries(10).unwrap();
        assert!(audit
            .iter()
            .any(|entry| entry["adapter"] == "cli" && entry["operation"] == "trello.card.create"));
        assert!(audit
            .iter()
            .any(|entry| entry["adapter"] == "mcp" && entry["operation"] == "trello.card.create"));
        assert!(audit
            .iter()
            .any(|entry| entry["adapter"] == "http" && entry["operation"] == "trello.card.create"));
        assert!(!audit.iter().any(|entry| entry["adapter"] == "forged-other"));
    }

    #[test]
    fn read_classification_keeps_common_queries_out_of_mutation_queue() {
        assert!(operation_is_read_only("trello.card.checklist.read"));
        assert!(operation_is_read_only("browser.claimed_tabs.list"));
        assert!(operation_is_read_only("corpus.search"));
        assert!(!operation_is_read_only("trello.card.create"));
        assert!(!operation_is_read_only("clipboard.paste"));
        assert!(!operation_is_read_only("trello.read.then_mutate"));
    }

    #[test]
    fn authenticated_bridge_accepts_wsl_reachable_bind() {
        assert!(ensure_loopback_bind("127.0.0.1:17345".parse().unwrap()).is_ok());
        assert!(ensure_loopback_bind("[::1]:17345".parse().unwrap()).is_ok());
        assert!(ensure_loopback_bind("0.0.0.0:17345".parse().unwrap()).is_ok());
    }

    #[test]
    fn pairing_hint_never_emits_the_handshake_secret() {
        let temp = tempfile::tempdir().unwrap();
        let auth = ExtensionAuthConfig::load(Some(temp.path()));
        let secret = auth.handshake_secret().to_string();
        let mut lines = Vec::new();
        print_extension_pairing_hint(&auth, |line| lines.push(line.to_string()));
        let output = lines.join("\n");

        assert!(!output.contains(&secret), "pairing secret leaked to output");
        assert!(output.contains("pairing settings"));
        assert!(output.contains(&auth.primary_origin()));
    }

    #[test]
    fn audit_projection_is_bounded_and_omits_operation_arguments() {
        let metadata = audit_metadata(&json!({
            "name": "x".repeat(2_000),
            "request_id": "request",
            "arguments": {"payload": "y".repeat(1_000_000)}
        }));
        assert!(serde_json::to_vec(&metadata).unwrap().len() < 2_000);
        assert_eq!(metadata["name"].as_str().unwrap().chars().count(), 512);
        assert!(metadata.get("arguments").is_none());
    }
}

impl resident::ResidentHandler for CanonicalResidentHandler {
    fn handle<'a>(&'a self, envelope: Value) -> resident::BoxResponseFuture<'a> {
        self.handle_ingress(envelope, resident::IngressContext::unknown())
    }

    fn handle_ingress<'a>(
        &'a self,
        mut envelope: Value,
        ingress: resident::IngressContext,
    ) -> resident::BoxResponseFuture<'a> {
        Box::pin(async move {
            if let Some(object) = envelope.as_object_mut() {
                object.remove("_adapter");
                object.remove("_client_version");
            }
            let mut audit_envelope = audit_metadata(&envelope);
            let adapter = ingress.adapter.as_str();
            let result = self.execute(envelope, ingress.adapter).await;
            if let Some(operation_id) = result
                .as_ref()
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/operation_id")
                        .or_else(|| value.pointer("/admission/operation_id"))
                })
                .and_then(Value::as_str)
            {
                audit_envelope["operation_id"] = Value::String(operation_id.to_owned());
            }
            if let Some(authority) = &self.state.runtime_authority {
                let outcome = result
                    .as_ref()
                    .ok()
                    .and_then(|value| value.get("ok"))
                    .and_then(Value::as_bool)
                    .map(|ok| if ok { "success" } else { "failure" })
                    .unwrap_or("transport_failure");
                let _ = authority.record_audit(
                    adapter,
                    ingress.client_version.as_deref(),
                    env!("CARGO_PKG_VERSION"),
                    &audit_envelope,
                    outcome,
                );
            }
            result
        })
    }
}

fn audit_metadata(envelope: &Value) -> Value {
    const FIELD_MAX_CHARS: usize = 512;
    let bounded = |key: &str| {
        envelope
            .get(key)
            .and_then(Value::as_str)
            .map(|value| value.chars().take(FIELD_MAX_CHARS).collect::<String>())
    };
    json!({
        "name": bounded("name"),
        "request_id": bounded("request_id"),
        "target_generation": bounded("target_generation"),
        "catalog_revision": bounded("catalog_revision"),
    })
}

async fn run_resident(
    bind: SocketAddr,
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
    state_dir: PathBuf,
    executable_version: String,
    configuration_id: Option<String>,
    idle_seconds: u64,
) -> Result<()> {
    ensure_loopback_bind(bind)?;
    // Browser reachability is part of resident readiness. Acquire the TCP
    // listener before publishing the owner-only IPC endpoint; otherwise an
    // occupied browser port can briefly advertise a ready resident that can
    // never accept an extension connection.
    let listener = match TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) => {
            let message = format!("could not bind {bind}: {error}");
            let _ = resident::lifecycle::record_startup_failure(
                &state_dir,
                "resident_browser_bind_failed",
                &message,
            );
            return Err(anyhow!("resident_browser_bind_failed: {message}"));
        }
    };
    let mut state = state_from_actions_map_paths_and_storage_root(
        actions_path,
        map_paths,
        storage_root,
        Vec::new(),
    )
    .await?;
    // The unitary resident owns one installation root. Pairing material must
    // follow that protected root instead of whichever cwd happened to launch
    // the invisible resident.
    state.extension_auth = Arc::new(ExtensionAuthConfig::load(Some(&state_dir)));
    state.payload.lock().await.payload_dir = state_dir.join("spills");
    let state_database = state_dir.join("state.sqlite3");
    state.runtime_authority = Some(Arc::new(
        runtime::RuntimeAuthority::open(&state_database)
            .map_err(|error| anyhow!(error.to_string()))?,
    ));
    state.operation_journal = Some(Arc::new(state::DurableOperationJournal::open(
        &state_database,
    )?));
    spawn_liveness_sweep(state.clone());
    spawn_durable_maintenance(state.clone());
    let mut resident = resident::serve(
        resident::endpoint_for(&state_dir),
        resident::ResidentStatus::current(executable_version)
            .with_configuration_id(configuration_id),
        Arc::new(CanonicalResidentHandler {
            state: state.clone(),
        }),
        (idle_seconds > 0).then(|| Duration::from_secs(idle_seconds)),
    )
    .await?;
    let app = app_from_state(state, true);
    let mut http = tokio::spawn(async move { axum::serve(listener, app).await });
    tokio::select! {
        _ = resident.wait_stopped() => {
            http.abort();
            let _ = http.await;
            Ok(())
        }
        result = &mut http => {
            resident.shutdown();
            resident.wait_stopped().await;
            match result {
                Ok(Ok(())) => Err(anyhow!("resident_browser_server_stopped")),
                Ok(Err(error)) => Err(anyhow!("resident_browser_server_failed: {error}")),
                Err(error) => Err(anyhow!("resident_browser_server_task_failed: {error}")),
            }
        }
    }
}

async fn serve(
    bind: SocketAddr,
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
) -> Result<()> {
    ensure_loopback_bind(bind)?;
    let state = state_from_actions_map_paths_and_storage_root(
        actions_path.clone(),
        map_paths.clone(),
        storage_root.clone(),
        Vec::new(),
    )
    .await?;
    spawn_liveness_sweep(state.clone());
    let extension_auth = state.extension_auth.clone();
    let app = app_from_state(state, true);

    let listener = TcpListener::bind(bind).await?;
    println!("actions-json bridge listening on http://{bind}");
    println!("extension WebSocket: ws://{bind}/extension");
    print_extension_pairing_hint(&extension_auth, |line| println!("{line}"));
    axum::serve(listener, app).await?;
    Ok(())
}

/// Point the operator to the pairing UI without putting the secret into logs,
/// process output, or an agent context. The protected installation state is the
/// sole source of truth for pairing material.
fn print_extension_pairing_hint(auth: &ExtensionAuthConfig, mut emit: impl FnMut(&str)) {
    emit("extension pairing settings: open the extension's Bridge pairing section");
    emit("  pairing secret is stored in the protected installation state; it is never written to logs");
    emit(&format!(
        "  allowed extension origin: {}",
        auth.primary_origin()
    ));
}

async fn mcp_stdio_server(
    bind: SocketAddr,
    actions_path: PathBuf,
    map_paths: Vec<PathBuf>,
    storage_root: Option<PathBuf>,
    payload_inline_limit: usize,
    payload_dir: Option<PathBuf>,
) -> Result<()> {
    ensure_loopback_bind(bind)?;
    let mut state = state_from_actions_map_paths_and_storage_root(
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
    let state_dir = canonical_state_dir()?;
    let bind_string = bind.to_string();
    let configuration_id = resident::configuration_id(
        Some(actions_path.as_path()),
        Some(bind_string.as_str()),
        &map_paths,
        storage_root.as_deref(),
    );
    let resident_config = resident::ResidentConfig {
        state_dir: state_dir.clone(),
        executable_version: env!("CARGO_PKG_VERSION").to_string(),
        configuration_id: Some(configuration_id.clone()),
        startup_timeout: Duration::from_secs(10),
    };
    let executable = std::env::current_exe()?;
    let child_actions = actions_path.clone();
    let child_maps = map_paths.clone();
    let child_storage = storage_root.clone();
    resident::ensure_resident(&resident_config, move || {
        let mut command = std::process::Command::new(executable);
        command
            .arg("resident")
            .arg("--bind")
            .arg(bind.to_string())
            .arg("--state-dir")
            .arg(&state_dir)
            .arg("--executable-version")
            .arg(env!("CARGO_PKG_VERSION"))
            .arg("--configuration-id")
            .arg(&configuration_id)
            .arg("--actions")
            .arg(child_actions)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        for map in child_maps {
            command.arg("--map").arg(map);
        }
        if let Some(storage) = child_storage {
            command.arg("--storage-root").arg(storage);
        }
        cli::launch_managed_resident(command, &configuration_id).map(|_| ())
    })
    .await?;
    let client = resident::Client::new(resident_config.endpoint(), Duration::from_secs(30));
    client.handshake(env!("CARGO_PKG_VERSION")).await?;
    state.mcp_resident = Some(mcp_adapter::ResidentMcpClient::new(
        client,
        env!("CARGO_PKG_VERSION"),
    ));
    state.extension_auth = Arc::new(ExtensionAuthConfig::load(Some(&resident_config.state_dir)));
    let actual_bind = bind;
    let launch = BridgeLaunchContext {
        bind: actual_bind,
        actions_path: actions_path.clone(),
        map_paths: map_paths.clone(),
        storage_root: storage_root.clone(),
    };
    eprintln!("actions-json resident browser listener on http://{actual_bind}");
    eprintln!("extension WebSocket: ws://{actual_bind}/extension");
    // stderr, not stdout: stdout is the MCP JSON-RPC channel and a stray line
    // there corrupts the protocol.
    print_extension_pairing_hint(&state.extension_auth, |line| eprintln!("{line}"));
    mcp_stdio_loop(state, launch).await
}

fn canonical_state_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ACTIONS_JSON_STATE_DIR") {
        Ok(PathBuf::from(path))
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("actions-json"))
            .context("LOCALAPPDATA is required for resident state")
    } else {
        std::env::var_os("ACTIONS_JSON_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("XDG_STATE_HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join("actions-json"))
            })
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join(".local/state/actions-json"))
            })
            .context("HOME or XDG_STATE_HOME is required for resident state")
    }
}

fn ensure_loopback_bind(_bind: SocketAddr) -> Result<()> {
    // The extension WebSocket requires both an allow-listed Chrome extension
    // Origin and the per-installation secret. Every compatibility HTTP control
    // route requires that same secret and rejects browser-origin traffic. This
    // remains the security boundary when WSL must listen on its virtual NIC so
    // Windows localhost forwarding can reach the bridge.
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
    let mut state = state_from_catalog(
        ActionCatalog {
            base_manifest: manifest,
            map_paths,
            manifest: catalog_manifest,
            site_manifest,
            site_action_names,
        },
        runtime_seeds,
        storage_root,
    );
    state.operation_journal = default_operation_journal()?;
    Ok(state)
}

fn default_operation_journal() -> Result<Option<Arc<state::DurableOperationJournal>>> {
    #[cfg(test)]
    {
        return Ok(None);
    }
    #[cfg(not(test))]
    {
        let path = if let Some(path) = std::env::var_os("ACTIONS_JSON_DURABLE_STATE_PATH") {
            PathBuf::from(path)
        } else if let Some(root) = std::env::var_os("XDG_STATE_HOME") {
            PathBuf::from(root).join("actions-json/resident.sqlite3")
        } else {
            let home =
                std::env::var_os("HOME").context("HOME is required for protected durable state")?;
            PathBuf::from(home).join(".local/state/actions-json/resident.sqlite3")
        };
        Ok(Some(Arc::new(state::DurableOperationJournal::open(path)?)))
    }
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
        for tool in &mut additional_tools {
            stamp_map_url_matches(tool, &map);
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
    let arguments = request.arguments.as_object().cloned().unwrap_or_default();
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
        announcements: None,
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

fn browser_active_tab_set_tool_manifest() -> Value {
    json!({
        "name": "browser.active_tab.set",
        "description": "Set or read the agent-managed active tab (default runtime). When more than one browser tab is connected, calls that carry no target_runtime_id / target_url_contains route to this active tab. Pass runtime_id to choose by exact runtime id, or url_contains to choose the connected tab whose URL contains that substring. Omit both to read the current active tab and the connected runtimes. Per-call routing fields still override the active tab for that one call.",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "runtime_id": {
                    "type": "string",
                    "description": "Runtime id (from actions-json://bridge/runtimes) to make active."
                },
                "url_contains": {
                    "type": "string",
                    "description": "Make active the connected tab whose URL contains this substring. Errors if it matches more than one runtime."
                }
            }
        }
    })
}

/// Return the bridge-wide tab inventory directly from the live runtime
/// registry. This deliberately does not dispatch to an extension instance:
/// extension-local storage cannot prove which tabs are connected to other
/// browsers or machines, and raw Chrome tab ids can collide across them.
async fn bridge_claimed_tabs_list(state: &AppState) -> Value {
    let runtimes = state.runtimes.lock().await;
    let active_runtime_id = state.active_runtime_id.lock().await.clone();
    let now = now_ms();
    let mut tabs = runtimes
        .values()
        .filter(|client| client.is_live(now))
        .map(|client| {
            let tab = client.tab.as_ref();
            let tab_id = tab
                .and_then(|value| value.get("tab_id").or_else(|| value.get("id")))
                .and_then(Value::as_i64);
            let window_id = tab
                .and_then(|value| value.get("window_id").or_else(|| value.get("windowId")))
                .and_then(Value::as_i64);
            let title = tab
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let url = client.url.as_deref().or_else(|| {
                tab.and_then(|value| value.get("url"))
                    .and_then(Value::as_str)
            });
            let browser_active = tab
                .and_then(|value| value.get("active"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut row = json!({
                "runtime_id": client.runtime_id,
                "tab_id": tab_id,
                "window_id": window_id,
                "url": url,
                "title": title,
                "host": url.and_then(host_from_url),
                "active": active_runtime_id.as_deref() == Some(client.runtime_id.as_str()),
                "browser_active": browser_active,
                "claimed": client.authorization_id.is_some(),
                "extension_version": client.extension_version,
            });
            if let Some(authorization_id) = client.authorization_id.as_deref() {
                row["authorization_id"] = json!(authorization_id);
            }
            if let Some(device) = client.device.as_deref() {
                row["device"] = json!(device);
            }
            row
        })
        .collect::<Vec<_>>();
    tabs.sort_by(|left, right| {
        left["runtime_id"]
            .as_str()
            .cmp(&right["runtime_id"].as_str())
    });
    json!({
        "ok": true,
        "scope": "bridge",
        "complete": true,
        "inventory_source": "live_runtime_registry",
        "active_runtime_id": active_runtime_id,
        "count": tabs.len(),
        "tabs": tabs,
    })
}

async fn browser_claimed_tabs_list_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let arguments = request.arguments.as_object().cloned().unwrap_or_default();
    if let Some(unexpected) = arguments.keys().next() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "browser.claimed_tabs.list accepts no arguments.",
                json!({ "unexpected_argument": unexpected }),
            ),
        ));
    }
    Ok(Json(ToolCallResponse {
        announcements: None,
        ok: true,
        call_id: Uuid::new_v4().to_string(),
        output: Some(bridge_claimed_tabs_list(&state).await),
        error: None,
    }))
}

async fn browser_active_tab_set_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let call_id = Uuid::new_v4().to_string();
    let arguments = request.arguments.as_object().cloned().unwrap_or_default();
    if let Some(unexpected) = arguments
        .keys()
        .find(|key| *key != "runtime_id" && *key != "url_contains")
    {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "browser.active_tab.set accepts only runtime_id or url_contains.",
                json!({ "unexpected_argument": unexpected }),
            ),
        ));
    }

    let runtimes = state.runtimes.lock().await;
    let requested_id = arguments.get("runtime_id").and_then(Value::as_str);
    let requested_url = arguments.get("url_contains").and_then(Value::as_str);

    // With no selector, this is a read of the current active tab.
    let resolved_id: Option<String> = if let Some(id) = requested_id {
        if !runtimes.contains_key(id) {
            return Err((
                StatusCode::NOT_FOUND,
                route_error(
                    "runtime_not_found",
                    "No connected runtime has that runtime id.",
                    json!({ "runtime_id": id, "runtimes": runtime_summaries(&runtimes) }),
                ),
            ));
        }
        Some(id.to_string())
    } else if let Some(needle) = requested_url {
        let matches = runtimes
            .values()
            .filter(|client| client.url.as_deref().unwrap_or("").contains(needle))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [client] => Some(client.runtime_id.clone()),
            [] => {
                return Err((
                    StatusCode::NOT_FOUND,
                    structured_error(
                        "no_match",
                        "No connected runtime URL matched url_contains.",
                        json!({ "url_contains": needle, "runtimes": runtime_summaries(&runtimes) }),
                    ),
                ));
            }
            _ => {
                return Err((
                    StatusCode::CONFLICT,
                    structured_error(
                        "multiple_matches",
                        "url_contains matched multiple runtimes; be more specific or use runtime_id.",
                        json!({
                            "url_contains": needle,
                            "matches": matches.iter().map(|client| runtime_summary(client)).collect::<Vec<_>>()
                        }),
                    ),
                ));
            }
        }
    } else {
        None
    };

    let mut active = state.active_runtime_id.lock().await;
    if let Some(id) = resolved_id {
        *active = Some(id);
    }
    // A READ MUST NOT WRITE. This branch used to default a stale/unset active to
    // `runtimes.keys().next()` — arbitrary HashMap order — which silently
    // installed some other tab, possibly on another machine, as the routing
    // target for every later BARE call (select_runtime's active-tab fallback).
    // Nothing announced it: the read returned ok and the misroute surfaced later
    // as the agent operating a tab nobody pointed it at. Choosing a tab is the
    // caller's decision; a read reports state, it does not repair it
    // (2026-07-27).
    let stored_active = active.clone();
    let live_active = stored_active
        .as_deref()
        .filter(|id| runtimes.contains_key(*id))
        .map(str::to_string);
    // Distinguish "never set" from "the tab you were using is gone" — the same
    // string for both is what makes a vanished tab look like a fresh session.
    let stale_active = match (&stored_active, &live_active) {
        (Some(stored), None) => Some(stored.clone()),
        _ => None,
    };

    Ok(Json(ToolCallResponse {
        announcements: None,
        ok: true,
        call_id,
        output: Some(json!({
            "ok": true,
            "active_runtime_id": live_active,
            "active_runtime": live_active
                .as_deref()
                .and_then(|id| runtimes.get(id))
                .map(runtime_summary),
            "active_runtime_stale_id": stale_active,
            "runtimes": runtime_summaries(&runtimes),
        })),
        error: None,
    }))
}

fn runtime_agent_await_event_tool_manifest() -> Value {
    json!({
        "name": "runtime.agent.await_event",
        "description": "Block until the hosted agent produces its next output event (assistant response, tool call/result, refusal, or lifecycle change), then return the events since your cursor. Returns immediately if a backlog exists. If no event arrives within timeout_ms it returns {idle:true, silent_ms} — a returned idle after silence is the stall signal. Pass the cursor from the previous call to avoid missing events; omit it on the first call to watch only future events. Does not consume the events (read-only cursor).",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "cursor": {
                    "type": "integer",
                    "description": "Last event seq you have seen; returns events with seq > cursor. Omit on first call for latest-only; pass -1 to replay the retained queue from the start."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1000,
                    "maximum": 60000,
                    "default": 25000,
                    "description": "How long to block waiting for the next event before returning idle. Clamped to [1000, 60000]."
                }
            }
        }
    })
}

async fn runtime_agent_await_event_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let call_id = Uuid::new_v4().to_string();
    let arguments = request.arguments.as_object().cloned().unwrap_or_default();

    // Resolve the runtime (error immediately if none — spec Q-3).
    let runtimes = state.runtimes.lock().await;
    let resolved_id: String = if let Some(id) = request
        .target_runtime_id
        .as_deref()
        .filter(|id| !id.is_empty())
    {
        if !runtimes.contains_key(id) {
            return Err((
                StatusCode::NOT_FOUND,
                route_error(
                    "runtime_not_found",
                    "No connected runtime has that runtime id.",
                    json!({ "runtime_id": id, "runtimes": runtime_summaries(&runtimes) }),
                ),
            ));
        }
        id.to_string()
    } else if let Some(needle) = request
        .target_url_contains
        .as_deref()
        .filter(|needle| !needle.is_empty())
    {
        let matches = runtimes
            .values()
            .filter(|client| client.url.as_deref().unwrap_or("").contains(needle))
            .map(|client| client.runtime_id.clone())
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [id] => id.clone(),
            [] => {
                return Err((
                    StatusCode::NOT_FOUND,
                    structured_error(
                        "no_match",
                        "No connected runtime URL matched target_url_contains.",
                        json!({ "target_url_contains": needle }),
                    ),
                ));
            }
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    structured_error(
                        "ambiguous_match",
                        "target_url_contains matched more than one runtime.",
                        json!({ "target_url_contains": needle }),
                    ),
                ));
            }
        }
    } else if let Some(active) = state.active_runtime_id.lock().await.clone() {
        active
    } else {
        return Err((
            StatusCode::NOT_FOUND,
            structured_error(
                "no_runtime",
                "No target runtime and no active runtime to await events from.",
                json!({ "runtimes": runtime_summaries(&runtimes) }),
            ),
        ));
    };
    drop(runtimes);

    let timeout_ms = arguments
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(25_000)
        .clamp(1_000, 60_000);

    // Default cursor: latest-only (skip the existing backlog). An explicit
    // cursor (including -1 to replay) overrides.
    let cursor: i64 = match arguments.get("cursor").and_then(Value::as_i64) {
        Some(explicit) => explicit,
        None => {
            let map = state.agent_event_queues.lock().await;
            map.get(&resolved_id)
                .map(|q| q.next_seq as i64 - 1)
                .unwrap_or(-1)
        }
    };

    let output = await_agent_event(&state, &resolved_id, cursor, timeout_ms).await;

    Ok(Json(ToolCallResponse {
        announcements: None,
        ok: true,
        call_id,
        output: Some(json!({
            "adapter": "bridge",
            "ok": true,
            "primitive": "runtime.agent.await_event",
            "runtime_id": resolved_id,
            "value": output,
        })),
        error: None,
    }))
}

async fn spill_payload_to_disk(
    dir: &Path,
    tool: &str,
    text: &str,
) -> Result<state::SpillDescriptor> {
    let policy = state::SpillPolicy {
        directory: dir.to_path_buf(),
        inline_limit_bytes: 0,
        max_spill_bytes: 64 * 1024 * 1024,
    };
    let tool = tool.to_string();
    let bytes = text.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || policy.persist(&tool, &bytes, "application/json"))
        .await??
        .into_spilled()
}

fn payload_spill_envelope(
    tool: &str,
    result: &Value,
    text: &str,
    limit: usize,
    descriptor: &state::SpillDescriptor,
) -> Value {
    let preview: String = text.chars().take(800).collect();
    json!({
        "payload_spilled": true,
        "tool": tool,
        "ok": result.get("ok").cloned().unwrap_or(Value::Null),
        "payload_bytes": text.len(),
        "inline_limit_bytes": limit,
        "payload_path": descriptor.path.display().to_string(),
        "payload_hash": descriptor.sha256,
        "media_type": descriptor.media_type,
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

// Add the optional routing meta-fields to a tool's advertised schema so MCP
// clients (which can only place arguments inside `arguments`) are allowed to
// carry target_runtime_id / target_url_contains there. They are stripped before
// executor-facing validation by strip_routing_meta_arguments. Never required.
fn schema_with_routing_meta(schema: Value) -> Value {
    let mut schema = schema;
    let Some(object) = schema.as_object_mut() else {
        return schema;
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
    let properties = properties
        .as_object_mut()
        .expect("properties was normalized to object");
    properties
        .entry("target_runtime_id".to_string())
        .or_insert_with(|| {
            json!({
                "type": "string",
                "description": "Route this call to a specific connected runtime by its runtime id (from actions-json://bridge/runtimes). Overrides the active tab."
            })
        });
    properties
        .entry("target_url_contains".to_string())
        .or_insert_with(|| {
            json!({
                "type": "string",
                "description": "Route this call to the connected runtime whose URL contains this substring. Overrides the active tab. Errors if it matches more than one runtime."
            })
        });
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
    let schema = if direct_mcp_tool_requires_policy_exception_report(name) {
        schema_with_policy_exception_report(schema)
    } else {
        schema
    };
    schema_with_routing_meta(schema)
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
            | "dom.focus"
            | "a11y.watch"
            | "a11y.tree"
            | "a11y.query"
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
            | "file.transfer.create"
            | "file.transfer.chunk"
            | "file.transfer.finalize"
            | "file.transfer.status"
            | "file.transfer.cancel"
            | "file.transfer.upload.consume"
            | "file.transfer.upload.complete"
            | "file.transfer.download.capture"
            | "file.transfer.download.read_chunk"
            | "file.transfer.download.complete"
            | "storage.read_file"
            | "corpus.search"
            | "corpus.build"
            | "keyboard.press"
            | "keyboard.press_gated"
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
                    "enum": ["list", "call", "state_read", "state_summary", "state_diff", "navigate", "search"],
                    "description": "Use list for bounded capability discovery, call for a listed action, state_read/state_summary/state_diff for a projection, or navigate/search for an active projection snapshot."
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
                "summary_arguments": {
                    "type": "object",
                    "description": "Optional inputs for state_summary. Follow the selected summary input_schema returned by actions.site list."
                },
                "query": {
                    "type": "string",
                    "description": "Case-insensitive catalog filter in list mode, or the text query in search mode."
                },
                "snapshot_id": {
                    "type": "string",
                    "description": "Opaque active projection snapshot identifier required by navigate and search."
                },
                "node_ref": {
                    "type": "string",
                    "description": "Optional opaque starting node reference for navigate. Omit to inspect roots."
                },
                "operation": {
                    "type": "string",
                    "enum": ["roots", "node", "neighbors", "traverse"],
                    "description": "Navigate operation. Defaults to roots without node_ref and node with node_ref."
                },
                "direction": {
                    "type": "string",
                    "enum": ["outgoing", "incoming", "both"],
                    "description": "Optional edge direction for neighbors or traversal."
                },
                "edge_types": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional edge-type filter for neighbors or traversal."
                },
                "max_depth": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Optional bounded traversal depth."
                },
                "measure_filter": {
                    "type": "object",
                    "description": "Optional named numeric edge-measure condition."
                },
                "measure_order": {
                    "type": "object",
                    "description": "Optional named numeric edge-measure ordering."
                },
                "scope": {
                    "type": "object",
                    "description": "Optional bounded graph scope for navigate or search."
                },
                "cursor": {
                    "type": "string",
                    "description": "Opaque continuation returned by navigate or search."
                },
                "continuation": {
                    "type": "string",
                    "description": "Opaque continuation returned by list."
                },
                "page_size": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5,
                    "description": "Requested bounded result count. Defaults to 5 and never exceeds 5."
                },
                "search_mode": {
                    "type": "string",
                    "enum": ["semantic", "lexical"],
                    "description": "Search retrieval mode. Defaults to semantic, which may visibly degrade to lexical when semantic retrieval is unavailable."
                },
                "max_bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 48000,
                    "description": "Optional bounded response budget for list, state_read, state_summary, navigate, or search."
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

fn file_upload_tool_manifest() -> Value {
    json!({
        "name": "file.upload",
        "description": "Stream one explicitly named coding-agent-local file, up to 25 MiB, in bounded acknowledged chunks to one authorized browser runtime and assign it to one concrete file input. The browser receives only the selected file bytes and metadata; no directory access is exposed. transfer_id is an idempotency key.",
        "input_schema": {
            "type": "object",
            "required": ["local_path", "origin", "file_input"],
            "additionalProperties": false,
            "properties": {
                "local_path": { "type": "string", "description": "Absolute or working-directory-relative path to the one local file to stream." },
                "filename": { "type": "string", "description": "Optional browser-visible basename; defaults to the local basename." },
                "mime_type": { "type": "string", "description": "Declared MIME type; defaults to application/octet-stream." },
                "origin": { "type": "string", "description": "Exact authorized HTTP(S) page origin." },
                "file_input": {
                    "type": "object",
                    "required": ["selector"],
                    "additionalProperties": false,
                    "properties": { "selector": { "type": "string", "description": "Concrete CSS selector for the destination input[type=file]." } }
                },
                "transfer_id": { "type": "string", "description": "Optional retry-safe idempotency key. Generated when omitted." },
                "timeout_ms": { "type": "integer", "minimum": 1, "description": "Per-chunk browser acknowledgement timeout." }
            }
        }
    })
}

fn file_download_tool_manifest() -> Value {
    json!({
        "name": "file.download",
        "description": "Capture one explicitly authorized same-origin browser URL, up to 25 MiB, and stream it back in bounded acknowledged chunks into the MCP bridge's private payload directory. Returns a local path plus verified filename, MIME type, byte size, and SHA-256.",
        "input_schema": {
            "type": "object",
            "required": ["url", "origin"],
            "additionalProperties": false,
            "properties": {
                "url": { "type": "string", "description": "Same-origin browser URL to capture." },
                "origin": { "type": "string", "description": "Exact authorized HTTP(S) page origin." },
                "filename": { "type": "string", "description": "Optional safe output basename." },
                "mime_type": { "type": "string", "description": "Optional expected MIME type." },
                "transfer_id": { "type": "string", "description": "Optional retry-safe idempotency key. Generated when omitted." },
                "timeout_ms": { "type": "integer", "minimum": 1, "description": "Per-chunk browser acknowledgement timeout." }
            }
        }
    })
}

fn file_transfer_status_tool_manifest() -> Value {
    json!({
        "name": "file.transfer.status",
        "description": "Read metadata-only status for one remote file transfer. Never returns file bytes.",
        "input_schema": {
            "type": "object",
            "required": ["transfer_id"],
            "additionalProperties": false,
            "properties": { "transfer_id": { "type": "string" } }
        }
    })
}

fn file_transfer_cancel_tool_manifest() -> Value {
    json!({
        "name": "file.transfer.cancel",
        "description": "Cancel one remote file transfer and clear retained bytes. Idempotent after cancellation.",
        "input_schema": {
            "type": "object",
            "required": ["transfer_id"],
            "additionalProperties": false,
            "properties": { "transfer_id": { "type": "string" } }
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
                && !path_has_proof_component(&path)
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

fn path_has_proof_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::Normal(name) if name == OsStr::new("proof")
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

/// Build an app whose U12 extension-auth policy — allowed extension ids and the
/// per-installation handshake secret — is read from `auth_root` rather than the
/// process cwd. Exists so a test can pin a temp-dir installation instead of
/// racing every other test in the process over one ambient config file.
pub fn app_from_manifest_value_with_auth_root(
    manifest: Value,
    auth_root: Option<PathBuf>,
) -> Router {
    app_from_manifest_value_with_auth_root_and_legacy_routes(manifest, auth_root, true)
}

/// The `mcp` command's router shape: the legacy HTTP tool routes are NOT
/// mounted. Exists so a test can assert that U12b's HTTP gate is scoped to the
/// `serve`-mode subtree — in this mode those paths must 404 (absent), never 401
/// (present but refused), because those are different operator diagnoses.
pub fn app_from_manifest_value_without_legacy_tool_http_routes(
    manifest: Value,
    auth_root: Option<PathBuf>,
) -> Router {
    app_from_manifest_value_with_auth_root_and_legacy_routes(manifest, auth_root, false)
}

fn app_from_manifest_value_with_auth_root_and_legacy_routes(
    manifest: Value,
    auth_root: Option<PathBuf>,
    include_legacy_tool_http_routes: bool,
) -> Router {
    app_from_state(
        state_from_catalog_with_auth_root(
            ActionCatalog {
                base_manifest: manifest.clone(),
                map_paths: Vec::new(),
                manifest: manifest.clone(),
                site_manifest: manifest,
                site_action_names: HashSet::new(),
            },
            Vec::new(),
            None,
            auth_root,
        ),
        include_legacy_tool_http_routes,
    )
}

/// Same as `state_from_catalog`, but with the U12 extension-auth policy read
/// from an explicit directory instead of the process cwd. Tests use this to pin
/// a temp-dir installation; production goes through `state_from_catalog`, which
/// resolves the policy from cwd exactly like the credential loaders do.
fn state_from_catalog_with_auth_root(
    catalog: ActionCatalog,
    runtime_seeds: Vec<RuntimeSeed>,
    storage_root: Option<PathBuf>,
    auth_root: Option<PathBuf>,
) -> AppState {
    let mut state = state_from_catalog(catalog, runtime_seeds, storage_root);
    state.extension_auth = Arc::new(ExtensionAuthConfig::load(auth_root.as_deref()));
    state
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
    for manifest in [
        file_upload_tool_manifest(),
        file_download_tool_manifest(),
        file_transfer_status_tool_manifest(),
        file_transfer_cancel_tool_manifest(),
    ] {
        ensure_advertised_tool(&mut catalog.manifest, manifest)
            .expect("file transfer tool must be insertable into advertised manifest");
    }
    ensure_advertised_tool(
        &mut catalog.manifest,
        browser_active_tab_set_tool_manifest(),
    )
    .expect("browser.active_tab.set tool must be insertable into advertised manifest");
    ensure_advertised_tool(
        &mut catalog.manifest,
        runtime_agent_await_event_tool_manifest(),
    )
    .expect("runtime.agent.await_event tool must be insertable into advertised manifest");
    ensure_site_tool(
        &mut catalog.site_manifest,
        runtime_agent_await_event_tool_manifest(),
    )
    .expect("runtime.agent.await_event tool must be insertable into site manifest");

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
                    device: None,
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
        operation_journal: None,
        runtime_authority: None,
        mcp_resident: None,
        extension_auth: Arc::new(ExtensionAuthConfig::load(None)),
        active_runtime_id: Arc::new(Mutex::new(seeded_runtimes.keys().next().cloned())),
        runtimes: Arc::new(Mutex::new(seeded_runtimes)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        stale_runtime_keys: Arc::new(Mutex::new(HashMap::new())),
        action_progress: Arc::new(Mutex::new(HashMap::new())),
        pending_probes: Arc::new(Mutex::new(HashMap::new())),
        last_replay_summary: Arc::new(Mutex::new(None)),
        last_credential_hydration: Arc::new(Mutex::new(None)),
        last_storage_hydration: Arc::new(Mutex::new(None)),
        pending_storage_hydrations: Arc::new(Mutex::new(HashMap::new())),
        payload: Arc::new(Mutex::new(PayloadSpillConfig::default())),
        agent_event_queues: Arc::new(Mutex::new(HashMap::new())),
        a11y: Arc::new(Mutex::new(A11yStore::default())),
    }
}

fn app_from_state(state: AppState, include_legacy_tool_http_routes: bool) -> Router {
    let mut router = Router::new()
        .route("/health", get(health))
        .route("/runtimes", get(runtimes))
        .route("/extension/auth-check", get(extension_auth_check))
        .route("/extension", get(extension_ws));
    if include_legacy_tool_http_routes {
        // U12b. The legacy tool routes are built as their OWN router so the auth
        // layer can be attached to exactly this subtree and nothing else. A
        // global middleware was rejected because it wraps the WHOLE app, so
        // the gate would then have to re-derive "is this path gated?" from the
        // URI — a second, drifting copy of the route list, and the exact shape
        // that lets a newly added route silently escape the guard. Here the
        // route list and the gate are the same expression.
        //
        // `/health` and `/runtimes` stay on the base router, deliberately: they
        // are the liveness surface every operator and supervisor script polls,
        // they expose no credentials and drive nothing, and gating them would
        // turn "the bridge is up" into a question you need a secret to ask.
        let gated = Router::new()
            .route("/actions", get(actions))
            .route("/mcp/tools/list", get(tools_list))
            .route("/mcp/tools/resolve", post(tools_resolve))
            .route("/mcp/tools/reload", post(tools_reload))
            .route("/mcp/tools/call", post(http_tools_call))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                require_bridge_http_secret,
            ))
            .layer(middleware::from_fn(reject_browser_http_ingress));
        router = router.merge(gated);
    }
    router.with_state(state)
}

async fn reject_browser_http_ingress(request: Request<Body>, next: Next) -> Response {
    let has_browser_origin = request.headers().contains_key(header::ORIGIN);
    let asks_private_network = request
        .headers()
        .contains_key("access-control-request-private-network");
    if request.method() == Method::OPTIONS || has_browser_origin || asks_private_network {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "ok": false,
                "error": {
                    "code": "browser_http_ingress_refused",
                    "message": "Legacy HTTP operations are local-process compatibility endpoints and do not accept browser-origin or private-network CORS requests."
                }
            })),
        )
            .into_response();
    }
    next.run(request).await
}

async fn http_tools_call(
    State(state): State<AppState>,
    Json(params): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let operation = mcp_adapter::McpToolCall::from_params(params).map_err(|message| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": {"code": "invalid_input", "message": message}
            })),
        )
    })?;
    // Router-only test/application constructors intentionally omit the durable
    // resident authority. Keep their historical direct handler semantics;
    // every real `serve`/resident process installs the authority and therefore
    // traverses the canonical adapter path below.
    if state.runtime_authority.is_none() {
        return tools_call(
            State(state),
            Json(ToolCallRequest::from(operation.into_request())),
        )
        .await
        .map(|Json(response)| {
            Json(serde_json::to_value(response).expect("serialize tool response"))
        });
    }
    let result = resident::ResidentHandler::handle_ingress(
        &CanonicalResidentHandler { state },
        operation.into_envelope(),
        resident::IngressContext {
            adapter: resident::IngressAdapter::Http,
            client_version: None,
        },
    )
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "ok": false,
                "error": {"code": "resident_operation_failed", "message": error.to_string()}
            })),
        )
    })?;
    Ok(Json(result))
}

/// U12b. Require the per-installation handshake secret on the legacy HTTP tool
/// routes `serve` mounts.
///
/// U12 closed `/extension`, but `POST /mcp/tools/call` was left holding FULL
/// BROWSER CONTROL behind nothing but loopback binding and CORS. CORS is a rule
/// browsers agree to follow; a local process — a hostile postinstall script,
/// another account on a shared machine — simply opens a socket and is never
/// asked. The secret is the check that binds to something an attacker cannot
/// obtain rather than something it can decline to honor.
///
/// The secret is read from `Authorization: Bearer <secret>` OR `?secret=<secret>`.
/// Both, because the two real caller shapes differ: a local process and the
/// extension's service-worker `fetch` can set headers, while a curl one-liner or
/// anything reusing the `/extension` query convention has the query string. A
/// bare `Authorization: <secret>` (no scheme) is accepted too — the scheme is a
/// convention here, not a protocol, and refusing over it would only produce a
/// confusing 401 for a caller that in fact holds the right secret.
async fn require_bridge_http_secret(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let header_secret = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim())
        .map(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .unwrap_or(value)
        })
        .map(str::trim)
        .filter(|secret| !secret.is_empty());

    let query_secret = request
        .uri()
        .query()
        .and_then(|query| query_parameter(query, "secret"))
        .filter(|secret| !secret.trim().is_empty());

    let presented = header_secret.map(str::to_string).or(query_secret);

    if let Err(rejection) = state.extension_auth.authorize_http(presented.as_deref()) {
        let reason = rejection.reason();
        eprintln!(
            "actions-json bridge refused {} {}: {reason}",
            request.method(),
            request.uri().path()
        );
        // Never a bare 401. The body names the specific cause and how to fix it,
        // because the operator on the other end is an agent or a script that
        // will otherwise report "the bridge is broken" and burn a day.
        return (
            StatusCode::UNAUTHORIZED,
            structured_error(
                reason,
                rejection.message(),
                json!({ "route": request.uri().path() }),
            ),
        )
            .into_response();
    }

    next.run(request).await
}

/// Pull one parameter out of a raw query string, percent-decoded.
///
/// Decoding goes through `reqwest::Url` — already a dependency, and the same
/// parser the rest of this file uses — rather than a hand-rolled split, so a
/// secret that survives a round trip through any conforming client is read back
/// byte-identical. Axum's `Query` extractor was the other option and was
/// rejected: it fails the WHOLE request on any unrelated malformed parameter,
/// which would surface an unrelated typo as an authentication failure and send
/// the caller hunting for the wrong problem.
fn query_parameter(query: &str, name: &str) -> Option<String> {
    let base = reqwest::Url::parse("http://bridge.invalid/").ok()?;
    let url = base.join(&format!("?{query}")).ok()?;
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
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
    // Native chrome-launcher tools (U7): browser launch / self-install / claim, merged into
    // this one MCP so a local user needs no second server.
    let mut tools = tools;
    for m in chrome_launcher_tools::tool_manifests() {
        tools.push(json!({
            "name": m.get("name").cloned().unwrap_or(Value::Null),
            "description": m.get("description").cloned().unwrap_or(Value::String(String::new())),
            "inputSchema": m.get("input_schema").cloned().unwrap_or(Value::Null),
        }));
    }
    Ok(json!({ "tools": tools }))
}

/// `explicit_target_required` used to say only "mutation requires an active,
/// profile-selected, or explicit stable target" — true, but it named neither
/// the candidates nor the argument to pass, so the caller had to make a
/// second discovery call and guess (2026-11-20, after a navigation dropped
/// the active runtime). List the live targets and the exact routing fields.
fn explicit_target_required_result(authority: &runtime::RuntimeAuthority) -> Value {
    let live: Vec<Value> = authority
        .list_targets()
        .unwrap_or_default()
        .into_iter()
        .filter(|target| target.live)
        .map(|target| {
            json!({
                "target_runtime_id": target.runtime_id,
                "url": target.url,
                "title": target.title,
            })
        })
        .collect();
    let message = if live.is_empty() {
        "This mutation needs a target tab, and no live tab is connected. Open or reload the tab with the actions.json extension, then retry.".to_string()
    } else {
        format!(
            "This mutation needs a target tab. Retry with target_runtime_id (one of the {} live tab(s) in evidence.live_targets) or target_url_contains, or set one active with browser.active_tab.set.",
            live.len()
        )
    };
    json!({
        "ok": false,
        "error": {
            "code": "explicit_target_required",
            "message": message,
            "recoverable": true,
            "evidence": {
                "live_targets": live,
                "routing_fields": ["target_runtime_id", "target_url_contains"]
            }
        }
    })
}

/// Tool-level (not protocol-level) error for a resident IPC failure, so the
/// agent sees the underlying reason instead of a bare "Resident operation failed".
fn resident_operation_error_result(tool: &str, message: &str) -> Value {
    mcp_adapter::render_tool_result(&json!({
        "ok": false,
        "primitive": tool,
        "error": {
            "code": "resident_operation_failed",
            "message": format!("Resident operation failed: {message}"),
            "detail": message,
            "recoverable": true,
            "hint": "The resident bridge could not complete this call. If it follows a page reload or navigation, the tab's runtime may be re-attaching: re-run browser.navigate (or browser.claimed_tabs.list) for the tab, then retry once."
        }
    }))
}

async fn mcp_tools_call(state: AppState, params: Value) -> Result<Value, Value> {
    let Some(name) = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
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
    // Native chrome-launcher tools (U7) short-circuit the site/primitive machinery — they
    // don't touch a connected browser runtime; they LAUNCH one. The helper path (the
    // cross-compiled Windows pipe helper) comes from env, falling back to the workspace build.
    if chrome_launcher_tools::is_chrome_launcher_tool(&name) {
        let helper_win = std::env::var("CHROME_LAUNCHER_HELPER_WIN").ok();
        let output =
            chrome_launcher_tools::dispatch(&name, &arguments, helper_win.as_deref()).await;
        let is_ok = output.get("ok").and_then(Value::as_bool).unwrap_or(false);
        return Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&output).unwrap_or_default() }],
            "isError": !is_ok,
        }));
    }
    let operation = mcp_adapter::McpToolCall::from_params(params).map_err(|message| {
        mcp_error_value(-32602, "Invalid params", json!({ "message": message }))
    })?;
    let envelope = operation.clone().into_envelope();

    let payload_config = state.payload.clone();
    let result = if let Some(client) = state.mcp_resident.as_ref() {
        match client.execute(envelope).await {
            Ok(result) => result,
            // A JSON-RPC protocol error surfaces to the agent as its bare
            // `message` ("Resident operation failed"); MCP clients drop
            // `error.data`, so every distinct resident failure collapsed into
            // one opaque string (8 occurrences on 2026-11-20, cause invisible).
            // Report it as a tool-execution error instead, per the MCP spec,
            // with the underlying reason in the visible result.
            Err(message) => return Ok(resident_operation_error_result(&name, &message)),
        }
    } else {
        // Unit/router constructors omit the resident client by design. Keep
        // their historical in-process semantics; production MCP startup always
        // installs `mcp_resident` before entering the JSON-RPC loop.
        match tools_call(
            State(state.clone()),
            Json(ToolCallRequest::from(operation.into_request())),
        )
        .await
        {
            Ok(Json(response)) => serde_json::to_value(response).map_err(|error| {
                mcp_error_value(
                    -32603,
                    "Serialize tool result failed",
                    json!({"message": error.to_string()}),
                )
            })?,
            Err((status, Json(error))) => {
                json!({"ok":false,"status":status.as_u16(),"error":error})
            }
        }
    };
    let is_error = result.get("ok").and_then(Value::as_bool) == Some(false)
        || result
            .get("output")
            .and_then(|output| output.get("ok"))
            .and_then(Value::as_bool)
            == Some(false);
    let (inline_limit, payload_dir) = {
        let config = payload_config.lock().await;
        (config.inline_limit_bytes, config.payload_dir.clone())
    };
    // Screenshots used to ride inside the JSON text as a base64 data URL, so
    // any real screenshot exceeded the inline limit and was spilled as a JSON
    // file the agent had to decode before it could look (2026-11-20). Lift
    // images out: write each as a real image file, return it as an MCP image
    // content block the client renders to the model, and leave the path in
    // the JSON where the data URL was.
    let mut result = result;
    let images = extract_inline_images(&mut result, &payload_dir, &name).await;
    let mut text = serde_json::to_string_pretty(&result).unwrap_or_else(|_| result.to_string());
    if text.len() > inline_limit {
        match spill_payload_to_disk(&payload_dir, &name, &text).await {
            Ok(descriptor) => {
                let envelope =
                    payload_spill_envelope(&name, &result, &text, inline_limit, &descriptor);
                text = serde_json::to_string_pretty(&envelope)
                    .unwrap_or_else(|_| envelope.to_string());
            }
            Err(error) => {
                text = json!({
                    "ok": false,
                    "error": {"code":"payload_spill_failed","message":error.to_string()},
                    "payload_bytes": text.len(),
                    "inline_limit_bytes": inline_limit,
                    "bounded": true
                })
                .to_string()
            }
        }
    }
    let mut content = vec![json!({ "type": "text", "text": text })];
    content.extend(images);
    Ok(json!({
        "content": content,
        "isError": is_error
    }))
}

/// Largest base64 image returned inline as an MCP image block; bigger images
/// are still written to disk and referenced by path.
const MAX_INLINE_IMAGE_BASE64_BYTES: usize = 4 * 1024 * 1024;

/// Replace every `data:image/{png,jpeg,webp};base64,...` string in `value`
/// with a pointer to an image file, returning MCP image content blocks.
async fn extract_inline_images(value: &mut Value, payload_dir: &Path, tool: &str) -> Vec<Value> {
    let mut found: Vec<(String, String)> = Vec::new();
    collect_image_data_urls(value, &mut found);
    let mut blocks = Vec::new();
    for (data_url, _) in found {
        let Some((media_type, b64)) = parse_image_data_url(&data_url) else {
            continue;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) else {
            continue;
        };
        let policy = state::SpillPolicy {
            directory: payload_dir.to_path_buf(),
            inline_limit_bytes: 0,
            max_spill_bytes: 64 * 1024 * 1024,
        };
        let tool_name = tool.to_string();
        let media = media_type.clone();
        let persisted =
            tokio::task::spawn_blocking(move || policy.persist(&tool_name, &bytes, &media))
                .await
                .ok()
                .and_then(|result| result.ok())
                .and_then(|spill| spill.into_spilled().ok());
        let replacement = match &persisted {
            Some(descriptor) => format!("<image written to {}>", descriptor.path.display()),
            None => "<image omitted: could not be written to disk>".to_string(),
        };
        replace_string_value(value, &data_url, &replacement);
        if let Some(descriptor) = &persisted {
            if let Value::Object(map) = value {
                map.entry("image_paths")
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .map(|paths| paths.push(json!(descriptor.path.display().to_string())));
            }
        }
        if b64.len() <= MAX_INLINE_IMAGE_BASE64_BYTES {
            blocks.push(json!({ "type": "image", "data": b64, "mimeType": media_type }));
        }
    }
    blocks
}

fn parse_image_data_url(data_url: &str) -> Option<(String, String)> {
    let rest = data_url.strip_prefix("data:")?;
    let (header, b64) = rest.split_once(',')?;
    let media_type = header.strip_suffix(";base64")?;
    matches!(media_type, "image/png" | "image/jpeg" | "image/webp")
        .then(|| (media_type.to_string(), b64.to_string()))
}

fn collect_image_data_urls(value: &Value, found: &mut Vec<(String, String)>) {
    match value {
        Value::String(text) if text.starts_with("data:image/") => {
            if !found.iter().any(|(existing, _)| existing == text) {
                found.push((text.clone(), String::new()));
            }
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_image_data_urls(item, found)),
        Value::Object(map) => map
            .values()
            .for_each(|item| collect_image_data_urls(item, found)),
        _ => {}
    }
}

fn replace_string_value(value: &mut Value, needle: &str, replacement: &str) {
    match value {
        Value::String(text) if text == needle => *text = replacement.to_string(),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| replace_string_value(item, needle, replacement)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| replace_string_value(item, needle, replacement)),
        _ => {}
    }
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
            serde_json::to_string_pretty(&mcp_bridge_runtimes_resource(state).await?).unwrap(),
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

async fn mcp_bridge_runtimes_resource(state: &AppState) -> Result<Value, Value> {
    let Some(client) = state.mcp_resident.as_ref() else {
        return Ok(bridge_runtimes_resource(state).await);
    };
    let status = client
        .execute(json!({
            "name": "resident.system.status",
            "arguments": {},
            "request_id": format!("ajm_{}", Uuid::new_v4().simple())
        }))
        .await
        .map_err(|message| {
            mcp_error_value(
                -32000,
                "Resident status failed",
                json!({"message": message}),
            )
        })?;
    let extension = status
        .get("extension")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let runtimes = extension
        .get("runtimes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(json!({
        "connected": extension.get("connected").and_then(Value::as_bool).unwrap_or(false),
        "count": runtimes.len(),
        "active_runtime_id": extension.get("active_runtime_id").cloned().unwrap_or(Value::Null),
        "runtimes": runtimes,
        "last_replay_summary": Value::Null,
        "credential_hydration": Value::Null,
        "storage_hydration": Value::Null,
        "bounded": true,
        "redacted": true
    }))
}

async fn bridge_runtimes_resource(state: &AppState) -> Value {
    let runtimes = state.runtimes.lock().await;
    let last_replay_summary = state.last_replay_summary.lock().await.clone();
    let credential_hydration = state.last_credential_hydration.lock().await.clone();
    let storage_hydration = state.last_storage_hydration.lock().await.clone();
    let now = now_ms();
    // Advertise only ground-truth-live runtimes. A dead runtime (heartbeat past
    // the TTL) is filtered here at the read path, so `connected`, `count`, and
    // the list can never lie about a tab that is gone — even before the periodic
    // sweep has physically evicted it.
    let live: Vec<&RuntimeClient> = runtimes.values().filter(|c| c.is_live(now)).collect();
    let active_runtime_id = state
        .active_runtime_id
        .lock()
        .await
        .clone()
        .filter(|id| runtimes.get(id).map(|c| c.is_live(now)).unwrap_or(false));
    json!({
        "connected": !live.is_empty(),
        "count": live.len(),
        "active_runtime_id": active_runtime_id,
        "runtimes": live.iter().map(|c| runtime_summary(c)).collect::<Vec<_>>(),
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

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "actions-json-mcp", "version": env!("CARGO_PKG_VERSION") }))
}

async fn actions(State(state): State<AppState>) -> Json<Value> {
    Json(state.catalog.lock().await.manifest.clone())
}

async fn runtimes(State(state): State<AppState>) -> Json<Value> {
    // The HTTP /runtimes surface is the same authoritative live view as the MCP
    // bridge/runtimes resource — route through it so it, too, is live-only and
    // never advertises a dead runtime (U1 + U5).
    Json(bridge_runtimes_resource(&state).await)
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

fn file_transfer_id(value: Option<&str>) -> Result<String, (StatusCode, Json<Value>)> {
    let id = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if id.len() > 128
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_id_invalid",
                "transfer_id must contain only ASCII letters, digits, hyphen, or underscore and be at most 128 characters.",
                json!({ "transfer_id": id }),
            ),
        ));
    }
    Ok(id)
}

fn file_transfer_filename(value: &str) -> Result<String, (StatusCode, Json<Value>)> {
    let filename = value.trim();
    if filename.is_empty()
        || matches!(filename, "." | "..")
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
    {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_filename_invalid",
                "filename must be one non-empty basename.",
                json!({ "filename": value }),
            ),
        ));
    }
    Ok(filename.to_string())
}

fn file_transfer_origin(value: &str) -> Result<String, (StatusCode, Json<Value>)> {
    let parsed = reqwest::Url::parse(value).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_origin_invalid",
                "origin must be an absolute HTTP(S) origin.",
                json!({ "origin": value }),
            ),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_origin_invalid",
                "origin must contain only an HTTP(S) scheme and authority.",
                json!({ "origin": value }),
            ),
        ));
    }
    Ok(parsed.origin().ascii_serialization())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_transfer_output_value(
    response: ToolCallResponse,
    primitive: &str,
) -> Result<Value, (StatusCode, Json<Value>)> {
    if !response.ok {
        return Err((
            StatusCode::BAD_GATEWAY,
            structured_error(
                "file_transfer_dispatch_failed",
                "Browser runtime rejected a file transfer primitive.",
                json!({ "primitive": primitive, "error": response.error, "call_id": response.call_id }),
            ),
        ));
    }
    let output = response.output.unwrap_or(Value::Null);
    if output.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = output.get("error").cloned().unwrap_or(Value::Null);
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("file_transfer_failed");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Browser file transfer primitive failed.");
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                code,
                message,
                json!({ "primitive": primitive, "error": error, "call_id": response.call_id }),
            ),
        ));
    }
    Ok(output.get("value").cloned().unwrap_or(output))
}

async fn dispatch_file_transfer_primitive(
    state: &AppState,
    request: &ToolCallRequest,
    primitive: &str,
    arguments: Value,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let Json(response) = dispatch_resolved_tool_call(
        state,
        ResolvedToolCall {
            name: primitive.to_string(),
            arguments,
            target_runtime_id: request.target_runtime_id.clone(),
            target_url_contains: request.target_url_contains.clone(),
            timeout_ms: request.timeout_ms,
            static_output: None,
        },
    )
    .await?;
    file_transfer_output_value(response, primitive)
}

async fn cancel_file_transfer_best_effort(
    state: &AppState,
    request: &ToolCallRequest,
    transfer_id: &str,
) {
    let _ = dispatch_file_transfer_primitive(
        state,
        request,
        "file.transfer.cancel",
        json!({ "transfer_id": transfer_id }),
    )
    .await;
}

async fn file_upload_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let local_path = request
        .arguments
        .get("local_path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "transfer_path_missing",
                    "file.upload requires local_path.",
                    json!({}),
                ),
            )
        })?;
    let path = PathBuf::from(local_path);
    let metadata = fs::metadata(&path).await.map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_path_unreadable",
                "The selected local file could not be read.",
                json!({ "path": path.display().to_string(), "message": error.to_string() }),
            ),
        )
    })?;
    if !metadata.is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_path_not_file",
                "local_path must identify one regular file.",
                json!({ "path": path.display().to_string() }),
            ),
        ));
    }
    if metadata.len() as usize > FILE_TRANSFER_MAX_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            structured_error(
                "transfer_oversize",
                "Selected file exceeds the remote transfer size limit.",
                json!({ "size": metadata.len(), "max_bytes": FILE_TRANSFER_MAX_BYTES }),
            ),
        ));
    }
    let bytes = fs::read(&path).await.map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_path_unreadable",
                "The selected local file could not be read.",
                json!({ "message": error.to_string() }),
            ),
        )
    })?;
    let default_filename = path.file_name().and_then(OsStr::to_str).unwrap_or("");
    let filename = file_transfer_filename(
        request
            .arguments
            .get("filename")
            .and_then(Value::as_str)
            .unwrap_or(default_filename),
    )?;
    let mime_type = request
        .arguments
        .get("mime_type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let origin = file_transfer_origin(
        request
            .arguments
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )?;
    let file_input = request
        .arguments
        .get("file_input")
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "transfer_file_input_missing",
                    "file.upload requires file_input.selector.",
                    json!({}),
                ),
            )
        })?;
    let transfer_id =
        file_transfer_id(request.arguments.get("transfer_id").and_then(Value::as_str))?;
    let digest = sha256_hex(&bytes);
    let result = async {
        let created = dispatch_file_transfer_primitive(
            &state,
            &request,
            "file.transfer.create",
            json!({
                "transfer_id": transfer_id,
                "direction": "upload",
                "filename": filename,
                "mime_type": mime_type,
                "expected_size": bytes.len(),
                "expected_sha256": digest,
                "origin": origin,
            }),
        )
        .await?;
        if created.get("state").and_then(Value::as_str) == Some("complete") {
            return Ok(created);
        }
        let next_index = created
            .get("next_index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        for (index, chunk) in bytes
            .chunks(FILE_TRANSFER_CHUNK_BYTES)
            .enumerate()
            .skip(next_index)
        {
            let acknowledged = dispatch_file_transfer_primitive(
                &state,
                &request,
                "file.transfer.chunk",
                json!({
                    "transfer_id": transfer_id,
                    "index": index,
                    "base64": BASE64_STANDARD.encode(chunk),
                }),
            )
            .await?;
            if acknowledged.get("next_index").and_then(Value::as_u64) != Some((index + 1) as u64) {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    structured_error(
                        "transfer_ack_invalid",
                        "Browser acknowledgement did not advance to the next chunk.",
                        json!({ "transfer_id": transfer_id, "index": index, "ack": acknowledged }),
                    ),
                ));
            }
        }
        let finalized = dispatch_file_transfer_primitive(
            &state,
            &request,
            "file.transfer.finalize",
            json!({ "transfer_id": transfer_id }),
        )
        .await?;
        if finalized.get("sha256").and_then(Value::as_str) != Some(digest.as_str()) {
            return Err((
                StatusCode::BAD_GATEWAY,
                structured_error(
                    "transfer_hash_mismatch",
                    "Browser did not verify the selected file hash.",
                    json!({ "transfer_id": transfer_id }),
                ),
            ));
        }
        dispatch_file_transfer_primitive(
            &state,
            &request,
            "file.transfer.upload.consume",
            json!({ "transfer_id": transfer_id, "origin": origin, "file_input": file_input }),
        )
        .await
    }
    .await;
    match result {
        Ok(value) => Ok(Json(ToolCallResponse {
            announcements: None,
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "transfer_id": transfer_id,
                "direction": "upload",
                "filename": filename,
                "mime_type": mime_type,
                "size": bytes.len(),
                "sha256": digest,
                "origin": origin,
                "state": value.get("state").cloned().unwrap_or(json!("complete")),
                "attached": value.get("attached").cloned().unwrap_or(json!(true)),
                "audit": "metadata_only"
            })),
            error: None,
        })),
        Err(error) => {
            cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
            Err(error)
        }
    }
}

async fn file_download_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let url = request
        .arguments
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("");
    let parsed_url = reqwest::Url::parse(url).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_download_url_invalid",
                "file.download requires an absolute URL.",
                json!({ "url": url }),
            ),
        )
    })?;
    let origin = file_transfer_origin(
        request
            .arguments
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )?;
    if parsed_url.origin().ascii_serialization() != origin {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "transfer_origin_mismatch",
                "Download URL must match the authorized origin.",
                json!({ "url": url, "origin": origin }),
            ),
        ));
    }
    let transfer_id =
        file_transfer_id(request.arguments.get("transfer_id").and_then(Value::as_str))?;
    let requested_filename = request
        .arguments
        .get("filename")
        .and_then(Value::as_str)
        .map(file_transfer_filename)
        .transpose()?;
    let captured = dispatch_file_transfer_primitive(
        &state,
        &request,
        "file.transfer.download.capture",
        json!({
            "transfer_id": transfer_id,
            "url": parsed_url.as_str(),
            "origin": origin,
            "filename": requested_filename,
            "mime_type": request.arguments.get("mime_type").cloned(),
        }),
    )
    .await?;
    let filename = file_transfer_filename(
        captured
            .get("filename")
            .and_then(Value::as_str)
            .unwrap_or("download.bin"),
    )?;
    let size = captured
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                structured_error(
                    "transfer_metadata_invalid",
                    "Browser download omitted byte size.",
                    json!({ "transfer_id": transfer_id }),
                ),
            )
        })? as usize;
    if size > FILE_TRANSFER_MAX_BYTES {
        cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            structured_error(
                "transfer_oversize",
                "Browser download exceeds the transfer size limit.",
                json!({ "size": size }),
            ),
        ));
    }
    let expected_hash = captured
        .get("sha256")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let chunk_count = captured
        .get("chunk_count")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let payload_dir = state.payload.lock().await.payload_dir.clone();
    let transfer_dir = payload_dir.join("file-transfers");
    let output_path = transfer_dir.join(format!("{}-{}", transfer_id, filename));
    if captured.get("state").and_then(Value::as_str) == Some("complete") {
        let existing = fs::read(&output_path).await.map_err(|error| {
            (
                StatusCode::CONFLICT,
                structured_error(
                    "transfer_interrupted",
                    "Browser reports a completed transfer but the private local artifact is unavailable.",
                    json!({ "transfer_id": transfer_id, "message": error.to_string() }),
                ),
            )
        })?;
        let actual_hash = sha256_hex(&existing);
        if existing.len() != size || actual_hash != expected_hash {
            return Err((
                StatusCode::CONFLICT,
                structured_error(
                    "transfer_local_replay_conflict",
                    "Completed transfer metadata does not match the private local artifact.",
                    json!({ "transfer_id": transfer_id, "expected_size": size, "actual_size": existing.len(), "expected_sha256": expected_hash, "actual_sha256": actual_hash }),
                ),
            ));
        }
        return Ok(Json(ToolCallResponse {
            announcements: None,
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "transfer_id": transfer_id,
                "direction": "download",
                "filename": filename,
                "mime_type": captured.get("mime_type").cloned().unwrap_or(json!("application/octet-stream")),
                "size": size,
                "sha256": actual_hash,
                "origin": origin,
                "state": "complete",
                "local_path": output_path.display().to_string(),
                "replayed": true,
                "audit": "metadata_only"
            })),
            error: None,
        }));
    }
    let mut bytes = Vec::with_capacity(size);
    for index in 0..chunk_count {
        let chunk = match dispatch_file_transfer_primitive(
            &state,
            &request,
            "file.transfer.download.read_chunk",
            json!({ "transfer_id": transfer_id, "index": index }),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
                return Err(error);
            }
        };
        let encoded = match chunk.get("base64").and_then(Value::as_str) {
            Some(value) => value,
            None => {
                cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
                return Err((
                    StatusCode::BAD_GATEWAY,
                    structured_error(
                        "transfer_chunk_invalid",
                        "Browser download chunk omitted base64 bytes.",
                        json!({ "index": index }),
                    ),
                ));
            }
        };
        let decoded = match BASE64_STANDARD.decode(encoded) {
            Ok(value) => value,
            Err(error) => {
                cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
                return Err((
                    StatusCode::BAD_GATEWAY,
                    structured_error(
                        "transfer_chunk_invalid",
                        "Browser download chunk was not valid base64.",
                        json!({ "index": index, "message": error.to_string() }),
                    ),
                ));
            }
        };
        if decoded.len() > FILE_TRANSFER_CHUNK_BYTES
            || bytes.len() + decoded.len() > FILE_TRANSFER_MAX_BYTES
        {
            cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                structured_error(
                    "transfer_chunk_oversize",
                    "Browser returned an oversized download chunk.",
                    json!({ "index": index }),
                ),
            ));
        }
        bytes.extend_from_slice(&decoded);
    }
    let actual_hash = sha256_hex(&bytes);
    if bytes.len() != size || actual_hash != expected_hash {
        cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
        return Err((
            StatusCode::BAD_GATEWAY,
            structured_error(
                "transfer_integrity_mismatch",
                "Downloaded bytes did not match browser metadata.",
                json!({ "expected_size": size, "actual_size": bytes.len(), "expected_sha256": expected_hash, "actual_sha256": actual_hash }),
            ),
        ));
    }
    if let Err(error) = fs::create_dir_all(&transfer_dir).await {
        cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            structured_error(
                "transfer_output_unavailable",
                "Private transfer directory could not be created.",
                json!({ "message": error.to_string() }),
            ),
        ));
    }
    let part_path = transfer_dir.join(format!(".{}.part", transfer_id));
    if let Err(error) = fs::write(&part_path, &bytes).await {
        cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            structured_error(
                "transfer_output_unavailable",
                "Downloaded bytes could not be written.",
                json!({ "message": error.to_string() }),
            ),
        ));
    }
    if let Err(error) = fs::rename(&part_path, &output_path).await {
        cancel_file_transfer_best_effort(&state, &request, &transfer_id).await;
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            structured_error(
                "transfer_output_unavailable",
                "Downloaded artifact could not be finalized.",
                json!({ "message": error.to_string() }),
            ),
        ));
    }
    dispatch_file_transfer_primitive(
        &state,
        &request,
        "file.transfer.download.complete",
        json!({ "transfer_id": transfer_id }),
    )
    .await?;
    Ok(Json(ToolCallResponse {
        announcements: None,
        ok: true,
        call_id: Uuid::new_v4().to_string(),
        output: Some(json!({
            "transfer_id": transfer_id,
            "direction": "download",
            "filename": filename,
            "mime_type": captured.get("mime_type").cloned().unwrap_or(json!("application/octet-stream")),
            "size": size,
            "sha256": actual_hash,
            "origin": origin,
            "state": "complete",
            "local_path": output_path.display().to_string(),
            "audit": "metadata_only"
        })),
        error: None,
    }))
}

async fn file_transfer_passthrough_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let primitive = request.name.clone();
    let value =
        dispatch_file_transfer_primitive(&state, &request, &primitive, request.arguments.clone())
            .await?;
    Ok(Json(ToolCallResponse {
        announcements: None,
        ok: true,
        call_id: Uuid::new_v4().to_string(),
        output: Some(value),
        error: None,
    }))
}

/// Outer tools/call handler: executes the call, then piggybacks pending
/// inject-mode a11y announcements onto the result envelope (KTD5: act → hear).
/// Both the HTTP route and mcp_tools_call flow through here.
async fn tools_call(
    state: State<AppState>,
    request: Json<ToolCallRequest>,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let a11y = state.0.a11y.clone();
    let is_a11y_read = request.0.name == "a11y.events.read";
    let mut result = tools_call_inner(state, request).await;
    if let Ok(Json(response)) = &mut result {
        // Don't piggyback onto the read primitive itself — it already carries
        // the history, and double-delivery would double-cursor the queue.
        if !is_a11y_read {
            let drained = a11y.lock().await.drain_inject();
            if !drained.is_empty() {
                response.announcements = Some(drained.into_iter().map(|r| json!(r)).collect());
            }
        }
    }
    result
}

async fn tools_call_inner(
    State(state): State<AppState>,
    Json(mut request): Json<ToolCallRequest>,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    if request.name == "actions.site" {
        return site_actions_call(state, request).await;
    }
    if request.name == "storage.read_file" {
        request.arguments =
            validate_and_strip_policy_exception_report(&request.name, &request.arguments)?;
        return storage_read_file_call(state, request).await;
    }
    if request.name == "bridge.payloads.configure" {
        return bridge_payloads_configure_call(state, request).await;
    }
    if request.name == "file.upload" {
        return file_upload_call(state, request).await;
    }
    if request.name == "file.download" {
        return file_download_call(state, request).await;
    }
    if matches!(
        request.name.as_str(),
        "file.transfer.status" | "file.transfer.cancel"
    ) {
        return file_transfer_passthrough_call(state, request).await;
    }
    if request.name == "browser.claimed_tabs.list" {
        return browser_claimed_tabs_list_call(state, request).await;
    }
    if request.name == "browser.active_tab.set" {
        return browser_active_tab_set_call(state, request).await;
    }
    validate_owner_qualified_lifecycle_target(&request)?;
    if request.name == "runtime.agent.await_event" {
        return runtime_agent_await_event_call(state, request).await;
    }
    if request.name == "a11y.events.read" {
        let args = &request.arguments;
        let since = args.get("since").and_then(Value::as_u64);
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
        let (items, next) = state.a11y.lock().await.read(since, limit.min(200));
        return Ok(Json(ToolCallResponse {
            announcements: None,
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "announcements": items,
                "next_cursor": next,
                "note": "speech history (R5); pass since=next_cursor to page"
            })),
            error: None,
        }));
    }
    if request.name == "a11y.announcements_subscribe"
        || request.name == "a11y.announcements_configure"
    {
        let args = &request.arguments;
        let subscriber = args
            .get("subscriber")
            .and_then(Value::as_str)
            .unwrap_or("mcp")
            .to_string();
        let tab = args.get("tab_id").and_then(Value::as_i64);
        let valid = |v: Option<&str>| -> Option<String> {
            match v {
                Some(m @ ("inject" | "buffer" | "off")) => Some(m.to_string()),
                _ => None,
            }
        };
        let assertive = valid(args.get("assertive").and_then(Value::as_str));
        let polite = valid(args.get("polite").and_then(Value::as_str));
        let mut store = state.a11y.lock().await;
        store.configure(&subscriber, tab, assertive, polite);
        let effective_assertive = store.mode_for(&subscriber, tab, "assertive");
        let effective_polite = store.mode_for(&subscriber, tab, "polite");
        return Ok(Json(ToolCallResponse {
            announcements: None,
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "subscriber": subscriber,
                "tab_id": tab,
                "assertive": effective_assertive,
                "polite": effective_polite,
                "note": "per-(agent, tab) subscription (R4a); an agent manages only its own"
            })),
            error: None,
        }));
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

fn validate_owner_qualified_lifecycle_target(
    request: &ToolCallRequest,
) -> Result<(), (StatusCode, Json<Value>)> {
    let owner_bound_tool = matches!(
        request.name.as_str(),
        "browser.claimed_tabs.activate"
            | "browser.navigate"
            | "browser.close_tab"
            | "browser.dismiss_dialog"
    );
    let explicit_tab_id = request.arguments.get("tab_id").and_then(Value::as_i64);
    if owner_bound_tool && explicit_tab_id.is_some() && request.target_runtime_id.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "owner_runtime_required",
                "A browser-local tab_id is not globally unique. Pass the owning runtime_id from browser.claimed_tabs.list as target_runtime_id.",
                json!({
                    "tool": request.name,
                    "tab_id": explicit_tab_id,
                    "required": "target_runtime_id",
                    "next_step": "Call browser.claimed_tabs.list and copy runtime_id and tab_id from the same row."
                }),
            ),
        ));
    }
    Ok(())
}

async fn dispatch_resolved_tool_call(
    state: &AppState,
    resolved: ResolvedToolCall,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let request_id = Uuid::new_v4().to_string();
    if let Some(output) = resolved.static_output {
        return Ok(Json(ToolCallResponse {
            announcements: None,
            ok: true,
            call_id: request_id,
            output: Some(output),
            error: None,
        }));
    }
    let runtime = select_runtime(state, &resolved).await?;
    // U3: a real call must never reach a tab that is gone. If the runtime is
    // stale, probe it and evict+fail with tab_closed rather than dispatching
    // into the void and eating a 30s timeout.
    ensure_dispatchable(state, &runtime).await?;

    let mut call_id = request_id;

    if let Some(journal) = &state.operation_journal {
        let stable_target = state
            .runtime_authority
            .as_ref()
            .and_then(|authority| authority.target_for_runtime(&runtime.runtime_id).ok());
        let acceptance = state::OperationAcceptance {
            request_id: call_id.clone(),
            scope: "legacy-adapter".to_string(),
            normalized_request: json!({"name":resolved.name.clone(),"arguments":resolved.arguments.clone()}),
            profile_token: None,
            target_generation: stable_target
                .as_ref()
                .map(|target| target.target_generation.clone())
                .or_else(|| Some(format!("{}/{}", runtime.connection_id, runtime.runtime_id))),
            catalog_revision: stable_target
                .as_ref()
                .map(|target| target.catalog_revision.clone()),
            lease_authority: None,
            output_policy: json!({"inline_limit_bytes":DEFAULT_PAYLOAD_INLINE_LIMIT_BYTES}),
            is_mutation: true,
        };
        match journal.accept(&acceptance).map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":{"code":"durable_acceptance_failed","message":error.to_string()}}))))? {
            state::AcceptOutcome::Accepted(operation) => call_id = operation.operation_id,
            state::AcceptOutcome::Existing(operation) => call_id = operation.operation_id,
            state::AcceptOutcome::Conflict { .. } => return Err((StatusCode::CONFLICT, Json(json!({"error":{"code":"request_identity_conflict"}})))),
        }
    }

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
        state.action_progress.lock().await.remove(&call_id);
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "failed to send action to extension runtime",
                "runtime_id": runtime.runtime_id
            })),
        ));
    }
    // A successful local socket enqueue means delivery may have happened. Mark
    // this boundary before yielding so no crash can classify it replayable.
    mark_durable_dispatch_enqueued(state, &call_id)?;

    let result = match tokio::time::timeout(Duration::from_millis(resolved.timeout_ms), response_rx)
        .await
    {
        Ok(result) => match result {
            Ok(result) => result,
            Err(_) => {
                if let Some(journal) = &state.operation_journal {
                    let _ = journal.mark_indeterminate(&call_id);
                }
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(
                        json!({ "error": "extension runtime dropped response", "call_id": call_id }),
                    ),
                ));
            }
        },
        Err(_) => {
            let removed = state.pending.lock().await.remove(&call_id).is_some();
            let timeout_context = take_action_timeout_context(state, &call_id, removed).await;
            if let Some(journal) = &state.operation_journal {
                let _ = journal.mark_indeterminate(&call_id);
            }
            eprintln!(
                "actions-json-mcp pending timeout name=action_call call_id={} removed_pending={} context={}",
                call_id,
                removed,
                timeout_context
            );
            return Err((
                StatusCode::GATEWAY_TIMEOUT,
                route_error(
                    "dispatch_timeout",
                    "The action was dispatched to the tab but no response arrived in time.",
                    timeout_context,
                ),
            ));
        }
    };
    state.action_progress.lock().await.remove(&call_id);

    if let Some(journal) = &state.operation_journal {
        journal.mark_terminal(&call_id, &result, None).map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":{"code":"durable_terminal_failed","message":error.to_string()},"call_id":call_id}))))?;
    }

    let is_error = result.get("type").and_then(Value::as_str) == Some("action_error");
    Ok(Json(ToolCallResponse {
        announcements: None,
        ok: !is_error,
        call_id,
        output: result.get("output").cloned(),
        error: result.get("error").cloned(),
    }))
}

fn mark_durable_dispatch_enqueued(
    state: &AppState,
    call_id: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    if let Some(journal) = &state.operation_journal {
        if let Err(error) = journal.mark_dispatched(call_id) {
            let _ = journal.mark_indeterminate(call_id);
            return Err((
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error":{
                    "code":"durable_dispatch_transition_indeterminate",
                    "message":"The action was enqueued, but its durable dispatched state could not be proven.",
                    "cause":error.to_string(),
                    "failure_class":"mutation_outcome_indeterminate"
                },"call_id":call_id})),
            ));
        }
    }
    Ok(())
}

fn send_outstanding_operation_receipt_queries(
    journal: &state::DurableOperationJournal,
    tx: &mpsc::UnboundedSender<Message>,
) -> Result<usize> {
    let operation_ids = journal.outstanding_operation_ids()?;
    let mut sent = 0;
    for operation_id in operation_ids {
        tx.send(Message::Text(
            json!({"type":"operation_receipt_query","operation_id":operation_id}).to_string(),
        ))
        .map_err(|_| anyhow!("extension receipt query channel closed"))?;
        sent += 1;
    }
    Ok(sent)
}

fn reconcile_extension_operation_receipt(
    journal: &state::DurableOperationJournal,
    item: &Value,
) -> Result<state::LifecycleState> {
    let operation_id = item
        .get("operation_id")
        .and_then(Value::as_str)
        .context("operation receipt omitted operation_id")?;
    if item.get("receipt").is_some_and(Value::is_null) {
        journal.mark_indeterminate(operation_id)?;
        return Ok(state::LifecycleState::Indeterminate);
    }
    match item.pointer("/receipt/state").and_then(Value::as_str) {
        Some("received" | "started") => {
            journal.reconcile_receipt(operation_id, state::ReceiptState::Started, None)
        }
        Some("terminal") => journal.reconcile_receipt(
            operation_id,
            state::ReceiptState::Terminal,
            item.pointer("/receipt/outcome"),
        ),
        _ => Ok(journal
            .get(operation_id)?
            .context("receipt references unknown operation")?
            .state),
    }
}

async fn take_action_timeout_context(state: &AppState, call_id: &str, removed: bool) -> Value {
    let progress = state.action_progress.lock().await.remove(call_id);
    json!({
        "call_id": call_id,
        "pending_cleanup": if removed { "completed" } else { "already_absent" },
        "last_entered_content_phase": progress.as_ref().and_then(|value| value.get("last_entered_content_phase")).cloned(),
        "last_completed_content_phase": progress.as_ref().and_then(|value| value.get("last_completed_content_phase")).cloned(),
        "content_progress": progress,
    })
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

    // Discovery and executable resolution share one registry. Validation stays
    // ahead of this boundary so malformed calls cannot reach browser dispatch.
    let registry = operation::OperationRegistry::from_manifest(manifest).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_catalog",
                "Loaded actions catalog cannot be registered.",
                json!({ "message": format!("{error:?}") }),
            ),
        )
    })?;
    let registered = registry
        .resolve(&operation::OperationRequest {
            name: request.name.clone(),
            arguments: request_arguments.clone(),
            target_runtime_id: request.target_runtime_id.clone(),
            target_url_contains: request.target_url_contains.clone(),
            timeout_ms: request.timeout_ms,
        })
        .map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "Operation could not be resolved.",
                    json!({ "message": format!("{error:?}") }),
                ),
            )
        })?;

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
                name: registered.name,
                arguments: registered.arguments,
                target_runtime_id: registered.target_runtime_id,
                target_url_contains: registered.target_url_contains,
                timeout_ms: registered.timeout_ms,
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

    Ok(ResolvedToolCall {
        name: registered.name,
        arguments: registered.arguments,
        target_runtime_id: registered.target_runtime_id,
        target_url_contains: registered.target_url_contains,
        timeout_ms: registered.timeout_ms,
        static_output: registered.static_output,
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

fn site_catalog_hash(actions: &[Value]) -> String {
    let bytes = serde_json::to_vec(actions).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

fn encode_site_catalog_cursor(cursor: &Value) -> String {
    BASE64_STANDARD.encode(serde_json::to_vec(cursor).unwrap_or_default())
}

fn decode_site_catalog_cursor(encoded: &str) -> Option<Value> {
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn bounded_site_action_listing(
    mut actions: Vec<Value>,
    query: &str,
    requested_page_size: u64,
    continuation: Option<&str>,
    max_bytes: u64,
) -> Result<Value, (StatusCode, Json<Value>)> {
    actions.sort_by(|left, right| {
        let left_name = left.get("name").and_then(Value::as_str).unwrap_or_default();
        let right_name = right
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        left_name.cmp(right_name)
    });
    let catalog_hash = site_catalog_hash(&actions);
    let normalized_query = query.trim().to_lowercase();
    let filtered: Vec<Value> = actions
        .into_iter()
        .filter(|action| {
            if normalized_query.is_empty() {
                return true;
            }
            let name = action
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let description = action
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("{name}\n{description}")
                .to_lowercase()
                .contains(&normalized_query)
        })
        .collect();
    let page_size = requested_page_size.clamp(1, 5) as usize;
    let offset = match continuation {
        Some(encoded) => {
            let cursor = decode_site_catalog_cursor(encoded).ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    structured_error(
                        "catalog_continuation_invalid",
                        "The catalog continuation is malformed.",
                        json!({}),
                    ),
                )
            })?;
            let valid = cursor.get("catalog_hash").and_then(Value::as_str)
                == Some(catalog_hash.as_str())
                && cursor.get("query").and_then(Value::as_str) == Some(normalized_query.as_str())
                && cursor.get("page_size").and_then(Value::as_u64) == Some(page_size as u64);
            if !valid {
                return Err((
                    StatusCode::CONFLICT,
                    structured_error(
                        "catalog_continuation_invalid",
                        "The catalog changed or this continuation belongs to different list options.",
                        json!({ "catalog_hash": catalog_hash }),
                    ),
                ));
            }
            cursor
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX) as usize
        }
        None => 0,
    };
    if offset > filtered.len() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "catalog_continuation_invalid",
                "The catalog continuation offset is outside the current result set.",
                json!({}),
            ),
        ));
    }
    let mut selected = Vec::new();
    for action in filtered.iter().skip(offset).take(page_size) {
        let mut candidate = selected.clone();
        candidate.push(action.clone());
        if serde_json::to_vec(&candidate)
            .map(|bytes| bytes.len() as u64 > max_bytes)
            .unwrap_or(true)
        {
            break;
        }
        selected = candidate;
    }
    if selected.is_empty() && offset < filtered.len() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "catalog_response_budget_too_small",
                "No catalog entry fits within max_bytes.",
                json!({ "minimum_action": filtered[offset].get("name") }),
            ),
        ));
    }
    let next_offset = offset + selected.len();
    let has_more = next_offset < filtered.len();
    Ok(json!({
        "actions": selected,
        "page": {
            "page_size": page_size,
            "returned": next_offset - offset,
            "has_more": has_more,
            "continuation": if has_more {
                Some(encode_site_catalog_cursor(&json!({
                    "catalog_hash": catalog_hash,
                    "query": normalized_query,
                    "page_size": page_size,
                    "offset": next_offset
                })))
            } else {
                None
            }
        },
        "provenance": {
            "catalog_hash": catalog_hash,
            "order": "name"
        }
    }))
}

async fn site_actions_call(
    state: AppState,
    request: ToolCallRequest,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    // Site maps are edited and synced while the bridge remains running. Keep
    // the advertised action catalog and the workflow/state maps read from disk
    // on the same revision so actions.site never lists an action it cannot
    // dispatch (or hides a newly added action until restart).
    if state.storage_root.is_some() {
        reload_catalog(&state).await?;
    }
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
        })?
        .to_string();
    let target_url_contains = site_action_target_url_contains(&state, &request).await?;

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
        let query = request
            .arguments
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let page_size = request
            .arguments
            .get("page_size")
            .and_then(Value::as_u64)
            .unwrap_or(5);
        let continuation = request
            .arguments
            .get("continuation")
            .or_else(|| request.arguments.get("cursor"))
            .and_then(Value::as_str);
        let max_bytes = request
            .arguments
            .get("max_bytes")
            .and_then(Value::as_u64)
            .unwrap_or(4_096)
            .clamp(256, 48_000);
        let action_page =
            bounded_site_action_listing(actions, query, page_size, continuation, max_bytes)?;
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
            announcements: None,
            ok: true,
            call_id: Uuid::new_v4().to_string(),
            output: Some(json!({
                "ok": true,
                "target_url_contains": target_url_contains,
                "actions": action_page["actions"],
                "page": action_page["page"],
                "provenance": action_page["provenance"],
                "state_projections": state_projections,
                "files": files,
                "skills": skills
            })),
            error: None,
        }));
    }

    if matches!(mode.as_str(), "state_read" | "state_summary" | "state_diff") {
        return site_actions_state_projection_call(state, request, mode, target_url_contains).await;
    }

    if matches!(mode.as_str(), "navigate" | "search") {
        return site_actions_graph_call(state, request, mode, target_url_contains).await;
    }

    if mode != "call" {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site mode must be list, call, state_read, state_summary, state_diff, navigate, or search.",
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
        let applicable = site_actions_for_target(
            &catalog.site_manifest,
            &catalog.site_action_names,
            target_url_contains.as_deref(),
        )
        .iter()
        .any(|tool| tool.get("name").and_then(Value::as_str) == Some(action.as_str()));
        if !applicable {
            return Err((
                StatusCode::BAD_REQUEST,
                structured_error(
                    "site_action_not_applicable",
                    "Requested site action is declared, but not for the selected page URL.",
                    json!({
                        "tool": action,
                        "target_url_contains": target_url_contains,
                        "next_step": "Call actions.site with mode=list on the selected runtime and choose an action from that page's catalog."
                    }),
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
                let map_paths = maps
                    .iter()
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
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
    if matches!(
        resolved.name.as_str(),
        "file.upload" | "file.download" | "file.transfer.status" | "file.transfer.cancel"
    ) {
        let bridge_request = ToolCallRequest {
            name: resolved.name.clone(),
            arguments: resolved.arguments.clone(),
            target_runtime_id: resolved.target_runtime_id.clone(),
            target_url_contains: resolved.target_url_contains.clone(),
            timeout_ms: resolved.timeout_ms,
        };
        return match resolved.name.as_str() {
            "file.upload" => file_upload_call(state, bridge_request).await,
            "file.download" => file_download_call(state, bridge_request).await,
            _ => file_transfer_passthrough_call(state, bridge_request).await,
        };
    }
    dispatch_resolved_tool_call(&state, resolved).await
}

async fn site_actions_graph_call(
    state: AppState,
    request: ToolCallRequest,
    mode: String,
    target_url_contains: Option<String>,
) -> Result<Json<ToolCallResponse>, (StatusCode, Json<Value>)> {
    let snapshot_id = request
        .arguments
        .get("snapshot_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                structured_error(
                    "snapshot_required",
                    "actions.site navigate/search requires the snapshot_id returned by state_read.",
                    json!({ "mode": mode, "next_step": "Call actions.site with mode=state_read for the desired projection." }),
                ),
            )
        })?;
    let query = request
        .arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::to_string);
    if mode == "search" && query.as_deref().is_none_or(|value| value.trim().is_empty()) {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site search requires a non-empty query.",
                json!({ "mode": mode }),
            ),
        ));
    }
    let scope = request.arguments.get("scope").cloned();
    if scope.as_ref().is_some_and(|value| !value.is_object()) {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site scope must be an object.",
                json!({ "mode": mode }),
            ),
        ));
    }
    let search_mode = request
        .arguments
        .get("search_mode")
        .and_then(Value::as_str)
        .map(str::to_string);
    if search_mode
        .as_deref()
        .is_some_and(|value| !matches!(value, "semantic" | "lexical"))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site search_mode must be semantic or lexical.",
                json!({ "search_mode": search_mode }),
            ),
        ));
    }
    let node_ref = request
        .arguments
        .get("node_ref")
        .and_then(Value::as_str)
        .map(str::to_string);
    let operation = if mode == "navigate" {
        let operation = request
            .arguments
            .get("operation")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| if node_ref.is_some() { "node" } else { "roots" }.to_string());
        if !matches!(
            operation.as_str(),
            "roots" | "node" | "neighbors" | "traverse"
        ) {
            return Err((
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "actions.site navigate operation must be roots, node, neighbors, or traverse.",
                    json!({ "operation": operation }),
                ),
            ));
        }
        if matches!(operation.as_str(), "node" | "neighbors" | "traverse") && node_ref.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                structured_error(
                    "invalid_input",
                    "This navigate operation requires node_ref.",
                    json!({ "operation": operation }),
                ),
            ));
        }
        Some(operation)
    } else {
        None
    };
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
        projection_name: None,
        summary_name: None,
        summary_arguments: json!({}),
        max_bytes: request.arguments.get("max_bytes").and_then(Value::as_u64),
        map_path: None,
        projection: None,
        snapshot_id: Some(snapshot_id),
        node_ref,
        operation,
        direction: request
            .arguments
            .get("direction")
            .and_then(Value::as_str)
            .map(str::to_string),
        edge_types: request.arguments.get("edge_types").cloned(),
        max_depth: request.arguments.get("max_depth").and_then(Value::as_u64),
        measure_filter: request.arguments.get("measure_filter").cloned(),
        measure_order: request.arguments.get("measure_order").cloned(),
        query,
        scope,
        cursor: request
            .arguments
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_string),
        page_size: request.arguments.get("page_size").and_then(Value::as_u64),
        search_mode,
    };
    dispatch_state_projection_call(&state, routing, dispatch).await
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
    let summary_arguments = request
        .arguments
        .get("summary_arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !summary_arguments.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            structured_error(
                "invalid_input",
                "actions.site summary_arguments must be an object.",
                json!({ "mode": mode }),
            ),
        ));
    }
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
        projection_name: Some(projection_name),
        summary_name,
        summary_arguments,
        max_bytes,
        map_path: Some(map_path),
        projection: Some(projection),
        snapshot_id: None,
        node_ref: None,
        operation: None,
        direction: None,
        edge_types: None,
        max_depth: None,
        measure_filter: None,
        measure_order: None,
        query: None,
        scope: None,
        cursor: None,
        page_size: None,
        search_mode: None,
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
    // U3: probe-at-dispatch — never send into a tab that has closed.
    ensure_dispatchable(state, &runtime).await?;

    let (response_tx, response_rx) = oneshot::channel::<Value>();
    state.pending.lock().await.insert(
        call_id.clone(),
        PendingCall {
            runtime_id: runtime.runtime_id.clone(),
            tx: response_tx,
        },
    );

    let item =
        state_projection_call_message(call_id.clone(), runtime.runtime_id.clone(), &dispatch);

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
            let call_id_for_cleanup = call_id.clone();
            let state_for_cleanup = state.clone();
            tokio::spawn(async move {
                let removed = state_for_cleanup
                    .pending
                    .lock()
                    .await
                    .remove(&call_id_for_cleanup)
                    .is_some();
                eprintln!(
                    "actions-json-mcp pending timeout name=state_projection_call call_id={} removed_pending={}",
                    call_id_for_cleanup, removed
                );
            });
            (
                StatusCode::GATEWAY_TIMEOUT,
                route_error(
                    "dispatch_timeout",
                    "The state projection was dispatched to the tab but no response arrived in time.",
                    json!({ "call_id": call_id, "pending_cleanup": "scheduled" }),
                ),
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
        announcements: None,
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
    let target_url_contains = site_action_target_url_contains(&state, &request).await?;
    let result = read_declared_storage_file(
        storage_root,
        target_url_contains.as_deref(),
        &request.arguments,
    )
    .await?;

    Ok(Json(ToolCallResponse {
        announcements: None,
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

async fn site_action_target_url_contains(
    state: &AppState,
    request: &ToolCallRequest,
) -> Result<Option<String>, (StatusCode, Json<Value>)> {
    let explicit = request.target_url_contains.clone().or_else(|| {
        request
            .arguments
            .get("target_url_contains")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if explicit.is_some() {
        return Ok(explicit);
    }

    if state.runtimes.lock().await.is_empty() {
        return Ok(None);
    }

    let target = ResolvedToolCall {
        name: request.name.clone(),
        arguments: request.arguments.clone(),
        target_runtime_id: request.target_runtime_id.clone(),
        target_url_contains: None,
        timeout_ms: request.timeout_ms,
        static_output: None,
    };
    let runtime = select_runtime(state, &target).await?;
    runtime.url.map(Some).ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            structured_error(
                "runtime_url_missing",
                "The selected runtime has no current URL for site catalog filtering.",
                json!({ "runtime_id": runtime.runtime_id }),
            ),
        )
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
        if !storage_map_matches_target(&map_path, &map, target_url_contains) {
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

/// Storage-scope precedence for resolving the same action declared in more than
/// one map. Lower rank wins: private overrides shared overrides public. A path
/// with no recognized scope segment falls to the lowest precedence so explicit
/// scopes always win over an unscoped map.
fn storage_scope_precedence_rank(relative_path: &str) -> u8 {
    let scope = relative_path
        .strip_prefix("scopes/")
        .and_then(|rest| rest.split('/').next());
    match scope {
        Some("private") => 0,
        Some("shared") => 1,
        Some("public") => 2,
        _ => 3,
    }
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
        let Ok(text) = fs::read_to_string(&map_path).await else {
            continue;
        };
        let Ok(map) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if map.get("protocol").and_then(Value::as_str) != Some("actions.json") {
            continue;
        }
        if !storage_map_matches_target(&map_path, &map, target_url_contains) {
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
    // Scope precedence: when the same workflow action is declared in multiple
    // maps (e.g. a private override of a public map), the highest-precedence
    // scope wins (private > shared > public) instead of erroring ambiguous.
    if matches.len() > 1 {
        let best_rank = matches
            .iter()
            .map(|(relative_path, _)| storage_scope_precedence_rank(relative_path))
            .min()
            .unwrap_or(u8::MAX);
        matches
            .retain(|(relative_path, _)| storage_scope_precedence_rank(relative_path) == best_rank);
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
    // U3: probe-at-dispatch — never send into a tab that has closed.
    ensure_dispatchable(state, &runtime).await?;

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

    let result = match tokio::time::timeout(Duration::from_millis(routing.timeout_ms), response_rx)
        .await
    {
        Ok(result) => result.map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "extension runtime dropped response", "call_id": call_id })),
            )
        })?,
        Err(_) => {
            let removed = state.pending.lock().await.remove(&call_id).is_some();
            let timeout_context = take_action_timeout_context(state, &call_id, removed).await;
            eprintln!(
                "actions-json-mcp pending timeout name=site_action_call call_id={} removed_pending={} context={}",
                call_id,
                removed,
                timeout_context
            );
            return Err((
                StatusCode::GATEWAY_TIMEOUT,
                route_error(
                    "dispatch_timeout",
                    "The site action was dispatched to the tab but no response arrived in time.",
                    timeout_context,
                ),
            ));
        }
    };
    state.action_progress.lock().await.remove(&call_id);

    let is_error = result.get("type").and_then(Value::as_str) == Some("action_error");
    Ok(Json(ToolCallResponse {
        announcements: None,
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
        let Ok(text) = fs::read_to_string(&map_path).await else {
            continue;
        };
        let Ok(map) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if map.get("protocol").and_then(Value::as_str) != Some("actions.json") {
            continue;
        }
        if !storage_map_matches_target(&map_path, &map, target_url_contains) {
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
            if !projection_matches_target_url(projection, target_url_contains) {
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
                                "max_bytes": summary.get("max_bytes").cloned().unwrap_or(Value::Null),
                                "input_schema": summary.get("input_schema").cloned().unwrap_or(Value::Null)
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

fn storage_map_matches_target(
    map_path: &Path,
    map: &Value,
    target_url_contains: Option<&str>,
) -> bool {
    let Some(target) = target_url_contains else {
        return true;
    };
    let Some(host) = storage_map_site_host(map_path) else {
        return map_matches_target_url(map, target_url_contains);
    };
    (target.contains(host.as_str()) || host.contains(target))
        && map_matches_target_url(map, target_url_contains)
}

fn map_scope_url_matches(map: &Value) -> Option<&str> {
    map.get("scope")
        .and_then(|scope| scope.get("url_matches"))
        .and_then(Value::as_str)
}

fn map_matches_target_url(map: &Value, target_url_contains: Option<&str>) -> bool {
    let Some(target) = target_url_contains else {
        return true;
    };
    map_scope_url_matches(map)
        .map(|pattern| url_pattern_matches_target(pattern, target))
        .unwrap_or(true)
}

fn url_pattern_matches_target(pattern: &str, target: &str) -> bool {
    if target.starts_with("http://") || target.starts_with("https://") {
        return wildcard_matches(pattern, target);
    }

    // target_url_contains also accepts URL fragments and human-readable tab
    // titles. Enforce map scope for URL-like fragments; title-only intent is
    // resolved against the live runtime before execution.
    if target.contains('/') {
        let normalized_pattern = strip_url_routing_prefix(pattern);
        let normalized_target = strip_url_routing_prefix(target);
        return wildcard_matches(normalized_pattern, normalized_target)
            || normalized_pattern.contains(normalized_target);
    }
    true
}

fn strip_url_routing_prefix(value: &str) -> &str {
    let without_scheme = value
        .split_once("://")
        .map(|(_, remainder)| remainder)
        .unwrap_or(value);
    without_scheme
        .strip_prefix("www.")
        .unwrap_or(without_scheme)
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    if pattern.trim().is_empty() {
        return true;
    }
    let mut remainder = value;
    let anchored_start = !pattern.starts_with('*');
    let anchored_end = !pattern.ends_with('*');
    let parts: Vec<&str> = pattern.split('*').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return true;
    }
    for (index, part) in parts.iter().enumerate() {
        let Some(position) = remainder.find(part) else {
            return false;
        };
        if index == 0 && anchored_start && position != 0 {
            return false;
        }
        remainder = &remainder[position + part.len()..];
    }
    if anchored_end {
        return remainder.is_empty();
    }
    true
}

fn projection_matches_target_url(projection: &Value, target_url_contains: Option<&str>) -> bool {
    let Some(target) = target_url_contains else {
        return true;
    };
    let Some(pattern) = projection
        .get("scope")
        .and_then(|scope| scope.get("url_matches"))
        .and_then(Value::as_str)
    else {
        return true;
    };
    url_pattern_matches_target(pattern, target)
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

fn stamp_map_url_matches(tool: &mut Value, map: &Value) {
    let Some(pattern) = map_scope_url_matches(map) else {
        return;
    };
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
        .entry("map_url_matches".to_string())
        .or_insert_with(|| json!(pattern));
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

/// Build the target-bound operation catalog persisted by the resident. Tools
/// without routing constraints remain universally available; constrained tools
/// are included only when their declared URL binding matches this generation's
/// observed page. Discovery is therefore bound to one live target rather than
/// a process-global union of every loaded site map.
fn catalog_snapshot_for_target(manifest: &Value, target_url: Option<&str>) -> Value {
    let operations = manifest
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| {
            let binding = tool.get("x_actions").and_then(|value| value.get("binding"));
            let Some(binding) = binding else { return true };
            let target_contains = binding.get("target_url_contains").and_then(Value::as_str);
            let host_matches = match (target_url, target_contains) {
                (Some(url), Some(fragment)) => url.contains(fragment) || fragment.contains(url),
                (None, Some(_)) => false,
                _ => true,
            };
            host_matches
                && ["map_url_matches", "url_matches"]
                    .iter()
                    .filter_map(|key| binding.get(*key).and_then(Value::as_str))
                    .all(|pattern| {
                        target_url.is_some_and(|url| url_pattern_matches_target(pattern, url))
                    })
        })
        .cloned()
        .collect::<Vec<_>>();
    json!({
        "protocol": manifest
            .get("protocol")
            .cloned()
            .unwrap_or_else(|| json!("actions.json")),
        "operations": operations,
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
            let binding = tool
                .get("x_actions")
                .and_then(|x_actions| x_actions.get("binding"))
                .unwrap_or(&Value::Null);
            let binding_target = binding
                .get("target_url_contains")
                .and_then(Value::as_str);
            let host_matches = match (target_url_contains, binding_target) {
                (Some(target), Some(binding_target)) => {
                    target.contains(binding_target) || binding_target.contains(target)
                }
                (Some(_), None) => true,
                (None, _) => true,
            };
            if !host_matches {
                return false;
            }
            ["map_url_matches", "url_matches"]
                .iter()
                .filter_map(|key| binding.get(*key).and_then(Value::as_str))
                .all(|pattern| {
                    target_url_contains
                        .map(|target| url_pattern_matches_target(pattern, target))
                        .unwrap_or(true)
                })
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
                    .unwrap_or(Value::Null),
                "url_matches": tool
                    .get("x_actions")
                    .and_then(|x_actions| x_actions.get("binding"))
                    .and_then(|binding| {
                        binding
                            .get("url_matches")
                            .or_else(|| binding.get("map_url_matches"))
                    })
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

/// The recovery next-step for each honest routing-failure code (R8/R9). The
/// opaque `no_claimed_tab` gave the agent no way to tell "the tab closed" from
/// "I never claimed one" from "that id is gone" from "the tab is just slow" —
/// so a wrong route could not self-correct. Each code now points somewhere
/// specific, in the agent's own terms.
fn route_error_next_step(code: &str) -> &'static str {
    match code {
        "tab_closed" => {
            "The tab has closed. Re-list runtimes (bridge/runtimes) and reopen or re-claim the target before retrying."
        }
        "claim_missing" => {
            "No claimed tab resolved for this call. Claim the target tab (claim_tab), then retry."
        }
        "runtime_not_found" => {
            "The routed runtime id is not in the live registry. Re-list runtimes and route to a currently-live id."
        }
        "dispatch_timeout" => {
            "The tab is present but did not respond in time. Retry; if it persists the tab may be hung — reload it."
        }
        "ambiguous_intent" => {
            "The intent phrase matched several live runtimes. Pick one from the named candidates and route by its runtime_id, or narrow the phrase."
        }
        _ => "Re-list runtimes (bridge/runtimes) and route to a currently-live runtime before retrying.",
    }
}

/// Build an agent-facing routing error that names its cause and carries the
/// recovery next-step for that cause. Same shape as `structured_error`, plus a
/// `next_step` field — the single honest error builder for the routing surface.
fn route_error(code: &str, message: impl Into<String>, evidence: Value) -> Json<Value> {
    Json(json!({
        "error": {
            "code": code,
            "message": message.into(),
            "recoverable": true,
            "next_step": route_error_next_step(code),
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
    let errors = validate_value_against_schema(arguments, schema, "");
    if errors.is_empty() {
        return Ok(());
    }
    let messages = errors
        .iter()
        .map(|error| error.message.as_str())
        .collect::<Vec<_>>();
    let missing_required = errors
        .iter()
        .filter(|error| error.keyword == "required")
        .map(|error| error.path.clone())
        .collect::<Vec<_>>();
    Err((
        StatusCode::BAD_REQUEST,
        structured_error(
            "invalid_input",
            messages.join("; "),
            json!({
                "tool": tool_name,
                "validation_errors": errors,
                "missing_required": missing_required,
            }),
        ),
    ))
}

// Routing fields are meta-arguments: an MCP client can only carry them inside
// `arguments` (the protocol gives the client no sibling to `arguments`), and the
// tool-call parser already lifts them into ToolCallRequest's typed fields. Strip
// them before schema validation so a tool with `additionalProperties: false`
// does not reject a perfectly valid routed call. Without this, the documented
// "specify target_url_contains" escape hatch is unusable on every generic tool.
const ROUTING_META_ARGUMENT_KEYS: [&str; 2] = ["target_runtime_id", "target_url_contains"];

fn strip_routing_meta_arguments(arguments: &Value) -> Value {
    match arguments.as_object() {
        Some(object) => {
            let mut stripped = object.clone();
            for key in ROUTING_META_ARGUMENT_KEYS {
                stripped.remove(key);
            }
            Value::Object(stripped)
        }
        None => arguments.clone(),
    }
}

fn validate_and_prepare_direct_tool_arguments(
    tool: &Value,
    request: &ToolCallRequest,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let arguments = strip_routing_meta_arguments(&request.arguments);
    if direct_mcp_tool_requires_policy_exception_report(&request.name) {
        let stripped = validate_and_strip_policy_exception_report(&request.name, &arguments)?;
        validate_tool_arguments(tool, &request.name, &stripped)?;
        return Ok(stripped);
    }

    validate_tool_arguments(tool, &request.name, &arguments)?;
    Ok(arguments)
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

#[derive(Debug, Serialize)]
struct ValidationError {
    path: String,
    keyword: String,
    message: String,
}

fn validate_value_against_schema(
    value: &Value,
    schema: &Value,
    path: &str,
) -> Vec<ValidationError> {
    let Some(schema_object) = schema.as_object() else {
        return Vec::new();
    };
    let mut errors = Vec::new();
    if let Some(schema_type) = schema_object.get("type").and_then(Value::as_str) {
        if let Err(message) = validate_json_type(value, schema_type, path) {
            errors.push(ValidationError {
                path: if path.is_empty() {
                    "arguments".to_string()
                } else {
                    path.to_string()
                },
                keyword: "type".to_string(),
                message,
            });
            return errors;
        }
    }

    if schema_object.get("type").and_then(Value::as_str) == Some("object") {
        let Some(object) = value.as_object() else {
            return errors;
        };

        if let Some(required) = schema_object.get("required").and_then(Value::as_array) {
            for required_key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(required_key) {
                    let required_path = schema_path_join(path, required_key);
                    errors.push(ValidationError {
                        path: required_path.clone(),
                        keyword: "required".to_string(),
                        message: format!("{required_path} is required"),
                    });
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
                    let property_path = schema_path_join(path, key);
                    errors.push(ValidationError {
                        path: property_path.clone(),
                        keyword: "additionalProperties".to_string(),
                        message: format!("{property_path} is not declared in input_schema"),
                    });
                }
            }
        }

        if let Some(properties) = properties {
            for (key, property_schema) in properties {
                if let Some(child) = object.get(key) {
                    errors.extend(validate_value_against_schema(
                        child,
                        property_schema,
                        &schema_path_join(path, key),
                    ));
                }
            }
        }
    }

    if schema_object.get("type").and_then(Value::as_str) == Some("array") {
        if let (Some(items), Some(values)) = (schema_object.get("items"), value.as_array()) {
            for (index, item) in values.iter().enumerate() {
                errors.extend(validate_value_against_schema(
                    item,
                    items,
                    &format!(
                        "{}[{}]",
                        if path.is_empty() { "arguments" } else { path },
                        index
                    ),
                ));
            }
        }
    }

    errors
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

/// Maps a dead runtime id to the live runtime on the SAME TAB, if one exists.
///
/// `runtime_key` is "chrome-tab:<tabId>" and survives a navigation, so it is the
/// only durable link between a runtime that was replaced and the one that
/// replaced it. Returns None rather than guessing: a tab that is really gone
/// gets a plain refusal.
async fn successor_for_stale_runtime(
    state: &AppState,
    runtimes: &HashMap<String, RuntimeClient>,
    stale_runtime_id: &str,
) -> Option<String> {
    let runtime_key = state
        .stale_runtime_keys
        .lock()
        .await
        .get(stale_runtime_id)
        .cloned()?;
    runtimes
        .values()
        .find(|client| client.runtime_key.as_deref() == Some(runtime_key.as_str()))
        .map(|client| client.runtime_id.clone())
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
        if let Some(client) = runtimes.get(runtime_id) {
            return Ok(client.clone());
        }
        // The id is dead. Still a refusal — never a fallback — but a dead id on a
        // tab that is still alive is the COMMON case, not an exception: ids
        // rotate on every cross-document navigation. Name the successor so the
        // caller can retry immediately instead of re-enumerating. A miss yields
        // a plainer refusal; it never yields a neighbouring runtime, which would
        // be the misroute this whole change removes.
        let successor = successor_for_stale_runtime(state, &runtimes, runtime_id).await;
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "target runtime not connected",
                "target_runtime_id": runtime_id,
                "successor_runtime_id": successor,
                "successor_reason": successor.as_ref().map(|_| "runtime_replaced_by_navigation"),
                "runtimes": runtime_summaries(&runtimes),
                "routing_trace": runtime_routing_trace(&runtimes, request, "runtime_id_not_found")
            })),
        ));
    }

    if let Some(needle) = request.target_url_contains.as_deref() {
        // U6: route by intent — match the phrase against url / title / host of
        // each (live, per this registry) runtime, not just the url.
        let matches = runtimes
            .values()
            .filter(|client| runtime_matches_intent(client, needle))
            .cloned()
            .collect::<Vec<_>>();

        return match matches.as_slice() {
            [client] => Ok(client.clone()),
            [] => Err((
                StatusCode::NOT_FOUND,
                route_error(
                    "runtime_not_found",
                    "No live runtime matched that intent phrase (url / title / host).",
                    json!({
                        "intent": needle,
                        "runtimes": runtime_summaries(&runtimes),
                    }),
                ),
            )),
            _ => Err((
                StatusCode::CONFLICT,
                route_error(
                    "ambiguous_intent",
                    "The intent phrase matched more than one live runtime; narrow it or pass a runtime_id.",
                    json!({
                        "intent": needle,
                        "candidates": matches.iter().map(runtime_summary).collect::<Vec<_>>(),
                    }),
                ),
            )),
        };
    }

    if runtimes.len() == 1 {
        return Ok(runtimes.values().next().unwrap().clone());
    }

    // No explicit target and more than one runtime: fall back to the
    // agent-manageable active tab instead of erroring. This is what lets the
    // agent hold several tabs open and still issue bare commands.
    if let Some(active_id) = state.active_runtime_id.lock().await.as_deref() {
        if let Some(client) = runtimes.get(active_id) {
            return Ok(client.clone());
        }
    }

    Err((
        StatusCode::CONFLICT,
        Json(json!({
            "error": "multiple extension runtimes connected and no active tab is set; specify target_runtime_id or target_url_contains, or set an active tab with browser.active_tab.set",
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
                // U7: one agent-facing id space. The routing trace addresses
                // runtimes by runtime_id only — runtime_key is an internal id
                // the agent never sees or routes by.
                "runtime_id": client.runtime_id,
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

/// The host portion of a URL, without scheme, userinfo, port, or path — the
/// human-meaningful "which site" label (R6). Deliberately lightweight (no url
/// crate): strip the scheme, cut at the first `/`, drop any `user@` and `:port`.
/// Returns None for an empty or path-only string.
fn host_from_url(url: &str) -> Option<String> {
    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let authority = without_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    // Trim a :port (but keep an IPv6 bracket form intact enough for a label).
    let host = host_port
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host_port);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// Whether a runtime matches an intent phrase (U6, R7). The agent routes by
/// what it can see in the unified view — a url fragment, a page title, or a host
/// — instead of hand-copying a runtime_id. Matched case-insensitively against
/// the url, the tab title, and the derived host.
fn runtime_matches_intent(client: &RuntimeClient, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    if let Some(url) = client.url.as_deref() {
        if url.to_lowercase().contains(&needle) {
            return true;
        }
        if let Some(host) = host_from_url(url) {
            if host.to_lowercase().contains(&needle) {
                return true;
            }
        }
    }
    if let Some(title) = client
        .tab
        .as_ref()
        .and_then(|tab| tab.get("title"))
        .and_then(Value::as_str)
    {
        if title.to_lowercase().contains(&needle) {
            return true;
        }
    }
    false
}

/// The agent-facing serialization of a live runtime (U5): one identity
/// (`runtime_id`), human-meaningful labels (`url`, `title`, `host`), and an
/// explicit `is_live`. The vestigial id spaces (`runtime_key` / `chrome-tab:`)
/// and the raw chrome `tab` object are NOT exposed to the agent — one identity,
/// no dead fields. `claimed_at_ms` is omitted entirely rather than serialized as
/// a constant null (R10).
fn runtime_summary(client: &RuntimeClient) -> Value {
    let title = client
        .tab
        .as_ref()
        .and_then(|tab| tab.get("title"))
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    let host = client.url.as_deref().and_then(host_from_url);
    let mut row = json!({
        "runtime_id": client.runtime_id,
        "url": client.url,
        "title": title,
        "host": host,
        "is_live": client.is_live(now_ms()),
        "extension_version": client.extension_version,
        "connected_at_ms": client.connected_at_ms,
        "last_seen_ms": client.last_seen_ms,
    });
    // U8 (R6-for-real): the MACHINE/BROWSER label, distinct from the site `host`.
    // Two browsers on the same page share a host but differ by device. OMITTED
    // (not null) when the extension does not report it — R10, no dead fields.
    if let Some(device) = client.device.as_deref() {
        row["device"] = json!(device);
    }
    row
}

/// U12. `WebSocketUpgrade` consumes the request, so it MUST come last; `HeaderMap`
/// and `Query` are non-consuming and are declared before it. Without the header
/// extractor this handler could not see `Origin` at all — which is precisely why
/// the bridge used to hand credentials to any page that dialed the socket.
///
/// Both checks run BEFORE `on_upgrade`, so a refused caller never reaches
/// `handle_extension_socket` and therefore never reaches the `runtime_ready`
/// branch that spawns credential hydration. The refusal is a plain HTTP 403
/// whose body is the specific reason, and it is logged server-side with the same
/// string, so an operator sees the same discriminating word on both sides.
async fn extension_ws(
    headers: header::HeaderMap,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let presented_secret = params.get("secret").map(String::as_str);

    if let Err(rejection) = state.extension_auth.authorize(origin, presented_secret) {
        let reason = rejection.reason();
        eprintln!(
            "actions-json bridge refused an /extension upgrade: {reason} (origin={})",
            origin.unwrap_or("<none>")
        );
        return (StatusCode::FORBIDDEN, reason).into_response();
    }

    ws.on_upgrade(move |socket| handle_extension_socket(socket, state))
        .into_response()
}

async fn extension_auth_check(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Response {
    let presented_secret = params.get("secret").map(String::as_str);

    match state.extension_auth.authorize_preflight(presented_secret) {
        Ok(()) => Json(json!({
            "ok": true,
            "authorized": true,
        }))
        .into_response(),
        Err(rejection) => {
            let reason = rejection.reason();
            eprintln!("actions-json bridge refused an /extension/auth-check request: {reason}");
            (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "authorized": false,
                    "error": {
                        "code": reason,
                        "message": rejection.message(),
                    }
                })),
            )
                .into_response()
        }
    }
}

async fn ingest_action_progress(state: &AppState, item: &Value) -> bool {
    let call_id = item.get("call_id").and_then(Value::as_str);
    let runtime_id = item.get("runtime_id").and_then(Value::as_str);
    let (Some(call_id), Some(runtime_id)) = (call_id, runtime_id) else {
        return false;
    };
    let pending_runtime_id = state
        .pending
        .lock()
        .await
        .get(call_id)
        .map(|pending| pending.runtime_id.clone());
    if pending_runtime_id.as_deref() != Some(runtime_id) {
        return false;
    }
    state.action_progress.lock().await.insert(
        call_id.to_string(),
        json!({
            "runtime_id": runtime_id,
            "action": item.get("action").and_then(Value::as_str),
            "last_entered_content_phase": item.get("last_entered_content_phase").and_then(Value::as_str),
            "last_completed_content_phase": item.get("last_completed_content_phase").and_then(Value::as_str),
            "observed_at": item.get("observed_at").and_then(Value::as_str),
            "received_at_ms": now_ms(),
        }),
    );
    if let Some(runtime) = state.runtimes.lock().await.get_mut(runtime_id) {
        runtime.last_seen_ms = now_ms();
    }
    true
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
                    "heartbeat_send_failed",
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
                // U8: the machine/browser this runtime lives on (e.g. "mac · 7c19").
                // Older extensions omit it; then the field is simply absent.
                let device = item
                    .get("device")
                    .and_then(Value::as_str)
                    .filter(|d| !d.is_empty())
                    .map(str::to_string);
                let tab = item.get("tab").cloned();
                let replay = item.get("replay").cloned();
                let authority_tab_key = runtime_key.clone().unwrap_or_else(|| runtime_id.clone());
                let authority_client_instance = item
                    .get("client_instance_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .or_else(|| device.clone())
                    .or_else(|| {
                        authorization_id.as_deref().map(|value| {
                            format!("auth-sha256:{:x}", Sha256::digest(value.as_bytes()))
                        })
                    })
                    .unwrap_or_else(|| format!("legacy-connection:{connection_id}"));
                let authority_title = tab
                    .as_ref()
                    .and_then(|value| value.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let authority_catalog = if state.runtime_authority.is_some() {
                    let catalog = state.catalog.lock().await;
                    Some(catalog_snapshot_for_target(
                        &catalog.manifest,
                        url.as_deref(),
                    ))
                } else {
                    None
                };
                connection_runtime_ids
                    .lock()
                    .await
                    .insert(runtime_id.clone());
                let timestamp = now_ms();
                let connect_tab_url = {
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
                    let tab_url = url.clone();
                    runtimes.insert(
                        runtime_id.clone(),
                        RuntimeClient {
                            runtime_id: runtime_id.clone(),
                            connection_id: connection_id.clone(),
                            runtime_key,
                            authorization_id,
                            extension_version,
                            device,
                            url,
                            tab,
                            replay,
                            connected_at_ms: timestamp,
                            last_seen_ms: timestamp,
                            tx: tx.clone(),
                        },
                    );
                    // Establish a default active tab: if none is set, or the
                    // previously active runtime is no longer connected, adopt
                    // this freshly connected runtime. An explicit
                    // browser.active_tab.set always wins over this.
                    let mut active = state.active_runtime_id.lock().await;
                    if active
                        .as_deref()
                        .is_none_or(|id| !runtimes.contains_key(id))
                    {
                        *active = Some(runtime_id.clone());
                    }
                    tab_url
                };
                if let (Some(authority), Some(catalog)) =
                    (&state.runtime_authority, authority_catalog)
                {
                    if let Err(error) = authority.observe_target(&runtime::LiveTargetObservation {
                        client_instance_id: authority_client_instance,
                        session_generation: connection_id.clone(),
                        tab_key: authority_tab_key,
                        runtime_id: runtime_id.clone(),
                        url: connect_tab_url.clone(),
                        title: authority_title,
                        catalog,
                    }) {
                        eprintln!("actions-json resident target observation failed: {error}");
                    }
                }
                // Logged after the runtimes lock is released so the file write
                // never blocks other connections while holding the map lock.
                append_lifecycle_log(
                    state.storage_root.as_deref(),
                    json!({
                        "ts_ms": timestamp,
                        "event": "connect",
                        "runtime_id": runtime_id,
                        "connection_id": connection_id,
                        "tab_url": connect_tab_url,
                    }),
                );
                tokio::spawn(send_storage_hydration_to_runtime(
                    state.clone(),
                    runtime_id.clone(),
                    tx.clone(),
                ));
                tokio::spawn(send_credential_hydration_to_extension(
                    state.clone(),
                    tx.clone(),
                ));
                if let Some(journal) = &state.operation_journal {
                    if let Err(error) = send_outstanding_operation_receipt_queries(journal, &tx) {
                        eprintln!("actions-json durable recovery query failed: {error}");
                    }
                }
            }
            Some("bridge_runtime_replay_summary") => {
                let mut last_replay_summary = state.last_replay_summary.lock().await;
                *last_replay_summary = Some(item);
            }
            Some("credential_hydration_result") => {
                let mut last_credential_hydration = state.last_credential_hydration.lock().await;
                let provider = item
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("openai");
                record_credential_hydration_status(
                    &mut last_credential_hydration,
                    provider,
                    json!({
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
                        "provider": provider,
                        "redacted": item.get("redacted").and_then(Value::as_str)
                    }),
                );
            }
            Some("action_progress") => {
                ingest_action_progress(&state, &item).await;
            }
            Some("operation_receipt") => {
                if let (Some(journal), Some(operation_id)) = (
                    state.operation_journal.as_ref(),
                    item.get("operation_id").and_then(Value::as_str),
                ) {
                    let reconciliation = reconcile_extension_operation_receipt(journal, &item);
                    if let Err(error) = reconciliation {
                        eprintln!("actions-json durable receipt reconciliation failed operation_id={operation_id}: {error}");
                    }
                }
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
                    match pending.get(call_id) {
                        Some(pending_call)
                            if Some(pending_call.runtime_id.as_str()) == item_runtime_id =>
                        {
                            if let Some(pending_call) = pending.remove(call_id) {
                                eprintln!(
                                    "actions-json-mcp pending matched type={} call_id={} runtime_id={}",
                                    item.get("type").and_then(Value::as_str).unwrap_or("unknown"),
                                    call_id,
                                    item_runtime_id.unwrap_or("<missing>")
                                );
                                let _ = pending_call.tx.send(item);
                            }
                        }
                        Some(pending_call) => {
                            eprintln!(
                                "actions-json-mcp pending runtime mismatch type={} call_id={} pending_runtime_id={} item_runtime_id={}",
                                item.get("type").and_then(Value::as_str).unwrap_or("unknown"),
                                call_id,
                                pending_call.runtime_id,
                                item_runtime_id.unwrap_or("<missing>")
                            );
                        }
                        None => {
                            eprintln!(
                                "actions-json-mcp pending missing type={} call_id={} item_runtime_id={}",
                                item.get("type").and_then(Value::as_str).unwrap_or("unknown"),
                                call_id,
                                item_runtime_id.unwrap_or("<missing>")
                            );
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
                    if let Some(authority) = &state.runtime_authority {
                        if let Err(error) = authority.touch_runtime(runtime_id) {
                            eprintln!("actions-json resident target heartbeat persistence failed: {error}");
                        }
                    }
                }
            }
            Some("runtime_removed") => {
                // A single tab closed while the browser (and this WS) stays
                // alive. Reap exactly that runtime now, rather than waiting for
                // the whole-connection teardown that never comes — the drag-504
                // gap. Also drop it from this connection's id set so the
                // eventual connection teardown does not double-log it.
                if let Some(runtime_id) = item.get("runtime_id").and_then(Value::as_str) {
                    connection_runtime_ids.lock().await.remove(runtime_id);
                    remove_single_runtime(&state, runtime_id, "tab_closed").await;
                }
            }
            Some("runtime_probe_result") => {
                // The extension's verdict on a pre-dispatch liveness probe (U3):
                // it ran chrome.tabs.get and reports whether the tab still
                // exists. Resolve the matching in-flight probe.
                if let Some(probe_id) = item.get("probe_id").and_then(Value::as_str) {
                    let alive = item.get("alive").and_then(Value::as_bool).unwrap_or(false);
                    resolve_runtime_probe(&state, probe_id, alive).await;
                }
            }
            Some("agent_event") => {
                ingest_agent_event(&state, &item).await;
            }
            Some("a11y_announcement") => {
                ingest_a11y_announcement(&state, &item).await;
            }
            _ => {}
        }
    }

    heartbeat_task.abort();
    send_task.abort();
    remove_runtimes_for_connection(
        &state,
        &connection_runtime_ids,
        &connection_id,
        "receive_loop_ended",
    )
    .await;
}

async fn remove_runtimes_for_connection(
    state: &AppState,
    runtime_ids: &Arc<Mutex<HashSet<String>>>,
    connection_id: &str,
    reason: &str,
) {
    let runtime_ids = runtime_ids.lock().await.clone();
    let active_before = state.active_runtime_id.lock().await.clone();
    let mut runtimes = state.runtimes.lock().await;
    let mut removed_active = false;
    // Collect what we actually removed (id + tab url) so the persistent log can
    // record which tabs dropped and why, not just that a connection closed.
    let mut removed: Vec<Value> = Vec::new();
    for runtime_id in runtime_ids {
        if runtimes
            .get(&runtime_id)
            .map(|client| client.connection_id == connection_id)
            .unwrap_or(false)
        {
            let tab_url = runtimes
                .get(&runtime_id)
                .and_then(|client| client.url.clone());
            runtimes.remove(&runtime_id);
            removed.push(json!({ "runtime_id": runtime_id, "tab_url": tab_url }));
            if active_before.as_deref() == Some(runtime_id.as_str()) {
                removed_active = true;
            }
        }
    }
    let remaining = runtimes.len();
    let next_active = runtimes.keys().next().cloned();
    drop(runtimes);
    if removed_active {
        *state.active_runtime_id.lock().await = next_active;
    }
    if let Some(authority) = &state.runtime_authority {
        if let Err(error) = authority.mark_session_offline(connection_id) {
            eprintln!("actions-json resident target disconnect persistence failed: {error}");
        }
    }
    if !removed.is_empty() {
        append_lifecycle_log(
            state.storage_root.as_deref(),
            json!({
                "ts_ms": now_ms(),
                "event": "disconnect",
                "reason": reason,
                "connection_id": connection_id,
                "removed_active": removed_active,
                "remaining_runtimes": remaining,
                "runtimes": removed,
            }),
        );
    }
}

/// Evict every runtime whose heartbeat has aged past `RUNTIME_LIVENESS_TTL_MS`,
/// reassign the active runtime if it was one of them, and record the eviction in
/// the persistent lifecycle log (reason `liveness_sweep`). Returns how many were
/// evicted. Idempotent: a run with nothing stale removes nothing and does not
/// panic on an empty registry. This is the depth layer behind the read-path
/// liveness filter — the read path never *advertises* a dead runtime, and the
/// sweep makes sure a dead runtime does not linger in memory indefinitely.
/// Resolve an in-flight liveness probe with the extension's verdict. Called from
/// the `runtime_probe_result` message arm (and from tests). A probe_id with no
/// waiter is a late/duplicate reply and is ignored.
async fn resolve_runtime_probe(state: &AppState, probe_id: &str, alive: bool) {
    if let Some(sender) = state.pending_probes.lock().await.remove(probe_id) {
        let _ = sender.send(alive);
    }
}

/// Probe a runtime for ground-truth liveness before dispatching into it: send a
/// `runtime_probe` the extension answers with a `chrome.tabs.get`, and await the
/// `runtime_probe_result`. A send failure, a timeout, or a negative verdict all
/// mean dead. This is the hard guarantee — the extension confirms the tab still
/// exists, not merely that a socket is open.
async fn probe_runtime(state: &AppState, client: &RuntimeClient) -> bool {
    let probe_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    state
        .pending_probes
        .lock()
        .await
        .insert(probe_id.clone(), tx);

    let message = json!({
        "type": "runtime_probe",
        "probe_id": probe_id,
        "runtime_id": client.runtime_id,
    });
    if client.tx.send(Message::Text(message.to_string())).is_err() {
        state.pending_probes.lock().await.remove(&probe_id);
        return false;
    }

    match tokio::time::timeout(Duration::from_millis(RUNTIME_PROBE_TIMEOUT_MS), rx).await {
        Ok(Ok(alive)) => alive,
        // Timeout or dropped sender: no confirmation the tab exists → dead.
        _ => {
            state.pending_probes.lock().await.remove(&probe_id);
            false
        }
    }
}

/// The freshness-gated dispatch guarantee (KTD2, R2c). A fresh runtime is
/// trusted and dispatches directly. A stale one is probed: on a positive probe
/// it is dispatchable; on a negative/timeout it is evicted (U1) and the caller
/// gets a `tab_closed` error (U4) instead of a real call vanishing into a closed
/// tab and a 30s dispatch timeout.
async fn ensure_dispatchable(
    state: &AppState,
    client: &RuntimeClient,
) -> Result<(), (StatusCode, Json<Value>)> {
    if !client.needs_dispatch_probe(now_ms()) {
        return Ok(());
    }
    if probe_runtime(state, client).await {
        return Ok(());
    }
    remove_single_runtime(state, &client.runtime_id, "tab_closed").await;
    Err((
        StatusCode::NOT_FOUND,
        route_error(
            "tab_closed",
            "The target tab did not respond to a liveness probe before dispatch; it has been evicted.",
            json!({ "runtime_id": client.runtime_id }),
        ),
    ))
}

/// Spawn the background task that periodically evicts stale runtimes. Runs on a
/// cadence tighter than the TTL so a dead runtime is reaped within roughly one
/// TTL window. Started at real bridge startup only — test app builders skip it,
/// keeping their registries under explicit control.
fn spawn_liveness_sweep(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            sweep_stale_runtimes(&state).await;
        }
    });
}

/// Bounded resident-owned retention maintenance. Coordination history is
/// pruned before journal metadata so active queue rows and the history floor
/// remain authoritative. Spill files are deleted before their metadata rows.
fn spawn_durable_maintenance(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            interval.tick().await;
            let Some(authority) = state.runtime_authority.clone() else {
                return;
            };
            let Some(journal) = state.operation_journal.clone() else {
                return;
            };
            let payload_dir = state.payload.lock().await.payload_dir.clone();
            let policy = state::SpillPolicy {
                directory: payload_dir,
                inline_limit_bytes: 0,
                max_spill_bytes: 64 * 1024 * 1024,
            };
            let maintenance = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                let maintenance_now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
                authority
                    .maintain_durable_state(maintenance_now, 256)
                    .map_err(|error| anyhow!(error.to_string()))?;
                journal.purge_expired_with_spills_bounded(maintenance_now, &policy, 256)?;
                Ok(())
            })
            .await;
            match maintenance {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("actions-json durable maintenance failed: {error}"),
                Err(error) => eprintln!("actions-json durable maintenance task failed: {error}"),
            }
        }
    });
}

/// Reap exactly one runtime from the registry by id — the tab-close path. Unlike
/// `remove_runtimes_for_connection` (which drops every runtime on a closed WS
/// connection), this removes a single tab's runtime while the browser and its
/// connection stay alive: the exact drag-504 gap where one tab closed but the
/// socket did not. Reassigns the active runtime if it was the reaped one, and
/// records the eviction in the lifecycle log. Returns whether a runtime was
/// present to reap (unknown/already-removed id → false, no-op, no panic).
/// How many dead runtime ids to remember for successor lookup. Ids rotate on
/// every navigation, so this map would grow without bound in a long session;
/// the cap is generous relative to a turn (a tester saw eleven rotations in two
/// hours) and losing the oldest only costs a plainer refusal.
const STALE_RUNTIME_MEMORY: usize = 256;

async fn remember_stale_runtime(state: &AppState, runtime_id: &str, runtime_key: &str) {
    let mut stale = state.stale_runtime_keys.lock().await;
    if stale.len() >= STALE_RUNTIME_MEMORY {
        // Cheap eviction: this is a hint cache, and a miss degrades to the
        // plain refusal that was correct before this existed.
        stale.clear();
    }
    stale.insert(runtime_id.to_string(), runtime_key.to_string());
}

async fn remove_single_runtime(state: &AppState, runtime_id: &str, reason: &str) -> bool {
    let active_before = state.active_runtime_id.lock().await.clone();
    let mut runtimes = state.runtimes.lock().await;
    let Some(removed_client) = runtimes.remove(runtime_id) else {
        return false;
    };
    let removed_active = active_before.as_deref() == Some(runtime_id);
    let remaining = runtimes.len();
    let next_active = runtimes.keys().next().cloned();
    let removed_runtime_key = removed_client.runtime_key.clone();
    drop(runtimes);
    if removed_active {
        *state.active_runtime_id.lock().await = next_active;
    }
    if let Some(authority) = &state.runtime_authority {
        if let Err(error) = authority.mark_runtime_offline(runtime_id) {
            eprintln!("actions-json resident target eviction persistence failed: {error}");
        }
    }
    // Remember which TAB this id lived on so a later call carrying it can be
    // told its successor instead of just being refused. Ids rotate on every
    // navigation, so this is the common path, not an edge case.
    if let Some(runtime_key) = removed_runtime_key {
        remember_stale_runtime(state, runtime_id, &runtime_key).await;
    }
    append_lifecycle_log(
        state.storage_root.as_deref(),
        json!({
            "ts_ms": now_ms(),
            "event": "disconnect",
            "reason": reason,
            "removed_active": removed_active,
            "remaining_runtimes": remaining,
            "runtimes": [{ "runtime_id": runtime_id, "tab_url": removed_client.url }],
        }),
    );
    true
}

async fn sweep_stale_runtimes(state: &AppState) -> usize {
    let now = now_ms();
    let active_before = state.active_runtime_id.lock().await.clone();
    let mut runtimes = state.runtimes.lock().await;
    let stale_ids: Vec<String> = runtimes
        .iter()
        .filter(|(_, client)| !client.is_live(now))
        .map(|(id, _)| id.clone())
        .collect();
    if stale_ids.is_empty() {
        return 0;
    }
    let mut removed_active = false;
    let mut removed: Vec<Value> = Vec::new();
    for runtime_id in &stale_ids {
        let tab_url = runtimes.get(runtime_id).and_then(|c| c.url.clone());
        let last_seen_ms = runtimes.get(runtime_id).map(|c| c.last_seen_ms);
        runtimes.remove(runtime_id);
        removed.push(json!({
            "runtime_id": runtime_id,
            "tab_url": tab_url,
            "last_seen_ms": last_seen_ms,
        }));
        if active_before.as_deref() == Some(runtime_id.as_str()) {
            removed_active = true;
        }
    }
    let remaining = runtimes.len();
    let next_active = runtimes.keys().next().cloned();
    drop(runtimes);
    if removed_active {
        *state.active_runtime_id.lock().await = next_active;
    }
    append_lifecycle_log(
        state.storage_root.as_deref(),
        json!({
            "ts_ms": now,
            "event": "disconnect",
            "reason": "liveness_sweep",
            "removed_active": removed_active,
            "remaining_runtimes": remaining,
            "runtimes": removed,
        }),
    );
    removed.len()
}

/// U12b. The CLI is a client of the bridge's OWN gated routes, so it has to
/// present the same secret every other caller does. It can read it directly:
/// `list-tools` and `open-overlay` run on the machine that owns the
/// installation, so `ExtensionAuthConfig::load(None)` resolves the very
/// `.actions-json.local.json` the serving process resolved — the same cwd-based
/// lookup `state_from_catalog` uses.
///
/// Loading (rather than requiring a flag) is the point: an operator running
/// `actions-json-mcp list-tools` must not have to paste a secret to talk to
/// their own bridge. If the bridge is a DIFFERENT installation, the secrets
/// differ and the request is refused with `bridge_secret_mismatch` — which is
/// the correct and informative answer, not a failure of this design.
fn local_bridge_secret() -> String {
    ExtensionAuthConfig::load(None)
        .handshake_secret()
        .to_string()
}

async fn list_tools(bridge: String) -> Result<()> {
    let url = format!("{}/mcp/tools/list", bridge.trim_end_matches('/'));
    let body = reqwest::Client::new()
        .get(url)
        .bearer_auth(local_bridge_secret())
        .send()
        .await?
        .text()
        .await?;
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
        .bearer_auth(local_bridge_secret())
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

#[cfg(test)]
mod resident_operation_error_result_tests {
    use super::*;

    #[test]
    fn resident_failure_is_a_visible_tool_error_carrying_the_underlying_reason() {
        let result = resident_operation_error_result(
            "browser.run_javascript",
            "debugger detached: target closed",
        );
        assert_eq!(result["isError"], json!(true));
        let text = result["content"][0]["text"].as_str().expect("text content");
        assert!(
            text.contains("debugger detached: target closed"),
            "the agent-visible text must include the underlying reason: {text}"
        );
        let parsed: Value = serde_json::from_str(text).expect("json body");
        assert_eq!(parsed["error"]["code"], json!("resident_operation_failed"));
        assert_eq!(parsed["ok"], json!(false));
    }
}

#[cfg(test)]
mod explicit_target_required_result_tests {
    use super::*;

    fn observe(authority: &runtime::RuntimeAuthority, tab: &str, runtime_id: &str, url: &str) {
        authority
            .observe_target(&runtime::LiveTargetObservation {
                client_instance_id: "browser-install-a".into(),
                session_generation: "session-1".into(),
                tab_key: tab.into(),
                runtime_id: runtime_id.into(),
                url: Some(url.into()),
                title: Some("Transfers".into()),
                catalog: json!({"operations":[{"name":"page.info"}]}),
            })
            .unwrap();
    }

    #[test]
    fn names_live_targets_and_the_fields_to_route_with() {
        let dir = tempfile::tempdir().unwrap();
        let authority = runtime::RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
        observe(
            &authority,
            "tab-1",
            "runtime-godaddy",
            "https://dcc.godaddy.com/control/transfers",
        );
        let result = explicit_target_required_result(&authority);
        assert_eq!(result["error"]["code"], json!("explicit_target_required"));
        let live = result["error"]["evidence"]["live_targets"]
            .as_array()
            .unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0]["target_runtime_id"], json!("runtime-godaddy"));
        assert_eq!(
            live[0]["url"],
            json!("https://dcc.godaddy.com/control/transfers")
        );
        let message = result["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("target_runtime_id") && message.contains("target_url_contains"),
            "{message}"
        );
    }

    #[test]
    fn says_no_tab_is_connected_when_none_is_live() {
        let dir = tempfile::tempdir().unwrap();
        let authority = runtime::RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
        let result = explicit_target_required_result(&authority);
        assert_eq!(result["error"]["evidence"]["live_targets"], json!([]));
        assert!(result["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no live tab is connected"));
    }
}
