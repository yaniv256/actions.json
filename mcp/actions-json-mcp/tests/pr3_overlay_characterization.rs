use actions_json_mcp::{
    app_from_manifest_and_map_paths, app_from_manifest_map_paths_and_storage_root,
    app_from_manifest_value, app_from_manifest_value_with_runtimes, storage_bundle_from_root,
    RuntimeSeed,
};
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tower::ServiceExt;

fn fixture_path(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/actions-json-storage")
        .join(path)
}

fn policy_exception_report(tool: &str, reason: &str) -> Value {
    json!({
        "kind": if tool.starts_with("debug.") { "debugger" } else { "generic" },
        "intended_tool": tool,
        "actions_json_path": "none",
        "reason": reason
    })
}

async fn list_tool_names(app: axum::Router) -> Vec<String> {
    let response = app
        .oneshot(
            Request::builder()
                .uri("/mcp/tools/list")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(status, StatusCode::OK);
    let payload: Value = serde_json::from_slice(&body).unwrap();
    payload["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .map(str::to_string)
        .collect::<Vec<_>>()
}

async fn resolve_tool(app: axum::Router, request: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/resolve")
                .header("content-type", "application/json")
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    (status, payload)
}

async fn post_reload(app: axum::Router) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/reload")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    (status, payload)
}

async fn call_tool(app: axum::Router, request: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/call")
                .header("content-type", "application/json")
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    (status, payload)
}

async fn runtime_count(app: axum::Router) -> usize {
    let response = app
        .oneshot(
            Request::builder()
                .uri("/runtimes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(status, StatusCode::OK);
    let payload: Value = serde_json::from_slice(&body).unwrap();
    payload["runtimes"].as_array().unwrap().len()
}

#[tokio::test]
async fn bridge_http_routes_accept_browser_preflight_requests() {
    let app = app_from_manifest_value(json!({
        "tools": [
            {
                "name": "overlay.open",
                "description": "Open an overlay",
                "input_schema": { "type": "object" }
            }
        ]
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/mcp/tools/list")
                .header(header::ORIGIN, "chrome-extension://actions-json-test")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "*"
    );
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-private-network")
            .unwrap(),
        "true"
    );
}

#[tokio::test]
async fn websocket_disconnect_removes_all_runtimes_registered_on_the_connection() {
    let app = app_from_manifest_value(json!({
        "tools": [
            {
                "name": "overlay.open",
                "description": "Open an overlay",
                "input_schema": { "type": "object" }
            }
        ]
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();

    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "extension-runtime",
                "runtime_key": "chrome-tab:1",
                "url": "https://example.test/",
                "extension_version": "0.1.26"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "bookmarklet-runtime",
                "runtime_key": "bookmarklet:https://example.test",
                "url": "https://example.test/",
                "extension_version": "bookmarklet-0.1.30"
            })
            .to_string(),
        ))
        .await
        .unwrap();

    for _ in 0..20 {
        if runtime_count(app.clone()).await == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(runtime_count(app.clone()).await, 2);

    socket.close(None).await.unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    assert_eq!(runtime_count(app).await, 0);
    server.abort();
}

async fn list_site_action_names(app: axum::Router, target_url_contains: &str) -> Vec<String> {
    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "list",
                "target_url_contains": target_url_contains
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    payload["output"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|action| action["name"].as_str())
        .map(str::to_string)
        .collect()
}

#[tokio::test]
async fn pr3_lists_overlay_tools() {
    let app = app_from_manifest_value(json!({
        "tools": [
            {
                "name": "overlay.open",
                "description": "Open an overlay",
                "input_schema": { "type": "object" }
            },
            {
                "name": "overlay.close",
                "description": "Close an overlay",
                "input_schema": { "type": "object" }
            }
        ]
    }));

    let tool_names = list_tool_names(app).await;

    assert!(tool_names.iter().any(|name| name == "overlay.open"));
    assert!(tool_names.iter().any(|name| name == "overlay.close"));
}

#[tokio::test]
async fn pr3_ambiguous_url_routing_fails_without_dispatch() {
    let app = app_from_manifest_value_with_runtimes(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![
            RuntimeSeed {
                runtime_id: "runtime-a".to_string(),
                url: Some("https://linear.app/actionsjson/issue/ACT-1".to_string()),
            },
            RuntimeSeed {
                runtime_id: "runtime-b".to_string(),
                url: Some("https://linear.app/actionsjson/issue/ACT-2".to_string()),
            },
        ],
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/call")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "overlay.open",
                        "target_url_contains": "linear.app/actionsjson",
                        "arguments": { "html": "<p>should not dispatch</p>" },
                        "timeout_ms": 1
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    // U6: an intent phrase matching >1 live runtime is an honest, candidate-
    // naming ambiguity error (was: an opaque "matched multiple" string). Still
    // CONFLICT, still no dispatch — the improvement is the error envelope.
    assert_eq!(payload["error"]["code"].as_str(), Some("ambiguous_intent"));
    assert!(payload["error"]["next_step"].is_string());
    assert_eq!(
        payload["error"]["evidence"]["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn url_routing_failure_reports_candidate_rejection_trace() {
    let app = app_from_manifest_value_with_runtimes(
        json!({
            "tools": [
                {
                    "name": "browser.screenshot",
                    "description": "Capture screenshot",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![RuntimeSeed {
            runtime_id: "runtime-a".to_string(),
            url: Some("https://acme.example/#research".to_string()),
        }],
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/call")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "browser.screenshot",
                        "target_url_contains": "https://beta.example/",
                        "arguments": {
                            "policy_exception_report": policy_exception_report(
                                "browser.screenshot",
                                "Route rejection test needs to reach runtime selection for a direct screenshot primitive."
                            )
                        },
                        "timeout_ms": 1
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    // U6: an intent phrase matching no live runtime returns the honest
    // runtime_not_found code with a re-list next-step (was: an opaque string +
    // routing_trace). Still NOT_FOUND, still no dispatch. The evidence lists the
    // live runtimes so the agent can pick a real one.
    assert_eq!(payload["error"]["code"].as_str(), Some("runtime_not_found"));
    assert!(payload["error"]["next_step"].is_string());
    assert_eq!(payload["error"]["evidence"]["intent"].as_str(), Some("https://beta.example/"));
    let runtimes = payload["error"]["evidence"]["runtimes"].as_array().unwrap();
    assert_eq!(runtimes.len(), 1);
    assert_eq!(runtimes[0]["runtime_id"].as_str(), Some("runtime-a"));
}

#[tokio::test]
async fn amazon_storage_map_tools_are_added_to_catalog() {
    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                },
                {
                    "name": "overlay.close",
                    "description": "Close an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![fixture_path(
            "scopes/private/sites/amazon.com/prime-video/actions.json",
        )],
    )
    .await
    .unwrap();

    let tool_names = list_tool_names(app.clone()).await;

    assert!(tool_names.iter().any(|name| name == "overlay.open"));
    assert!(tool_names.iter().any(|name| name == "overlay.close"));
    assert!(tool_names.iter().any(|name| name == "actions.site"));
    assert!(!tool_names
        .iter()
        .any(|name| name == "prime_video.continue_watching.collect"));
    let site_actions = list_site_action_names(app, "amazon.com").await;
    assert!(site_actions
        .iter()
        .any(|name| name == "prime_video.continue_watching.collect"));
    assert!(site_actions
        .iter()
        .any(|name| name == "overlay.open_continue_watching"));
}

#[tokio::test]
async fn storage_map_tools_reload_without_restarting_bridge() {
    let map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "site.old_action",
                    "description": "Old action",
                    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "x_actions": {
                        "handler": "viewport.scroll",
                        "binding": { "arguments": { "delta_x": 0, "delta_y": 1 } }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "viewport.scroll",
                    "description": "Scroll",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![map.path().to_path_buf()],
    )
    .await
    .unwrap();

    let initial_tools = list_tool_names(app.clone()).await;
    assert!(!initial_tools.iter().any(|name| name == "site.old_action"));
    let initial_site_actions = list_site_action_names(app.clone(), "example.com").await;
    assert!(initial_site_actions
        .iter()
        .any(|name| name == "site.old_action"));
    assert!(!initial_site_actions
        .iter()
        .any(|name| name == "site.new_action"));

    std::fs::write(
        map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "site.new_action",
                    "description": "New action",
                    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "x_actions": {
                        "handler": "viewport.scroll",
                        "binding": { "arguments": { "delta_x": 0, "delta_y": 2 } }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let (status, payload) = post_reload(app.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);

    let reloaded_tools = list_tool_names(app.clone()).await;
    assert!(!reloaded_tools.iter().any(|name| name == "site.old_action"));
    assert!(!reloaded_tools.iter().any(|name| name == "site.new_action"));
    let reloaded_site_actions = list_site_action_names(app, "example.com").await;
    assert!(!reloaded_site_actions
        .iter()
        .any(|name| name == "site.old_action"));
    assert!(reloaded_site_actions
        .iter()
        .any(|name| name == "site.new_action"));
}

#[tokio::test]
async fn storage_sync_reloads_map_tools_before_dispatch() {
    let storage_root = tempfile::tempdir().unwrap();
    let map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "site.before_sync",
                    "description": "Before sync",
                    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "x_actions": {
                        "handler": "viewport.scroll",
                        "binding": { "arguments": { "delta_x": 0, "delta_y": 1 } }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "viewport.scroll",
                    "description": "Scroll",
                    "input_schema": { "type": "object" }
                },
                {
                    "name": "storage.import_bundle",
                    "description": "Import bundle",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![map.path().to_path_buf()],
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();

    assert!(!list_tool_names(app.clone())
        .await
        .iter()
        .any(|name| name == "site.before_sync"));
    assert!(list_site_action_names(app.clone(), "example.com")
        .await
        .iter()
        .any(|name| name == "site.before_sync"));

    std::fs::write(
        map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "site.after_sync",
                    "description": "After sync",
                    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "x_actions": {
                        "handler": "viewport.scroll",
                        "binding": { "arguments": { "delta_x": 0, "delta_y": 2 } }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let (status, payload) = call_tool(
        app.clone(),
        json!({
            "name": "storage.sync",
            "arguments": {}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(payload["error"], "no extension runtime connected");

    let reloaded_tools = list_tool_names(app.clone()).await;
    assert!(!reloaded_tools.iter().any(|name| name == "site.before_sync"));
    assert!(!reloaded_tools.iter().any(|name| name == "site.after_sync"));
    let reloaded_site_actions = list_site_action_names(app, "example.com").await;
    assert!(!reloaded_site_actions
        .iter()
        .any(|name| name == "site.before_sync"));
    assert!(reloaded_site_actions
        .iter()
        .any(|name| name == "site.after_sync"));
}

#[tokio::test]
async fn runtime_ready_proactively_imports_storage_bundle() {
    let storage_root = tempfile::tempdir().unwrap();
    let site_dir = storage_root
        .path()
        .join("scopes/private/sites/trello.com/board");
    std::fs::create_dir_all(&site_dir).unwrap();
    std::fs::write(
        site_dir.join("actions.json"),
        json!({
            "protocol": "actions.json",
            "tools": []
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(site_dir.join("SKILL.md"), "# Trello skill\n").unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "storage.import_bundle",
                    "description": "Import storage",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        Vec::new(),
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-trello",
                "runtime_key": "chrome-tab:1",
                "url": "https://trello.com/b/example/actionsjson",
                "extension_version": "0.1.97"
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let hydration_call = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let Some(message) = socket.next().await else {
                panic!("extension socket closed before hydration call");
            };
            let message = message.unwrap();
            if let Message::Text(text) = message {
                let payload: Value = serde_json::from_str(&text).unwrap();
                if payload["type"].as_str() == Some("action_call")
                    && payload["name"].as_str() == Some("storage.import_bundle")
                {
                    return payload;
                }
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(
        hydration_call["runtime_id"].as_str(),
        Some("runtime-trello")
    );
    assert_eq!(
        hydration_call["arguments"]["bundle"]["protocol"].as_str(),
        Some("actions.json.storage.bundle")
    );
    assert_eq!(
        hydration_call["arguments"]["bundle"]["x_actions_json_bridge_hydration"].as_bool(),
        Some(true)
    );
    assert!(hydration_call["arguments"]["bundle"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"].as_str()
            == Some("scopes/private/sites/trello.com/board/SKILL.md")));

    server.abort();
}

#[tokio::test]
async fn storage_root_discovers_site_maps_without_explicit_map_flags() {
    let storage_root = tempfile::tempdir().unwrap();
    let amazon_map = storage_root
        .path()
        .join("scopes/private/sites/amazon.com/prime-video/actions.json");
    let linear_map = storage_root
        .path()
        .join("scopes/private/sites/linear.app/workspace/actions.json");
    std::fs::create_dir_all(amazon_map.parent().unwrap()).unwrap();
    std::fs::create_dir_all(linear_map.parent().unwrap()).unwrap();
    std::fs::write(
        &amazon_map,
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "prime_video.continue_watching.read_visible",
                    "description": "Read Prime Video cards",
                    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "x_actions": {
                        "handler": "browser.extract_elements",
                        "binding": { "target_url_contains": "amazon.com", "arguments": { "item_selector": "a" } }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        &linear_map,
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "linear.visible_act_issues.read",
                    "description": "Read Linear issue links",
                    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
                    "x_actions": {
                        "handler": "browser.extract_elements",
                        "binding": { "target_url_contains": "linear.app", "arguments": { "item_selector": "a" } }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "browser.extract_elements",
                    "description": "Extract elements",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        Vec::new(),
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let tool_names = list_tool_names(app.clone()).await;

    assert!(tool_names.iter().any(|name| name == "actions.site"));
    assert!(!tool_names
        .iter()
        .any(|name| name == "prime_video.continue_watching.read_visible"));
    assert!(!tool_names
        .iter()
        .any(|name| name == "linear.visible_act_issues.read"));

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "list",
                "target_url_contains": "amazon.com"
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    let actions = payload["output"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|action| action["name"].as_str())
        .collect::<Vec<_>>();
    assert!(actions.contains(&"prime_video.continue_watching.read_visible"));
    assert!(!actions.contains(&"linear.visible_act_issues.read"));
}

#[tokio::test]
async fn actions_site_call_dispatches_site_action_handler_from_base_manifest() {
    let storage_root = tempfile::tempdir().unwrap();
    let amazon_map = storage_root
        .path()
        .join("scopes/private/sites/amazon.com/prime-video/actions.json");
    std::fs::create_dir_all(amazon_map.parent().unwrap()).unwrap();
    std::fs::write(
        &amazon_map,
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "prime_video.carousel_sections.list",
                    "description": "List Prime Video carousel sections",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "text_contains": { "type": "string" }
                        },
                        "additionalProperties": false
                    },
                    "x_actions": {
                        "handler": "dom.list_sections",
                        "binding": {
                            "target_url_contains": "amazon.com",
                            "arguments": { "text_contains": "Continue watching" }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "dom.list_sections",
                    "description": "List rendered sections",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "text_contains": { "type": "string" }
                        },
                        "additionalProperties": false
                    }
                }
            ]
        }),
        Vec::new(),
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-amazon",
                "runtime_key": "chrome-tab:1",
                "url": "https://www.amazon.com/gp/video/storefront",
                "extension_version": "0.1.29"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(runtime_count(app.clone()).await, 1);

    let call_app = app.clone();
    let call_task = tokio::spawn(async move {
        call_tool(
            call_app,
            json!({
                "name": "actions.site",
                "target_runtime_id": "runtime-amazon",
                "arguments": {
                    "mode": "call",
                    "action": "prime_video.carousel_sections.list",
                    "target_url_contains": "amazon.com",
                    "arguments": {}
                },
                "timeout_ms": 1000
            }),
        )
        .await
    });

    let item = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let item: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if item["type"].as_str() == Some("action_call")
                && item["name"].as_str() == Some("dom.list_sections")
            {
                break item;
            }
        }
    })
    .await
    .expect("runtime did not receive an action call");
    assert_eq!(item["type"].as_str(), Some("action_call"));
    assert_eq!(item["name"].as_str(), Some("dom.list_sections"));
    assert_eq!(
        item["arguments"]["text_contains"].as_str(),
        Some("Continue watching")
    );

    socket
        .send(Message::Text(
            json!({
                "type": "action_call_output",
                "call_id": item["call_id"].as_str().unwrap(),
                "runtime_id": "runtime-amazon",
                "output": { "ok": true, "sections": [] }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let (status, payload) = call_task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);

    server.abort();
}

#[tokio::test]
async fn actions_site_call_returns_static_storage_output_without_runtime() {
    let storage_root = tempfile::tempdir().unwrap();
    let site_map = storage_root
        .path()
        .join("scopes/private/sites/acme.example/home/actions.json");
    std::fs::create_dir_all(site_map.parent().unwrap()).unwrap();
    std::fs::write(
        &site_map,
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "acme.site.map",
                    "description": "Return the mapped Acme page and menu knowledge.",
                    "input_schema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    },
                    "x_actions": {
                        "static_output": {
                            "ok": true,
                            "pages": [
                                {
                                    "path": "/forge",
                                    "title": "The Forge Cycle"
                                }
                            ]
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({ "tools": [] }),
        Vec::new(),
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "target_url_contains": "acme.example",
            "arguments": {
                "mode": "call",
                "action": "acme.site.map",
                "arguments": {}
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["output"]["ok"], true);
    assert_eq!(payload["output"]["pages"][0]["path"], "/forge");
}

#[tokio::test]
async fn actions_site_list_includes_storage_files_and_skill_front_matter_from_storage_root() {
    let storage_root = tempfile::tempdir().unwrap();
    let site_dir = storage_root
        .path()
        .join("scopes/shared/youtube/sites/youtube.com/watch");
    std::fs::create_dir_all(&site_dir).unwrap();
    std::fs::write(
        site_dir.join("SKILL.md"),
        "---\nname: YouTube Tutorial Extraction\ndescription: Capture transcript-backed screenshots while handling ads.\n---\n# Skill\n",
    )
    .unwrap();
    std::fs::write(
        site_dir.join("actions.json"),
        json!({
            "protocol": "actions.json",
            "x_actions": {
                "files": [
                    {
                        "id": "youtube-tutorial-skill",
                        "path": "SKILL.md",
                        "kind": "skill",
                        "title": "YouTube tutorial extraction skill",
                        "description": "Read before extracting YouTube tutorial screenshots.",
                        "read_when": "Before extracting key moments, screenshots, or tutorials from a YouTube video."
                    }
                ]
            },
            "tools": [
                {
                    "name": "youtube.video.info",
                    "description": "Return video context.",
                    "input_schema": { "type": "object" },
                    "x_actions": { "static_output": { "ok": true } }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({ "tools": [] }),
        Vec::new(),
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "list",
                "target_url_contains": "youtube.com"
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    assert_eq!(
        payload["output"]["files"][0]["id"],
        "youtube-tutorial-skill"
    );
    assert_eq!(
        payload["output"]["files"][0]["path"],
        "scopes/shared/youtube/sites/youtube.com/watch/SKILL.md"
    );
    assert_eq!(
        payload["output"]["skills"][0]["front_matter"]["name"],
        "YouTube Tutorial Extraction"
    );
    assert_eq!(
        payload["output"]["skills"][0]["read_when"],
        "Before extracting key moments, screenshots, or tutorials from a YouTube video."
    );
}

#[tokio::test]
async fn storage_read_file_reads_declared_markdown_from_storage_root() {
    let storage_root = tempfile::tempdir().unwrap();
    let site_dir = storage_root
        .path()
        .join("scopes/private/trello/sites/trello.com/board");
    std::fs::create_dir_all(&site_dir).unwrap();
    std::fs::write(
        site_dir.join("SKILL.md"),
        "---\nname: Trello Board Operations\ndescription: Human-like board editing with cards, labels, dates, checklists, and movement.\n---\n# Trello Skill\nUse the UI like a human.\n",
    )
    .unwrap();
    std::fs::write(
        site_dir.join("actions.json"),
        json!({
            "protocol": "actions.json",
            "x_actions": {
                "files": [
                    {
                        "id": "trello-board-skill",
                        "path": "SKILL.md",
                        "kind": "skill",
                        "description": "Read before operating Trello boards."
                    }
                ]
            },
            "tools": []
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({ "tools": [] }),
        Vec::new(),
        Some(storage_root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "storage.read_file",
            "target_url_contains": "trello.com",
            "arguments": {
                "id": "trello-board-skill",
                "policy_exception_report": policy_exception_report(
                    "storage.read_file",
                    "Storage file read test is directly exercising the storage primitive after site file discovery."
                )
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["output"]["ok"], true);
    assert_eq!(payload["output"]["primitive"], "storage.read_file");
    assert_eq!(payload["output"]["adapter"], "bridge");
    assert_eq!(payload["output"]["value"]["id"], "trello-board-skill");
    assert_eq!(payload["output"]["value"]["mime_type"], "text/markdown");
    assert_eq!(
        payload["output"]["value"]["front_matter"]["name"],
        "Trello Board Operations"
    );
    assert!(payload["output"]["value"]["text"]
        .as_str()
        .unwrap()
        .contains("Use the UI like a human."));
}

#[tokio::test]
async fn linear_storage_map_tools_are_added_to_catalog() {
    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![fixture_path(
            "scopes/private/sites/linear.app/workspace/actions.json",
        )],
    )
    .await
    .unwrap();

    let tool_names = list_tool_names(app.clone()).await;

    assert!(tool_names.iter().any(|name| name == "overlay.open"));
    assert!(tool_names.iter().any(|name| name == "actions.site"));
    assert!(!tool_names
        .iter()
        .any(|name| name == "create_top_level_work_view"));
    let site_actions = list_site_action_names(app, "linear.app").await;
    assert!(site_actions
        .iter()
        .any(|name| name == "create_top_level_work_view"));
}

#[tokio::test]
async fn linear_step_action_returns_structured_unsupported_execution_mode() {
    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![fixture_path(
            "scopes/private/sites/linear.app/workspace/actions.json",
        )],
    )
    .await
    .unwrap();

    let (status, payload) = resolve_tool(
        app,
        json!({
            "name": "create_top_level_work_view",
            "arguments": {
                "view_name": "My top-level work"
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(
        payload["error"]["code"].as_str(),
        Some("unsupported_execution_mode")
    );
    assert_eq!(
        payload["error"]["evidence"]["tool"].as_str(),
        Some("create_top_level_work_view")
    );
    assert_eq!(
        payload["error"]["evidence"]["mode"].as_str(),
        Some("navigation")
    );
}

#[tokio::test]
async fn state_machine_tool_resolves_to_internal_element_extraction_action() {
    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                },
                {
                    "name": "browser.extract_elements",
                    "description": "Extract structured data from DOM elements using schema-declared selectors",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![fixture_path(
            "scopes/private/sites/amazon.com/prime-video/actions.json",
        )],
    )
    .await
    .unwrap();

    let (status, payload) = resolve_tool(
        app,
        json!({
            "name": "prime_video.continue_watching.collect",
            "target_url_contains": "amazon.com/gp/video",
            "arguments": {
                "scope": {
                    "selectors": ["h2"],
                    "text_equals": "Fantasy and Sci-Fi",
                    "root_strategy": "nearest_ancestor_containing_items",
                    "max_ancestor_depth": 6
                }
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["name"].as_str(), Some("browser.extract_elements"));
    assert_eq!(
        payload["target_url_contains"].as_str(),
        Some("amazon.com/gp/video")
    );
    assert_eq!(
        payload["arguments"]["scope"]["text_equals"].as_str(),
        Some("Fantasy and Sci-Fi")
    );
    assert_eq!(
        payload["arguments"]["scope"]["root_strategy"].as_str(),
        Some("nearest_ancestor_containing_items")
    );
    assert_eq!(
        payload["arguments"]["item_selector"].as_str(),
        Some("article:has(a[href*='/gp/video/detail/']), li:has(a[href*='/gp/video/detail/']), div:has(> a[href*='/gp/video/detail/']):has(img)")
    );
    assert_eq!(
        payload["arguments"]["fields"][0]["name"].as_str(),
        Some("title")
    );
    assert_eq!(
        payload["arguments"]["fields"][0]["selector"].as_str(),
        Some("a[href*='/gp/video/detail/'], img")
    );
    assert_eq!(
        payload["arguments"]["fields"][0]["attributes"][0].as_str(),
        Some("aria-label")
    );
}

#[tokio::test]
async fn invalid_storage_map_tools_are_not_exposed() {
    let invalid_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        invalid_map.path(),
        json!({
            "protocol": "not-actions-json",
            "tools": [
                {
                    "name": "invalid.exposed_tool",
                    "input_schema": { "type": "object" }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![invalid_map.path().to_path_buf()],
    )
    .await
    .unwrap();

    let tool_names = list_tool_names(app).await;

    assert!(tool_names.iter().any(|name| name == "overlay.open"));
    assert!(!tool_names.iter().any(|name| name == "invalid.exposed_tool"));
}

#[tokio::test]
async fn stored_overlay_binding_delegates_to_overlay_open_arguments() {
    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "overlay.open_continue_watching",
                    "description": "Open stored Continue Watching overlay",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.open",
                        "binding": {
                            "target_url_contains": "amazon.com/gp/video",
                            "arguments": {
                                "title": "Prime Video Continue Watching",
                                "launchers": [
                                    {
                                        "id": "prime-continue-watching",
                                        "selectors": ["h1", "h2", "h3", "[role=\"heading\"]"],
                                        "text_equals": "Continue watching",
                                        "url_contains": "amazon.com/gp/video",
                                        "placement": "afterend",
                                        "max_instances": 1
                                    }
                                ]
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_and_map_paths(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
    )
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/resolve")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "overlay.open_continue_watching",
                        "arguments": { "title": "Override title" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(status, StatusCode::OK);
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["name"].as_str(), Some("overlay.open"));
    assert_eq!(
        payload["target_url_contains"].as_str(),
        Some("amazon.com/gp/video")
    );
    assert_eq!(
        payload["arguments"]["title"].as_str(),
        Some("Override title")
    );
    assert_eq!(
        payload["arguments"]["launchers"][0]["text_equals"].as_str(),
        Some("Continue watching")
    );
    assert_eq!(
        payload["arguments"]["launchers"][0]["selectors"]
            .as_array()
            .unwrap(),
        &vec![
            json!("h1"),
            json!("h2"),
            json!("h3"),
            json!("[role=\"heading\"]")
        ]
    );
}

#[tokio::test]
async fn stored_overlay_binding_renders_storage_overlay_and_items() {
    let root = tempfile::tempdir().unwrap();
    let scoped_root = root.path().join("scopes/private");
    std::fs::create_dir_all(scoped_root.join("sites/example.com/show/overlays")).unwrap();
    std::fs::create_dir_all(scoped_root.join("sites/example.com/show/items")).unwrap();
    std::fs::write(
        scoped_root.join("sites/example.com/show/overlays/continue.overlay.json"),
        json!({
            "type": "overlay",
            "title": "Continue Watching",
            "source_items": "sites/example.com/show/items/continue.items.json",
            "rendering": { "width": 900, "height": 640 },
            "categories": ["Nature", "Drama"]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        scoped_root.join("sites/example.com/show/items/continue.items.json"),
        json!({
            "type": "item_index",
            "items": {
                "item-1": {
                    "title": "Planet Earth",
                    "url": "https://example.com/planet",
                    "category": "Nature",
                    "latest_cover_url": "https://img.example.com/planet.jpg"
                },
                "item-2": {
                    "title": "Westworld",
                    "url": "https://example.com/westworld",
                    "category": "Drama",
                    "latest_cover_url": "https://img.example.com/westworld.jpg"
                },
                "item-3": {
                    "title": "Missing Cover",
                    "url": "https://example.com/missing-cover",
                    "category": "Drama",
                    "latest_cover_url": ""
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "overlay.open_continue_watching",
                    "description": "Open stored Continue Watching overlay",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.open",
                        "binding": {
                            "target_url_contains": "example.com/watch",
                            "arguments": {
                                "overlay_source": "sites/example.com/show/overlays/continue.overlay.json",
                                "items_source": "sites/example.com/show/items/continue.items.json",
                                "launchers": [
                                    {
                                        "id": "continue-watching",
                                        "selectors": ["h2"],
                                        "text_equals": "Continue watching"
                                    }
                                ]
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
        Some(root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/resolve")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "overlay.open_continue_watching",
                        "arguments": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["name"].as_str(), Some("overlay.open"));
    assert_eq!(
        payload["arguments"]["title"].as_str(),
        Some("Continue Watching")
    );
    assert_eq!(payload["arguments"]["width"].as_u64(), Some(900));
    assert_eq!(payload["arguments"]["height"].as_u64(), Some(640));
    assert_eq!(
        payload["arguments"]["launchers"][0]["text_equals"].as_str(),
        Some("Continue watching")
    );
    assert!(payload["arguments"].get("overlay_source").is_none());
    assert!(payload["arguments"].get("items_source").is_none());

    let html = payload["arguments"]["html"].as_str().unwrap();
    assert!(html.contains("Nature"));
    assert!(html.contains("Drama"));
    assert!(html.contains("Planet Earth"));
    assert!(html.contains("Westworld"));
    assert!(html.contains("Missing Cover"));
    assert!(html.contains("https://img.example.com/planet.jpg"));
    assert!(html.contains("https://example.com/westworld"));
    assert!(html.contains("<main class=\"aj-shell\""));
    assert!(html.contains("<div class=\"aj-sections\">"));
    assert!(html.contains(".aj-shell {"));
    assert!(html.contains(".aj-sections {"));
    assert!(html.contains("grid-template-columns: repeat(2, minmax(0, 1fr));"));
    assert!(html.contains("@media (max-width: 640px)"));
    assert!(html.contains("overflow-y: auto;"));
    assert!(html.contains("data-count=\"1\""));
    assert!(html.contains("data-count=\"2\""));
    assert!(html.contains(".aj-title {"));
    assert!(html.contains("flex-wrap: wrap;"));
    assert!(html.contains("width: min(210px, 100%);"));
    assert!(html.contains("color: #f7f9ff;"));
    assert!(html.contains("aria-label=\"No cover available for Missing Cover\""));
    assert!(html.contains("No cover"));
    assert!(!html.contains("<h1>Continue Watching</h1>"));
}

#[tokio::test]
async fn stored_overlay_binding_renders_html_source_with_css_sources() {
    let root = tempfile::tempdir().unwrap();
    let scoped_root = root.path().join("scopes/private");
    std::fs::create_dir_all(scoped_root.join("sites/example.com/report/overlays")).unwrap();
    std::fs::create_dir_all(scoped_root.join("shared/styles")).unwrap();
    std::fs::write(
        scoped_root.join("sites/example.com/report/overlays/weekly.overlay.json"),
        json!({
            "type": "overlay",
            "title": "Weekly Report",
            "html_source": "sites/example.com/report/overlays/weekly.html",
            "css_sources": ["shared/styles/report.css"],
            "rendering": { "width": 720, "height": 560 }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        scoped_root.join("sites/example.com/report/overlays/weekly.html"),
        r#"<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body><main class="report-card">Weekly attribution</main></body>
</html>"#,
    )
    .unwrap();
    std::fs::write(
        scoped_root.join("shared/styles/report.css"),
        ".report-card { color: #123456; }",
    )
    .unwrap();

    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "overlay.open_weekly_report",
                    "description": "Open stored HTML report",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.open",
                        "binding": {
                            "target_url_contains": "example.com/report",
                            "arguments": {
                                "overlay_source": "sites/example.com/report/overlays/weekly.overlay.json"
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
        Some(root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/resolve")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "overlay.open_weekly_report",
                        "arguments": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["name"].as_str(), Some("overlay.open"));
    assert_eq!(
        payload["arguments"]["title"].as_str(),
        Some("Weekly Report")
    );
    assert_eq!(payload["arguments"]["width"].as_u64(), Some(720));
    assert_eq!(payload["arguments"]["height"].as_u64(), Some(560));
    assert!(payload["arguments"].get("overlay_source").is_none());

    let html = payload["arguments"]["html"].as_str().unwrap();
    assert!(html.contains("Weekly attribution"));
    assert!(html.contains("<style data-actions-json-source=\"shared/styles/report.css\">"));
    assert!(html.contains(".report-card { color: #123456; }"));
}

#[tokio::test]
async fn stored_overlay_binding_renders_legacy_source_html_relative_to_overlay_file() {
    let root = tempfile::tempdir().unwrap();
    let scoped_root = root.path().join("scopes/private");
    std::fs::create_dir_all(scoped_root.join("sites/linear.app/workspace/overlays")).unwrap();
    std::fs::write(
        scoped_root.join("sites/linear.app/workspace/overlays/act10.overlay.json"),
        json!({
            "type": "overlay",
            "title": "ACT-10 prototype execution path",
            "source": {
                "issue": "ACT-10",
                "html": "act10.html"
            },
            "overlay_open": {
                "name": "overlay.open",
                "arguments": {
                    "title": "ACT-10 execution",
                    "width": 1040,
                    "height": 780
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        scoped_root.join("sites/linear.app/workspace/overlays/act10.html"),
        r#"<!doctype html>
<html>
<head><meta charset="utf-8"><style>.execution { color: #234567; }</style></head>
<body><main class="execution">Linear execution path</main></body>
</html>"#,
    )
    .unwrap();

    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "linear.overlay.open_act10_execution_path",
                    "description": "Open stored Linear overlay",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.open",
                        "binding": {
                            "target_url_contains": "linear.app/actionsjson/issue/ACT-10",
                            "arguments": {
                                "overlay_source": "sites/linear.app/workspace/overlays/act10.overlay.json"
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
        Some(root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/resolve")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "linear.overlay.open_act10_execution_path",
                        "arguments": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["name"].as_str(), Some("overlay.open"));
    assert_eq!(
        payload["arguments"]["title"].as_str(),
        Some("ACT-10 execution")
    );
    assert_eq!(payload["arguments"]["width"].as_u64(), Some(1040));
    assert_eq!(payload["arguments"]["height"].as_u64(), Some(780));
    assert!(payload["arguments"].get("overlay_source").is_none());

    let html = payload["arguments"]["html"].as_str().unwrap();
    assert!(html.contains("Linear execution path"));
    assert!(html.contains(".execution { color: #234567; }"));
}

#[tokio::test]
async fn stored_overlay_register_launcher_binding_renders_overlay_without_opening() {
    let root = tempfile::tempdir().unwrap();
    let scoped_root = root.path().join("sites/example.com/show");
    std::fs::create_dir_all(scoped_root.join("overlays")).unwrap();
    std::fs::create_dir_all(scoped_root.join("items")).unwrap();
    std::fs::write(
        scoped_root.join("overlays/continue.overlay.json"),
        json!({
            "type": "overlay",
            "title": "Continue Watching",
            "source_items": "sites/example.com/show/items/continue.items.json",
            "rendering": { "width": 900, "height": 640 },
            "categories": ["Drama"]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        scoped_root.join("items/continue.items.json"),
        json!({
            "type": "item_index",
            "items": {
                "item-1": {
                    "title": "Westworld",
                    "url": "https://example.com/westworld",
                    "category": "Drama",
                    "latest_cover_url": "https://img.example.com/westworld.jpg"
                }
            }
        })
        .to_string(),
    )
    .unwrap();

    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "overlay.install_continue_watching_launcher",
                    "description": "Install stored Continue Watching launcher",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.register_launcher",
                        "binding": {
                            "target_url_contains": "example.com/watch",
                            "arguments": {
                                "overlay_source": "sites/example.com/show/overlays/continue.overlay.json",
                                "items_source": "sites/example.com/show/items/continue.items.json",
                                "launchers": [
                                    {
                                        "id": "continue-watching",
                                        "label": "Categories",
                                        "selectors": ["h2"],
                                        "text_equals": "Continue watching"
                                    }
                                ]
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.register_launcher",
                    "description": "Register a launcher",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
        Some(root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/resolve")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "overlay.install_continue_watching_launcher",
                        "arguments": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(status, StatusCode::OK);
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["name"].as_str(), Some("overlay.register_launcher"));
    assert_eq!(
        payload["arguments"]["title"].as_str(),
        Some("Continue Watching")
    );
    assert_eq!(
        payload["arguments"]["launchers"][0]["label"].as_str(),
        Some("Categories")
    );
    assert!(payload["arguments"].get("overlay_source").is_none());
    assert!(payload["arguments"].get("items_source").is_none());
    let html = payload["arguments"]["html"].as_str().unwrap();
    assert!(html.contains("Westworld"));
    assert!(html.contains("https://img.example.com/westworld.jpg"));
}

#[tokio::test]
async fn stored_overlay_missing_items_source_returns_structured_invalid_input() {
    let root = tempfile::tempdir().unwrap();
    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "overlay.open_continue_watching",
                    "description": "Open stored Continue Watching overlay",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.open",
                        "binding": {
                            "arguments": {
                                "items_source": "sites/example.com/show/items/missing.items.json"
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
        Some(root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let (status, payload) = resolve_tool(
        app,
        json!({
            "name": "overlay.open_continue_watching",
            "arguments": {}
        }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(payload["error"]["code"].as_str(), Some("invalid_input"));
    assert_eq!(
        payload["error"]["evidence"]["path"].as_str(),
        Some("sites/example.com/show/items/missing.items.json")
    );
}

#[tokio::test]
async fn stored_overlay_path_escape_returns_structured_permission_denied() {
    let root = tempfile::tempdir().unwrap();
    let escaped = root.path().join("secret.items.json");
    std::fs::write(
        &escaped,
        json!({ "type": "item_index", "items": {} }).to_string(),
    )
    .unwrap();

    let stored_map = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        stored_map.path(),
        json!({
            "protocol": "actions.json",
            "tools": [
                {
                    "name": "overlay.open_continue_watching",
                    "description": "Open stored Continue Watching overlay",
                    "input_schema": { "type": "object" },
                    "x_actions": {
                        "handler": "overlay.open",
                        "binding": {
                            "arguments": {
                                "items_source": "../secret.items.json"
                            }
                        }
                    }
                }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![stored_map.path().to_path_buf()],
        Some(root.path().join("scopes/private")),
    )
    .await
    .unwrap();

    let (status, payload) = resolve_tool(
        app,
        json!({
            "name": "overlay.open_continue_watching",
            "arguments": {}
        }),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(payload["error"]["code"].as_str(), Some("permission_denied"));
    assert_eq!(
        payload["error"]["evidence"]["path"].as_str(),
        Some("../secret.items.json")
    );
}

#[tokio::test]
async fn storage_bundle_reads_text_files_from_storage_root() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("scopes/private/sites/example.com")).unwrap();
    std::fs::create_dir_all(root.path().join(".git/objects")).unwrap();
    std::fs::write(
        root.path()
            .join("scopes/private/sites/example.com/actions.json"),
        json!({ "protocol": "actions.json", "tools": [] }).to_string(),
    )
    .unwrap();
    std::fs::write(root.path().join("README.md"), "# storage\n").unwrap();
    std::fs::write(root.path().join(".git/config"), "ignored").unwrap();

    let bundle = storage_bundle_from_root(root.path().to_path_buf())
        .await
        .unwrap();
    let paths = bundle["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|entry| entry["path"].as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        paths,
        vec!["README.md", "scopes/private/sites/example.com/actions.json"]
    );
    assert_eq!(
        bundle["protocol"].as_str(),
        Some("actions.json.storage.bundle")
    );
    assert_eq!(
        bundle["entries"][1]["content_type"].as_str(),
        Some("application/json")
    );
}

#[tokio::test]
async fn storage_sync_tool_is_exposed_when_storage_root_is_configured() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("README.md"), "# storage\n").unwrap();

    let app = app_from_manifest_map_paths_and_storage_root(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                },
                {
                    "name": "storage.import_bundle",
                    "description": "Import storage",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![],
        Some(root.path().to_path_buf()),
    )
    .await
    .unwrap();

    let tool_names = list_tool_names(app).await;

    assert!(tool_names.iter().any(|name| name == "storage.sync"));
    assert!(tool_names
        .iter()
        .any(|name| name == "storage.import_bundle"));
}

#[tokio::test]
async fn runtime_session_log_tool_is_exposed_by_the_bridge_catalog() {
    let app = app_from_manifest_value(json!({
        "tools": [
            {
                "name": "overlay.open",
                "description": "Open an overlay",
                "input_schema": { "type": "object" }
            }
        ]
    }));

    let tool_names = list_tool_names(app).await;

    assert!(tool_names.iter().any(|name| name == "runtime.session.log"));
}

#[tokio::test]
async fn unknown_tool_call_returns_structured_unknown_action() {
    let app = app_from_manifest_value_with_runtimes(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": { "type": "object" }
                }
            ]
        }),
        vec![RuntimeSeed {
            runtime_id: "runtime-a".to_string(),
            url: Some("https://example.com".to_string()),
        }],
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/call")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "missing.tool",
                        "arguments": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["error"]["code"].as_str(), Some("unknown_action"));
    assert_eq!(
        payload["error"]["evidence"]["tool"].as_str(),
        Some("missing.tool")
    );
}

#[tokio::test]
async fn invalid_tool_arguments_return_structured_invalid_input() {
    let app = app_from_manifest_value_with_runtimes(
        json!({
            "tools": [
                {
                    "name": "overlay.open",
                    "description": "Open an overlay",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "html": { "type": "string" }
                        },
                        "required": ["html"],
                        "additionalProperties": false
                    }
                }
            ]
        }),
        vec![RuntimeSeed {
            runtime_id: "runtime-a".to_string(),
            url: Some("https://example.com".to_string()),
        }],
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/call")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "overlay.open",
                        "arguments": {
                            "html": 17
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(payload["error"]["code"].as_str(), Some("invalid_input"));
    assert_eq!(
        payload["error"]["evidence"]["tool"].as_str(),
        Some("overlay.open")
    );
}

#[tokio::test]
async fn browser_screenshot_dispatches_to_runtime_without_open_browser_use_intercept() {
    let app = app_from_manifest_value_with_runtimes(
        json!({
            "tools": [
                {
                    "name": "browser.screenshot",
                    "description": "Capture screenshot",
                    "input_schema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    }
                }
            ]
        }),
        vec![RuntimeSeed {
            runtime_id: "runtime-a".to_string(),
            url: Some("https://example.com".to_string()),
        }],
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp/tools/call")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "browser.screenshot",
                        "arguments": {
                            "policy_exception_report": policy_exception_report(
                                "browser.screenshot",
                                "Dispatch failure test needs to reach runtime send for a direct screenshot primitive."
                            )
                        },
                        "target_runtime_id": "runtime-a",
                        "timeout_ms": 1
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        payload["error"].as_str(),
        Some("failed to send action to extension runtime")
    );
    assert_eq!(payload["runtime_id"].as_str(), Some("runtime-a"));
}

fn trello_state_projection_map() -> Value {
    json!({
        "protocol": "actions.json",
        "tools": [],
        "state_projections": [
            {
                "name": "trello.board",
                "description": "Logical Trello board state: lists, cards, labels.",
                "snapshot": {
                    "version": 1,
                    "source": "dom",
                    "extract": [],
                    "projection": { "language": "jsonata", "expression": "{% records %}" }
                },
                "summaries": [
                    {
                        "name": "agent_context",
                        "description": "Compact board summary.",
                        "max_bytes": 12000
                    }
                ]
            }
        ]
    })
}

fn write_storage_map(root: &std::path::Path, relative: &str, map: &Value) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, map.to_string()).unwrap();
}

async fn state_projection_app(storage_root: &std::path::Path) -> axum::Router {
    app_from_manifest_map_paths_and_storage_root(
        json!({ "tools": [] }),
        Vec::new(),
        Some(storage_root.to_path_buf()),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn actions_site_list_includes_state_projections() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_state_projection_map(),
    );
    let app = state_projection_app(storage_root.path()).await;

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": { "mode": "list", "target_url_contains": "trello.com" }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let projections = payload["output"]["state_projections"].as_array().unwrap();
    assert_eq!(projections.len(), 1);
    assert_eq!(projections[0]["name"].as_str(), Some("trello.board"));
    assert_eq!(
        projections[0]["summaries"][0]["name"].as_str(),
        Some("agent_context")
    );
    assert_eq!(
        projections[0]["map_path"].as_str(),
        Some("scopes/private/sites/trello.com/board/actions.json")
    );
    assert!(projections[0].get("snapshot").is_none());
}

#[tokio::test]
async fn actions_site_state_read_unknown_projection_fails_without_dispatch() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_state_projection_map(),
    );
    let app = state_projection_app(storage_root.path()).await;

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "state_read",
                "projection_name": "linear.workspace",
                "target_url_contains": "trello.com"
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        payload["error"]["code"].as_str(),
        Some("state_projection_not_found")
    );
    assert_eq!(
        payload["error"]["evidence"]["known_projections"][0].as_str(),
        Some("trello.board")
    );
}

#[tokio::test]
async fn actions_site_state_read_rejects_ambiguous_projection_names() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_state_projection_map(),
    );
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/workspace/actions.json",
        &trello_state_projection_map(),
    );
    let app = state_projection_app(storage_root.path()).await;

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "state_read",
                "projection_name": "trello.board",
                "target_url_contains": "trello.com"
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        payload["error"]["code"].as_str(),
        Some("state_projection_ambiguous")
    );
    assert_eq!(
        payload["error"]["evidence"]["map_paths"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn actions_site_state_read_round_trips_through_runtime() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_state_projection_map(),
    );
    let app = state_projection_app(storage_root.path()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-trello",
                "runtime_key": "chrome-tab:7",
                "url": "https://trello.com/b/example/board",
                "extension_version": "0.1.105"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(runtime_count(app.clone()).await, 1);

    let call_app = app.clone();
    let call_task = tokio::spawn(async move {
        call_tool(
            call_app,
            json!({
                "name": "actions.site",
                "target_runtime_id": "runtime-trello",
                "arguments": {
                    "mode": "state_read",
                    "projection_name": "trello.board",
                    "target_url_contains": "trello.com"
                },
                "timeout_ms": 1000
            }),
        )
        .await
    });

    let item = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let item: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if item["type"].as_str() == Some("state_projection_call") {
                break item;
            }
        }
    })
    .await
    .expect("runtime did not receive a state projection call");
    assert_eq!(item["mode"].as_str(), Some("state_read"));
    assert_eq!(item["projection_name"].as_str(), Some("trello.board"));
    assert_eq!(
        item["map_path"].as_str(),
        Some("scopes/private/sites/trello.com/board/actions.json")
    );
    assert_eq!(item["projection"]["name"].as_str(), Some("trello.board"));
    assert_eq!(
        item["projection"]["snapshot"]["version"].as_u64(),
        Some(1)
    );

    socket
        .send(Message::Text(
            json!({
                "type": "action_call_output",
                "call_id": item["call_id"].as_str().unwrap(),
                "runtime_id": "runtime-trello",
                "output": {
                    "ok": true,
                    "projection": "trello.board",
                    "state": { "board": { "lists": [] } },
                    "state_hash": "sha256:test",
                    "diagnostics": { "schema_valid": true }
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let (status, payload) = call_task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    assert_eq!(
        payload["output"]["state"]["board"]["lists"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(payload["output"]["state_hash"].as_str(), Some("sha256:test"));

    server.abort();
}

#[tokio::test]
async fn actions_site_state_read_passes_runtime_errors_through() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_state_projection_map(),
    );
    let app = state_projection_app(storage_root.path()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-trello",
                "runtime_key": "chrome-tab:7",
                "url": "https://trello.com/b/example/board",
                "extension_version": "0.1.105"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let call_app = app.clone();
    let call_task = tokio::spawn(async move {
        call_tool(
            call_app,
            json!({
                "name": "actions.site",
                "target_runtime_id": "runtime-trello",
                "arguments": {
                    "mode": "state_read",
                    "projection_name": "trello.board",
                    "target_url_contains": "trello.com"
                },
                "timeout_ms": 1000
            }),
        )
        .await
    });

    let item = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let item: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if item["type"].as_str() == Some("state_projection_call") {
                break item;
            }
        }
    })
    .await
    .expect("runtime did not receive a state projection call");

    socket
        .send(Message::Text(
            json!({
                "type": "action_error",
                "call_id": item["call_id"].as_str().unwrap(),
                "runtime_id": "runtime-trello",
                "error": {
                    "code": "state_payload_too_large",
                    "message": "Full state exceeded the configured budget.",
                    "recoverable": true,
                    "available_summaries": ["agent_context"]
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let (status, payload) = call_task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], false);
    assert_eq!(
        payload["error"]["code"].as_str(),
        Some("state_payload_too_large")
    );
    assert_eq!(
        payload["error"]["available_summaries"][0].as_str(),
        Some("agent_context")
    );

    server.abort();
}

fn trello_workflow_map() -> Value {
    json!({
        "protocol": "actions.json",
        "tools": [{
            "name": "trello.board.add_card.open_composer",
            "description": "Open the add-card composer for a named list.",
            "input_schema": {
                "type": "object",
                "required": ["list_name"],
                "properties": { "list_name": { "type": "string" } },
                "additionalProperties": false
            },
            "workflow": {
                "version": 1,
                "expression_language": "jsonata",
                "steps": []
            }
        }]
    })
}

#[tokio::test]
async fn actions_site_workflow_call_round_trips_through_runtime() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_workflow_map(),
    );
    let app = state_projection_app(storage_root.path()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-trello",
                "runtime_key": "chrome-tab:7",
                "url": "https://trello.com/b/example/board",
                "extension_version": "0.1.107"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(runtime_count(app.clone()).await, 1);

    let call_app = app.clone();
    let call_task = tokio::spawn(async move {
        call_tool(
            call_app,
            json!({
                "name": "actions.site",
                "target_runtime_id": "runtime-trello",
                "arguments": {
                    "mode": "call",
                    "action": "trello.board.add_card.open_composer",
                    "arguments": { "list_name": "Backlog" },
                    "target_url_contains": "trello.com"
                },
                "timeout_ms": 1000
            }),
        )
        .await
    });

    let item = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let item: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if item["type"].as_str() == Some("site_action_call") {
                break item;
            }
        }
    })
    .await
    .expect("runtime did not receive a site action call");
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

    socket
        .send(Message::Text(
            json!({
                "type": "action_call_output",
                "call_id": item["call_id"].as_str().unwrap(),
                "runtime_id": "runtime-trello",
                "output": {
                    "ok": true,
                    "opened": "Backlog",
                    "steps": []
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let (status, payload) = call_task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["output"]["opened"].as_str(), Some("Backlog"));

    server.abort();
}

#[tokio::test]
async fn actions_site_workflow_call_rejects_ambiguous_maps() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_workflow_map(),
    );
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/calendar/actions.json",
        &trello_workflow_map(),
    );
    let app = state_projection_app(storage_root.path()).await;

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "call",
                "action": "trello.board.add_card.open_composer",
                "arguments": { "list_name": "Backlog" },
                "target_url_contains": "trello.com"
            }
        }),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        payload["error"]["code"].as_str(),
        Some("site_action_ambiguous")
    );
    let map_paths = payload["error"]["evidence"]["map_paths"].as_array().unwrap();
    assert_eq!(map_paths.len(), 2);
}

#[tokio::test]
async fn actions_site_workflow_call_private_overrides_public() {
    // Same action declared in both a private and a public map must resolve to the
    // private one (private > shared > public), not error site_action_ambiguous.
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_workflow_map(),
    );
    write_storage_map(
        storage_root.path(),
        "scopes/public/sites/trello.com/board/actions.json",
        &trello_workflow_map(),
    );
    let app = state_projection_app(storage_root.path()).await;

    let (status, payload) = call_tool(
        app,
        json!({
            "name": "actions.site",
            "arguments": {
                "mode": "call",
                "action": "trello.board.add_card.open_composer",
                "arguments": { "list_name": "Backlog" },
                "target_url_contains": "trello.com"
            }
        }),
    )
    .await;

    // Not ambiguous: precedence collapsed to the private map, so resolution gets
    // past the ambiguity check. Any remaining error is a downstream dispatch
    // error (no runtime connected in this unit harness), NOT site_action_ambiguous.
    assert_ne!(
        payload["error"]["code"].as_str(),
        Some("site_action_ambiguous"),
        "private+public duplication must resolve to private, not error ambiguous; got status {status} payload {payload}"
    );
}

#[tokio::test]
async fn actions_site_workflow_call_without_storage_map_falls_back_to_action_call() {
    let map_dir = tempfile::tempdir().unwrap();
    let map_path = map_dir.path().join("trello-board.actions.json");
    std::fs::write(&map_path, trello_workflow_map().to_string()).unwrap();
    let app = app_from_manifest_and_map_paths(json!({ "tools": [] }), vec![map_path])
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-trello",
                "runtime_key": "chrome-tab:7",
                "url": "https://trello.com/b/example/board",
                "extension_version": "0.1.107"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let call_app = app.clone();
    let call_task = tokio::spawn(async move {
        call_tool(
            call_app,
            json!({
                "name": "actions.site",
                "target_runtime_id": "runtime-trello",
                "arguments": {
                    "mode": "call",
                    "action": "trello.board.add_card.open_composer",
                    "arguments": { "list_name": "Backlog" }
                },
                "timeout_ms": 1000
            }),
        )
        .await
    });

    let item = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let item: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if item["type"].as_str() == Some("action_call") {
                break item;
            }
        }
    })
    .await
    .expect("runtime did not receive the legacy action call fallback");
    assert_eq!(
        item["name"].as_str(),
        Some("trello.board.add_card.open_composer")
    );

    socket
        .send(Message::Text(
            json!({
                "type": "action_call_output",
                "call_id": item["call_id"].as_str().unwrap(),
                "runtime_id": "runtime-trello",
                "output": { "ok": true }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let (status, payload) = call_task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], true);

    server.abort();
}

#[tokio::test]
async fn actions_site_workflow_call_passes_runtime_errors_through() {
    let storage_root = tempfile::tempdir().unwrap();
    write_storage_map(
        storage_root.path(),
        "scopes/private/sites/trello.com/board/actions.json",
        &trello_workflow_map(),
    );
    let app = state_projection_app(storage_root.path()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    let (mut socket, _) = connect_async(format!("ws://{address}/extension"))
        .await
        .unwrap();
    socket
        .send(Message::Text(
            json!({
                "type": "runtime_ready",
                "runtime_id": "runtime-trello",
                "runtime_key": "chrome-tab:7",
                "url": "https://trello.com/b/example/board",
                "extension_version": "0.1.107"
            })
            .to_string(),
        ))
        .await
        .unwrap();
    for _ in 0..20 {
        if runtime_count(app.clone()).await == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let call_app = app.clone();
    let call_task = tokio::spawn(async move {
        call_tool(
            call_app,
            json!({
                "name": "actions.site",
                "target_runtime_id": "runtime-trello",
                "arguments": {
                    "mode": "call",
                    "action": "trello.board.add_card.open_composer",
                    "arguments": { "list_name": "Backlog" },
                    "target_url_contains": "trello.com"
                },
                "timeout_ms": 1000
            }),
        )
        .await
    });

    let item = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            let item: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
            if item["type"].as_str() == Some("site_action_call") {
                break item;
            }
        }
    })
    .await
    .expect("runtime did not receive a site action call");

    socket
        .send(Message::Text(
            json!({
                "type": "action_error",
                "call_id": item["call_id"].as_str().unwrap(),
                "runtime_id": "runtime-trello",
                "error": {
                    "code": "workflow_step_failed",
                    "message": "Step findList failed: list not visible.",
                    "recoverable": true
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let (status, payload) = call_task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload["ok"], false);
    assert_eq!(
        payload["error"]["code"].as_str(),
        Some("workflow_step_failed")
    );

    server.abort();
}
