import importlib.util
import pathlib
from types import SimpleNamespace
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
PROJECTION_PATH = ROOT / "contracts" / "capability-resolution" / "streamlit_projection.py"


def load_projection():
    spec = importlib.util.spec_from_file_location("streamlit_projection_for_test", PROJECTION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeHost:
    def __init__(self):
        self.calls = []

    def handle(self, call, continuation_id):
        self.calls.append((call, continuation_id))
        return {
            "type": "action_call_output",
            "result": {"ok": True},
            "continuation_id": continuation_id or "server-minted",
        }

    def browser_project(self, value):
        return value


class FakeStreamlit:
    def __init__(self):
        self.session_state = {}
        self.registrations = []
        self.mounts = []
        self.callback = None
        self.components = SimpleNamespace(v2=SimpleNamespace(component=self.component))

    def component(self, **registration):
        self.registrations.append(registration)

        def mount(**kwargs):
            self.mounts.append(kwargs)
            self.callback = kwargs["on_action_change"]
            return SimpleNamespace(action=None)

        return mount


class StreamlitProjectionTest(unittest.TestCase):
    def setUp(self):
        self.module = load_projection()
        self.call = {
            "type": "action_call",
            "call_id": "call-1",
            "primitive": "data.query",
            "arguments": {"limit": 1},
        }

    def test_warehouse_identity_requires_snowflake_user_name(self):
        identity = self.module.identity_from_streamlit_user(
            {"user_name": "ANALYST"},
            tenant_id="tenant-1",
            installation_id="install-1",
            projection="streamlit-warehouse-v1",
            authority_mode="owner_rights",
        )
        self.assertEqual("ANALYST", identity.principal_id)
        with self.assertRaisesRegex(ValueError, "user_name"):
            self.module.identity_from_streamlit_user(
                {"email": "analyst@example.com"},
                tenant_id="tenant-1",
                installation_id="install-1",
                projection="streamlit-warehouse-v1",
                authority_mode="owner_rights",
            )

    def test_container_identity_accepts_authenticated_subject(self):
        identity = self.module.identity_from_streamlit_user(
            {"sub": "oidc-subject-1", "email": "analyst@example.com"},
            tenant_id="tenant-1",
            installation_id="install-1",
            projection="streamlit-container-v2",
            authority_mode="caller_rights",
        )
        self.assertEqual("oidc-subject-1", identity.principal_id)

    def test_v1_step_stages_response_for_the_next_rerun(self):
        host = FakeHost()
        observed = []

        def component(**kwargs):
            observed.append(kwargs)
            return self.call if len(observed) == 1 else None

        first = self.module.warehouse_v1_step(
            component,
            host,
            continuation_id=None,
            pending_response=None,
            key="actions-json",
        )
        self.assertEqual("server-minted", first["continuation_id"])
        self.assertEqual("action_call_output", first["pending_response"]["type"])
        self.assertEqual([(self.call, None)], host.calls)

        second = self.module.warehouse_v1_step(
            component,
            host,
            continuation_id=first["continuation_id"],
            pending_response=first["pending_response"],
            key="actions-json",
        )
        self.assertIsNone(second["pending_response"])
        self.assertEqual(first["pending_response"], observed[1]["response"])

    def test_v1_none_is_idle_and_does_not_execute(self):
        host = FakeHost()
        result = self.module.warehouse_v1_step(
            lambda **_kwargs: None,
            host,
            continuation_id="continuation-1",
            pending_response=None,
            key="actions-json",
        )
        self.assertEqual([], host.calls)
        self.assertEqual("continuation-1", result["continuation_id"])

    def test_v2_event_uses_the_same_trusted_host_boundary(self):
        host = FakeHost()
        result = self.module.container_v2_event(host, self.call, "continuation-1")
        self.assertEqual("action_call_output", result["type"])
        self.assertEqual([(self.call, "continuation-1")], host.calls)

    def test_v2_mount_delivers_terminal_response_on_reconstruction(self):
        streamlit = FakeStreamlit()
        first_host = FakeHost()

        first = self.module.mount_container_v2(
            streamlit,
            first_host,
            name="actions_json_embed",
            html="<div id='agent'></div>",
            css="#agent { display: block; }",
            js="export default function() {}",
            key="actions-json",
        )
        self.assertIsNone(first["response"])
        self.assertEqual(
            {"continuation_id": None, "response": None},
            streamlit.mounts[0]["data"],
        )

        streamlit.session_state["actions-json"] = {"action": self.call}
        streamlit.callback()
        self.assertEqual([(self.call, None)], first_host.calls)

        reconstructed_host = FakeHost()
        second = self.module.mount_container_v2(
            streamlit,
            reconstructed_host,
            name="actions_json_embed",
            html="<div id='agent'></div>",
            js="export default function() {}",
            key="actions-json",
            input_data={"call": self.call},
        )
        self.assertEqual("server-minted", second["continuation_id"])
        self.assertEqual("action_call_output", second["response"]["type"])
        self.assertEqual(second["response"], streamlit.mounts[1]["data"]["response"])
        self.assertEqual(self.call, streamlit.mounts[1]["data"]["call"])
        self.assertEqual([], reconstructed_host.calls)

    def test_v2_mount_rejects_invalid_delivery_state(self):
        streamlit = FakeStreamlit()
        streamlit.session_state["actions-json:actions-json-delivery"] = "forged"
        with self.assertRaisesRegex(RuntimeError, "delivery state"):
            self.module.mount_container_v2(
                streamlit,
                FakeHost(),
                name="actions_json_embed",
                html="",
                js="export default function() {}",
            )

    def test_v2_mount_rejects_input_data_that_replaces_delivery_fields(self):
        with self.assertRaisesRegex(ValueError, "reserved keys"):
            self.module.mount_container_v2(
                FakeStreamlit(),
                FakeHost(),
                name="actions_json_embed",
                html="",
                js="export default function() {}",
                input_data={"response": {"forged": True}},
            )

    def test_projection_rejects_non_action_envelopes_before_host(self):
        host = FakeHost()
        result = self.module.container_v2_event(host, {"type": "catalog"}, None)
        self.assertEqual("invalid_arguments", result["error"]["code"])
        self.assertEqual([], host.calls)


if __name__ == "__main__":
    unittest.main()
