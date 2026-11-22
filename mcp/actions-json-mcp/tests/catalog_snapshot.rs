use actions_json_mcp::runtime::{LiveTargetObservation, RuntimeAuthority, TargetSelector};
use serde_json::json;
use tempfile::tempdir;

fn observe(
    authority: &RuntimeAuthority,
    catalog: serde_json::Value,
) -> actions_json_mcp::runtime::TargetStatus {
    authority
        .observe_target(&LiveTargetObservation {
            client_instance_id: "browser-a".into(),
            session_generation: "session-1".into(),
            tab_key: "tab-4".into(),
            runtime_id: "runtime-4".into(),
            url: Some("https://trello.com/b/board".into()),
            title: Some("Board".into()),
            catalog,
        })
        .unwrap()
}

#[test]
fn catalog_list_and_describe_are_bound_to_target_generation_and_revision() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = observe(
        &authority,
        json!({"operations":[
            {"name":"trello.card.read","description":"Read a card","input_schema":{"type":"object"}},
            {"name":"trello.card.move","description":"Move a card","input_schema":{"type":"object"}}
        ]}),
    );

    let listing = authority
        .catalog_list(TargetSelector::TargetId(target.target_id.clone()))
        .unwrap();
    assert_eq!(listing.target_generation, target.target_generation);
    assert_eq!(listing.catalog_revision, target.catalog_revision);
    assert_eq!(listing.operations.len(), 2);
    assert!(
        listing.operations[0].input_schema.is_none(),
        "compact listing omits full schemas"
    );
    let description = authority
        .catalog_describe(
            TargetSelector::TargetId(target.target_id),
            "trello.card.move",
        )
        .unwrap();
    assert_eq!(description.operation.name, "trello.card.move");
    assert_eq!(
        description.operation.input_schema.unwrap(),
        json!({"type":"object"})
    );
}

#[test]
fn catalog_drift_refuses_before_dispatch_binding() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let first = observe(
        &authority,
        json!({"operations":[{"name":"trello.card.read"}]}),
    );
    let bound_revision = first.catalog_revision.clone();
    let second = observe(
        &authority,
        json!({"operations":[{"name":"trello.card.read"},{"name":"trello.card.move"}]}),
    );
    assert_ne!(bound_revision, second.catalog_revision);

    let error = authority
        .resolve_target(
            None,
            Some(TargetSelector::TargetId(second.target_id.clone())),
            Some(&second.target_generation),
            Some(&bound_revision),
        )
        .unwrap_err();
    assert_eq!(error.code(), "stale_catalog");
    let resolved = authority
        .resolve_target(
            None,
            Some(TargetSelector::TargetId(second.target_id)),
            Some(&second.target_generation),
            Some(&second.catalog_revision),
        )
        .unwrap();
    assert_eq!(resolved.runtime_id, "runtime-4");
}

#[test]
fn catalog_revision_is_deterministic_for_equivalent_object_key_order() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let first = observe(
        &authority,
        json!({"operations":[{"name":"read","description":"x"}],"protocol":"actions.json"}),
    );
    let second = observe(
        &authority,
        json!({"protocol":"actions.json","operations":[{"description":"x","name":"read"}]}),
    );
    assert_eq!(first.catalog_revision, second.catalog_revision);
}
