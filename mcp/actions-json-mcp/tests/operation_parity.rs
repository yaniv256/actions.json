use actions_json_mcp::{
    mcp_adapter::McpToolCall,
    operation::{
        classify_legacy_result, CanonicalOutcome, OperationRegistry, OperationRequest, ResolveError,
    },
};
use serde_json::json;

fn manifest() -> serde_json::Value {
    json!({"tools": [
        {"name":"primitive.echo","description":"Echo","input_schema":{"type":"object"}},
        {"name":"workflow.echo","description":"Workflow","input_schema":{"type":"object"},
         "x_actions":{"handler":"primitive.echo","binding":{"arguments":{"fixed":true}}}},
        {"name":"bridge.info","description":"Info","input_schema":{"type":"object"},
         "x_actions":{"static_output":{"version":1}}}
    ]})
}

#[test]
fn mcp_and_core_inputs_resolve_to_the_same_operation() {
    let registry = OperationRegistry::from_manifest(&manifest()).unwrap();
    let mcp = McpToolCall::from_params(json!({
        "name":"workflow.echo",
        "arguments":{"value":"hello", "target_runtime_id":"runtime-in-args"},
        "target_runtime_id":"runtime-at-envelope",
        "timeout_ms":1234
    }))
    .unwrap();
    let direct = OperationRequest {
        name: "workflow.echo".into(),
        arguments: json!({"value":"hello", "target_runtime_id":"runtime-in-args"}),
        target_runtime_id: Some("runtime-at-envelope".into()),
        target_url_contains: None,
        timeout_ms: 1234,
    };

    assert_eq!(
        registry.resolve(&mcp.into_request()).unwrap(),
        registry.resolve(&direct).unwrap()
    );
}

#[test]
fn every_catalog_entry_is_registered_and_resolvable() {
    let registry = OperationRegistry::from_manifest(&manifest()).unwrap();
    assert_eq!(
        registry
            .list()
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["bridge.info", "primitive.echo", "workflow.echo"]
    );
    for entry in registry.list() {
        assert!(registry
            .resolve(&OperationRequest::new(entry.name.clone()))
            .is_ok());
        assert!(registry.describe(&entry.name).is_some());
    }
}

#[test]
fn malformed_or_unknown_calls_fail_before_dispatch() {
    assert!(McpToolCall::from_params(json!({"arguments":{}})).is_err());
    let registry = OperationRegistry::from_manifest(&manifest()).unwrap();
    assert!(matches!(
        registry.resolve(&OperationRequest::new("missing")),
        Err(ResolveError::UnknownOperation { .. })
    ));
}

#[test]
fn post_dispatch_verification_timeout_is_indeterminate() {
    let payload = json!({"error":{"code":"dispatch_timeout"}});
    assert_eq!(
        classify_legacy_result(504, &payload),
        CanonicalOutcome::Indeterminate
    );
}
