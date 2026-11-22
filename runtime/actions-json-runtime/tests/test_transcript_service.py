import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import jsonschema


ROOT = Path(__file__).resolve().parents[3]


def load_module():
    path = ROOT / "contracts" / "capability-resolution" / "transcript_service.py"
    spec = importlib.util.spec_from_file_location("transcript_service", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ts = load_module()


class TranscriptContractTest(unittest.TestCase):
    def setUp(self):
        self.members = ts.StaticMembershipResolver()
        self.store = ts.InMemoryTranscriptStore()
        self.service = ts.TranscriptService(self.store, self.members)
        self.alice = ts.Authority("tenant-a", "install-a", "alice")
        self.bob = ts.Authority("tenant-a", "install-a", "bob")
        self.session = self.service.create_session(self.alice)

    def append(self, key, payload, kind="user"):
        return self.service.append_event(
            self.alice, self.session, kind, payload, key
        )

    def test_schema_and_vectors_are_well_formed(self):
        contract = ROOT / "contracts" / "capability-resolution" / "transcript"
        schema = json.loads((contract / "transcript.schema.json").read_text())
        vectors = json.loads((contract / "transcript.vectors.json").read_text())
        self.assertEqual("https://json-schema.org/draft/2020-12/schema", schema["$schema"])
        self.assertEqual("actions.json/transcript-vectors/v1", vectors["kind"])
        self.assertGreaterEqual(len(vectors["vectors"]), 8)

    def test_persistence_result_schema_rejects_contradictory_states(self):
        contract = ROOT / "contracts" / "capability-resolution" / "transcript"
        schema = json.loads((contract / "transcript.schema.json").read_text())
        valid = {
            "status": "history_not_persisted",
            "recoverable": True,
            "reconciliation_token": "x" * 32,
        }
        jsonschema.validate(valid, schema)
        invalid = [
            {"status": "persisted", "recoverable": True},
            {
                "status": "already_persisted",
                "recoverable": False,
                "reconciliation_token": "x" * 32,
            },
            {"status": "history_not_persisted", "recoverable": True},
        ]
        for document in invalid:
            with self.subTest(document=document):
                with self.assertRaises(jsonschema.ValidationError):
                    jsonschema.validate(document, schema)

    def test_scope_is_server_bound_and_cross_user_read_is_uniform_absence(self):
        self.append("e1", {"text": "private"})
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.read_transcript(self.bob, self.session)
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.read_transcript(self.bob, "does-not-exist")

    def test_agent_session_list_is_owned_and_excludes_deleted_sessions(self):
        other = self.service.create_session(self.alice)
        bob_session = self.service.create_session(self.bob)
        self.service.soft_delete(self.alice, other)
        self.assertEqual(((self.session,), None), self.service.list_sessions(self.alice))
        self.assertEqual(((bob_session,), None), self.service.list_sessions(self.bob))

    def test_agent_session_list_pages_without_stranding_later_sessions(self):
        session_ids = sorted(
            [self.session, *(self.service.create_session(self.alice) for _ in range(4))]
        )
        first, cursor = self.service.list_sessions(self.alice, limit=2)
        self.assertEqual(tuple(session_ids[:2]), first)
        self.assertEqual(session_ids[1], cursor)
        second, cursor = self.service.list_sessions(
            self.alice,
            after=cursor,
            limit=2,
        )
        self.assertEqual(tuple(session_ids[2:4]), second)
        self.assertEqual(session_ids[3], cursor)
        final, cursor = self.service.list_sessions(
            self.alice,
            after=cursor,
            limit=2,
        )
        self.assertEqual((session_ids[4],), final)
        self.assertIsNone(cursor)

    def test_redacts_before_digest_and_retries_idempotently(self):
        first = self.append("e1", {"text": "hello", "headers": {"authorization": "Bearer one"}})
        second = self.append("e1", {"text": "hello", "headers": {"authorization": "Bearer two"}})
        self.assertEqual("persisted", first.status)
        self.assertEqual("already_persisted", second.status)
        event = self.service.read_transcript(self.alice, self.session).events[0]
        self.assertEqual("[REDACTED]", event.payload["headers"]["authorization"])
        self.assertNotIn("Bearer", json.dumps(event.payload))
        with self.assertRaises(ts.IdempotencyConflict):
            self.append("e1", {"text": "different"})

    def test_clear_memory_is_append_only_and_context_starts_after_boundary(self):
        self.append("u1", {"text": "forget me"})
        self.append("a1", {"text": "old reply"}, "assistant")
        cleared = self.service.clear_memory(self.alice, self.session, "clear-1")
        self.assertEqual("memory_cleared", cleared.kind)
        self.append("u2", {"text": "remember me"})
        transcript = self.service.read_transcript(self.alice, self.session)
        context = self.service.read_memory(self.alice, self.session)
        self.assertEqual(4, len(transcript.events))
        self.assertEqual(["remember me"], [e.payload["text"] for e in context.events])

    def test_context_is_bounded_and_role_preserving(self):
        for index in range(12):
            self.append(f"e{index}", {"text": "x" * 30}, "tool_result" if index % 2 else "user")
        context = self.service.read_memory(self.alice, self.session, max_bytes=180)
        self.assertLessEqual(context.canonical_bytes, 180)
        self.assertTrue(context.events)
        self.assertEqual("tool_result", context.events[-1].kind)

    def test_context_never_splits_a_causal_group(self):
        self.append("u1", {"causal_group": "turn-1", "text": "q"})
        self.append("t1", {"causal_group": "turn-1", "text": "x" * 60}, "tool_result")
        self.append("a1", {"causal_group": "turn-1", "text": "a"}, "assistant")
        context = self.service.read_memory(self.alice, self.session, max_bytes=100)
        self.assertEqual((), context.events)

    def test_developer_disclosure_requires_current_membership_and_audits_first(self):
        self.append("e1", {"text": "support case"})
        developer = ts.Authority("tenant-a", "install-a", "dev")
        self.members.set_role(developer, "developer")
        transcript = self.service.developer_read(developer, self.session)
        self.assertEqual("support case", transcript.events[0].payload["text"])
        self.assertEqual("developer_read", self.store.audit_events[-1].action)
        self.members.set_role(developer, "not_member")
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.developer_read(developer, self.session)

    def test_audit_failure_discloses_nothing(self):
        self.append("e1", {"text": "secret"})
        developer = ts.Authority("tenant-a", "install-a", "dev")
        self.members.set_role(developer, "owner")
        self.store.fail_audit = True
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.developer_read(developer, self.session)

    def test_soft_delete_restore_purge_and_uninstall_precedence(self):
        self.append("e1", {"text": "x"})
        self.service.soft_delete(self.alice, self.session)
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.read_transcript(self.alice, self.session)
        developer = ts.Authority("tenant-a", "install-a", "dev")
        self.members.set_role(developer, "developer")
        self.service.restore(developer, self.session)
        self.assertEqual(1, len(self.service.read_transcript(self.alice, self.session).events))
        self.members.set_role(developer, "owner")
        self.service.uninstall(developer)
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.developer_read(developer, self.session)

    def test_uninstall_requires_current_installation_membership(self):
        outsider = ts.Authority("tenant-a", "install-a", "outsider")
        with self.assertRaises(ts.TranscriptNotFound):
            self.service.uninstall(outsider)
        self.assertIsNotNone(self.store.session(self.alice, self.session))

    def test_purge_is_bounded_and_removes_only_expired_sessions(self):
        expired = [self.service.create_session(self.alice) for _ in range(3)]
        future = self.service.create_session(self.alice)
        for session_id in expired:
            self.store.soft_delete(self.alice, session_id, 10.0)
        self.store.soft_delete(self.alice, future, 30.0)
        self.assertEqual(2, self.service.purge_expired(now=20.0, limit=2))
        self.assertEqual(1, self.service.purge_expired(now=20.0, limit=2))
        self.assertIsNotNone(self.store.session(self.alice, future))

    def test_storage_failure_requires_durable_outbox_for_recoverability(self):
        with tempfile.TemporaryDirectory() as directory:
            key = ts.generate_outbox_key()
            outbox_path = Path(directory) / "outbox.sqlite3"
            outbox = ts.EncryptedSQLiteOutbox(outbox_path, key)
            service = ts.TranscriptService(self.store, self.members, outbox=outbox)
            self.store.fail_appends = True
            result = service.append_event(self.alice, self.session, "user", {"text": "retry"}, "e1")
            self.assertEqual("history_not_persisted", result.status)
            self.assertTrue(result.recoverable)
            raw = outbox_path.read_bytes()
            self.assertNotIn(b"retry", raw)
            self.store.fail_appends = False
            restarted = ts.TranscriptService(
                self.store,
                self.members,
                outbox=ts.EncryptedSQLiteOutbox(outbox_path, key),
            )
            settled = restarted.reconcile(self.alice, result.reconciliation_token)
            self.assertEqual("persisted", settled.status)
            self.assertEqual(1, len(restarted.read_transcript(self.alice, self.session).events))

    def test_without_durable_outbox_failure_is_explicitly_not_recoverable(self):
        self.store.fail_appends = True
        result = self.append("e1", {"text": "not-custodied"})
        self.assertEqual("history_not_persisted", result.status)
        self.assertFalse(result.recoverable)
        self.assertIsNone(result.reconciliation_token)

    def test_outbox_write_failure_is_explicitly_not_recoverable(self):
        class BrokenOutbox:
            def put(self, token, entry):
                raise OSError("disk full")

        self.store.fail_appends = True
        service = ts.TranscriptService(self.store, self.members, outbox=BrokenOutbox())
        result = service.append_event(self.alice, self.session, "user", {"text": "lost"}, "e1")
        self.assertEqual("history_not_persisted", result.status)
        self.assertFalse(result.recoverable)
        self.assertIsNone(result.reconciliation_token)

    def test_expired_outbox_claim_lease_can_be_reclaimed(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox = ts.EncryptedSQLiteOutbox(Path(directory) / "outbox.sqlite3", ts.generate_outbox_key())
            entry = ts._OutboxEntry(
                self.alice, self.session, "user", {"text": "retry"}, "e1", "digest", 10**12
            )
            outbox.put("token", entry)
            self.assertIsNotNone(outbox.claim("token"))
            self.assertIsNone(outbox.claim("token"))
            import sqlite3

            with sqlite3.connect(outbox.path) as db:
                db.execute(
                    "UPDATE transcript_outbox SET claimed_at=?",
                    (time.time() - ts.OUTBOX_CLAIM_LEASE_SECONDS - 1,),
                )
            self.assertIsNotNone(outbox.claim("token"))

    def test_terminal_reconciliation_error_settles_token(self):
        with tempfile.TemporaryDirectory() as directory:
            outbox = ts.EncryptedSQLiteOutbox(Path(directory) / "outbox.sqlite3", ts.generate_outbox_key())
            service = ts.TranscriptService(self.store, self.members, outbox=outbox)
            self.store.fail_appends = True
            result = service.append_event(self.alice, self.session, "user", {"text": "retry"}, "e1")
            self.store.fail_appends = False
            self.store.uninstall(self.alice)
            with self.assertRaises(ts.TranscriptNotFound):
                service.reconcile(self.alice, result.reconciliation_token)
            self.assertIsNone(outbox.claim(result.reconciliation_token))

    def test_decrypt_failure_quarantines_without_erasing_ciphertext(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as directory:
            outbox = ts.EncryptedSQLiteOutbox(Path(directory) / "outbox.sqlite3", ts.generate_outbox_key())
            entry = ts._OutboxEntry(
                self.alice, self.session, "user", {"text": "preserve"}, "e1", "digest", 10**12
            )
            outbox.put("token", entry)
            with sqlite3.connect(outbox.path) as db:
                original = db.execute("SELECT ciphertext FROM transcript_outbox").fetchone()[0]
                damaged = bytes(original[:-1]) + bytes([original[-1] ^ 1])
                db.execute("UPDATE transcript_outbox SET ciphertext=?", (damaged,))
            with self.assertRaises(ts.StorageUnavailable):
                outbox.claim("token")
            with sqlite3.connect(outbox.path) as db:
                ciphertext, quarantined, claimed = db.execute(
                    "SELECT ciphertext,quarantined,claimed FROM transcript_outbox"
                ).fetchone()
            self.assertEqual(damaged, ciphertext)
            self.assertEqual((1, 0), (quarantined, claimed))
            self.assertIsNone(outbox.claim("token"))

    def test_correction_must_target_earlier_event_in_same_session(self):
        self.append("e1", {"text": "typo"})
        result = self.append("e2", {"corrects_sequence": 1, "text": "fixed"}, "correction")
        self.assertEqual("persisted", result.status)
        with self.assertRaises(ts.TranscriptNotFound):
            self.append("e3", {"corrects_sequence": 99, "text": "impossible"}, "correction")

    def test_limits_reject_deep_or_oversized_payloads(self):
        value = {}
        cursor = value
        for _ in range(34):
            cursor["x"] = {}
            cursor = cursor["x"]
        with self.assertRaises(ts.ResourceLimitExceeded):
            self.append("deep", value)
        with self.assertRaises(ts.ResourceLimitExceeded):
            self.append("large", {"text": "x" * (257 * 1024)})


class SQLiteTranscriptStoreTest(unittest.TestCase):
    def test_passes_reusable_store_conformance_harness(self):
        conformance_path = (
            ROOT
            / "contracts"
            / "capability-resolution"
            / "transcript_store_conformance.py"
        )
        conformance_spec = importlib.util.spec_from_file_location(
            "transcript_store_conformance", conformance_path
        )
        conformance = importlib.util.module_from_spec(conformance_spec)
        assert conformance_spec.loader is not None
        conformance_spec.loader.exec_module(conformance)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "conformance.sqlite3"
            passed = conformance.verify_transcript_store(
                ts,
                lambda: ts.SQLiteTranscriptStore(path),
            )

        self.assertEqual(
            (
                "idempotent_append",
                "ordered_and_scoped_read",
                "developer_read_requires_audit",
                "memory_clear_preserves_history",
                "soft_delete_and_audited_restore",
                "concurrent_sequence_allocation",
                "bounded_purge",
                "installation_uninstall",
            ),
            passed,
        )

    def test_conformance_harness_rejects_shared_backend_session(self):
        conformance_path = (
            ROOT
            / "contracts"
            / "capability-resolution"
            / "transcript_store_conformance.py"
        )
        conformance_spec = importlib.util.spec_from_file_location(
            "transcript_store_conformance_shared", conformance_path
        )
        conformance = importlib.util.module_from_spec(conformance_spec)
        assert conformance_spec.loader is not None
        conformance_spec.loader.exec_module(conformance)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "shared-session.sqlite3"
            with self.assertRaisesRegex(
                conformance.TranscriptStoreConformanceFailure,
                "distinct backend sessions",
            ):
                conformance.verify_transcript_store(
                    ts,
                    lambda: ts.SQLiteTranscriptStore(path),
                    concurrent_actor_factory=lambda: (
                        ts.SQLiteTranscriptStore(path),
                        "same-session",
                    ),
                )

    def test_persists_across_connections_and_allocates_ordered_sequences(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transcripts.sqlite3"
            members = ts.StaticMembershipResolver()
            alice = ts.Authority("t", "i", "alice")
            first = ts.TranscriptService(ts.SQLiteTranscriptStore(path), members)
            session = first.create_session(alice)
            first.append_event(alice, session, "user", {"text": "one"}, "e1")
            second = ts.TranscriptService(ts.SQLiteTranscriptStore(path), members)
            second.append_event(alice, session, "assistant", {"text": "two"}, "e2")
            page = second.read_transcript(alice, session)
            self.assertEqual([1, 2], [event.sequence for event in page.events])

    def test_audited_restore_is_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ts.SQLiteTranscriptStore(Path(directory) / "t.sqlite3")
            members = ts.StaticMembershipResolver()
            service = ts.TranscriptService(store, members)
            alice = ts.Authority("t", "i", "alice")
            dev = ts.Authority("t", "i", "dev")
            members.set_role(dev, "developer")
            session = service.create_session(alice)
            service.soft_delete(alice, session)
            service.restore(dev, session)
            self.assertEqual("developer_restore", store.read_audit()[-1].action)

    def test_concurrent_separate_connections_allocate_unique_sequences(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "race.sqlite3"
            members = ts.StaticMembershipResolver()
            alice = ts.Authority("t", "i", "alice")
            service = ts.TranscriptService(ts.SQLiteTranscriptStore(path), members)
            session = service.create_session(alice)
            barrier = threading.Barrier(8)
            errors = []

            def append(index):
                try:
                    barrier.wait()
                    separate = ts.TranscriptService(ts.SQLiteTranscriptStore(path), members)
                    separate.append_event(alice, session, "user", {"text": index}, f"e{index}")
                except Exception as error:
                    errors.append(error)

            threads = [threading.Thread(target=append, args=(index,)) for index in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual([], errors)
            events = service.read_transcript(alice, session).events
            self.assertEqual(list(range(1, 9)), [event.sequence for event in events])

    def test_file_backed_purge_is_bounded_and_durable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "purge.sqlite3"
            store = ts.SQLiteTranscriptStore(path)
            members = ts.StaticMembershipResolver()
            service = ts.TranscriptService(store, members)
            alice = ts.Authority("t", "i", "alice")
            sessions = [service.create_session(alice) for _ in range(3)]
            for session_id in sessions:
                store.soft_delete(alice, session_id, 10.0)
            self.assertEqual(2, service.purge_expired(now=20.0, limit=2))
            reopened = ts.SQLiteTranscriptStore(path)
            self.assertEqual(1, reopened.purge_expired(now=20.0, limit=2))
            self.assertTrue(all(reopened.session(alice, session_id) is None for session_id in sessions))

    def test_adapter_open_failure_is_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            impossible = Path(directory) / "missing" / "transcripts.sqlite3"
            with self.assertRaises(ts.StorageUnavailable):
                ts.SQLiteTranscriptStore(impossible)


if __name__ == "__main__":
    unittest.main()
