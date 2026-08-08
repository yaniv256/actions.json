//! U12 — the pre-install security finding.
//!
//! `/extension` used to accept ANY WebSocket connection and, on `runtime_ready`,
//! hand back raw OpenAI and Protoface credentials. Loopback binding does NOT
//! protect this: WebSocket connections are not subject to the same-origin policy
//! the way XHR is, so any page the user has open can call
//! `new WebSocket("ws://127.0.0.1:17345/extension")` and receive whatever the
//! bridge sends.
//!
//! These tests pin the guard: an Origin check plus a per-installation handshake
//! secret, both enforced BEFORE any credential frame reaches the socket. The
//! rejection reason is a DISTINCT string per cause — five agents share this
//! machine, each running a different bridge version, and "my bridge is dead"
//! with no discriminating message burns a day.

use actions_json_mcp::{app_from_manifest_value_with_auth_root, ExtensionAuthConfig};
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::Path;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tower::ServiceExt;

const EXTENSION_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

fn manifest() -> Value {
    json!({
        "tools": [
            {
                "name": "overlay.open",
                "description": "Open an overlay",
                "input_schema": { "type": "object" }
            }
        ]
    })
}

/// Write a local config that pins the allowed extension id, the same
/// `.actions-json.local.json` file the bridge already reads OpenAI and
/// Protoface credentials from. The OpenAI key is present so that a successful
/// handshake has an observable credential frame to receive — and so that a
/// FAILED handshake has something it must not leak.
fn write_local_config(root: &Path) {
    std::fs::write(
        root.join(".actions-json.local.json"),
        json!({
            "openai_api_key": "sk-proj-testtesttesttest7890",
            "extension_ids": [EXTENSION_ID],
        })
        .to_string(),
    )
    .unwrap();
}

struct Bridge {
    address: std::net::SocketAddr,
    app: axum::Router,
    secret: String,
    _server: tokio::task::JoinHandle<()>,
}

async fn spawn_bridge(root: &Path) -> Bridge {
    let app = app_from_manifest_value_with_auth_root(manifest(), Some(root.to_path_buf()));
    let secret = ExtensionAuthConfig::load(Some(root))
        .handshake_secret()
        .to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    Bridge {
        address,
        app,
        secret,
        _server: server,
    }
}

fn runtime_ready() -> Message {
    Message::Text(
        json!({
            "type": "runtime_ready",
            "runtime_id": "extension-runtime",
            "runtime_key": "chrome-tab:1",
            "url": "https://example.test/",
            "extension_version": "0.1.248"
        })
        .to_string(),
    )
}

/// Drain the socket for a bounded window and report what arrived: every text
/// frame, plus the close frame if one came. Tests assert on the ABSENCE of a
/// credential_hydration message here, not merely that the socket closed — a
/// socket that closes AFTER leaking the key is still a leak.
async fn drain(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> (Vec<Value>, Option<String>) {
    let mut texts = Vec::new();
    let mut close_reason = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(1500);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    texts.push(value);
                }
            }
            Ok(Some(Ok(Message::Close(frame)))) => {
                close_reason = frame.map(|frame| frame.reason.to_string());
                break;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(
                tokio_tungstenite::tungstenite::Error::ConnectionClosed
                | tokio_tungstenite::tungstenite::Error::AlreadyClosed,
            ))) => break,
            Ok(Some(Err(tokio_tungstenite::tungstenite::Error::Protocol(_)))) => break,
            Ok(Some(Err(error))) => panic!("unexpected websocket error: {error}"),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    (texts, close_reason)
}

fn has_credential_hydration(texts: &[Value]) -> bool {
    texts
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("credential_hydration"))
}

async fn connect(
    address: std::net::SocketAddr,
    origin: Option<&str>,
    secret: Option<&str>,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    (StatusCode, Option<String>),
> {
    let uri = match secret {
        Some(secret) => format!("ws://{address}/extension?secret={secret}"),
        None => format!("ws://{address}/extension"),
    };
    let mut request = uri.into_client_request().unwrap();
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert(header::ORIGIN, origin.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let status = response.status();
            let reason = response
                .body()
                .as_ref()
                .map(|body| String::from_utf8_lossy(body).to_string());
            Err((status, reason))
        }
        Err(error) => panic!("unexpected connect error: {error}"),
    }
}

