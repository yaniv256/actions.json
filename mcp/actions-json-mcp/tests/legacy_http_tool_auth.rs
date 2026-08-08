//! U12b — the HTTP half of the U12 finding.
//!
//! U12 authenticated `/extension`. It did NOT authenticate the legacy HTTP tool
//! routes `serve` mounts: `/actions`, `/mcp/tools/list`, `/mcp/tools/resolve`,
//! `/mcp/tools/reload`, and `/mcp/tools/call`. `POST /mcp/tools/call` drives the
//! user's authorized browser tabs, and it was protected by nothing but loopback
//! binding and CORS. CORS is a BROWSER rule: any other local process — a
//! malicious npm postinstall, another user's session on a shared box — just
//! opens a socket and skips it entirely.
//!
//! These tests pin the guard on EVERY route in the gated set, not only the
//! scariest one. The repo has an incident on exactly that shape ("a fix landed
//! on one step, not its sibling"), so the route list here is the whole set and
//! each member is asserted individually.
//!
//! Reason strings are DISTINCT per cause, matching the U12 vocabulary: a caller
//! that forgot the header and a caller holding a stale secret must not read the
//! same word, or they end up on the same wrong trail.

use actions_json_mcp::{app_from_manifest_value_with_auth_root, ExtensionAuthConfig};
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::path::Path;
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
    app: Router,
    secret: String,
}

fn bridge(root: &Path) -> Bridge {
    let app = app_from_manifest_value_with_auth_root(manifest(), Some(root.to_path_buf()));
    let secret = ExtensionAuthConfig::load(Some(root))
        .handshake_secret()
        .to_string();
    Bridge { app, secret }
}

/// Every route `app_from_state(_, true)` adds beyond the base router. This list
/// IS the gated set — if a route is added to the `include_legacy_tool_http_routes`
/// block and not here, the sibling-coverage tests below stop covering it, which
/// is why they iterate this constant rather than naming routes inline.
const GATED_ROUTES: &[(Method, &str)] = &[
    (Method::GET, "/actions"),
    (Method::GET, "/mcp/tools/list"),
    (Method::POST, "/mcp/tools/resolve"),
    (Method::POST, "/mcp/tools/reload"),
    (Method::POST, "/mcp/tools/call"),
];

/// A body every gated route accepts. `/mcp/tools/resolve` and `/mcp/tools/call`
/// deserialize a `ToolCallRequest`; the GET routes ignore it. Naming a tool that
/// EXISTS in the manifest matters for the authorized case — an authorized call
/// must get past the gate and reach real handler behavior, so that the refusal
/// is the only difference between the refused and the allowed run.
fn tool_call_body() -> Body {
    Body::from(json!({ "name": "overlay.open", "arguments": {} }).to_string())
}

fn request(method: &Method, uri: &str) -> axum::http::request::Builder {
    Request::builder()
        .method(method.clone())
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, String) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&body).to_string())
}

/// The reason string the guard names, wherever it puts it. Asserting on the raw
/// body text rather than a parsed field keeps this honest about the actual
/// requirement — the response must NAME what failed — without over-pinning a
/// serialization shape.
fn names_reason(body: &str, reason: &str) -> bool {
    body.contains(reason)
}

// ---------------------------------------------------------------------------
// 1. No credential at all.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tools_call_without_a_credential_is_refused_and_the_body_names_the_reason() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = bridge(root.path());

    let (status, body) = send(
        &bridge.app,
        request(&Method::POST, "/mcp/tools/call")
            .body(tool_call_body())
            .unwrap(),
    )
    .await;

    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "an uncredentialed tools/call must be refused, got {status} with body {body}"
    );
    assert!(
        names_reason(&body, "bridge_secret_missing"),
        "a bare refusal with no reason routes every caller wrong; body was {body}"
    );
}

// ---------------------------------------------------------------------------
// 2. Wrong credential — a DIFFERENT reason from #1.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tools_call_with_a_wrong_secret_is_refused_distinguishably_from_a_missing_one() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = bridge(root.path());

    let (status, wrong) = send(
        &bridge.app,
        request(&Method::POST, "/mcp/tools/call")
            .header(header::AUTHORIZATION, "Bearer not-the-secret")
            .body(tool_call_body())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        names_reason(&wrong, "bridge_secret_mismatch"),
        "a wrong secret must say so; body was {wrong}"
    );

    let (_, missing) = send(
        &bridge.app,
        request(&Method::POST, "/mcp/tools/call")
            .body(tool_call_body())
            .unwrap(),
    )
    .await;
    assert!(
        !names_reason(&missing, "bridge_secret_mismatch"),
        "mismatch and missing must not collapse to one string; missing said {missing}"
    );
    assert_ne!(
        wrong, missing,
        "an operator holding a stale secret and one who sent none must read different words"
    );
}

