"""Turnkey read-only acceptance support for Streamlit container runtime.

This fixture deliberately uses the JSON receipt store test double.  It proves
browser transport, authenticated identity binding, reconstruction, and replay;
it is not the production mutation-store acceptance.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys
import threading
from collections.abc import Callable, Mapping
from functools import cache
from typing import Any
from urllib.parse import unquote


CALL_ID = "streamlit-container-v2-read-1"
PROVIDER_REVISION = "sha256:" + hashlib.sha256(
    b"actions-json/streamlit-snowflake-read-acceptance/v1"
).hexdigest()


def _load_module(name: str, path: pathlib.Path) -> Any:
    loaded = sys.modules.get(name)
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


@cache
def _contract_module(root: pathlib.Path) -> Any:
    contract = root / "contracts" / "capability-resolution"
    return _load_module(
        "actions_json_acceptance_projection",
        contract / "streamlit_projection.py",
    )


class _LockedReceiptStore:
    """Serialize access to the diagnostic JSON store in a shared container."""

    def __init__(self, store: Any) -> None:
        self._store = store
        self._lock = threading.RLock()

    def inspect(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._store.inspect(*args, **kwargs)

    def reserve(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._store.reserve(*args, **kwargs)

    def settle(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._store.settle(*args, **kwargs)

    def has_scope(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._store.has_scope(*args, **kwargs)


class AcceptanceResources:
    """Process-persistent resources shared across Streamlit reconstructions."""

    def __init__(
        self,
        *,
        query: Callable[[], list[Any]] | None = None,
        page_provider: Any | None = None,
    ) -> None:
        if (query is None) == (page_provider is None):
            raise ValueError("configure exactly one database backend")
        self._query = query
        self._page_provider = page_provider
        self._lock = threading.RLock()
        self.provider_invocations = 0
        self.receipt_store: Any | None = None
        self.transcript_service: Any | None = None
        self._transcript_module: Any | None = None
        self.transcript_host: Any | None = None

    def ensure_store(self, root: pathlib.Path) -> Any:
        with self._lock:
            if self.receipt_store is None:
                contract = _contract_module(root)
                self.receipt_store = _LockedReceiptStore(contract.JsonReceiptStore())
            return self.receipt_store

    def read_page(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        if self._page_provider is not None:
            result = self._page_provider.read_page(arguments)
            with self._lock:
                self.provider_invocations += 1
            return result
        url = arguments.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError("url is required")
        assert self._query is not None
        rows = self._query()
        with self._lock:
            self.provider_invocations += 1
        return {
            "url": url,
            "text": "Snowflake provider read completed through the trusted embedded host.",
            "rows_observed": len(rows),
            "backend": "snowflake",
        }

    def handlers(self) -> dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]:
        handlers = {"database.page.read": self.read_page}
        if self._page_provider is not None:
            handlers["database.page.search"] = self.search_pages
        return handlers

    def enable_transcripts(self, root: pathlib.Path, database_path: pathlib.Path) -> None:
        module = _load_module(
            "actions_json_transcript_service",
            root / "contracts" / "capability-resolution" / "transcript_service.py",
        )
        self._transcript_module = module
        self.transcript_service = module.TranscriptService(
            module.SQLiteTranscriptStore(database_path),
            module.StaticMembershipResolver(),
        )
        host_module = _load_module(
            "actions_json_embedded_transcript_host",
            root / "contracts" / "capability-resolution" / "embedded_transcript_host.py",
        )
        self.transcript_host = host_module.EmbeddedTranscriptHost.from_service(
            self.transcript_service,
            module,
        )

    def enable_transcripts_url(self, root: pathlib.Path, database_url: str) -> None:
        """Configure the shipped transcript store from an explicit database URL."""
        module = _load_module(
            "actions_json_transcript_service",
            root / "contracts" / "capability-resolution" / "transcript_service.py",
        )
        if database_url.startswith("sqlite://"):
            database = unquote(database_url.removeprefix("sqlite://"))
            if not database:
                raise ValueError("SQLite transcript URL must name a database file")
            store = module.SQLiteTranscriptStore(
                pathlib.Path(database).expanduser().resolve()
            )
        elif database_url.startswith(("postgres://", "postgresql://")):
            try:
                import psycopg
            except ImportError as error:
                raise RuntimeError("PostgreSQL transcript support requires psycopg") from error
            store = module.PostgreSQLTranscriptStore(
                lambda: psycopg.connect(database_url)
            )
        else:
            raise ValueError(
                "transcript database URL must use sqlite://, postgres://, or postgresql://"
            )
        self._transcript_module = module
        self.transcript_service = module.TranscriptService(
            store,
            module.StaticMembershipResolver(),
        )
        host_module = _load_module(
            "actions_json_embedded_transcript_host",
            root / "contracts" / "capability-resolution" / "embedded_transcript_host.py",
        )
        self.transcript_host = host_module.EmbeddedTranscriptHost.from_service(
            self.transcript_service,
            module,
        )

    def _require_transcripts(self) -> tuple[Any, Any]:
        if self.transcript_service is None or self._transcript_module is None:
            raise RuntimeError("transcript storage is not configured")
        return self.transcript_service, self._transcript_module

    def _bound_transcripts(self, identity: Any) -> Any:
        self._require_transcripts()
        if self.transcript_host is None:
            raise RuntimeError("transcript host is not configured")
        return self.transcript_host.bind(identity)

    def transcript_handlers(
        self, identity: Any
    ) -> dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]:
        if self.transcript_host is None:
            return {}
        return self._bound_transcripts(identity).handlers()

    def create_transcript_session(self, identity: Any) -> str:
        return self._bound_transcripts(identity).create_session()

    def resume_transcript_session(self, identity: Any, session_id: str) -> str:
        return self._bound_transcripts(identity).resume_session(session_id)

    def record_transcript_event(
        self,
        identity: Any,
        session_id: str,
        kind: str,
        payload: Any,
        idempotency_key: str,
    ) -> Any:
        return self._bound_transcripts(identity).append_event(
            session_id, kind, payload, idempotency_key
        )

    def record_transcript_turn(
        self,
        identity: Any,
        session_id: str,
        events: list[tuple[str, Any, str]],
    ) -> tuple[Any, ...]:
        """Persist one complete turn without allowing a clear boundary to split it."""
        return self._bound_transcripts(identity).append_turn(session_id, events)

    def clear_transcript_memory(
        self, identity: Any, session_id: str, idempotency_key: str
    ) -> str:
        return self._bound_transcripts(identity).clear_memory(
            session_id, idempotency_key
        )

    def read_full_transcript(self, identity: Any, session_id: str) -> Any:
        return self._bound_transcripts(identity).read_full_transcript(session_id)

    def transcript_evidence(self, identity: Any, session_id: str) -> dict[str, Any]:
        """Return bounded, principal-authorized acceptance evidence.

        Event payloads can contain user or provider data, so the shared
        Streamlit evidence panel receives only the count and event kinds.
        """
        transcript = self.read_full_transcript(identity, session_id)
        events = tuple(transcript.events)
        return {
            "event_count": len(events),
            "event_kinds": [event.kind for event in events],
        }

    def recording_host(self, identity: Any, action_host: Any, session_id: str) -> Any:
        """Wrap an action host so every terminal outcome is durably recorded."""
        if self.transcript_host is None:
            return action_host
        host_module = _load_module(
            "actions_json_embedded_transcript_host",
            pathlib.Path(__file__).resolve().parents[2]
            / "contracts"
            / "capability-resolution"
            / "embedded_transcript_host.py",
        )
        return host_module.TranscriptRecordingActionHost(
            action_host,
            self._bound_transcripts(identity),
            session_id,
        )

    def search_pages(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        if self._page_provider is None:
            raise RuntimeError("page search is not configured")
        result = self._page_provider.search_pages(arguments)
        with self._lock:
            self.provider_invocations += 1
        return result


def database_resources(root: pathlib.Path, database_url: str) -> AcceptanceResources:
    module = _load_module(
        "actions_json_database_page_provider",
        root / "contracts" / "capability-resolution" / "database_page_provider.py",
    )
    return AcceptanceResources(page_provider=module.provider_from_url(database_url))


def acceptance_call() -> dict[str, Any]:
    return {
        "type": "action_call",
        "call_id": CALL_ID,
        "primitive": "database.page.read",
        "primitive_version": 1,
        "arguments": {"url": "snowflake://actions-json/transport-probe"},
    }


def build_host(
    *,
    root: pathlib.Path,
    user: Any,
    resources: AcceptanceResources,
    tenant_id: str = "snowflake-target-account",
    installation_id: str = "actions-json-streamlit-acceptance",
) -> Any:
    root = root.resolve()
    contract = _contract_module(root)
    dictionary = _acceptance_dictionary(root)
    identity = contract.identity_from_streamlit_user(
        user,
        tenant_id=tenant_id,
        installation_id=installation_id,
        projection="streamlit-container-v2",
        authority_mode="caller_rights",
    )
    providers = contract.ProviderRegistry()
    handlers = resources.handlers()
    handlers.update(resources.transcript_handlers(identity))
    providers.register(
        "snowflake-read-acceptance",
        handlers,
        revision=PROVIDER_REVISION,
        descriptors=_provider_descriptors(dictionary, handlers),
    )
    return contract.StreamlitTrustedHost(
        dictionary=dictionary,
        identity=identity,
        projection="streamlit-container-v2",
        transport_status="supported",
        installation_revision="acceptance-v1",
        preflight="read_only_ready",
        providers=providers,
        receipt_store=resources.ensure_store(root),
    )


def _provider_descriptors(
    dictionary: Mapping[str, Any],
    handlers: Mapping[str, Callable[[Mapping[str, Any]], dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    """Bind the target canary to the same provider-owned v4 contract it tests.

    The acceptance provider currently implements the canonical wire schema, so
    its descriptor is an explicit copy rather than an independent widening.
    Keeping it on the registration is load-bearing: the target-account canary
    then exercises provider selection, descriptor fingerprinting, and
    call-boundary validation instead of silently falling back to canonical.
    """

    entries = {
        entry.get("name"): entry
        for entry in dictionary.get("primitives", [])
        if isinstance(entry, Mapping) and isinstance(entry.get("name"), str)
    }
    descriptors: dict[str, dict[str, Any]] = {}
    for primitive in handlers:
        entry = entries.get(primitive)
        if not isinstance(entry, Mapping):
            raise ValueError(f"handler has no canonical primitive: {primitive}")
        descriptor = {
            "summary": str(entry.get("summary", "")),
            "input_schema": dict(entry.get("input_schema", {})),
            "provider_extensions": {},
        }
        if isinstance(entry.get("output_schema"), Mapping):
            descriptor["output_schema"] = dict(entry["output_schema"])
        descriptors[primitive] = descriptor
    return descriptors


@cache
def _acceptance_dictionary(root: pathlib.Path) -> dict[str, Any]:
    dictionary = json.loads(
        (root / "runtime" / "actions-json-runtime" / "src" / "primitives" / "dictionary.v1.json").read_text(
            encoding="utf-8"
        )
    )
    for entry in dictionary["primitives"]:
        if entry.get("name") in {
            "database.page.read",
            "database.page.search",
            "transcript.session.list",
            "transcript.session.read",
        }:
            entry["effect"] = "read_only"
    return dictionary


@cache
def component_assets(directory: pathlib.Path) -> dict[str, str]:
    return {
        name: (directory / f"component.{name}").read_text(encoding="utf-8")
        for name in ("html", "css", "js")
    }


def mount(streamlit: Any, host: Any, *, root: pathlib.Path) -> dict[str, Any]:
    contract = _contract_module(root.resolve())
    assets = component_assets(pathlib.Path(__file__).resolve().parent)
    return contract.mount_container_v2(
        streamlit,
        host,
        name="actions_json_snowflake_acceptance",
        html=assets["html"],
        css=assets["css"],
        js=assets["js"],
        key="actions-json-snowflake-acceptance",
        input_data={"call": acceptance_call()},
    )
