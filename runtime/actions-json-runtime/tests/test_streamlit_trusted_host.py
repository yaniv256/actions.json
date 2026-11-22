import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "contracts" / "capability-resolution" / "streamlit_trusted_host.py"
REFERENCE_PATH = ROOT / "contracts" / "capability-resolution" / "python_reference.py"
PROVIDER_V1 = "sha256:" + "1" * 64
PROVIDER_V2 = "sha256:" + "2" * 64
PROVIDER_V3 = "sha256:" + "3" * 64
PROVIDER_A_V1 = "sha256:" + "a" * 64
PROVIDER_A_V2 = "sha256:" + "b" * 64
PROVIDER_B_V1 = "sha256:" + "c" * 64


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class StreamlitTrustedHostTest(unittest.TestCase):
    def setUp(self):
        self.ref = load_module("streamlit_reference_for_test", REFERENCE_PATH)
        self.hosts = load_module("streamlit_trusted_host_for_test", MODULE_PATH)
        self.dictionary = {
            "kind": "canonical",
            "version": 1,
            "stage": 1,
            "primitives": [
                {
                    "name": "data.query",
                    "namespace": "data",
                    "effect": "read_only",
                    "version": 1,
                },
                {
                    "name": "data.write",
                    "namespace": "data",
                    "effect": "mutation",
                    "version": 2,
                },
            ],
        }
        self.identity = self.hosts.TrustedIdentity(
            tenant_id="tenant-1",
            installation_id="install-1",
            principal_id="viewer@example.com",
            authority_mode="owner_rights",
        )
        self.invocations = []
        self.registry = self.hosts.ProviderRegistry()
        self.registry.register(
            "snowflake-account-prod.secret-provider",
            {
                "data.query": lambda arguments: self.invocations.append(("query", arguments)) or {"rows": [1]},
                "data.write": lambda arguments: self.invocations.append(("write", arguments)) or {"written": 1},
            },
            revision=PROVIDER_V1,
        )
        self.store = self.ref.JsonReceiptStore(token_factory=lambda: "owner-token")

    def make_host(
        self,
        *,
        store=None,
        identity=None,
        preflight="durable_mutation_store_ready",
        providers=None,
        revision="rev-A",
        provider_extension_policies=None,
    ):
        return self.hosts.StreamlitTrustedHost(
            dictionary=self.dictionary,
            identity=identity or self.identity,
            projection="streamlit-warehouse-v1",
            transport_status="supported",
            installation_revision=revision,
            preflight=preflight,
            providers=providers or self.registry,
            receipt_store=store or self.store,
            provider_extension_policies=provider_extension_policies,
        )

    def test_authenticated_identity_and_continuation_are_server_bound(self):
        host = self.make_host()
        admitted = host.admit_continuation("attacker-chosen")
        self.assertEqual("created", admitted["continuity"])
        self.assertNotEqual("attacker-chosen", admitted["continuation_id"])

        scope = host.scope(admitted["continuation_id"])
        self.assertEqual("viewer@example.com", scope["principal_id"])
        self.assertNotIn("runtime_id", scope)

    def test_resolve_precedes_reserve_and_rejected_calls_write_nothing(self):
        host = self.make_host(preflight="read_only_ready")
        result = host.handle(
            {"call_id": "c-1", "primitive": "data.write", "arguments": {"value": 7}},
            None,
        )
        continuation = result["continuation_id"]
        self.assertEqual("action_error", result["type"])
        self.assertEqual("capability_unavailable", result["error"]["code"])
        self.assertEqual([], self.invocations)
        self.assertEqual("absent", self.store.inspect(host.scope(continuation), "c-1")["state"])

    def test_setup_required_carries_the_copyable_packet_into_host_state(self):
        packet = {
            "sql": "CREATE HYBRID TABLE APP.RECEIPTS (...) PRIMARY KEY (AUTHORITY_KEY, CALL_ID)",
            "required_privilege": "CREATE HYBRID TABLE",
            "target": "APP.RECEIPTS",
        }
        host = self.make_host(
            preflight={"state": "setup_required", "setup_packet": packet}
        )

        self.assertEqual("setup_required", host.host_state["preflight"])
        self.assertEqual(packet, host.host_state["setup_packet"])

        with self.assertRaisesRegex(ValueError, "complete setup packet"):
            self.make_host(preflight="setup_required")

    def test_ready_and_read_only_states_cannot_carry_stale_setup_instructions(self):
        for state in ("durable_mutation_store_ready", "read_only_ready"):
            for packet in (
                None,
                {
                    "sql": "CREATE HYBRID TABLE APP.RECEIPTS (...) PRIMARY KEY (A, B)",
                    "required_privilege": "CREATE HYBRID TABLE",
                    "target": "APP.RECEIPTS",
                },
            ):
                with self.subTest(state=state, packet=packet):
                    with self.assertRaisesRegex(ValueError, "only when setup is required"):
                        self.make_host(
                            preflight={"state": state, "setup_packet": packet}
                        )

    def test_internal_probe_failure_keeps_reads_available_without_leaking_diagnostics(self):
        host = self.make_host(
            preflight={
                "state": "unavailable",
                "reason": "receipt_store_preflight_failed",
            }
        )
        self.assertEqual("read_only_ready", host.host_state["preflight"])
        self.assertNotIn("reason", host.host_state)
        self.assertNotIn("setup_packet", host.host_state)

        with self.assertRaisesRegex(ValueError, "malformed internal"):
            self.make_host(
                preflight={"state": "unavailable", "reason": "private driver text"}
            )

    def test_setup_packet_validation_matches_the_public_schema_bounds(self):
        valid = {
            "sql": "S" * 4000,
            "required_privilege": "P" * 200,
            "target": "T" * 200,
        }
        host = self.make_host(
            preflight={"state": "setup_required", "setup_packet": valid}
        )
        self.assertEqual(valid, host.host_state["setup_packet"])

        invalid_packets = (
            {"sql": "x", "required_privilege": "x"},
            {**valid, "extra": "x"},
            {**valid, "sql": ""},
            {**valid, "target": 7},
            {**valid, "sql": "S" * 4001},
            {**valid, "required_privilege": "P" * 201},
            {**valid, "target": "T" * 201},
        )
        for packet in invalid_packets:
            with self.subTest(keys=tuple(packet), lengths={k: len(v) if isinstance(v, str) else None for k, v in packet.items()}):
                with self.assertRaises(ValueError):
                    self.make_host(
                        preflight={"state": "setup_required", "setup_packet": packet}
                    )

    def test_caller_rights_host_cannot_expose_owner_setup_instructions(self):
        caller = self.hosts.TrustedIdentity(
            tenant_id="tenant-1",
            installation_id="install-1",
            principal_id="viewer@example.com",
            authority_mode="caller_rights",
        )
        packet = {
            "sql": "CREATE HYBRID TABLE APP.RECEIPTS (...) PRIMARY KEY (A, B)",
            "required_privilege": "CREATE HYBRID TABLE",
            "target": "APP.RECEIPTS",
        }
        with self.assertRaisesRegex(ValueError, "owner-rights"):
            self.hosts.StreamlitTrustedHost(
                dictionary=self.dictionary,
                identity=caller,
                projection="streamlit-container-v2",
                transport_status="supported",
                installation_revision="rev-A",
                preflight={"state": "setup_required", "setup_packet": packet},
                providers=self.registry,
                receipt_store=self.store,
            )

    def test_provider_registry_drives_resolution_and_execution(self):
        host = self.make_host()
        result = host.handle(
            {"call_id": "c-1", "primitive": "data.query", "arguments": {"limit": 1}},
            None,
        )
        self.assertEqual({"rows": [1]}, result["result"])
        self.assertEqual([("query", {"limit": 1})], self.invocations)

    def test_host_freezes_provider_handler_for_its_installation_revision(self):
        host = self.make_host()
        self.registry.register(
            "snowflake-account-prod.secret-provider",
            {
                "data.query": lambda _arguments: {"rows": ["replacement"]},
            },
            revision=PROVIDER_V2,
        )

        result = host.handle(
            {"call_id": "c-1", "primitive": "data.query", "arguments": {"limit": 1}},
            None,
        )

        self.assertEqual({"rows": [1]}, result["result"])
        original_revision = result["execution_binding"]["host_revision"]
        self.assertRegex(original_revision, r"^host-[0-9a-f]{32}$")
        self.assertEqual([("query", {"limit": 1})], self.invocations)

        old_write = host.handle(
            {"call_id": "c-2", "primitive": "data.write", "arguments": {"value": 7}},
            result["continuation_id"],
        )
        self.assertEqual({"written": 1}, old_write["result"])
        self.assertEqual(
            [("query", {"limit": 1}), ("write", {"value": 7})],
            self.invocations,
        )

        with self.assertRaisesRegex(RuntimeError, "snapshot is frozen"):
            host._providers.register(
                "snowflake-account-prod.secret-provider",
                {"data.query": lambda _arguments: {"rows": ["redirected"]}},
                revision=PROVIDER_V3,
            )
        with self.assertRaises(TypeError):
            host._providers._providers["snowflake-account-prod.secret-provider"][
                "data.query"
            ] = lambda _arguments: {"rows": ["redirected"]}

        diagnostic = host.host_state
        diagnostic["revision"] = "attacker-revision"
        diagnostic["namespaces"]["data"]["provider"] = "attacker-provider"
        self.assertEqual(original_revision, host.host_state["revision"])
        self.assertEqual(
            "snowflake-account-prod.secret-provider",
            host.host_state["namespaces"]["data"]["provider"],
        )

        rebuilt = self.make_host(
            store=self.ref.JsonReceiptStore(token_factory=lambda: "owner-token-B"),
            revision="rev-B",
        )
        replacement = rebuilt.handle(
            {"call_id": "c-3", "primitive": "data.query", "arguments": {}},
            None,
        )
        self.assertEqual({"rows": ["replacement"]}, replacement["result"])
        self.assertNotEqual(original_revision, replacement["execution_binding"]["host_revision"])
        removed = rebuilt.handle(
            {"call_id": "c-4", "primitive": "data.write", "arguments": {}},
            replacement["continuation_id"],
        )
        self.assertEqual("capability_unavailable", removed["error"]["code"])

    def test_host_revision_binds_each_normalized_input_deterministically(self):
        def revision(registry, installation_revision="rev-A"):
            host = self.make_host(
                store=self.ref.JsonReceiptStore(),
                providers=registry,
                revision=installation_revision,
            )
            return host.host_state["revision"]

        first = self.hosts.ProviderRegistry()
        first.register(
            "provider-b",
            {"data.write": lambda _arguments: None},
            revision=PROVIDER_B_V1,
        )
        first.register(
            "provider-a",
            {
                "other.read": lambda _arguments: None,
                "other.write": lambda _arguments: None,
            },
            revision=PROVIDER_A_V1,
        )
        reordered = self.hosts.ProviderRegistry()
        reordered.register(
            "provider-a",
            {
                "other.write": lambda _arguments: None,
                "other.read": lambda _arguments: None,
            },
            revision=PROVIDER_A_V1,
        )
        reordered.register(
            "provider-b",
            {"data.write": lambda _arguments: None},
            revision=PROVIDER_B_V1,
        )
        changed_provider_revision = self.hosts.ProviderRegistry()
        changed_provider_revision.register(
            "provider-a",
            {
                "other.read": lambda _arguments: None,
                "other.write": lambda _arguments: None,
            },
            revision=PROVIDER_A_V2,
        )
        changed_provider_revision.register(
            "provider-b",
            {"data.write": lambda _arguments: None},
            revision=PROVIDER_B_V1,
        )
        changed_membership = self.hosts.ProviderRegistry()
        changed_membership.register(
            "provider-a",
            {
                "other.read": lambda _arguments: None,
                "other.write": lambda _arguments: None,
                "other.delete": lambda _arguments: None,
            },
            revision=PROVIDER_A_V1,
        )
        changed_membership.register(
            "provider-b",
            {"data.write": lambda _arguments: None},
            revision=PROVIDER_B_V1,
        )

        baseline = revision(first)
        self.assertEqual(baseline, revision(reordered))
        self.assertNotEqual(baseline, revision(first, "rev-B"))
        self.assertNotEqual(baseline, revision(changed_provider_revision))
        self.assertNotEqual(baseline, revision(changed_membership))

        invalid = self.hosts.ProviderRegistry()
        with self.assertRaisesRegex(ValueError, "sha256 content digest"):
            invalid.register(
                "provider-a",
                {"other.read": lambda _arguments: None},
                revision="provider-a-v1",
            )

    def test_provider_descriptors_are_projected_and_revision_bound(self):
        first = self.hosts.ProviderRegistry()
        first.register(
            "provider-a",
            {"data.query": lambda _arguments: None},
            revision=PROVIDER_A_V1,
            descriptors={
                "data.query": {
                    "summary": "Query through provider A.",
                    "input_schema": {"type": "object", "properties": {}},
                }
            },
        )
        changed = self.hosts.ProviderRegistry()
        changed.register(
            "provider-a",
            {"data.query": lambda _arguments: None},
            revision=PROVIDER_A_V1,
            descriptors={
                "data.query": {
                    "summary": "Changed executable contract.",
                    "input_schema": {"type": "object", "properties": {}},
                }
            },
        )

        registration = first.host_namespaces()["data"]["registrations"]["provider-a"]
        self.assertEqual(
            "Query through provider A.",
            registration["descriptors"]["data.query"]["summary"],
        )
        self.assertNotEqual(first.fingerprint(), changed.fingerprint())

        invalid = self.hosts.ProviderRegistry()
        with self.assertRaisesRegex(ValueError, "registered primitives"):
            invalid.register(
                "provider-a",
                {"data.query": lambda _arguments: None},
                revision=PROVIDER_A_V1,
                descriptors={"data.write": {"input_schema": {"type": "object"}}},
            )

    def test_provider_extension_policy_and_effect_are_enforced_at_execution(self):
        registry = self.hosts.ProviderRegistry()
        registry.register(
            "provider-a",
            {"data.query": lambda arguments: self.invocations.append(("query", arguments)) or {"ok": True}},
            revision=PROVIDER_A_V1,
            descriptors={
                "data.query": {
                    "input_schema": {
                        "type": "object",
                        "properties": {"write_back": {"type": "boolean"}},
                        "additionalProperties": False,
                    },
                    "extensions": {
                        "input": {
                            "write_back": {
                                "authority": "additional_policy",
                                "effect": "mutation",
                            }
                        }
                    }
                }
            },
        )
        call = {
            "call_id": "provider-extension-call",
            "primitive": "data.query",
            "arguments": {"write_back": True},
        }
        denied = self.make_host(providers=registry).handle(call, None)
        self.assertEqual("action_error", denied["type"])
        self.assertEqual([], self.invocations)

        allowed = self.make_host(
            providers=registry,
            provider_extension_policies={"data.query": ["write_back"]},
        ).handle({**call, "call_id": "provider-extension-call-allowed"}, None)
        self.assertEqual("action_call_output", allowed["type"])
        self.assertEqual(1, len(self.invocations))
        self.assertEqual(
            "mutation",
            allowed["execution_binding"]["effect"],
        )

        invalid_arguments = self.make_host(
            providers=registry,
            provider_extension_policies={"data.query": ["write_back"]},
        ).handle(
            {**call, "call_id": "provider-extension-invalid", "arguments": {"write_back": "yes"}},
            None,
        )
        self.assertEqual("invalid_arguments", invalid_arguments["error"]["code"])
        self.assertEqual(1, len(self.invocations))

    def test_host_rejects_incompatible_provider_descriptor_before_execution(self):
        registry = self.hosts.ProviderRegistry()
        registry.register(
            "provider-a",
            {"data.query": lambda _arguments: {"ok": True}},
            revision=PROVIDER_A_V1,
            descriptors={
                "data.query": {
                    "input_schema": {
                        "type": "object",
                        "properties": {"write_back": {"type": "boolean"}},
                        "additionalProperties": False,
                    }
                }
            },
        )
        with self.assertRaisesRegex(ValueError, "undeclared_provider_extension"):
            self.make_host(providers=registry)

    def test_reconstruction_replays_through_shared_store(self):
        first = self.make_host()
        call = {"call_id": "c-1", "primitive": "data.write", "arguments": {"value": 7}}
        original = first.handle(call, None)
        continuation = original["continuation_id"]
        self.assertTrue(original["executed"])

        reconstructed_store = self.ref.JsonReceiptStore.from_json(self.store.snapshot_json())
        second = self.make_host(store=reconstructed_store)
        replay = second.handle(call, continuation)
        self.assertFalse(replay["executed"])
        self.assertTrue(replay["from_receipt"])
        self.assertEqual(1, len(self.invocations))

    def test_browser_projection_recursively_redacts_provider_and_secrets(self):
        host = self.make_host()
        payload = {
            "provider": "snowflake-account-prod.secret-provider",
            "nested": {
                "config_ref": "keychain://prod",
                "connection_identifier": "acct.region",
                "bounds": {"max_rows": 10},
            },
        }
        projected = host.browser_project(payload)
        rendered = repr(projected)
        self.assertNotIn("snowflake-account-prod", rendered)
        self.assertNotIn("keychain://prod", rendered)
        self.assertNotIn("acct.region", rendered)
        self.assertEqual({"max_rows": 10}, projected["nested"]["bounds"])
        self.assertRegex(projected["provider"], r"^provider-[0-9a-f]{16}$")

    def test_handler_exception_returns_stable_public_error_only(self):
        registry = self.hosts.ProviderRegistry()
        registry.register(
            "snowflake-secret",
            {"data.query": lambda _arguments: (_ for _ in ()).throw(RuntimeError("account=private"))},
            revision=PROVIDER_V1,
        )
        host = self.hosts.StreamlitTrustedHost(
            dictionary=self.dictionary,
            identity=self.identity,
            projection="streamlit-warehouse-v1",
            transport_status="supported",
            installation_revision="rev-A",
            preflight="durable_mutation_store_ready",
            providers=registry,
            receipt_store=self.store,
        )
        result = host.handle(
            {"call_id": "c-1", "primitive": "data.query", "arguments": {}},
            None,
        )
        self.assertEqual({"code": "handler_failed"}, result["error"])
        self.assertNotIn("private", repr(result))


if __name__ == "__main__":
    unittest.main()