// ---------------------------------------------------------------------------
// 3. Correct credential succeeds — via BOTH accepted channels.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tools_call_with_the_correct_secret_succeeds() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = bridge(root.path());

    // Authorization header — what a local process or a service-worker `fetch`
    // uses, since both can set headers.
    let (status, body) = send(
        &bridge.app,
        request(&Method::POST, "/mcp/tools/call")
            .header(header::AUTHORIZATION, format!("Bearer {}", bridge.secret))
            .body(tool_call_body())
            .unwrap(),
    )
    .await;
    assert_ne!(
        status,
        StatusCode::UNAUTHORIZED,
        "the right secret must pass the gate; body was {body}"
    );
    assert!(
        !names_reason(&body, "bridge_secret_missing")
            && !names_reason(&body, "bridge_secret_mismatch"),
        "an authorized call must not carry a refusal reason; body was {body}"
    );

    // Query parameter — the same channel `/extension` uses, kept so a curl or a
    // browser-side caller that cannot set headers is not locked out.
    let (query_status, query_body) = send(
        &bridge.app,
        request(
            &Method::POST,
            &format!("/mcp/tools/call?secret={}", bridge.secret),
        )
        .body(tool_call_body())
        .unwrap(),
    )
    .await;
    assert_ne!(
        query_status,
        StatusCode::UNAUTHORIZED,
        "the secret must also be accepted as a query parameter; body was {query_body}"
    );
}

// ---------------------------------------------------------------------------
// 4. Every sibling route is gated, not only the scariest one.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_legacy_http_tool_route_is_gated_not_only_tools_call() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = bridge(root.path());

    for (method, uri) in GATED_ROUTES {
        let (status, body) = send(
            &bridge.app,
            request(method, uri).body(tool_call_body()).unwrap(),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{method} {uri} is still reachable without a credential (status {status}, body {body})"
        );
        assert!(
            names_reason(&body, "bridge_secret_missing"),
            "{method} {uri} refused without naming a reason; body was {body}"
        );

        let (wrong_status, wrong_body) = send(
            &bridge.app,
            request(method, uri)
                .header(header::AUTHORIZATION, "Bearer not-the-secret")
                .body(tool_call_body())
                .unwrap(),
        )
        .await;
        assert_eq!(wrong_status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert!(
            names_reason(&wrong_body, "bridge_secret_mismatch"),
            "{method} {uri} did not distinguish a wrong secret; body was {wrong_body}"
        );

        // And each one is genuinely USABLE with the right secret, so the red
        // above is the gate refusing rather than the route being broken.
        let (ok_status, ok_body) = send(
            &bridge.app,
            request(method, uri)
                .header(header::AUTHORIZATION, format!("Bearer {}", bridge.secret))
                .body(tool_call_body())
                .unwrap(),
        )
        .await;
        assert_ne!(
            ok_status,
            StatusCode::UNAUTHORIZED,
            "{method} {uri} refuses even the correct secret; body was {ok_body}"
        );
    }
}

/// The CORS preflight must stay open. A browser sends `OPTIONS` WITHOUT the
/// Authorization header by design — gating it would make every credentialed
/// cross-origin call fail at the preflight, i.e. the guard would break the very
/// caller it is meant to admit.
#[tokio::test]
async fn cors_preflight_is_not_gated() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = bridge(root.path());

    for (_, uri) in GATED_ROUTES.iter().filter(|(_, uri)| *uri != "/actions") {
        let (status, body) = send(
            &bridge.app,
            request(&Method::OPTIONS, uri).body(Body::empty()).unwrap(),
        )
        .await;
        assert_ne!(
            status,
            StatusCode::UNAUTHORIZED,
            "OPTIONS {uri} must not be gated or every preflight fails; body was {body}"
        );
    }
}

// ---------------------------------------------------------------------------
// 5. /health and /runtimes stay open.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_and_runtimes_remain_open_without_a_credential() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let bridge = bridge(root.path());

    for uri in ["/health", "/runtimes"] {
        let (status, body) = send(
            &bridge.app,
            Request::builder().uri(uri).body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{uri} is a liveness surface and must stay open; body was {body}"
        );
        let payload: Value = serde_json::from_str(&body).unwrap();
        assert!(
            payload.is_object(),
            "{uri} must still answer with its real payload, got {body}"
        );
    }
}

// ---------------------------------------------------------------------------
// 6. The `mcp` command path does not mount these routes at all.
// ---------------------------------------------------------------------------

/// `mcp` passes `include_legacy_tool_http_routes = false`, so the gated set is
/// never mounted there and the guard changes nothing for it: the routes 404 as
/// they always did, and `/health` and `/runtimes` still answer.
///
/// A 404 and a 401 are deliberately distinguished here. If the guard had been
/// implemented as a global layer rather than one scoped to the mounted subtree,
/// this would flip to 401 and mislabel "not mounted" as "not authorized".
#[tokio::test]
async fn the_mcp_command_path_is_unaffected() {
    let root = tempfile::tempdir().unwrap();
    write_local_config(root.path());
    let app = actions_json_mcp::app_from_manifest_value_without_legacy_tool_http_routes(
        manifest(),
        Some(root.path().to_path_buf()),
    );

    for (method, uri) in GATED_ROUTES {
        let (status, body) = send(
            &app,
            request(method, uri).body(tool_call_body()).unwrap(),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{method} {uri} must be absent in mcp mode, not gated; got {status} / {body}"
        );
    }

    for uri in ["/health", "/runtimes"] {
        let (status, _) = send(
            &app,
            Request::builder().uri(uri).body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{uri} must still answer in mcp mode");
    }
}