/// The whole finding in one test: a webpage's socket must never see a
/// credential frame. The assertion is on the ABSENCE of credential_hydration,
/// not on the socket having closed.
#[tokio::test]
async fn page_origin_is_rejected_before_any_credential_frame_is_sent() {
    // A credential MUST be configured for this test to mean anything. With no
    // key on the machine there is nothing to leak, the absence assertion passes
    // vacuously, and the test would stay green even with the guard deleted —
    // a null experiment. This makes the leak possible so the guard is what
    // prevents it.
    std::env::set_var("ACTIONS_JSON_OPENAI_API_KEY", "sk-proj-testtesttesttest7890");

    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let outcome = connect(
        bridge.address,
        Some("https://evil.example"),
        // The page presents the RIGHT secret, so the only thing standing
        // between it and the keys is the origin check.
        Some(&bridge.secret),
    )
    .await;

    match outcome {
        Err((status, reason)) => {
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert_eq!(reason.as_deref(), Some("origin_rejected"));
        }
        Ok(mut socket) => {
            // If the upgrade was allowed at all, the socket must still never
            // produce a credential frame, and must name the cause on close.
            socket.send(runtime_ready()).await.ok();
            let (texts, close_reason) = drain(&mut socket).await;
            assert!(
                !has_credential_hydration(&texts),
                "a page-origin socket received credentials: {texts:?}"
            );
            assert_eq!(close_reason.as_deref(), Some("origin_rejected"));
        }
    }
}

#[tokio::test]
async fn extension_origin_without_secret_is_rejected_as_handshake_secret_missing() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let outcome = connect(
        bridge.address,
        Some(&format!("chrome-extension://{EXTENSION_ID}")),
        None,
    )
    .await;

    match outcome {
        Err((status, reason)) => {
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert_eq!(reason.as_deref(), Some("handshake_secret_missing"));
        }
        Ok(mut socket) => {
            socket.send(runtime_ready()).await.ok();
            let (texts, close_reason) = drain(&mut socket).await;
            assert!(!has_credential_hydration(&texts));
            assert_eq!(close_reason.as_deref(), Some("handshake_secret_missing"));
        }
    }
}

/// A DIFFERENT string from the missing case. An operator staring at a dead
/// bridge must be able to tell "the extension never learned the secret" from
/// "the extension is holding another bridge's secret" — the mismatched case is
/// exactly what a version-skewed cutover produces.
#[tokio::test]
async fn extension_origin_with_wrong_secret_is_rejected_as_handshake_secret_mismatch() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let outcome = connect(
        bridge.address,
        Some(&format!("chrome-extension://{EXTENSION_ID}")),
        Some("not-the-right-secret"),
    )
    .await;

    let observed = match outcome {
        Err((status, reason)) => {
            assert_eq!(status, StatusCode::FORBIDDEN);
            reason
        }
        Ok(mut socket) => {
            socket.send(runtime_ready()).await.ok();
            let (texts, close_reason) = drain(&mut socket).await;
            assert!(!has_credential_hydration(&texts));
            close_reason
        }
    };
    assert_eq!(observed.as_deref(), Some("handshake_secret_mismatch"));
    assert_ne!(
        observed.as_deref(),
        Some("handshake_secret_missing"),
        "mismatch and missing must not collapse to one string"
    );
}

#[tokio::test]
async fn auth_check_exposes_the_exact_safe_handshake_rejection() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let response = bridge
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/extension/auth-check?secret=not-the-right-secret")
                .header(
                    header::ORIGIN,
                    format!("chrome-extension://{EXTENSION_ID}"),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["ok"], false);
    assert_eq!(payload["error"]["code"], "handshake_secret_mismatch");
    assert!(
        !String::from_utf8_lossy(&body).contains(&bridge.secret),
        "auth diagnostics must never echo the configured secret"
    );
}

#[tokio::test]
async fn auth_check_accepts_the_current_secret_without_echoing_it() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let response = bridge
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/extension/auth-check?secret={}",
                    bridge.secret
                ))
                .header(
                    header::ORIGIN,
                    format!("chrome-extension://{EXTENSION_ID}"),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["ok"], true);
    assert!(
        !String::from_utf8_lossy(&body).contains(&bridge.secret),
        "successful auth diagnostics must not echo the configured secret"
    );
}

