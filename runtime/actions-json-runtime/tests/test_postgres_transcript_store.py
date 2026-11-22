import importlib.util
import os
import sys
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "contracts" / "capability-resolution" / "transcript_service.py"
SPEC = importlib.util.spec_from_file_location("transcript_service_postgres", PATH)
ts = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ts
SPEC.loader.exec_module(ts)

try:
    import psycopg2
except ImportError:
    psycopg2 = None


def connection():
    return psycopg2.connect(
        host=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_HOST", "127.0.0.1"),
        port=int(os.environ.get("ACTIONS_JSON_TEST_POSTGRES_PORT", "55432")),
        dbname=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_DB", "actions_json_test"),
        user=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_USER", "postgres"),
        password=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_PASSWORD", "actions_json_test"),
        connect_timeout=2,
    )


def postgres_available():
    if psycopg2 is None:
        return False
    try:
        db = connection()
        db.close()
        return True
    except Exception:
        return False


@unittest.skipUnless(postgres_available(), "live disposable PostgreSQL is unavailable")
class PostgreSQLTranscriptStoreTest(unittest.TestCase):
    def setUp(self):
        db = connection()
        with db.cursor() as cursor:
            cursor.execute("DROP TABLE IF EXISTS transcript_events CASCADE")
            cursor.execute("DROP TABLE IF EXISTS transcript_sessions CASCADE")
            cursor.execute("DROP TABLE IF EXISTS transcript_audit CASCADE")
        db.commit()
        db.close()
        self.store = ts.PostgreSQLTranscriptStore(connection)
        self.members = ts.StaticMembershipResolver()
        self.service = ts.TranscriptService(self.store, self.members)
        self.alice = ts.Authority("tenant-pg", "install-pg", "alice")

    def test_real_connection_matches_append_memory_and_idempotency_contract(self):
        session = self.service.create_session(self.alice)
        first = self.service.append_event(self.alice, session, "user", {"text": "old"}, "e1")
        retry = self.service.append_event(self.alice, session, "user", {"text": "old"}, "e1")
        self.service.clear_memory(self.alice, session, "clear")
        self.service.append_event(self.alice, session, "assistant", {"text": "new"}, "e2")
        self.assertEqual("persisted", first.status)
        self.assertEqual("already_persisted", retry.status)
        self.assertEqual(["new"], [event.payload["text"] for event in self.service.read_memory(self.alice, session).events])

    def test_reusable_conformance_harness_uses_exact_independent_backend_sessions(self):
        path = (
            ROOT
            / "contracts"
            / "capability-resolution"
            / "transcript_store_conformance.py"
        )
        spec = importlib.util.spec_from_file_location(
            "transcript_store_conformance_postgres", path
        )
        conformance = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(conformance)

        def store_factory():
            return ts.PostgreSQLTranscriptStore(connection, initialize=False)

        def concurrent_actor_factory():
            ownership_read = connection()
            append_transaction = connection()
            with append_transaction.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                backend_id = str(cursor.fetchone()[0])
            operation_connections = iter((ownership_read, append_transaction))
            return (
                ts.PostgreSQLTranscriptStore(
                    lambda: next(operation_connections), initialize=False
                ),
                backend_id,
            )

        passed = conformance.verify_transcript_store(
            ts,
            store_factory,
            concurrent_actor_factory=concurrent_actor_factory,
        )

        self.assertIn("concurrent_sequence_allocation", passed)

    def test_real_connection_developer_read_audits_before_disclosure(self):
        session = self.service.create_session(self.alice)
        self.service.append_event(self.alice, session, "user", {"text": "case"}, "e1")
        dev = ts.Authority("tenant-pg", "install-pg", "dev")
        self.members.set_role(dev, "developer")
        self.assertEqual("case", self.service.developer_read(dev, session).events[0].payload["text"])
        self.assertEqual("developer_read", self.store.read_audit()[-1].action)

    def test_production_contract_requires_verified_tls_and_non_owner_role(self):
        requirements = self.store.production_requirements()
        self.assertEqual("verify-full", requirements["sslmode"])
        self.assertIn("non-owner", requirements["runtime_role"])
        self.assertIn("FORCE ROW LEVEL SECURITY", ts.POSTGRES_RLS_POLICY)

    def test_concurrent_real_connections_allocate_unique_sequences(self):
        session = self.service.create_session(self.alice)
        barrier = threading.Barrier(6)
        errors = []

        def append(index):
            try:
                barrier.wait()
                service = ts.TranscriptService(ts.PostgreSQLTranscriptStore(connection, initialize=False), self.members)
                service.append_event(self.alice, session, "user", {"text": index}, f"e{index}")
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=append, args=(index,)) for index in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual([], errors)
        self.assertEqual(list(range(1, 7)), [event.sequence for event in self.service.read_transcript(self.alice, session).events])

    def test_real_connection_purge_is_bounded(self):
        sessions = [self.service.create_session(self.alice) for _ in range(3)]
        for session_id in sessions:
            self.store.soft_delete(self.alice, session_id, 10.0)
        self.assertEqual(2, self.service.purge_expired(now=20.0, limit=2))
        self.assertEqual(1, self.service.purge_expired(now=20.0, limit=2))
        self.assertTrue(all(self.store.session(self.alice, session_id) is None for session_id in sessions))

    def test_rls_non_owner_defaults_to_deny_and_transaction_scope_does_not_leak(self):
        visible = self.service.create_session(self.alice)
        other = ts.Authority("other-tenant", "other-install", "mallory")
        self.service.create_session(other)
        admin = connection()
        with admin.cursor() as cursor:
            cursor.execute("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='transcript_runtime_test') THEN CREATE ROLE transcript_runtime_test LOGIN PASSWORD 'transcript_runtime_test'; END IF; END $$")
            cursor.execute("GRANT USAGE ON SCHEMA public TO transcript_runtime_test")
            cursor.execute("GRANT SELECT,INSERT,UPDATE ON transcript_sessions,transcript_events TO transcript_runtime_test")
            cursor.execute(ts.POSTGRES_RLS_POLICY)
        admin.commit()
        admin.close()

        runtime = psycopg2.connect(
            host=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_HOST", "127.0.0.1"),
            port=int(os.environ.get("ACTIONS_JSON_TEST_POSTGRES_PORT", "55432")),
            dbname=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_DB", "actions_json_test"),
            user="transcript_runtime_test",
            password="transcript_runtime_test",
        )
        with runtime.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM transcript_sessions")
            self.assertEqual(0, cursor.fetchone()[0])
            cursor.execute("BEGIN")
            cursor.execute("SET LOCAL actions_json.tenant_id = %s", (self.alice.tenant_id,))
            cursor.execute("SET LOCAL actions_json.installation_id = %s", (self.alice.installation_id,))
            cursor.execute("SELECT session_id FROM transcript_sessions")
            self.assertEqual([(visible,)], cursor.fetchall())
            runtime.commit()
            cursor.execute("SELECT COUNT(*) FROM transcript_sessions")
            self.assertEqual(0, cursor.fetchone()[0])
        runtime.close()

    def test_rls_non_owner_service_path_binds_scope_for_every_operation(self):
        admin = connection()
        with admin.cursor() as cursor:
            cursor.execute("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='transcript_runtime_test') THEN CREATE ROLE transcript_runtime_test LOGIN PASSWORD 'transcript_runtime_test'; END IF; END $$")
            cursor.execute("GRANT USAGE ON SCHEMA public TO transcript_runtime_test")
            cursor.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON transcript_sessions,transcript_events TO transcript_runtime_test")
            cursor.execute("GRANT SELECT,INSERT ON transcript_audit TO transcript_runtime_test")
            cursor.execute("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO transcript_runtime_test")
            cursor.execute(ts.POSTGRES_RLS_POLICY)
        admin.commit()
        admin.close()

        def runtime_connection():
            return psycopg2.connect(
                host=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_HOST", "127.0.0.1"),
                port=int(os.environ.get("ACTIONS_JSON_TEST_POSTGRES_PORT", "55432")),
                dbname=os.environ.get("ACTIONS_JSON_TEST_POSTGRES_DB", "actions_json_test"),
                user="transcript_runtime_test",
                password="transcript_runtime_test",
            )

        members = ts.StaticMembershipResolver()
        service = ts.TranscriptService(
            ts.PostgreSQLTranscriptStore(runtime_connection, initialize=False), members
        )
        session = service.create_session(self.alice)
        service.append_event(self.alice, session, "user", {"text": "scoped"}, "e1")
        self.assertEqual(((session,), None), service.list_sessions(self.alice))
        self.assertEqual("scoped", service.read_transcript(self.alice, session).events[0].payload["text"])

        other = ts.Authority("other-tenant", "other-install", "mallory")
        with self.assertRaises(ts.TranscriptNotFound):
            service.read_transcript(other, session)

        developer = ts.Authority("tenant-pg", "install-pg", "developer")
        members.set_role(developer, "developer")
        self.assertEqual("scoped", service.developer_read(developer, session).events[0].payload["text"])


class PostgreSQLAvailabilityBoundaryTest(unittest.TestCase):
    def test_connection_factory_failure_is_normalized(self):
        def unavailable():
            raise OSError("network down")

        store = ts.PostgreSQLTranscriptStore(unavailable, initialize=False)
        with self.assertRaises(ts.StorageUnavailable):
            store.session(ts.Authority("t", "i", "p"), "session")


if __name__ == "__main__":
    unittest.main()
