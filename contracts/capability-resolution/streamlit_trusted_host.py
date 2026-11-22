"""Trusted, transport-neutral Python boundary for Streamlit embed projections.

Streamlit V1 warehouse and V2 container adapters supply authenticated identity
and a transport around this core.  Neither browser envelopes nor caller input
may select provider identity or durable authority.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import re
import threading
from collections.abc import Callable, Mapping
from types import MappingProxyType
from typing import Any


def _load_reference():
    path = pathlib.Path(__file__).with_name("python_reference.py")
    spec = importlib.util.spec_from_file_location("actions_json_capability_reference", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("capability reference unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_reference = _load_reference()
JsonReceiptStore = _reference.JsonReceiptStore


def _load_descriptor_contract():
    path = pathlib.Path(__file__).with_name("provider_descriptor_contract.py")
    spec = importlib.util.spec_from_file_location("actions_json_provider_descriptor_contract", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("provider descriptor contract unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_descriptor_contract = _load_descriptor_contract()

_FORBIDDEN_KEYS = {
    "account_locator",
    "config_ref",
    "connection_identifier",
    "credential",
    "secret_name",
}
_PROVIDER_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
_PREFLIGHT_STATES = {
    "durable_mutation_store_ready",
    "setup_required",
    "read_only_ready",
}
_INTERNAL_PREFLIGHT_FAILURES = {
    "receipt_store_preflight_failed",
    "receipt_store_cleanup_failed",
}


def _preflight_host_state(preflight: str | Mapping[str, Any]) -> dict[str, Any]:
    """Validate preflight evidence before it enters the authority snapshot."""

    if isinstance(preflight, str):
        state = preflight
        packet = None
        packet_present = False
    elif isinstance(preflight, Mapping):
        state = preflight.get("state")
        packet = preflight.get("setup_packet")
        packet_present = "setup_packet" in preflight
    else:
        raise ValueError("preflight must be a state or preflight result")

    if state == "unavailable":
        if (
            set(preflight) != {"state", "reason"}
            or preflight.get("reason") not in _INTERNAL_PREFLIGHT_FAILURES
        ):
            raise ValueError("malformed internal preflight failure")
        # The automatic probe cannot safely distinguish a transient outage,
        # missing DDL, or missing privilege. Keep reads usable, fail mutations
        # closed, and do not expose the internal reason or misleading setup.
        return {"preflight": "read_only_ready"}
    if state not in _PREFLIGHT_STATES:
        raise ValueError("unsupported preflight state")
    if state != "setup_required":
        if packet_present:
            raise ValueError("setup packet is allowed only when setup is required")
        return {"preflight": state}

    if not isinstance(packet, Mapping):
        raise ValueError("setup_required preflight needs a complete setup packet")
    expected = {"sql", "required_privilege", "target"}
    if set(packet) != expected or not all(
        isinstance(packet[field], str) and packet[field] for field in expected
    ):
        raise ValueError("setup packet must contain non-empty sql, privilege, and target")
    if len(packet["sql"]) > 4000 or any(
        len(packet[field]) > 200 for field in ("required_privilege", "target")
    ):
        raise ValueError("setup packet exceeds the public HostState bounds")
    return {"preflight": state, "setup_packet": dict(packet)}


class TrustedIdentity:
    """Server-derived authority identity; never constructed from a call envelope."""

    def __init__(
        self,
        *,
        tenant_id: str,
        installation_id: str,
        principal_id: str,
        authority_mode: str,
    ) -> None:
        values = (tenant_id, installation_id, principal_id, authority_mode)
        if not all(isinstance(value, str) and value for value in values):
            raise ValueError("trusted identity fields must be non-empty strings")
        if authority_mode not in {"owner_rights", "caller_rights"}:
            raise ValueError("unsupported authority mode")
        self.tenant_id = tenant_id
        self.installation_id = installation_id
        self.principal_id = principal_id
        self.authority_mode = authority_mode

    def scope(self, continuation_id: str | None = None) -> dict[str, str]:
        scope = {
            "tenant_id": self.tenant_id,
            "installation_id": self.installation_id,
            "principal_id": self.principal_id,
            "authority_mode": self.authority_mode,
        }
        if continuation_id is not None:
            scope["continuation_id"] = continuation_id
        return scope


class ProviderRegistry:
    """One source of truth for provider membership and executable handlers."""

    def __init__(self) -> None:
        self._providers: Mapping[
            str, Mapping[str, Callable[[Mapping[str, Any]], Any]]
        ] = {}
        self._provider_revisions: Mapping[str, str] = {}
        self._provider_descriptors: Mapping[str, Mapping[str, Mapping[str, Any]]] = {}
        self._lock = threading.RLock()
        self._frozen = False

    def register(
        self,
        provider: str,
        handlers: Mapping[str, Callable[[Mapping[str, Any]], Any]],
        *,
        revision: str,
        descriptors: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> None:
        if not isinstance(provider, str) or not provider:
            raise ValueError("provider must be a non-empty string")
        if not isinstance(revision, str) or _PROVIDER_REVISION.fullmatch(revision) is None:
            raise ValueError("provider revision must be a sha256 content digest")
        with self._lock:
            if self._frozen:
                raise RuntimeError("provider registry snapshot is frozen")
            checked: dict[str, Callable[[Mapping[str, Any]], Any]] = {}
            for primitive, handler in handlers.items():
                if not isinstance(primitive, str) or "." not in primitive or not callable(handler):
                    raise ValueError("provider handlers require dotted primitive names and callables")
                checked[primitive] = handler
            if not checked:
                raise ValueError("provider must implement at least one primitive")
            checked_descriptors = json.loads(json.dumps(descriptors or {}))
            if not isinstance(checked_descriptors, dict):
                raise ValueError("provider descriptors must be an object")
            if set(checked_descriptors) - set(checked):
                raise ValueError("provider descriptors must name registered primitives")
            self._providers[provider] = checked
            self._provider_revisions[provider] = revision
            self._provider_descriptors[provider] = checked_descriptors

    def host_namespaces(self) -> dict[str, Any]:
        namespaces: dict[str, Any] = {}
        with self._lock:
            for provider, handlers in self._providers.items():
                by_namespace: dict[str, list[str]] = {}
                for primitive in handlers:
                    by_namespace.setdefault(primitive.split(".", 1)[0], []).append(primitive)
                for namespace, primitives in by_namespace.items():
                    state = namespaces.setdefault(namespace, {"registrations": {}})
                    if "provider" in state and state["provider"] != provider:
                        raise ValueError(f"provider selection required for namespace {namespace}")
                    state["provider"] = provider
                    registration: dict[str, Any] = {"implements": sorted(primitives)}
                    descriptors = {
                        primitive: self._provider_descriptors[provider][primitive]
                        for primitive in primitives
                        if primitive in self._provider_descriptors[provider]
                    }
                    if descriptors:
                        registration["descriptors"] = descriptors
                    state["registrations"][provider] = registration
        return namespaces

    def invoke(self, provider: str, primitive: str, arguments: Mapping[str, Any]) -> Any:
        with self._lock:
            try:
                handler = self._providers[provider][primitive]
            except KeyError as exc:
                raise RuntimeError("provider handler unavailable") from exc
        return handler(arguments)

    def snapshot(self) -> "ProviderRegistry":
        """Freeze provider membership and handlers for one host revision.

        A mutable application registry may be updated while a Streamlit process
        remains alive.  A host instance must not let such an update change the
        handler behind an execution binding that was already resolved and
        reserved.  Reconstruction creates a new host and therefore a new
        snapshot under the caller-supplied installation revision.
        """

        frozen = ProviderRegistry()
        with self._lock:
            frozen._providers = MappingProxyType(
                {
                    provider: MappingProxyType(dict(handlers))
                    for provider, handlers in self._providers.items()
                }
            )
            frozen._provider_revisions = MappingProxyType(dict(self._provider_revisions))
            frozen._provider_descriptors = MappingProxyType(
                {
                    provider: MappingProxyType(json.loads(json.dumps(descriptors)))
                    for provider, descriptors in self._provider_descriptors.items()
                }
            )
            frozen._frozen = True
        return frozen

    def fingerprint(self) -> str:
        """Return a stable digest of provider identity, revision, and membership."""

        with self._lock:
            payload = [
                {
                    "provider": provider,
                    "revision": self._provider_revisions[provider],
                    "implements": sorted(handlers),
                    "descriptors": dict(self._provider_descriptors[provider]),
                }
                for provider, handlers in sorted(self._providers.items())
            ]
        preimage = b"actions-json/provider-registry/v2\n" + _stable_registry_json(payload).encode(
            "utf-8"
        )
        return hashlib.sha256(preimage).hexdigest()


def _stable_registry_json(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable_registry_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        keys = sorted(value, key=lambda item: item.encode("utf-8"))
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _stable_registry_json(value[key])
            for key in keys
        ) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class StreamlitTrustedHost:
    """Shared trusted core for local Streamlit V1 and V2 projection adapters."""

    def __init__(
        self,
        *,
        dictionary: Mapping[str, Any],
        identity: TrustedIdentity,
        projection: str,
        transport_status: str,
        installation_revision: str,
        preflight: str | Mapping[str, Any],
        providers: ProviderRegistry,
        receipt_store: Any,
        provider_extension_policies: Mapping[str, list[str]] | None = None,
    ) -> None:
        if projection not in {"streamlit-warehouse-v1", "streamlit-container-v2"}:
            raise ValueError("unsupported Streamlit projection")
        if projection == "streamlit-warehouse-v1" and identity.authority_mode != "owner_rights":
            raise ValueError("warehouse projection cannot claim caller rights")
        self.identity = identity
        self._providers = providers.snapshot()
        self.receipt_store = receipt_store
        entries = {
            entry.get("name"): entry
            for entry in dictionary.get("primitives", [])
            if isinstance(entry, Mapping) and isinstance(entry.get("name"), str)
        }
        for namespace_state in self._providers.host_namespaces().values():
            for registration in namespace_state.get("registrations", {}).values():
                for primitive in registration.get("implements", []):
                    if primitive not in entries:
                        if primitive in registration.get("descriptors", {}):
                            raise ValueError(f"provider describes unknown primitive {primitive}")
                        continue
                    _descriptor_contract.effective_descriptor(
                        entries[primitive], registration, primitive
                    )
        revision_preimage = (
            "actions-json/streamlit-host-revision/v1\n"
            f"{installation_revision}\n{self._providers.fingerprint()}\n"
        ).encode("utf-8")
        effective_revision = f"host-{hashlib.sha256(revision_preimage).hexdigest()[:32]}"
        host_state = {
            "host": "embed",
            "revision": effective_revision,
            "principal_id": identity.principal_id,
            "authority_mode": identity.authority_mode,
            "projection": projection,
            "transport_status": transport_status,
            "namespaces": self._providers.host_namespaces(),
        }
        normalized_preflight = _preflight_host_state(preflight)
        if (
            normalized_preflight["preflight"] == "setup_required"
            and identity.authority_mode != "owner_rights"
        ):
            raise ValueError("only an owner-rights host may expose setup instructions")
        host_state.update(normalized_preflight)
        self._host = _reference.ReferenceHost(
            dictionary,
            host_state,
            receipt_store,
            provider_extension_policies=provider_extension_policies,
        )
        self._host.dictionary = _freeze(self._host.dictionary)
        self._host.host_state = _freeze(self._host.host_state)

    @property
    def host_state(self) -> dict[str, Any]:
        """Return a diagnostic copy, never the live authority snapshot."""

        return _thaw(self._host.host_state)

    def admit_continuation(self, presented: str | None) -> dict[str, Any]:
        return _reference.admit_continuation(
            self.identity.scope(),
            presented,
            self.receipt_store,
        )

    def scope(self, continuation_id: str) -> dict[str, str]:
        return self.identity.scope(continuation_id)

    def describe_capability(
        self, primitive: str, arguments: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """Return the browser-safe effective descriptor selected for a call."""

        return self.browser_project(self._host.resolve(primitive, arguments))

    def handle(self, call: Mapping[str, Any], continuation_id: str | None) -> dict[str, Any]:
        admission = self.admit_continuation(continuation_id)
        if admission.get("outcome") != "ok":
            return self.browser_project(_public_error(str(admission.get("reason"))))
        admitted_continuation = admission["continuation_id"]
        primitive = call.get("primitive")
        arguments = call.get("arguments", {})
        if (
            not isinstance(call.get("call_id"), str)
            or not call["call_id"]
            or not isinstance(primitive, str)
            or not isinstance(arguments, Mapping)
        ):
            projected = self.browser_project(_public_error("invalid_arguments"))
            projected["continuation_id"] = admitted_continuation
            return projected

        def execute(_call: Mapping[str, Any]) -> Any:
            resolution = self._host.resolve(primitive, arguments)
            provider = resolution.get("provider")
            if not isinstance(provider, str):
                raise RuntimeError("provider unavailable")
            return self._providers.invoke(provider, primitive, arguments)

        projected = self.browser_project(
            self._host.call(self.scope(admitted_continuation), call, execute)
        )
        projected["continuation_id"] = admitted_continuation
        return projected

    def browser_project(self, payload: Any) -> Any:
        """Recursively remove trusted identities and stabilize public failures."""

        return _browser_project(payload, self.identity.installation_id)


def _public_error(code: str) -> dict[str, Any]:
    return {
        "type": "action_error",
        "error": {"code": code},
        "executed": False,
        "from_receipt": False,
    }


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(child) for key, child in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(child) for child in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(child) for key, child in value.items()}
    if isinstance(value, tuple):
        return [_thaw(child) for child in value]
    return value


def _opaque_provider(provider: str, installation_id: str) -> str:
    digest = hashlib.sha256(
        f"actions-json/provider-instance/v1\n{installation_id}\n{provider}\n".encode("utf-8")
    ).hexdigest()
    return f"provider-{digest[:16]}"


def _browser_project(value: Any, installation_id: str, key: str | None = None) -> Any:
    if key in _FORBIDDEN_KEYS:
        return None
    if key == "provider" and isinstance(value, str):
        return _opaque_provider(value, installation_id)
    if isinstance(value, Mapping):
        projected = {}
        for child_key, child_value in value.items():
            if child_key in _FORBIDDEN_KEYS:
                continue
            if child_key == "message" and value.get("code") == "handler_failed":
                continue
            projected[child_key] = _browser_project(child_value, installation_id, child_key)
        return projected
    if isinstance(value, list):
        return [_browser_project(item, installation_id) for item in value]
    return value
