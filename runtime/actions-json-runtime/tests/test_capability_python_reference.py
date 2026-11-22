import importlib.util
import json
import pathlib
import re
import subprocess
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "contracts" / "capability-resolution" / "python_reference.py"
REQUEST_DIGEST_GOLDENS = (
    ROOT
    / "contracts"
    / "capability-resolution"
    / "schemas"
    / "golden-request-digests.json"
)


def load_reference():
    spec = importlib.util.spec_from_file_location("capability_python_reference", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CapabilityPythonReferenceTest(unittest.TestCase):
    def setUp(self):
        self.ref = load_reference()
        self.dictionary = {
            "kind": "canonical",
            "version": 1,
            "stage": 1,
            "primitives": [
                {
                    "name": "data.write",
                    "capability_class": "privileged",
                    "portable": False,
                    "effect": "mutation",
                    "version": 3,
                }
            ],
        }
        self.host_state = {
            "host": "embed",
            "revision": "rev-A",
            "principal_id": "viewer@example.com",
            "authority_mode": "owner_rights",
            "projection": "streamlit-container-v2",
            "transport_status": "supported",
            "preflight": "durable_mutation_store_ready",
            "namespaces": {
                "data": {
                    "provider": "snowflake",
                    "registrations": {
                        "snowflake": {"implements": ["data.write"]}
                    },
                }
            },
        }
        self.scope = {
            "tenant_id": "tenant-1",
            "installation_id": "install-1",
            "principal_id": "viewer@example.com",
            "authority_mode": "owner_rights",
            "continuation_id": "continuation-1",
        }

    def test_request_digest_is_typed_and_canonical(self):
        base = {"primitive": "data.write", "arguments": {"b": 2, "a": 1}, "primitive_version": 3}
        reordered = {"primitive": "data.write", "arguments": {"a": 1, "b": 2}, "primitive_version": 3}
        self.assertEqual(self.ref.request_digest(base), self.ref.request_digest(reordered))
        self.assertNotEqual(
            self.ref.typed_digest("execution", {"provider": None}),
            self.ref.typed_digest("execution", {"provider": "-"}),
        )
        self.assertNotEqual(
            self.ref.typed_digest("execution", {"provider": "snowflake\nother"}),
            self.ref.typed_digest("execution", {"provider": "snowflake", "suffix": "other"}),
        )

    def test_request_digest_reproduces_the_shared_cross_language_goldens(self):
        corpus = json.loads(REQUEST_DIGEST_GOLDENS.read_text())
        self.assertGreater(len(corpus["cases"]), 0)
        for case in corpus["cases"]:
            with self.subTest(case=case["description"]):
                request = {
                    "primitive": case["primitive"],
                    "arguments": case["arguments"],
                }
                if "primitive_version" in case:
                    request["primitive_version"] = case["primitive_version"]
                self.assertEqual(case["expected"], self.ref.request_digest(request))

    def test_durable_rows_round_trip_through_json_only(self):
        tokens = iter(["owner-token-1"])
        store = self.ref.JsonReceiptStore(token_factory=lambda: next(tokens))
        request_digest = self.ref.request_digest(
            {"primitive": "data.write", "arguments": {"row": 7}, "primitive_version": 3}
        )
        claim = store.reserve(
            self.scope,
            "call-1",
            request_digest,
            {"provider": "snowflake", "primitive_version": 3, "effect": "mutation"},
        )
        self.assertEqual("acquired", claim["state"])
        payload = store.snapshot_json()
        self.assertIsInstance(json.loads(payload), dict)
        rebuilt = self.ref.JsonReceiptStore.from_json(payload, token_factory=lambda: "owner-token-2")
        self.assertEqual("unknown_disposition", rebuilt.inspect(self.scope, "call-1")["state"])

    def test_snapshot_rejects_process_local_values(self):
        store = self.ref.JsonReceiptStore()
        store._rows["bad"] = {"state": "reserved", "waiter": lambda: None}
        with self.assertRaisesRegex(TypeError, "JSON-safe"):
            store.snapshot_json()

    def test_settled_receipt_replays_after_provider_withdrawal(self):
        store = self.ref.JsonReceiptStore(token_factory=lambda: "owner-token")
        host = self.ref.ReferenceHost(self.dictionary, self.host_state, store)
        invocations = []
        call = {"call_id": "call-1", "primitive": "data.write", "arguments": {"row": 7}}
        first = host.call(self.scope, call, lambda request: invocations.append(request) or {"ok": True})
        self.assertTrue(first["executed"])
        self.assertEqual(1, len(invocations))

        withdrawn = json.loads(json.dumps(self.host_state))
        withdrawn["namespaces"] = {}
        rebuilt = self.ref.ReferenceHost(
            self.dictionary,
            withdrawn,
            self.ref.JsonReceiptStore.from_json(store.snapshot_json()),
        )
        replay = rebuilt.call(self.scope, call, lambda _request: self.fail("must not execute"))
        self.assertFalse(replay["executed"])
        self.assertTrue(replay["from_receipt"])
        self.assertEqual({"ok": True}, replay["result"])
        self.assertEqual("capability_unavailable", replay["current_capability"]["reason"])

    def test_two_interpreters_share_only_serialized_rows(self):
        store = self.ref.JsonReceiptStore(token_factory=lambda: "owner-token")
        host = self.ref.ReferenceHost(self.dictionary, self.host_state, store)
        call = {"call_id": "call-1", "primitive": "data.write", "arguments": {"row": 7}}
        first = host.call(self.scope, call, lambda _request: {"ok": True})
        self.assertTrue(first["executed"])

        request = {
            "module_path": str(MODULE_PATH),
            "dictionary": self.dictionary,
            "host_state": self.host_state,
            "scope": {**self.scope, "runtime_id": "run-B"},
            "call": call,
            "snapshot": store.snapshot_json(),
        }
        script = r'''
import importlib.util, json, sys
request = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location("capability_python_reference_child", request["module_path"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
store = module.JsonReceiptStore.from_json(request["snapshot"])
host = module.ReferenceHost(request["dictionary"], request["host_state"], store)
result = host.call(request["scope"], request["call"], lambda _request: (_ for _ in ()).throw(RuntimeError("executed")))
json.dump(result, sys.stdout, sort_keys=True)
'''
        completed = subprocess.run(
            [sys.executable, "-c", script],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        replay = json.loads(completed.stdout)
        self.assertFalse(replay["executed"])
        self.assertTrue(replay["from_receipt"])

    def test_continuation_tokens_are_server_minted_and_crypto_sized(self):
        store = self.ref.JsonReceiptStore()
        trusted = {key: self.scope[key] for key in ("tenant_id", "installation_id", "principal_id", "authority_mode")}
        created = self.ref.admit_continuation(trusted, "attacker-token", store)
        self.assertEqual("created", created["continuity"])
        self.assertNotEqual("attacker-token", created["continuation_id"])
        self.assertRegex(created["continuation_id"], re.compile(r"^[A-Za-z0-9_-]{43}$"))


if __name__ == "__main__":
    unittest.main()
