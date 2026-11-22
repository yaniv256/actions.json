import importlib.util
import pathlib
import sqlite3
import tempfile
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
SUPPORT_PATH = (
    ROOT
    / "examples"
    / "streamlit-snowflake-container"
    / "acceptance_support.py"
)
SPCS_CONNECTION_PATH = (
    ROOT
    / "examples"
    / "streamlit-snowflake-container"
    / "spcs_connection.py"
)


def load_support():
    spec = importlib.util.spec_from_file_location(
        "streamlit_snowflake_acceptance_support", SUPPORT_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_spcs_connection():
    spec = importlib.util.spec_from_file_location(
        "streamlit_snowflake_spcs_connection", SPCS_CONNECTION_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SPCSConnectionFactoryTest(unittest.TestCase):
    def setUp(self):
        self.spcs = load_spcs_connection()

    def test_each_call_reads_current_token_and_opens_a_new_connection(self):
        calls = []

        def connect(**kwargs):
            connection = object()
            calls.append((kwargs, connection))
            return connection

        with tempfile.TemporaryDirectory() as directory:
            token_path = pathlib.Path(directory) / "token"
            token_path.write_text("first-token\n", encoding="utf-8")
            factory = self.spcs.spcs_service_connection_factory(
                connect,
                environ={
                    "SNOWFLAKE_HOST": "internal.snowflake.test",
                    "SNOWFLAKE_ACCOUNT": "account-locator",
                    "SNOWFLAKE_DATABASE": "APP_DB",
                    "SNOWFLAKE_SCHEMA": "TRANSCRIPTS",
                    "SNOWFLAKE_WAREHOUSE": "APP_WH",
                },
                token_path=token_path,
            )

            first = factory()
            token_path.write_text("second-token\n", encoding="utf-8")
            second = factory()

        self.assertIsNot(first, second)
        self.assertEqual(
            [call[0]["token"] for call in calls],
            ["first-token", "second-token"],
        )
        self.assertEqual(calls[0][0]["authenticator"], "oauth")
        self.assertEqual(calls[0][0]["host"], "internal.snowflake.test")
        self.assertEqual(calls[0][0]["account"], "account-locator")
        self.assertEqual(calls[0][0]["database"], "APP_DB")
        self.assertEqual(calls[0][0]["schema"], "TRANSCRIPTS")
        self.assertEqual(calls[0][0]["warehouse"], "APP_WH")

    def test_missing_platform_identity_fails_before_connect(self):
        with self.assertRaisesRegex(RuntimeError, "SNOWFLAKE_HOST"):
            self.spcs.spcs_service_connection_factory(
                lambda **kwargs: kwargs,
                environ={},
            )

    def test_missing_or_empty_token_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = pathlib.Path(directory) / "token"
            factory = self.spcs.spcs_service_connection_factory(
                lambda **kwargs: kwargs,
                environ={"SNOWFLAKE_HOST": "host", "SNOWFLAKE_ACCOUNT": "account"},
                token_path=token_path,
            )
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                factory()
            token_path.write_text("\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "empty"):
                factory()


class StreamlitSnowflakeAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.support = load_support()

    def test_read_reconstructs_and_replays_without_second_provider_invocation(self):
        query_calls = []
        resources = self.support.AcceptanceResources(
            query=lambda: query_calls.append("query") or [{"STATUS": 1}]
        )
        user = {"sub": "snowflake-user-subject"}
        call = self.support.acceptance_call()

        first_host = self.support.build_host(
            root=ROOT,
            user=user,
            resources=resources,
        )
        first = first_host.handle(call, None)

        self.assertEqual("action_call_output", first["type"])
        self.assertEqual(
            {
                "url": "snowflake://actions-json/transport-probe",
                "text": "Snowflake provider read completed through the trusted embedded host.",
                "rows_observed": 1,
                "backend": "snowflake",
            },
            first["result"],
        )
        self.assertEqual(1, resources.provider_invocations)
        self.assertEqual(["query"], query_calls)

        registration = first_host.host_state["namespaces"]["database"]["registrations"][
            "snowflake-read-acceptance"
        ]
        self.assertIn("database.page.read", registration["descriptors"])
        resolved = first_host.describe_capability(
            "database.page.read", call["arguments"]
        )
        self.assertEqual("provider_registration", resolved["descriptor"]["source"])
        self.assertEqual(
            registration["descriptors"]["database.page.read"]["input_schema"],
            resolved["descriptor"]["input_schema"],
        )

        reconstructed_host = self.support.build_host(
            root=ROOT,
            user=user,
            resources=resources,
        )
        replay = reconstructed_host.handle(call, first["continuation_id"])

        self.assertEqual("action_call_output", replay["type"])
        self.assertTrue(replay["from_receipt"])
        self.assertEqual(first["result"], replay["result"])
        self.assertEqual(1, resources.provider_invocations)
        self.assertEqual(["query"], query_calls)

    def test_browser_assets_send_an_action_and_render_the_terminal_response(self):
        assets = self.support.component_assets(
            ROOT / "examples" / "streamlit-snowflake-container"
        )
        self.assertIn('setTriggerValue("action"', assets["js"])
        self.assertIn("data?.response", assets["js"])
        self.assertIn("data.call", assets["js"])
        self.assertNotIn("data-call-id", assets["html"])

    def test_sqlite_backend_executes_through_the_trusted_host(self):
        with tempfile.TemporaryDirectory() as directory:
            database = pathlib.Path(directory) / "pages.sqlite3"
            connection = sqlite3.connect(database)
            try:
                connection.execute(
                    "CREATE TABLE actions_json_pages (url TEXT PRIMARY KEY, text TEXT NOT NULL)"
                )
                connection.execute(
                    "INSERT INTO actions_json_pages (url, text) VALUES (?, ?)",
                    ("https://example.test/live", "Live SQLite page text."),
                )
                connection.commit()
            finally:
                connection.close()

            resources = self.support.database_resources(ROOT, f"sqlite://{database}")
            host = self.support.build_host(
                root=ROOT,
                user={"sub": "sqlite-user"},
                resources=resources,
            )
            result = host.handle(
                {
                    "type": "action_call",
                    "call_id": "sqlite-live-read-1",
                    "primitive": "database.page.read",
                    "primitive_version": 1,
                    "arguments": {"url": "https://example.test/live"},
                },
                None,
            )

        self.assertEqual("action_call_output", result["type"])
        self.assertEqual("Live SQLite page text.", result["result"]["text"])
        self.assertEqual("sqlite", result["result"]["backend"])

    def test_transcript_memory_survives_reconstruction_and_clear_preserves_history(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts(ROOT, pathlib.Path(directory) / "transcripts.sqlite3")
            user = {"sub": "memory-user"}
            first_host = self.support.build_host(root=ROOT, user=user, resources=resources)
            session_id = resources.create_transcript_session(first_host.identity)
            persisted = resources.record_transcript_event(
                first_host.identity, session_id, "user", {"text": "old context"}, "event-1"
            )
            self.assertEqual("persisted", persisted.status)

            reconstructed = self.support.build_host(root=ROOT, user=user, resources=resources)
            before = reconstructed.handle(
                {
                    "type": "action_call",
                    "call_id": "memory-read-1",
                    "primitive": "transcript.session.read",
                    "primitive_version": 1,
                    "arguments": {"session_id": session_id},
                },
                None,
            )
            self.assertEqual("old context", before["result"]["events"][0]["payload"]["text"])
            self.assertEqual(
                "untrusted_transcript_data", before["result"]["events"][0]["trust"]
            )

            resources.clear_transcript_memory(reconstructed.identity, session_id, "clear-1")
            resources.record_transcript_event(
                reconstructed.identity, session_id, "user", {"text": "new context"}, "event-2"
            )
            after = reconstructed.handle(
                {
                    "type": "action_call",
                    "call_id": "memory-read-2",
                    "primitive": "transcript.session.read",
                    "primitive_version": 1,
                    "arguments": {"session_id": session_id},
                },
                before["continuation_id"],
            )
            self.assertEqual(["new context"], [event["payload"]["text"] for event in after["result"]["events"]])
            transcript = resources.read_full_transcript(reconstructed.identity, session_id)
            self.assertEqual(["user", "memory_cleared", "user"], [event.kind for event in transcript.events])

    def test_transcript_agent_cannot_read_another_user_session(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts(ROOT, pathlib.Path(directory) / "transcripts.sqlite3")
            alice_host = self.support.build_host(root=ROOT, user={"sub": "alice"}, resources=resources)
            session_id = resources.create_transcript_session(alice_host.identity)
            resources.record_transcript_event(
                alice_host.identity, session_id, "user", {"text": "alice only"}, "event-a"
            )
            bob_host = self.support.build_host(root=ROOT, user={"sub": "bob"}, resources=resources)
            bob_session = resources.create_transcript_session(bob_host.identity)
            resources.record_transcript_event(
                bob_host.identity, bob_session, "user", {"text": "bob only"}, "event-b"
            )
            bob_own = bob_host.handle(
                {
                    "type": "action_call",
                    "call_id": "bob-own-read",
                    "primitive": "transcript.session.read",
                    "primitive_version": 1,
                    "arguments": {"session_id": bob_session},
                },
                None,
            )
            self.assertEqual("action_call_output", bob_own["type"])
            result = bob_host.handle(
                {
                    "type": "action_call",
                    "call_id": "bob-cross-user-read",
                    "primitive": "transcript.session.read",
                    "primitive_version": 1,
                    "arguments": {"session_id": session_id},
                },
                None,
            )
            self.assertEqual("action_error", result["type"])
            self.assertEqual("handler_failed", result["error"]["code"])
            self.assertEqual("handler_failed", result["error"]["code"])
            self.assertNotIn("alice only", str(result))

    def test_transcript_handler_enforces_runtime_resource_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts(ROOT, pathlib.Path(directory) / "transcripts.sqlite3")
            host = self.support.build_host(root=ROOT, user={"sub": "alice"}, resources=resources)
            session_id = resources.create_transcript_session(host.identity)
            result = host.handle(
                {
                    "type": "action_call",
                    "call_id": "oversized-memory-read",
                    "primitive": "transcript.session.read",
                    "primitive_version": 1,
                    "arguments": {"session_id": session_id, "max_bytes": 65_537},
                },
                None,
            )
            self.assertEqual("action_error", result["type"])

    def test_refused_turn_is_recorded_through_the_trusted_streamlit_host(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts(
                ROOT, pathlib.Path(directory) / "transcripts.sqlite3"
            )
            host = self.support.build_host(
                root=ROOT,
                user={"sub": "refused-turn-user"},
                resources=resources,
            )
            session_id = resources.create_transcript_session(host.identity)
            recording_host = resources.recording_host(
                host.identity, host, session_id
            )

            result = recording_host.handle(
                {
                    "type": "action_call",
                    "call_id": "refused-browser-call-1",
                    "primitive": "browser.open_tab",
                    "primitive_version": 1,
                    "arguments": {"url": "https://private.example"},
                },
                None,
            )

            self.assertEqual("action_error", result["type"])
            transcript = resources.read_full_transcript(
                host.identity, session_id
            )
            self.assertEqual(
                ["action_refusal"], [event.kind for event in transcript.events]
            )
            self.assertEqual(
                result["error"]["code"], transcript.events[0].payload["code"]
            )
            self.assertNotIn("private.example", repr(transcript.events[0].payload))

    def test_sqlite_transcript_url_configures_the_shipped_store(self):
        with tempfile.TemporaryDirectory() as directory:
            database = pathlib.Path(directory) / "configured-transcripts.sqlite3"
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts_url(ROOT, f"sqlite://{database}")
            host = self.support.build_host(
                root=ROOT,
                user={"sub": "configured-user"},
                resources=resources,
            )
            session_id = resources.create_transcript_session(host.identity)
            result = resources.record_transcript_event(
                host.identity,
                session_id,
                "user",
                {"text": "configured"},
                "configured-1",
            )

            self.assertEqual("persisted", result.status)
            self.assertTrue(database.exists())

            evidence = resources.transcript_evidence(host.identity, session_id)
            self.assertEqual(
                {"event_count": 1, "event_kinds": ["user"]},
                evidence,
            )
            self.assertNotIn("configured", repr(evidence))

    def test_same_principal_conversations_have_independent_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts(ROOT, pathlib.Path(directory) / "transcripts.sqlite3")
            host = self.support.build_host(root=ROOT, user={"sub": "alice"}, resources=resources)
            first = resources.create_transcript_session(host.identity)
            second = resources.create_transcript_session(host.identity)
            resources.record_transcript_event(
                host.identity, first, "user", {"text": "first"}, "first-1"
            )
            resources.record_transcript_event(
                host.identity, second, "user", {"text": "second"}, "second-1"
            )
            resources.clear_transcript_memory(host.identity, first, "first-clear")

            self.assertEqual(
                [],
                resources._bound_transcripts(host.identity).read_model_memory(
                    {"session_id": first}
                )["events"],
            )
            self.assertEqual(
                "second",
                resources._bound_transcripts(host.identity).read_model_memory(
                    {"session_id": second}
                )["events"][0]["payload"]["text"],
            )

    def test_clear_waits_until_complete_turn_is_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            resources = self.support.AcceptanceResources(query=lambda: [])
            resources.enable_transcripts(ROOT, pathlib.Path(directory) / "transcripts.sqlite3")
            host = self.support.build_host(root=ROOT, user={"sub": "alice"}, resources=resources)
            session_id = resources.create_transcript_session(host.identity)
            first_append_started = threading.Event()
            permit_first_append = threading.Event()
            original = resources.transcript_service.append_event

            def delayed_append(*args, **kwargs):
                if args[2] == "user":
                    first_append_started.set()
                    permit_first_append.wait(timeout=2)
                return original(*args, **kwargs)

            resources.transcript_service.append_event = delayed_append
            turn = threading.Thread(
                target=resources.record_transcript_turn,
                args=(host.identity, session_id, [
                    ("user", {"text": "question", "causal_group": "turn-1"}, "turn-1-user"),
                    ("assistant", {"text": "answer", "causal_group": "turn-1"}, "turn-1-assistant"),
                ]),
            )
            clear = threading.Thread(
                target=resources.clear_transcript_memory,
                args=(host.identity, session_id, "clear-after-turn"),
            )
            turn.start()
            self.assertTrue(first_append_started.wait(timeout=2))
            clear.start()
            permit_first_append.set()
            turn.join(timeout=2)
            clear.join(timeout=2)

            transcript = resources.read_full_transcript(host.identity, session_id)
            self.assertEqual(
                ["user", "assistant", "memory_cleared"],
                [event.kind for event in transcript.events],
            )
            self.assertEqual(
                [],
                resources._bound_transcripts(host.identity).read_model_memory(
                    {"session_id": session_id}
                )["events"],
            )


if __name__ == "__main__":
    unittest.main()