#[tokio::test]
async fn auth_check_accepts_extension_service_worker_fetch_without_origin() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let response = bridge
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/extension/auth-check?secret={}", bridge.secret))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["authorized"], true);
    assert!(
        !String::from_utf8_lossy(&body).contains(&bridge.secret),
        "the secret-only preflight must never echo the configured secret"
    );
}

/// The guard must not have broken the thing it protects. Credential hydration is
/// keyed off the crate's own `ACTIONS_JSON_OPENAI_API_KEY` override — the same
/// path `load_local_openai_credential` checks first — so this asserts on a value
/// this test owns rather than on whatever config happens to sit on the machine.
#[tokio::test]
async fn extension_origin_with_correct_secret_receives_credentials() {
    const TEST_KEY: &str = "sk-proj-testtesttesttest7890";
    // SAFETY: single-threaded within this test's setup, before any bridge task
    // reads it. The bridge loads the credential lazily, per connection.
    std::env::set_var("ACTIONS_JSON_OPENAI_API_KEY", TEST_KEY);

    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = spawn_bridge(root.path()).await;

    let mut socket = connect(
        bridge.address,
        Some(&format!("chrome-extension://{EXTENSION_ID}")),
        Some(&bridge.secret),
    )
    .await
    .expect("an authorized extension origin with the right secret must connect");

    socket.send(runtime_ready()).await.unwrap();
    let (texts, _) = drain(&mut socket).await;
    let credential = texts
        .iter()
        .find(|item| {
            item.get("type").and_then(Value::as_str) == Some("credential_hydration")
                && item.get("provider").and_then(Value::as_str) == Some("openai")
        })
        .expect("an authorized socket still receives credential hydration");
    assert_eq!(credential["credential"]["api_key"], TEST_KEY);

    // And the connection actually registered a runtime, i.e. the guard did not
    // silently degrade the happy path.
    let response = bridge
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/runtimes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["runtimes"].as_array().map(Vec::len), Some(1));
}

/// The secret is per-installation, not per-process. A bridge restart must not
/// invalidate every extension on the machine.
#[tokio::test]
async fn handshake_secret_is_generated_once_and_survives_a_restart() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());

    let first = ExtensionAuthConfig::load(Some(root.path()))
        .handshake_secret()
        .to_string();
    assert!(
        first.len() >= 32,
        "a guessable secret is not a secret: {first}"
    );

    // A second load is a fresh process's view of the same installation.
    let second = ExtensionAuthConfig::load(Some(root.path()))
        .handshake_secret()
        .to_string();
    assert_eq!(first, second);

    // And it survived because it was PERSISTED, not because it was cached.
    let text = std::fs::read_to_string(root.path().join(".actions-json.local.json")).unwrap();
    let config: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        config["bridge_handshake_secret"].as_str(),
        Some(first.as_str())
    );
    // Persisting the secret must not have eaten the credentials living beside it.
    assert_eq!(
        config["openai_api_key"].as_str(),
        Some("sk-proj-testtesttesttest7890")
    );

    // A live handshake against a freshly constructed app accepts the persisted
    // secret — the restart is real, not just a re-read.
    let bridge = spawn_bridge(root.path()).await;
    assert_eq!(bridge.secret, first);
    let socket = connect(
        bridge.address,
        Some(&format!("chrome-extension://{EXTENSION_ID}")),
        Some(&first),
    )
    .await;
    assert!(socket.is_ok(), "the persisted secret must still authorize");
}

#[tokio::test]
async fn cors_responses_no_longer_advertise_wildcard_or_private_network() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let app = app_from_manifest_value_with_auth_root(manifest(), Some(root.path().to_path_buf()));

    for (method, uri) in [
        (Method::OPTIONS, "/mcp/tools/list"),
        (Method::GET, "/mcp/tools/list"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let headers = response.headers().clone();
        let allow_origin = headers
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .map(|value| value.to_str().unwrap().to_string());
        assert_ne!(
            allow_origin.as_deref(),
            Some("*"),
            "{method} {uri} still advertises a wildcard origin"
        );
        assert_eq!(
            allow_origin.as_deref(),
            Some(format!("chrome-extension://{EXTENSION_ID}").as_str()),
            "{method} {uri} must scope CORS to the extension origin"
        );
        assert!(
            headers
                .get("access-control-allow-private-network")
                .is_none(),
            "{method} {uri} still sends access-control-allow-private-network"
        );
    }
}
