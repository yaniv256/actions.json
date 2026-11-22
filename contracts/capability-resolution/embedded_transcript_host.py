"""Reusable trusted-host boundary for embedded-agent transcript storage.

The browser or model may present an opaque session identifier, but it never
supplies tenant, installation, or principal authority.  A host binds those
values from its authenticated identity before exposing any transcript action.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any


UNTRUSTED_TRANSCRIPT_DATA = "untrusted_transcript_data"


def authority_from_identity(transcript_module: Any, identity: Any) -> Any:
    """Construct storage authority exclusively from a trusted host identity."""
    return transcript_module.Authority(
        identity.tenant_id,
        identity.installation_id,
        identity.principal_id,
    )


@dataclass(frozen=True)
class EmbeddedTranscriptHost:
    """Process-persistent transcript capability shared by embedded runtimes."""

    service: Any
    transcript_module: Any
    turns: Any

    @classmethod
    def from_service(cls, service: Any, transcript_module: Any) -> "EmbeddedTranscriptHost":
        return cls(
            service=service,
            transcript_module=transcript_module,
            turns=transcript_module.TranscriptTurnCoordinator(service),
        )

    def bind(self, identity: Any) -> "BoundTranscriptHost":
        return BoundTranscriptHost(
            host=self,
            authority=authority_from_identity(self.transcript_module, identity),
        )


@dataclass(frozen=True)
class BoundTranscriptHost:
    """Transcript operations bound to one authenticated principal."""

    host: EmbeddedTranscriptHost
    authority: Any

    def create_session(self) -> str:
        """Create a new opaque session within this principal's authority."""
        return self.host.service.create_session(self.authority)

    def resume_session(self, session_id: str) -> str:
        """Validate and resume an explicit opaque session identifier."""
        _require_session_id(session_id)
        # A bounded read performs the service's uniform ownership check without
        # exposing whether a foreign identifier exists.
        self.host.service.read_transcript(
            self.authority,
            session_id,
            limit=1,
        )
        return session_id

    def handlers(self) -> dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]:
        return {
            "transcript.session.list": self.list_sessions,
            "transcript.session.read": self.read_model_memory,
        }

    def list_sessions(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        limit = arguments.get("limit", 100)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
            raise ValueError("limit must be an integer from 1 through 500")
        after = arguments.get("after", "")
        if not isinstance(after, str):
            raise ValueError("after must be a string")
        sessions, next_after = self.host.service.list_sessions(
            self.authority,
            after=after,
            limit=limit,
        )
        return {"sessions": list(sessions), "next_after": next_after}

    def read_model_memory(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        session_id = arguments.get("session_id")
        _require_session_id(session_id)
        max_bytes = arguments.get("max_bytes", 64 * 1024)
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or not 1 <= max_bytes <= 64 * 1024
        ):
            raise ValueError("max_bytes must be an integer from 1 through 65536")
        page = self.host.service.read_memory(
            self.authority,
            session_id,
            max_bytes=max_bytes,
        )
        return {
            "session_id": session_id,
            "trust": UNTRUSTED_TRANSCRIPT_DATA,
            "events": [
                {
                    "sequence": event.sequence,
                    "kind": event.kind,
                    "payload": event.payload,
                    "trust": UNTRUSTED_TRANSCRIPT_DATA,
                }
                for event in page.events
            ],
        }

    def append_event(
        self,
        session_id: str,
        kind: str,
        payload: Any,
        idempotency_key: str,
    ) -> Any:
        _require_session_id(session_id)
        return self.host.service.append_event(
            self.authority,
            session_id,
            kind,
            payload,
            idempotency_key,
        )

    def append_turn(
        self,
        session_id: str,
        events: Sequence[tuple[str, Any, str]],
    ) -> tuple[Any, ...]:
        """Persist a causal turn atomically with respect to memory clearing."""
        _require_session_id(session_id)
        return self.host.turns.append_turn(
            self.authority,
            session_id,
            list(events),
        )

    def clear_memory(self, session_id: str, idempotency_key: str) -> str:
        """Append a model-memory boundary without deleting transcript history."""
        _require_session_id(session_id)
        self.host.turns.clear_memory(self.authority, session_id, idempotency_key)
        return session_id

    def read_full_transcript(self, session_id: str, *, after: int = 0, limit: int = 100) -> Any:
        _require_session_id(session_id)
        return self.host.service.read_transcript(
            self.authority,
            session_id,
            after=after,
            limit=limit,
        )

    def record_action_result(
        self,
        session_id: str,
        call: Mapping[str, Any],
        result: Mapping[str, Any],
    ) -> Any:
        """Persist one terminal action outcome during the active request.

        Refusals are first-class events.  Only the browser-safe public code and
        an opaque correlation identifier are retained; trusted provider errors
        never enter transcript data.
        """
        _require_session_id(session_id)
        call_id = call.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            call_id = f"missing-{secrets.token_hex(16)}"
        primitive = call.get("primitive")
        if not isinstance(primitive, str) or not primitive:
            primitive = "unknown"
        if result.get("type") == "action_error":
            error = result.get("error")
            code = error.get("code") if isinstance(error, Mapping) else None
            if not isinstance(code, str) or not code:
                code = "action_refused"
            correlation_id = result.get("correlation_id")
            if not isinstance(correlation_id, str) or not correlation_id:
                correlation_id = "transcript-" + hashlib.sha256(
                    f"actions-json/refusal/v1\n{call_id}\n{primitive}\n".encode("utf-8")
                ).hexdigest()[:32]
            return self.append_event(
                session_id,
                "action_refusal",
                {
                    "call_id": call_id,
                    "primitive": primitive,
                    "code": code,
                    "correlation_id": correlation_id,
                },
                f"action-refusal:{call_id}",
            )
        return self.append_event(
            session_id,
            "tool_result",
            {
                "call_id": call_id,
                "primitive": primitive,
                "type": result.get("type", "action_call_output"),
            },
            f"action-result:{call_id}",
        )


@dataclass(frozen=True)
class TranscriptRecordingActionHost:
    """Decorate a trusted action host with synchronous transcript custody."""

    action_host: Any
    transcripts: BoundTranscriptHost
    session_id: str

    def handle(self, call: Mapping[str, Any], continuation_id: str | None) -> dict[str, Any]:
        result = self.action_host.handle(call, continuation_id)
        self.transcripts.record_action_result(self.session_id, call, result)
        return result

    def __getattr__(self, name: str) -> Any:
        return getattr(self.action_host, name)


def _require_session_id(session_id: Any) -> None:
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("session_id is required")
