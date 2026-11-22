use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use actions_json_mcp::runtime::{
    LiveTargetObservation, MutationCaller, RuntimeAuthority, TargetSelector,
};
use actions_json_mcp::state::{LifecycleState, OperationAcceptance};
use serde_json::json;
use tempfile::tempdir;

fn observation(runtime: &str) -> LiveTargetObservation {
    LiveTargetObservation {
        client_instance_id: "browser-install-a".into(),
        session_generation: "session-1".into(),
        tab_key: "tab-7".into(),
        runtime_id: runtime.into(),
        url: Some("https://trello.com/b/work".into()),
        title: Some("Work".into()),
        catalog: json!({"operations":[{"name":"trello.card.create"},{"name":"trello.board.read"}]}),
    }
}

fn acceptance(request_id: &str) -> OperationAcceptance {
    OperationAcceptance {
        request_id: request_id.into(),
        scope: "placeholder".into(),
        normalized_request: json!({"name":"trello.card.create","arguments":{"title":request_id}}),
        profile_token: None,
        target_generation: None,
        catalog_revision: None,
        lease_authority: None,
        output_policy: json!({"inline_limit":262144}),
        is_mutation: true,
    }
}

#[test]
fn mutations_are_durably_admitted_and_claimed_fifo_per_target() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
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

    let first = authority
        .admit_mutation(
            &acceptance("first"),
            Some(MutationCaller::profile("alice", &alice.token)),
            None,
            None,
        )
        .unwrap();
    let second = authority
        .admit_mutation(
            &acceptance("second"),
            Some(MutationCaller::profile("alice", &alice.token)),
            None,
            None,
        )
        .unwrap();
    assert!(first.queue_sequence < second.queue_sequence);
    assert_eq!(
        authority
            .operation_status(&first.operation_id)
            .unwrap()
            .unwrap()
            .state,
        LifecycleState::AcceptedNotDispatched
    );

    let claimed = authority
        .claim_next_mutation(&target.target_id)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.operation_id, first.operation_id);
    assert!(
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap()
            .is_none(),
        "one target may have only one in-flight mutation"
    );
    authority
        .complete_mutation(&first.operation_id, &json!({"ok":true}))
        .unwrap();
    assert_eq!(
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap()
            .unwrap()
            .operation_id,
        second.operation_id
    );
}

