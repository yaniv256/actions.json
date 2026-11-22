"""Thin Streamlit projections over the transport-neutral trusted host.

Session state may retain the V1 response waiting for the next rerun, but it is
never the receipt ledger or an authority source.  Both projections delegate
execution to ``StreamlitTrustedHost``.
"""

from __future__ import annotations

import importlib.util
import pathlib
from collections.abc import Callable, Mapping
from typing import Any


def _load_trusted_host():
    path = pathlib.Path(__file__).with_name("streamlit_trusted_host.py")
    spec = importlib.util.spec_from_file_location("actions_json_streamlit_trusted_host", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Streamlit trusted host unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_trusted_host = _load_trusted_host()
JsonReceiptStore = _trusted_host.JsonReceiptStore
ProviderRegistry = _trusted_host.ProviderRegistry
StreamlitTrustedHost = _trusted_host.StreamlitTrustedHost


def _claim(user: Any, name: str) -> Any:
    if isinstance(user, Mapping):
        return user.get(name)
    return getattr(user, name, None)


def identity_from_streamlit_user(
    user: Any,
    *,
    tenant_id: str,
    installation_id: str,
    projection: str,
    authority_mode: str,
) -> Any:
    """Build trusted identity only from the host-authenticated user surface."""

    if projection == "streamlit-warehouse-v1":
        principal_id = _claim(user, "user_name")
        if not isinstance(principal_id, str) or not principal_id:
            raise ValueError("warehouse projection requires authenticated user_name")
    elif projection == "streamlit-container-v2":
        principal_id = _claim(user, "sub")
        if not isinstance(principal_id, str) or not principal_id:
            raise ValueError("container projection requires authenticated sub")
    else:
        raise ValueError("unsupported Streamlit projection")

    return _trusted_host.TrustedIdentity(
        tenant_id=tenant_id,
        installation_id=installation_id,
        principal_id=principal_id,
        authority_mode=authority_mode,
    )


def _valid_action_call(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and value.get("type") == "action_call"
        and isinstance(value.get("call_id"), str)
        and bool(value["call_id"])
        and isinstance(value.get("primitive"), str)
        and "." in value["primitive"]
        and isinstance(value.get("arguments"), Mapping)
    )


def _invalid_arguments(host: Any) -> dict[str, Any]:
    return host.browser_project(
        {
            "type": "action_error",
            "error": {"code": "invalid_arguments"},
            "executed": False,
            "from_receipt": False,
        }
    )


def warehouse_v1_step(
    component: Callable[..., Any],
    host: Any,
    *,
    continuation_id: str | None,
    pending_response: Mapping[str, Any] | None,
    key: str,
) -> dict[str, Any]:
    """Run one V1 rerun step and stage any output for the next rerun.

    The caller may keep the returned ``pending_response`` in Session State for
    delivery only.  Durable replay and call ownership remain in ReceiptStore.
    """

    incoming = component(
        response=pending_response,
        continuation_id=continuation_id,
        key=key,
    )
    if incoming is None:
        return {"continuation_id": continuation_id, "pending_response": None}
    if not _valid_action_call(incoming):
        return {
            "continuation_id": continuation_id,
            "pending_response": _invalid_arguments(host),
        }

    response = host.handle(incoming, continuation_id)
    return {
        "continuation_id": response.get("continuation_id", continuation_id),
        "pending_response": response,
    }


def container_v2_event(
    host: Any,
    event: Any,
    continuation_id: str | None,
) -> dict[str, Any]:
    """Handle one bidirectional V2 component event through the trusted core."""

    if not _valid_action_call(event):
        return _invalid_arguments(host)
    return host.handle(event, continuation_id)


def mount_container_v2(
    streamlit: Any,
    host: Any,
    *,
    name: str,
    html: str,
    js: str,
    css: str = "",
    key: str = "actions-json",
    continuation_id: str | None = None,
    input_data: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Mount a V2 component and bridge its ``action`` trigger to the host.

    Streamlit runs component callbacks before reconstructing the script.  The
    callback therefore stores only the browser-safe terminal envelope and the
    opaque continuation in Session State; the following render supplies both
    to JavaScript through ``data``.  Session State is delivery custody only --
    durable replay and call ownership remain in ``ReceiptStore``.
    """

    if not isinstance(name, str) or not name:
        raise ValueError("component name must be a non-empty string")
    if not isinstance(key, str) or not key:
        raise ValueError("component key must be a non-empty string")

    delivery_key = f"{key}:actions-json-delivery"
    delivery = streamlit.session_state.setdefault(
        delivery_key,
        {"continuation_id": continuation_id, "response": None},
    )
    if not isinstance(delivery, dict):
        raise RuntimeError("component delivery state is invalid")

    def on_action_change() -> None:
        component_state = streamlit.session_state.get(key)
        event = _claim(component_state, "action")
        response = container_v2_event(host, event, delivery.get("continuation_id"))
        delivery["continuation_id"] = response.get(
            "continuation_id", delivery.get("continuation_id")
        )
        delivery["response"] = response

    component = streamlit.components.v2.component(
        name=name,
        html=html,
        css=css,
        js=js,
    )
    component_data = {
        "continuation_id": delivery.get("continuation_id"),
        "response": delivery.get("response"),
    }
    if input_data is not None:
        reserved = {"continuation_id", "response"}.intersection(input_data)
        if reserved:
            raise ValueError(
                f"component data cannot replace reserved keys: {sorted(reserved)}"
            )
        component_data.update(input_data)

    result = component(
        key=key,
        data=component_data,
        on_action_change=on_action_change,
    )
    return {
        "continuation_id": delivery.get("continuation_id"),
        "response": delivery.get("response"),
        "component_result": result,
    }
