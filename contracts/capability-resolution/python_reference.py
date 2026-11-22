"""Independent Python reference for the capability receipt contract.

This module intentionally uses only the Python standard library.  It is a
conformance backend, not the Snowflake adapter itself: every durable value must
cross JSON so a passing test cannot accidentally rely on JavaScript promises,
functions, shared object identity, or one interpreter's memory.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import secrets
from collections.abc import Callable, Mapping
from typing import Any


REQUEST_DOMAIN = "actions-json/request-digest/v1"
DIGEST_PREFIX = "req-"


def _load_descriptor_contract():
    path = pathlib.Path(__file__).with_name("provider_descriptor_contract.py")
    spec = importlib.util.spec_from_file_location("actions_json_provider_descriptor_contract", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("provider descriptor contract unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_descriptor_contract = _load_descriptor_contract()


def _canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def typed_digest(domain: str, value: Any) -> str:
    """Hash a typed JSON value without sentinels or delimiter ambiguity."""

    preimage = _canonical({"domain": domain, "value": value}).encode("utf-8")
    return hashlib.sha256(preimage).hexdigest()


def request_digest(request: Mapping[str, Any]) -> str:
    """Return caller-stable request identity, independent of live providers."""

    primitive = request.get("primitive")
    version = request.get("primitive_version")
    version_field = "-" if version is None else str(version)
    preimage = "\n".join(
        [
            REQUEST_DOMAIN,
            str(primitive),
            version_field,
            _canonical(request.get("arguments", {})),
            "",
        ]
    ).encode("utf-8")
    return DIGEST_PREFIX + hashlib.sha256(preimage).hexdigest()[:32]


def authority_key(scope: Mapping[str, Any]) -> str:
    """Bind receipts to durable authority, excluding volatile runtime IDs."""

    return _canonical(
        [
            scope.get("tenant_id"),
            scope.get("installation_id"),
            scope.get("principal_id"),
            scope.get("authority_mode", "unspecified"),
            scope.get("continuation_id") or scope.get("session_id"),
        ]
    )


def _token() -> str:
    # 32 random bytes = 256 bits; urlsafe base64 without padding is 43 chars.
    return secrets.token_urlsafe(32)


class JsonReceiptStore:
    """JSON-only receipt store test double with atomic-operation semantics.

    Production stores implement these same state transitions transactionally.
    No waiter, callback, future, connection or process identity belongs in a
    row.  Process-local coalescing may exist beside this store, never inside it.
    """

    def __init__(
        self,
        rows: Mapping[str, Mapping[str, Any]] | None = None,
        *,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        self._rows: dict[str, dict[str, Any]] = {
            key: dict(value) for key, value in (rows or {}).items()
        }
        self._token_factory = token_factory or _token

    @staticmethod
    def _row_id(scope: Mapping[str, Any], call_id: str) -> str:
        return _canonical([authority_key(scope), call_id])

    def inspect(self, scope: Mapping[str, Any], call_id: str) -> dict[str, Any]:
        row = self._rows.get(self._row_id(scope, call_id))
        if row is None:
            return {"state": "absent"}
        if row["state"] in {"settled_success", "settled_error"}:
            return {"state": "settled", "row": json.loads(_canonical(row))}
        if row["state"] != "reserved":
            return {"state": "unrecognised"}
        if row.get("owner_live"):
            return {"state": "in_flight"}
        return {"state": "unknown_disposition"}

    def reserve(
        self,
        scope: Mapping[str, Any],
        call_id: str,
        digest: str,
        execution_binding: Mapping[str, Any],
    ) -> dict[str, Any]:
        row_id = self._row_id(scope, call_id)
        row = self._rows.get(row_id)
        if row is not None:
            if row.get("request_digest") != digest:
                return {"state": "conflict"}
            return self.inspect(scope, call_id)

        owner_token = self._token_factory()
        row = {
            "authority_key": authority_key(scope),
            "call_id": call_id,
            "state": "reserved",
            "request_digest": digest,
            "execution_binding": json.loads(_canonical(execution_binding)),
            "owner_token": owner_token,
            "owner_live": True,
            "result": None,
            "error": None,
        }
        # Validate before admission so an invalid durable row never exists.
        _require_json_safe(row)
        self._rows[row_id] = row
        return {"state": "acquired", "owner_token": owner_token}

    def settle(
        self,
        scope: Mapping[str, Any],
        call_id: str,
        *,
        digest: str,
        owner_token: str,
        result: Any = None,
        error: Any = None,
    ) -> dict[str, Any]:
        row_id = self._row_id(scope, call_id)
        row = self._rows.get(row_id)
        if row is None:
            return {"ok": False, "reason": "no_reservation"}
        if row.get("state") != "reserved":
            return {"ok": False, "reason": "already_terminal"}
        if row.get("owner_token") != owner_token:
            return {"ok": False, "reason": "wrong_owner"}
        if row.get("request_digest") != digest:
            return {"ok": False, "reason": "wrong_digest"}

        state = "settled_error" if error is not None else "settled_success"
        updated = {
            **row,
            "state": state,
            "owner_live": False,
            "result": result,
            "error": error,
        }
        _require_json_safe(updated)
        self._rows[row_id] = json.loads(_canonical(updated))
        return {"ok": True, "state": state}

    def lose_owner(self, scope: Mapping[str, Any], call_id: str) -> None:
        row = self._rows.get(self._row_id(scope, call_id))
        if row is not None and row.get("state") == "reserved":
            row["owner_live"] = False

    def has_scope(self, scope: Mapping[str, Any]) -> bool:
        key = authority_key(scope)
        return any(row.get("authority_key") == key for row in self._rows.values())

    def snapshot_json(self) -> str:
        _require_json_safe(self._rows)
        return _canonical({"kind": "receipt-store-snapshot", "version": 1, "rows": self._rows})

    @classmethod
    def from_json(
        cls,
        payload: str,
        *,
        token_factory: Callable[[], str] | None = None,
    ) -> "JsonReceiptStore":
        parsed = json.loads(payload)
        if parsed.get("kind") != "receipt-store-snapshot" or parsed.get("version") != 1:
            raise ValueError("unsupported receipt store snapshot")
        rows = parsed.get("rows")
        if not isinstance(rows, dict):
            raise ValueError("receipt store rows must be an object")
        reconstructed: dict[str, dict[str, Any]] = {}
        for row_id, value in rows.items():
            if not isinstance(value, dict):
                raise ValueError("receipt store row must be an object")
            row = dict(value)
            if row.get("state") == "reserved":
                # The old process owner cannot survive reconstruction.
                row["owner_live"] = False
            reconstructed[row_id] = row
        _require_json_safe(reconstructed)
        return cls(reconstructed, token_factory=token_factory)


def _require_json_safe(value: Any) -> None:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise TypeError("durable rows must contain only finite JSON-safe values") from exc


def admit_continuation(
    trusted: Mapping[str, Any],
    presented: str | None,
    store: JsonReceiptStore,
    *,
    token_factory: Callable[[], str] | None = None,
) -> dict[str, Any]:
    if presented is not None and (not isinstance(presented, str) or not 0 < len(presented) <= 128):
        return {"outcome": "error", "reason": "invalid_arguments"}
    claimed = trusted.get("claimed_principal_id")
    if claimed and claimed != trusted.get("principal_id"):
        return {"outcome": "error", "reason": "principal_mismatch"}

    if presented:
        candidate = {**trusted, "continuation_id": presented}
        if store.has_scope(candidate):
            return {"outcome": "ok", "continuity": "resumed", "continuation_id": presented}

    minted = (token_factory or _token)()
    return {"outcome": "ok", "continuity": "created", "continuation_id": minted}


class ReferenceHost:
    """Trusted Python execution boundary for conformance and host prototypes."""

    def __init__(
        self,
        dictionary: Mapping[str, Any],
        host_state: Mapping[str, Any],
        store: JsonReceiptStore,
        provider_extension_policies: Mapping[str, list[str]] | None = None,
    ) -> None:
        self.dictionary = json.loads(_canonical(dictionary))
        self.host_state = json.loads(_canonical(host_state))
        self.store = store
        self.provider_extension_policies = {
            primitive: frozenset(parameters)
            for primitive, parameters in (provider_extension_policies or {}).items()
        }

    def _entry(self, primitive: str) -> Mapping[str, Any] | None:
        for entry in self.dictionary.get("primitives", []):
            if entry.get("name") == primitive:
                return entry
        return None

    def resolve(
        self, primitive: str, arguments: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        entry = self._entry(primitive)
        if entry is None or entry.get("effect") not in {"read_only", "mutation"}:
            return {"support": "unsupported", "reason": "capability_unavailable"}
        if self.host_state.get("transport_status") != "supported":
            return {"support": "unsupported", "reason": "transport_unavailable"}

        namespace = primitive.split(".", 1)[0]
        namespace_state = self.host_state.get("namespaces", {}).get(namespace)
        if not isinstance(namespace_state, Mapping):
            return {"support": "unsupported", "reason": "capability_unavailable"}
        provider = namespace_state.get("provider")
        registration = namespace_state.get("registrations", {}).get(provider)
        implementations = (
            registration.get("implements") if isinstance(registration, Mapping) else None
        )
        claims_namespace = isinstance(registration, Mapping) and registration.get("implements_namespace") is True
        if not claims_namespace and (
            not isinstance(implementations, (list, tuple)) or primitive not in implementations
        ):
            return {"support": "unsupported", "reason": "capability_unavailable"}
        effective_effect = entry["effect"]
        try:
            descriptor = _descriptor_contract.effective_descriptor(entry, registration, primitive)
        except _descriptor_contract.ProviderDescriptorError:
            return {"support": "unsupported", "reason": "capability_unavailable"}
        extensions = descriptor.get("provider_extensions", {})
        for parameter, declaration in extensions.items():
            if not isinstance(declaration, Mapping) or declaration.get("authority") not in {
                "same_as_primitive", "additional_policy"
            } or declaration.get("effect") not in {"same_as_primitive", "read", "mutation"}:
                return {"support": "unsupported", "reason": "capability_unavailable"}
            if arguments is None or parameter not in arguments:
                continue
            if (
                declaration["authority"] == "additional_policy"
                and parameter not in self.provider_extension_policies.get(primitive, ())
            ):
                return {"support": "unsupported", "reason": "capability_unavailable"}
            if declaration["effect"] == "mutation":
                effective_effect = "mutation"
        if effective_effect == "mutation" and self.host_state.get("preflight") != "durable_mutation_store_ready":
            return {"support": "unsupported", "reason": "preflight_required"}
        return {
            "support": "supported",
            "reason": None,
            "provider": provider,
            "primitive_version": entry.get("version"),
            "effect": effective_effect,
            "descriptor": descriptor,
        }

    def call(
        self,
        scope: Mapping[str, Any],
        call: Mapping[str, Any],
        handler: Callable[[Mapping[str, Any]], Any],
    ) -> dict[str, Any]:
        if scope.get("principal_id") != self.host_state.get("principal_id"):
            return _error("principal_mismatch")

        entry = self._entry(str(call.get("primitive")))
        primitive_version = entry.get("version") if entry else None
        digest = request_digest(
            {
                "primitive": call.get("primitive"),
                "arguments": call.get("arguments", {}),
                "primitive_version": primitive_version,
            }
        )
        call_id = str(call.get("call_id"))
        existing = self.store.inspect(scope, call_id)
        if existing["state"] != "absent":
            row = existing.get("row")
            if row is not None and row.get("request_digest") != digest:
                return _error("call_id_conflict")
            if existing["state"] == "settled":
                capability = self.resolve(str(call.get("primitive")), call.get("arguments", {}))
                if row["state"] == "settled_error":
                    return {
                        "type": "action_error",
                        "error": row["error"],
                        "executed": False,
                        "from_receipt": True,
                        "execution_binding": row["execution_binding"],
                        "current_capability": capability,
                    }
                return {
                    "type": "action_call_output",
                    "result": row["result"],
                    "executed": False,
                    "from_receipt": True,
                    "execution_binding": row["execution_binding"],
                    "current_capability": capability,
                }
            if existing["state"] == "in_flight":
                return _error("reconcile_required", "owner_in_flight")
            return _error("unknown_disposition")

        capability = self.resolve(str(call.get("primitive")), call.get("arguments", {}))
        if capability["support"] != "supported":
            return _error("capability_unavailable", capability["reason"])
        if not _descriptor_contract.validate_instance(
            capability["descriptor"]["input_schema"], call.get("arguments", {})
        ):
            return _error("invalid_arguments")

        execution_binding = {
            "provider": capability["provider"],
            "primitive_version": capability["primitive_version"],
            "effect": capability["effect"],
            "host_revision": self.host_state.get("revision"),
        }
        claim = self.store.reserve(scope, call_id, digest, execution_binding)
        if claim["state"] == "conflict":
            return _error("call_id_conflict")
        if claim["state"] != "acquired":
            return _error("reconcile_required", claim["state"])

        try:
            result = handler(call)
            written = self.store.settle(
                scope,
                call_id,
                digest=digest,
                owner_token=claim["owner_token"],
                result=result,
            )
        except Exception as exc:  # reference boundary turns failures into receipts
            error = {"code": "handler_failed", "message": str(exc)}
            written = self.store.settle(
                scope,
                call_id,
                digest=digest,
                owner_token=claim["owner_token"],
                error=error,
            )
            if not written["ok"]:
                return _error("reconcile_required", written["reason"], executed=True)
            return {
                "type": "action_error",
                "error": error,
                "executed": True,
                "from_receipt": False,
                "execution_binding": execution_binding,
            }

        if not written["ok"]:
            return _error("reconcile_required", written["reason"], executed=True)
        return {
            "type": "action_call_output",
            "result": result,
            "executed": True,
            "from_receipt": False,
            "execution_binding": execution_binding,
        }


def _error(code: str, reason: str | None = None, *, executed: bool = False) -> dict[str, Any]:
    error = {"code": code}
    if reason is not None:
        error["reason"] = reason
    return {
        "type": "action_error",
        "error": error,
        "executed": executed,
        "from_receipt": False,
    }
