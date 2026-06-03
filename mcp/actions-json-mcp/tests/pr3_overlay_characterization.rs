use actions_json_mcp::{
    app_from_manifest_and_map_paths, app_from_manifest_map_paths_and_storage_root,
    app_from_manifest_value, app_from_manifest_value_with_runtimes, storage_bundle_from_root,
    RuntimeSeed,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::path::PathBuf;
use tower::ServiceExt;

fn fixture_path(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/actions-json-storage")
        .join(path)
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

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
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
                url: Some("https://tracker.example.test/issue/DEMO-1".to_string()),
            },
            RuntimeSeed {
                runtime_id: "runtime-b".to_string(),
                url: Some("https://tracker.example.test/issue/DEMO-2".to_string()),
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
                        "target_url_contains": "tracker.example.test/issue",
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

    assert_eq!(
        payload["error"].as_str(),
        Some("target_url_contains matched multiple runtimes")
    );
    assert_eq!(payload["matches"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn example_video_storage_map_tools_are_added_to_catalog() {
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

    let tool_names = list_tool_names(app).await;

    assert!(tool_names.iter().any(|name| name == "overlay.open"));
    assert!(tool_names.iter().any(|name| name == "overlay.close"));
    assert!(tool_names
        .iter()
        .any(|name| name == "example_video.continue_watching.collect"));
    assert!(tool_names
        .iter()
        .any(|name| name == "overlay.open_continue_watching"));
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

    let tool_names = list_tool_names(app).await;

    assert!(tool_names.iter().any(|name| name == "overlay.open"));
    assert!(tool_names
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
                                "title": "Example Video Continue Watching",
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

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
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
                    "title": "Example Nature Series",
                    "url": "https://example.com/planet",
                    "category": "Nature",
                    "latest_cover_url": "https://img.example.com/planet.jpg"
                },
                "item-2": {
                    "title": "Example Character Drama",
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
    assert!(html.contains("Example Nature Series"));
    assert!(html.contains("Example Character Drama"));
    assert!(html.contains("https://img.example.com/planet.jpg"));
    assert!(html.contains("https://example.com/westworld"));
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