#[tokio::test]
async fn queued_mutation_waits_on_target_notification_and_claims_after_completion() {
    let dir = tempdir().unwrap();
    let authority = Arc::new(RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap());
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let first = authority
        .admit_mutation(
            &acceptance("notify-first"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    let second = authority
        .admit_mutation(
            &acceptance("notify-second"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    assert_eq!(
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap()
            .unwrap()
            .operation_id,
        first.operation_id
    );
    let waiter = {
        let authority = authority.clone();
        let target_id = target.target_id.clone();
        let operation_id = second.operation_id.clone();
        tokio::spawn(async move {
            authority
                .wait_to_claim_mutation(&target_id, &operation_id, Duration::from_secs(2))
                .await
                .unwrap()
        })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        !waiter.is_finished(),
        "waiter must remain parked without polling progress"
    );
    authority
        .complete_mutation(&first.operation_id, &json!({"ok":true}))
        .unwrap();
    let claimed = tokio::time::timeout(Duration::from_millis(250), waiter)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(claimed.operation_id, second.operation_id);
}

#[tokio::test]
async fn mutation_wait_deadline_performs_a_final_authoritative_claim() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let admitted = authority
        .admit_mutation(
            &acceptance("deadline"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    let claimed = authority
        .wait_to_claim_mutation(&target.target_id, &admitted.operation_id, Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(claimed.unwrap().operation_id, admitted.operation_id);
}

#[test]
fn concurrent_claimers_have_exactly_one_winner() {
    let dir = tempdir().unwrap();
    let authority = Arc::new(RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap());
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    authority
        .admit_mutation(
            &acceptance("race"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    let barrier = Arc::new(Barrier::new(5));
    let handles = (0..4)
        .map(|_| {
            let authority = authority.clone();
            let target_id = target.target_id.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                authority.claim_next_mutation(&target_id).unwrap()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let wins = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(Option::is_some)
        .count();
    assert_eq!(wins, 1);
}

#[test]
fn profiles_may_reuse_the_same_request_id_without_sharing_operation_identity() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let alice = authority.create_profile("alice", Some("Alice")).unwrap();
    let bob = authority.create_profile("bob", Some("Bob")).unwrap();
    for profile in [&alice, &bob] {
        authority
            .select_profile_target(
                &profile.name,
                &profile.token,
                TargetSelector::TargetId(target.target_id.clone()),
            )
            .unwrap();
    }
    let alice_op = authority
        .admit_mutation(
            &acceptance("shared-request"),
            Some(MutationCaller::profile("alice", &alice.token)),
            None,
            None,
        )
        .unwrap();
    let bob_op = authority
        .admit_mutation(
            &acceptance("shared-request"),
            Some(MutationCaller::profile("bob", &bob.token)),
            None,
            None,
        )
        .unwrap();
    assert_ne!(alice_op.operation_id, bob_op.operation_id);
    assert_eq!(
        authority
            .operation_status(&alice_op.operation_id)
            .unwrap()
            .unwrap()
            .request_id,
        "shared-request"
    );
    assert_eq!(
        authority
            .operation_status(&bob_op.operation_id)
            .unwrap()
            .unwrap()
            .request_id,
        "shared-request"
    );
}

#[test]
fn lease_refuses_competing_mutation_fast_but_not_reads_and_expires_without_holder() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let alice = authority
        .create_profile("alice", Some("Alice worker"))
        .unwrap();
    let bob = authority.create_profile("bob", Some("Bob worker")).unwrap();
    for profile in [&alice, &bob] {
        authority
            .select_profile_target(
                &profile.name,
                &profile.token,
                TargetSelector::TargetId(target.target_id.clone()),
            )
            .unwrap();
    }
    let lease = authority
        .acquire_lease_at(
            MutationCaller::profile("alice", &alice.token),
            None,
            60_000,
            1_000,
        )
        .unwrap();
    assert_eq!(lease.expires_at_ms, 61_000);

    let error = authority
        .admit_mutation_at(
            &acceptance("blocked"),
            Some(MutationCaller::profile("bob", &bob.token)),
            None,
            None,
            2_000,
        )
        .unwrap_err();
    assert_eq!(error.code(), "tab_locked");
    assert_eq!(error.details().unwrap()["remaining_ms"], 59_000);
    assert_eq!(error.details().unwrap()["holder_label"], "Alice worker");
    assert!(
        authority
            .resolve_target(Some(("bob", &bob.token)), None, None, None)
            .is_ok(),
        "reads/routing continue during lease"
    );

    let admitted = authority
        .admit_mutation_at(
            &acceptance("after-expiry"),
            Some(MutationCaller::profile("bob", &bob.token)),
            None,
            None,
            61_001,
        )
        .unwrap();
    assert_eq!(admitted.lease_authority, None);
    assert_eq!(
        authority
            .release_lease_at(
                MutationCaller::profile("alice", &alice.token),
                &target.target_id,
                &lease.token,
                61_001
            )
            .unwrap_err()
            .code(),
        "lease_expired"
    );
}

#[test]
fn accepted_holder_work_survives_expiry_and_release_requires_holder_token() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let alice = authority.create_profile("alice", Some("Alice")).unwrap();
    authority
        .select_profile_target(
            "alice",
            &alice.token,
            TargetSelector::TargetId(target.target_id.clone()),
        )
        .unwrap();
    let lease = authority
        .acquire_lease_at(
            MutationCaller::profile("alice", &alice.token),
            None,
            10,
            100,
        )
        .unwrap();
    let accepted = authority
        .admit_mutation_at(
            &acceptance("holder-work"),
            Some(MutationCaller::profile("alice", &alice.token)),
            None,
            Some(&lease.token),
            105,
        )
        .unwrap();
    assert!(accepted.lease_authority.is_some());
    assert_eq!(
        authority
            .release_lease_at(
                MutationCaller::profile("alice", &alice.token),
                &target.target_id,
                "wrong",
                106
            )
            .unwrap_err()
            .code(),
        "lease_token_mismatch"
    );
    let claim = authority
        .claim_next_mutation_at(&target.target_id, 111)
        .unwrap()
        .unwrap();
    assert_eq!(
        claim.operation_id, accepted.operation_id,
        "expiry affects later admission, not already accepted work"
    );
    let completed = authority
        .complete_mutation_at(&accepted.operation_id, &json!({"ok":true}), 120)
        .unwrap();
    assert_eq!(completed.canonical_result["mutation_revision"], 1);
    assert_eq!(
        completed.canonical_result["lease_authority"],
        lease.lease_id
    );
    assert!(completed.canonical_result.get("interference").is_some());
}

#[test]
fn revisions_and_intervening_notices_are_bounded_cursor_based_and_non_secret() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let alice = authority.create_profile("alice", Some("Alice")).unwrap();
    let bob = authority.create_profile("bob", Some("Bob")).unwrap();
    for profile in [&alice, &bob] {
        authority
            .select_profile_target(
                &profile.name,
                &profile.token,
                TargetSelector::TargetId(target.target_id.clone()),
            )
            .unwrap();
    }
    for id in ["b1", "b2", "b3"] {
        let admitted = authority
            .admit_mutation(
                &acceptance(id),
                Some(MutationCaller::profile("bob", &bob.token)),
                None,
                None,
            )
            .unwrap();
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap()
            .unwrap();
        authority
            .complete_mutation(&admitted.operation_id, &json!({"ok":true}))
            .unwrap();
    }
    let page = authority
        .mutation_notices(
            MutationCaller::profile("alice", &alice.token),
            &target.target_id,
            None,
            2,
        )
        .unwrap();
    assert_eq!(page.current_revision, 3);
    assert_eq!(page.notices.len(), 2);
    assert!(page.has_more);
    assert_eq!(page.next_cursor, 2);
    assert!(page
        .notices
        .iter()
        .all(|notice| notice.caller_label == "Bob"));
    let serialized = serde_json::to_string(&page).unwrap();
    assert!(!serialized.contains(&bob.token));
    let rest = authority
        .mutation_notices(
            MutationCaller::profile("alice", &alice.token),
            &target.target_id,
            Some(page.next_cursor),
            2,
        )
        .unwrap();
    assert_eq!(rest.notices.len(), 1);
    assert!(!rest.has_more);
}

#[test]
fn maintenance_prunes_only_completed_history_and_reports_truncated_cursors() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("state.sqlite3");
    let authority = RuntimeAuthority::open(&database).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let alice = authority
        .create_profile("alice-prune", Some("Alice"))
        .unwrap();
    let bob = authority.create_profile("bob-prune", Some("Bob")).unwrap();
    for profile in [&alice, &bob] {
        authority
            .select_profile_target(
                &profile.name,
                &profile.token,
                TargetSelector::TargetId(target.target_id.clone()),
            )
            .unwrap();
    }
    let old = authority
        .admit_mutation_at(
            &acceptance("old-terminal"),
            Some(MutationCaller::profile(&bob.name, &bob.token)),
            None,
            None,
            1,
        )
        .unwrap();
    authority
        .claim_next_mutation_at(&target.target_id, 2)
        .unwrap()
        .unwrap();
    authority
        .complete_mutation_at(&old.operation_id, &json!({"ok":true}), 3)
        .unwrap();
    let active = authority
        .admit_mutation_at(
            &acceptance("active-survives"),
            Some(MutationCaller::profile(&bob.name, &bob.token)),
            None,
            None,
            4,
        )
        .unwrap();
    let future = actions_json_mcp::state::revisions::OPERATION_METADATA_RETENTION_MS + 10;
    assert_eq!(
        authority.maintain_durable_state(future, 32).unwrap(),
        (1, 1)
    );
    assert_eq!(
        authority
            .claim_next_mutation_at(&target.target_id, future + 1)
            .unwrap()
            .unwrap()
            .operation_id,
        active.operation_id
    );
    authority
        .complete_mutation_at(&active.operation_id, &json!({"ok":true}), future + 2)
        .unwrap();
    let page = authority
        .mutation_notices(
            MutationCaller::profile(&alice.name, &alice.token),
            &target.target_id,
            Some(0),
            5,
        )
        .unwrap();
    assert!(page.history_truncated);
    assert_eq!(page.oldest_available_cursor, 1);
    assert_eq!(page.notices.len(), 1);
    assert_eq!(page.notices[0].revision, 2);
}

#[test]
fn stale_target_or_catalog_is_refused_before_durable_acceptance() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let mut stale = acceptance("stale");
    stale.target_generation = Some("wrong-generation".into());
    stale.catalog_revision = Some("wrong-catalog".into());
    let error = authority
        .admit_mutation(
            &stale,
            None,
            Some(TargetSelector::TargetId(target.target_id)),
            None,
        )
        .unwrap_err();
    assert!(matches!(error.code(), "stale_target" | "stale_catalog"));
    assert!(authority.operation_status("stale").unwrap().is_none());
}

#[test]
fn recovery_refuses_an_accepted_mutation_after_target_generation_disappears() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let admitted = authority
        .admit_mutation(
            &acceptance("parked"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    authority.mark_runtime_offline("runtime-1").unwrap();
    assert_eq!(
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap_err()
            .code(),
        "stale_mutation_authority"
    );
    assert_eq!(
        authority
            .operation_status(&admitted.operation_id)
            .unwrap()
            .unwrap()
            .state,
        LifecycleState::Indeterminate
    );
}

#[test]
fn indeterminate_dispatch_does_not_wedge_the_next_fifo_mutation() {
    let dir = tempdir().unwrap();
    let authority = RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let lost = authority
        .admit_mutation(
            &acceptance("lost"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    let next = authority
        .admit_mutation(
            &acceptance("next"),
            None,
            Some(TargetSelector::TargetId(target.target_id.clone())),
            None,
        )
        .unwrap();
    assert_eq!(
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap()
            .unwrap()
            .operation_id,
        lost.operation_id
    );
    authority
        .mark_mutation_indeterminate(&lost.operation_id)
        .unwrap();
    assert_eq!(
        authority
            .claim_next_mutation(&target.target_id)
            .unwrap()
            .unwrap()
            .operation_id,
        next.operation_id
    );
    assert_eq!(
        authority
            .operation_status(&lost.operation_id)
            .unwrap()
            .unwrap()
            .state,
        LifecycleState::Indeterminate
    );
    let connection = rusqlite::Connection::open(dir.path().join("state.sqlite3")).unwrap();
    let replay_payload: Option<String> = connection
        .query_row(
            "SELECT replay_payload FROM durable_operations WHERE operation_id=?",
            [&lost.operation_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        replay_payload.is_none(),
        "indeterminate mutations must discard their replay request body",
    );
}

#[test]
fn profile_and_lease_secrets_are_not_persisted_in_coordination_records() {
    let dir = tempdir().unwrap();
    let database = dir.path().join("state.sqlite3");
    let authority = RuntimeAuthority::open(&database).unwrap();
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let profile = authority.create_profile("alice", Some("Alice")).unwrap();
    authority
        .select_profile_target(
            "alice",
            &profile.token,
            TargetSelector::TargetId(target.target_id),
        )
        .unwrap();
    let lease = authority
        .acquire_lease_at(
            MutationCaller::profile("alice", &profile.token),
            None,
            1000,
            10,
        )
        .unwrap();
    authority
        .admit_mutation_at(
            &acceptance("private-coordination"),
            Some(MutationCaller::profile("alice", &profile.token)),
            None,
            Some(&lease.token),
            11,
        )
        .unwrap();
    drop(authority);
    let bytes = std::fs::read(database).unwrap();
    let raw = String::from_utf8_lossy(&bytes);
    assert!(!raw.contains(&profile.token));
    assert!(!raw.contains(&lease.token));
}

#[cfg(unix)]
#[tokio::test]
async fn durable_mutation_acceptance_roundtrips_through_owner_only_resident_ipc() {
    use actions_json_mcp::resident::{serve, Client, IpcRequest, ResidentHandler, ResidentStatus};
    use anyhow::Result;
    use serde_json::Value;
    use std::{future::Future, pin::Pin, time::Duration};

    struct Controls(Arc<RuntimeAuthority>);
    impl ResidentHandler for Controls {
        fn handle<'a>(
            &'a self,
            request: Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
            Box::pin(async move {
                self.0
                    .handle_control_operation(&request)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?
                    .ok_or_else(|| anyhow::anyhow!("not a resident control operation"))
            })
        }
    }

    let dir = tempdir().unwrap();
    let authority = Arc::new(RuntimeAuthority::open(dir.path().join("state.sqlite3")).unwrap());
    let target = authority.observe_target(&observation("runtime-1")).unwrap();
    let endpoint = dir.path().join("resident.sock");
    let mut server = serve(
        &endpoint,
        ResidentStatus::current("u5-test"),
        Arc::new(Controls(authority.clone())),
        None,
    )
    .await
    .unwrap();
    let client = Client::new(&endpoint, Duration::from_secs(1));
    let accepted = client
        .request(&IpcRequest::Operation {
            envelope: json!({
                "name":"resident.mutation.accept",
                "arguments":{
                    "request_id":"ipc-mutation-1",
                    "operation":"trello.card.create",
                    "operation_arguments":{"title":"IPC proof"},
                    "target_id":target.target_id,
                    "target_generation":target.target_generation,
                    "catalog_revision":target.catalog_revision
                }
            }),
        })
        .await
        .unwrap();
    assert!(accepted.ok);
    let accepted = accepted.result.unwrap();
    let operation_id = accepted["admission"]["operation_id"].as_str().unwrap();
    assert!(operation_id.starts_with("ajo_"));
    let status = client
        .request(&IpcRequest::Operation {
            envelope: json!({
                "name":"resident.operation.status",
                "arguments":{"operation_id":operation_id}
            }),
        })
        .await
        .unwrap();
    assert_eq!(
        status.result.unwrap()["operation"]["state"],
        "accepted_not_dispatched"
    );
    server.shutdown();
    server.wait_stopped().await;
}
