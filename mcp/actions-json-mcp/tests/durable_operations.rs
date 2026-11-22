use actions_json_mcp::state::{
    AcceptOutcome, DurableOperationJournal, LifecycleState, OperationAcceptance, ReceiptState,
};
use actions_json_mcp::state::{ResultSpill, SpillPolicy};
use serde_json::json;
use tempfile::tempdir;

fn acceptance(request_id: &str, value: &str) -> OperationAcceptance {
    acceptance_in_scope("profile-token-1", request_id, value)
}

fn acceptance_in_scope(scope: &str, request_id: &str, value: &str) -> OperationAcceptance {
    OperationAcceptance {
        request_id: request_id.into(),
        scope: scope.into(),
        normalized_request: json!({"name":"trello.card.create","arguments":{"title":value}}),
        profile_token: Some("profile-token-1".into()),
        target_generation: Some("browser-a/session-1/tab-7".into()),
        catalog_revision: Some("catalog-4".into()),
        lease_authority: None,
        output_policy: json!({"inline_limit":262144}),
        is_mutation: true,
    }
}

#[test]
fn identical_request_ids_are_isolated_by_scope_with_distinct_wire_operation_ids() {
    let dir = tempdir().unwrap();
    let journal = DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
    let alice = match journal
        .accept(&acceptance_in_scope("profile:alice", "shared-id", "same"))
        .unwrap()
    {
        AcceptOutcome::Accepted(value) => value,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let bob = match journal
        .accept(&acceptance_in_scope("profile:bob", "shared-id", "same"))
        .unwrap()
    {
        AcceptOutcome::Accepted(value) => value,
        other => panic!("unexpected outcome: {other:?}"),
    };
    assert_eq!(alice.request_id, "shared-id");
    assert_eq!(bob.request_id, "shared-id");
    assert_ne!(alice.operation_id, bob.operation_id);
    let resumed = match journal
        .accept(&acceptance_in_scope("profile:alice", "shared-id", "same"))
        .unwrap()
    {
        AcceptOutcome::Existing(value) => value,
        other => panic!("unexpected outcome: {other:?}"),
    };
    assert_eq!(resumed.operation_id, alice.operation_id);
    assert!(matches!(
        journal.accept(&acceptance_in_scope("profile:alice", "shared-id", "changed")).unwrap(),
        AcceptOutcome::Conflict { operation_id } if operation_id == alice.operation_id
    ));
}

#[test]
fn same_identity_resumes_and_changed_fingerprint_conflicts() {
    let dir = tempdir().unwrap();
    let journal = DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
    let first = match journal.accept(&acceptance("request-1", "alpha")).unwrap() {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    let resumed = match journal.accept(&acceptance("request-1", "alpha")).unwrap() {
        AcceptOutcome::Existing(v) => v,
        _ => panic!(),
    };
    assert_eq!(resumed.operation_id, first.operation_id);
    match journal.accept(&acceptance("request-1", "beta")).unwrap() {
        AcceptOutcome::Conflict { operation_id } => assert_eq!(operation_id, first.operation_id),
        _ => panic!(),
    }
}

#[test]
fn recovery_replays_only_proven_not_dispatched_operations() {
    let dir = tempdir().unwrap();
    let journal = DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
    let a = match journal.accept(&acceptance("a", "a")).unwrap() {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    let b = match journal.accept(&acceptance("b", "b")).unwrap() {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    journal.mark_dispatched(&b.operation_id).unwrap();
    let replay = journal.replayable().unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].0.operation_id, a.operation_id);
    journal.mark_indeterminate(&b.operation_id).unwrap();
    assert_eq!(
        journal.get(&b.operation_id).unwrap().unwrap().state,
        LifecycleState::Indeterminate
    );
}

#[test]
fn extension_receipt_closes_both_crash_windows_without_duplicate_replay() {
    let dir = tempdir().unwrap();
    let journal = DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
    let before = match journal.accept(&acceptance("before", "x")).unwrap() {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    assert_eq!(
        journal
            .reconcile_receipt(&before.operation_id, ReceiptState::Absent, None)
            .unwrap(),
        LifecycleState::AcceptedNotDispatched
    );
    assert_eq!(journal.replayable().unwrap().len(), 1);
    let after = match journal.accept(&acceptance("after", "y")).unwrap() {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    assert_eq!(
        journal
            .reconcile_receipt(&after.operation_id, ReceiptState::Received, None)
            .unwrap(),
        LifecycleState::Dispatched
    );
    assert!(journal
        .replayable()
        .unwrap()
        .iter()
        .all(|(op, _)| op.operation_id != after.operation_id));
    let terminal = json!({"ok":true,"card":"created"});
    assert_eq!(
        journal
            .reconcile_receipt(&after.operation_id, ReceiptState::Terminal, Some(&terminal))
            .unwrap(),
        LifecycleState::Terminal
    );
    assert_eq!(
        journal.get(&after.operation_id).unwrap().unwrap().result,
        Some(terminal)
    );
}

#[test]
fn terminal_records_drop_private_replay_payload_and_expired_records_purge() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("state.sqlite3");
    let journal = DurableOperationJournal::open(&db).unwrap();
    let op = match journal
        .accept(&acceptance("secret-request", "private page text"))
        .unwrap()
    {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    journal
        .mark_terminal(&op.operation_id, &json!({"ok":true}), None)
        .unwrap();
    let status = journal.status(&op.operation_id).unwrap().unwrap();
    assert!(!serde_json::to_string(&status)
        .unwrap()
        .contains("private page text"));
    let bytes = std::fs::read(&db).unwrap();
    let raw = String::from_utf8_lossy(&bytes);
    assert!(
        !raw.contains("private page text"),
        "terminal replay payload must be deleted"
    );
    assert_eq!(journal.purge_expired(i64::MAX).unwrap(), 1);
}

#[test]
fn concurrent_acceptance_has_exactly_one_winner() {
    use std::sync::{Arc, Barrier};
    use std::thread;
    let dir = tempdir().unwrap();
    let journal =
        Arc::new(DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap());
    let barrier = Arc::new(Barrier::new(5));
    let handles = (0..4)
        .map(|_| {
            let journal = journal.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                journal.accept(&acceptance("race", "same")).unwrap()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| matches!(v, AcceptOutcome::Accepted(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| matches!(v, AcceptOutcome::Existing(_)))
            .count(),
        3
    );
}

#[test]
fn retention_cleanup_deletes_spill_before_operation_metadata() {
    let dir = tempdir().unwrap();
    let journal = DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
    let policy = SpillPolicy {
        directory: dir.path().join("spills"),
        inline_limit_bytes: 1,
        max_spill_bytes: 1024,
    };
    let descriptor = match policy
        .persist("tool", b"large terminal result", "application/json")
        .unwrap()
    {
        ResultSpill::Spilled(v) => v,
        _ => panic!(),
    };
    let op = match journal.accept(&acceptance("spill-gc", "x")).unwrap() {
        AcceptOutcome::Accepted(v) => v,
        _ => panic!(),
    };
    journal
        .mark_terminal(
            &op.operation_id,
            &json!({"ok":true}),
            Some(&serde_json::to_value(&descriptor).unwrap()),
        )
        .unwrap();
    assert!(descriptor.path.exists());
    assert_eq!(
        journal
            .purge_expired_with_spills(i64::MAX, &policy)
            .unwrap(),
        1
    );
    assert!(!descriptor.path.exists());
    assert!(journal.get(&op.operation_id).unwrap().is_none());
}

#[test]
fn production_retention_cleanup_is_bounded_per_pass() {
    let dir = tempdir().unwrap();
    let journal = DurableOperationJournal::open(dir.path().join("state.sqlite3")).unwrap();
    let policy = SpillPolicy {
        directory: dir.path().join("spills"),
        inline_limit_bytes: 1,
        max_spill_bytes: 1024,
    };
    for request in ["bounded-1", "bounded-2"] {
        let operation = match journal.accept(&acceptance(request, request)).unwrap() {
            AcceptOutcome::Accepted(value) => value,
            other => panic!("unexpected acceptance: {other:?}"),
        };
        journal
            .mark_terminal(&operation.operation_id, &json!({"ok":true}), None)
            .unwrap();
    }
    assert_eq!(
        journal
            .purge_expired_with_spills_bounded(i64::MAX, &policy, 1)
            .unwrap(),
        1
    );
    assert_eq!(
        journal
            .purge_expired_with_spills_bounded(i64::MAX, &policy, 1)
            .unwrap(),
        1
    );
    assert_eq!(
        journal
            .purge_expired_with_spills_bounded(i64::MAX, &policy, 1)
            .unwrap(),
        0
    );
}
