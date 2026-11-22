use actions_json_mcp::runtime::{LiveTargetObservation, RuntimeAuthority, TargetSelector};
use serde_json::json;
use tempfile::tempdir;

fn observation(session: &str, tab: &str, runtime: &str, title: &str) -> LiveTargetObservation {
    LiveTargetObservation {
        client_instance_id: "browser-install-a".into(),
        session_generation: session.into(),
        tab_key: tab.into(),
        runtime_id: runtime.into(),
        url: Some(format!("https://trello.com/b/{tab}")),
        title: Some(title.into()),
        catalog: json!({"operations":[{"name":"trello.card.read"}]}),
    }
}

#[test]
fn same_profile_name_without_token_inherits_nothing() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority
        .observe_target(&observation("session-1", "tab-7", "runtime-1", "Work"))
        .unwrap();
    let alice = authority
        .create_profile("alice", Some("Alice worker"))
        .unwrap();
    authority
        .select_profile_target(
            "alice",
            &alice.token,
            TargetSelector::TargetId(target.target_id.clone()),
        )
        .unwrap();

    let error = authority
        .profile_status("alice", "wrong-token")
        .unwrap_err();
    assert_eq!(error.code(), "profile_token_mismatch");
    let listed = authority.list_profiles().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "alice");
    assert!(
        listed[0].selected_target_id.is_none(),
        "list must not expose ambient target state"
    );
    let serialized = serde_json::to_string(&listed).unwrap();
    assert!(!serialized.contains(&alice.token));
}

#[test]
fn profiles_keep_separate_targets_and_anonymous_requires_explicit_target() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let one = authority
        .observe_target(&observation("session-1", "tab-1", "runtime-1", "Backlog"))
        .unwrap();
    let two = authority
        .observe_target(&observation("session-1", "tab-2", "runtime-2", "Roadmap"))
        .unwrap();
    let alice = authority.create_profile("alice", None).unwrap();
    let bob = authority.create_profile("bob", None).unwrap();
    authority
        .select_profile_target(
            "alice",
            &alice.token,
            TargetSelector::TargetId(one.target_id.clone()),
        )
        .unwrap();
    authority
        .select_profile_target(
            "bob",
            &bob.token,
            TargetSelector::TargetId(two.target_id.clone()),
        )
        .unwrap();

    assert_eq!(
        authority
            .resolve_target(Some(("alice", &alice.token)), None, None, None)
            .unwrap()
            .target_id,
        one.target_id
    );
    assert_eq!(
        authority
            .resolve_target(Some(("bob", &bob.token)), None, None, None)
            .unwrap()
            .target_id,
        two.target_id
    );
    assert_eq!(
        authority
            .resolve_target(None, None, None, None)
            .unwrap_err()
            .code(),
        "explicit_target_required"
    );
    assert_eq!(
        authority
            .resolve_target(
                None,
                Some(TargetSelector::RuntimeId("runtime-2".into())),
                None,
                None
            )
            .unwrap()
            .target_id,
        two.target_id
    );
}

#[test]
fn discovery_refuses_ambiguity_and_browser_restart_invalidates_old_generation() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let old = authority
        .observe_target(&observation(
            "session-old",
            "tab-9",
            "runtime-old",
            "Trello Work",
        ))
        .unwrap();
    authority
        .observe_target(&LiveTargetObservation {
            client_instance_id: "browser-install-b".into(),
            ..observation("session-other", "tab-2", "runtime-other", "Trello Personal")
        })
        .unwrap();
    assert_eq!(
        authority
            .discover_target(TargetSelector::Intent("trello".into()))
            .unwrap_err()
            .code(),
        "ambiguous_target"
    );

    let profile = authority.create_profile("alice", None).unwrap();
    authority
        .select_profile_target(
            "alice",
            &profile.token,
            TargetSelector::TargetId(old.target_id.clone()),
        )
        .unwrap();
    let replacement = authority
        .observe_target(&observation(
            "session-new",
            "tab-9",
            "runtime-new",
            "Trello Work",
        ))
        .unwrap();
    assert_ne!(old.target_generation, replacement.target_generation);
    let error = authority
        .resolve_target(Some(("alice", &profile.token)), None, None, None)
        .unwrap_err();
    assert_eq!(error.code(), "stale_target");
    assert!(authority
        .resolve_target(
            None,
            Some(TargetSelector::TargetId(replacement.target_id)),
            None,
            None
        )
        .is_ok());
}

#[test]
fn rotate_and_delete_require_the_current_opaque_token() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let original = authority.create_profile("alice", None).unwrap();
    let rotated = authority.rotate_profile("alice", &original.token).unwrap();
    assert_ne!(original.token, rotated.token);
    assert_eq!(
        authority
            .profile_status("alice", &original.token)
            .unwrap_err()
            .code(),
        "profile_token_mismatch"
    );
    authority.delete_profile("alice", &rotated.token).unwrap();
    let recreated = authority.create_profile("alice", None).unwrap();
    assert_ne!(rotated.token, recreated.token);
    assert!(authority
        .profile_status("alice", &recreated.token)
        .unwrap()
        .selected_target_id
        .is_none());
}

#[test]
fn profile_target_and_catalog_state_survive_restart_and_journal_migration() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("state.sqlite3");
    let (token, target_id, generation, revision) = {
        let authority = RuntimeAuthority::open(&database).unwrap();
        let target = authority
            .observe_target(&observation("session-1", "tab-7", "runtime-1", "Work"))
            .unwrap();
        let profile = authority.create_profile("alice", None).unwrap();
        authority
            .select_profile_target(
                "alice",
                &profile.token,
                TargetSelector::TargetId(target.target_id.clone()),
            )
            .unwrap();
        (
            profile.token,
            target.target_id,
            target.target_generation,
            target.catalog_revision,
        )
    };
    // U2 and U4 deliberately share one SQLite database. Opening the durable
    // journal between resident generations must not downgrade/remove U4 tables.
    drop(actions_json_mcp::state::DurableOperationJournal::open(&database).unwrap());
    let restarted = RuntimeAuthority::open(&database).unwrap();
    let status = restarted.profile_status("alice", &token).unwrap();
    assert_eq!(
        status.selected_target_id.as_deref(),
        Some(target_id.as_str())
    );
    let resolved = restarted
        .resolve_target(
            Some(("alice", &token)),
            None,
            Some(&generation),
            Some(&revision),
        )
        .unwrap();
    assert_eq!(resolved.target_id, target_id);
}

#[test]
fn resident_control_status_is_json_and_does_not_echo_profile_tokens() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let created = authority
        .handle_control_operation(&json!({
            "name":"resident.profile.create",
            "arguments":{"name":"alice","label":"Alice worker"}
        }))
        .unwrap()
        .unwrap();
    let token = created
        .pointer("/profile/token")
        .and_then(serde_json::Value::as_str)
        .unwrap()
        .to_string();
    let listed = authority
        .handle_control_operation(&json!({
            "name":"resident.profile.list","arguments":{}
        }))
        .unwrap()
        .unwrap();
    assert_eq!(listed["profiles"][0]["name"], "alice");
    assert!(!listed.to_string().contains(&token));
    let status = authority
        .handle_control_operation(&json!({
            "name":"resident.profile.status","arguments":{"name":"alice","token":token}
        }))
        .unwrap()
        .unwrap();
    assert_eq!(status["profile"]["label"], "Alice worker");
    assert!(status.pointer("/profile/token").is_none());
}
