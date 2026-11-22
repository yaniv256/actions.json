"""Authorization-first transcript storage contract and portable implementations.

Browser input never selects authority.  Callers must construct ``Authority`` from
their trusted host authentication boundary and pass opaque session identifiers.
"""

from __future__ import annotations

import copy
import hashlib
import json
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from cryptography.fernet import Fernet, InvalidToken


MAX_EVENT_BYTES = 256 * 1024
MAX_NESTING_DEPTH = 32
MAX_EVENTS_PER_SESSION = 10_000
MAX_SESSION_BYTES = 64 * 1024 * 1024
DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500
DEFAULT_MEMORY_BYTES = 64 * 1024
RECONCILIATION_TTL_SECONDS = 24 * 60 * 60
OUTBOX_CLAIM_LEASE_SECONDS = 30
REDACTED = "[REDACTED]"
SECRET_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
    }
)
EVENT_KINDS = frozenset(
    {
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "action_refusal",
        "memory_cleared",
        "correction",
    }
)


class TranscriptError(Exception):
    pass


class TranscriptNotFound(TranscriptError):
    """Uniform absence/authorization failure that discloses no object existence."""


class IdempotencyConflict(TranscriptError):
    pass


class ResourceLimitExceeded(TranscriptError):
    pass


class StorageUnavailable(TranscriptError):
    pass


@dataclass(frozen=True)
class Authority:
    tenant_id: str
    installation_id: str
    principal_id: str

    def __post_init__(self) -> None:
        if not all(isinstance(value, str) and value for value in self.scope):
            raise ValueError("authority fields must be non-empty strings")

    @property
    def scope(self) -> tuple[str, str, str]:
        return self.tenant_id, self.installation_id, self.principal_id


@dataclass(frozen=True)
class TranscriptEvent:
    sequence: int
    kind: str
    payload: Any
    idempotency_key: str
    digest: str
    created_at: float


@dataclass(frozen=True)
class TranscriptPage:
    session_id: str
    events: tuple[TranscriptEvent, ...]
    next_after: int | None = None
    canonical_bytes: int = 0


@dataclass(frozen=True)
class AppendResult:
    status: str
    event: TranscriptEvent | None = None
    reconciliation_token: str | None = None
    recoverable: bool = False


@dataclass(frozen=True)
class AuditEvent:
    sequence: int
    tenant_id: str
    installation_id: str
    actor_id: str
    action: str
    session_id: str
    created_at: float


@dataclass
class _Session:
    tenant_id: str
    installation_id: str
    principal_id: str
    session_id: str
    next_sequence: int = 1
    total_bytes: int = 0
    deleted_at: float | None = None
    purge_after: float | None = None


@dataclass
class _OutboxEntry:
    authority: Authority
    session_id: str
    kind: str
    payload: Any
    idempotency_key: str
    digest: str
    expires_at: float
    settled: bool = False


def generate_outbox_key() -> bytes:
    """Generate a host-managed key; the key must never be persisted beside the DB."""
    return Fernet.generate_key()


class EncryptedSQLiteOutbox:
    """Durable encrypted custody for bounded reconciliation.

    Tokens are stored only as SHA-256 hashes.  A transaction claims each record,
    preventing two reconcilers from concurrently treating it as unsettled.
    """

    def __init__(self, path: str | Path, key: bytes) -> None:
        self.path = str(path)
        self._cipher = Fernet(key)
        with sqlite3.connect(self.path) as db:
            db.execute(
                """CREATE TABLE IF NOT EXISTS transcript_outbox(
                token_hash TEXT PRIMARY KEY, ciphertext BLOB NOT NULL,
                expires_at REAL NOT NULL, claimed INTEGER NOT NULL DEFAULT 0,
                claimed_at REAL, settled INTEGER NOT NULL DEFAULT 0,
                quarantined INTEGER NOT NULL DEFAULT 0)"""
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(transcript_outbox)")}
            if "claimed_at" not in columns:
                db.execute("ALTER TABLE transcript_outbox ADD COLUMN claimed_at REAL")
            if "quarantined" not in columns:
                db.execute("ALTER TABLE transcript_outbox ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0")

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def put(self, token: str, entry: _OutboxEntry) -> None:
        document = {
            "authority": list(entry.authority.scope),
            "session_id": entry.session_id,
            "kind": entry.kind,
            "payload": entry.payload,
            "idempotency_key": entry.idempotency_key,
            "digest": entry.digest,
            "expires_at": entry.expires_at,
        }
        ciphertext = self._cipher.encrypt(canonical_json(document).encode("utf-8"))
        with sqlite3.connect(self.path) as db:
            db.execute(
                "INSERT INTO transcript_outbox(token_hash,ciphertext,expires_at) VALUES (?,?,?)",
                (self._hash(token), ciphertext, entry.expires_at),
            )

    def claim(self, token: str) -> _OutboxEntry | None:
        db = sqlite3.connect(self.path, isolation_level=None)
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT ciphertext,expires_at,claimed,claimed_at,settled,quarantined FROM transcript_outbox WHERE token_hash=?",
                (self._hash(token),),
            ).fetchone()
            now = time.time()
            claim_is_live = bool(row and row[2] and row[3] is not None and row[3] > now - OUTBOX_CLAIM_LEASE_SECONDS)
            if not row or row[1] <= now or claim_is_live or row[4] or row[5]:
                db.rollback()
                return None
            db.execute(
                "UPDATE transcript_outbox SET claimed=1,claimed_at=? WHERE token_hash=?",
                (now, self._hash(token)),
            )
            db.commit()
        finally:
            db.close()
        try:
            document = json.loads(self._cipher.decrypt(row[0]).decode("utf-8"))
        except (InvalidToken, ValueError, TypeError) as error:
            self.quarantine(token)
            raise StorageUnavailable("outbox ciphertext failed authentication") from error
        return _OutboxEntry(
            Authority(*document["authority"]), document["session_id"], document["kind"],
            document["payload"], document["idempotency_key"], document["digest"],
            document["expires_at"], False,
        )

    def release(self, token: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE transcript_outbox SET claimed=0,claimed_at=NULL WHERE token_hash=? AND settled=0", (self._hash(token),))

    def settle(self, token: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE transcript_outbox SET settled=1,claimed=0,claimed_at=NULL,ciphertext=X'' WHERE token_hash=?", (self._hash(token),))

    def quarantine(self, token: str) -> None:
        """Retain authenticated custody evidence while preventing automatic retries."""
        with sqlite3.connect(self.path) as db:
            db.execute(
                "UPDATE transcript_outbox SET quarantined=1,claimed=0,claimed_at=NULL WHERE token_hash=?",
                (self._hash(token),),
            )


class MembershipResolver(Protocol):
    def role_for(self, authority: Authority) -> str: ...


class StaticMembershipResolver:
    """Deterministic test/reference resolver; production hosts inject live membership."""

    def __init__(self) -> None:
        self._roles: dict[tuple[str, str, str], str] = {}
        self.available = True

    def set_role(self, authority: Authority, role: str) -> None:
        if role not in {"owner", "developer", "not_member"}:
            raise ValueError("unsupported membership role")
        self._roles[authority.scope] = role

    def role_for(self, authority: Authority) -> str:
        if not self.available:
            return "unavailable"
        return self._roles.get(authority.scope, "not_member")


def _depth(value: Any, current: int = 0) -> int:
    if current > MAX_NESTING_DEPTH:
        return current
    if isinstance(value, dict):
        return max((_depth(item, current + 1) for item in value.values()), default=current)
    if isinstance(value, (list, tuple)):
        return max((_depth(item, current + 1) for item in value), default=current)
    return current


def redact(value: Any) -> Any:
    """Return a deep redacted copy; caller-owned data is never mutated."""
    if isinstance(value, dict):
        return {
            str(key): REDACTED if str(key).lower() in SECRET_KEYS else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def event_digest(kind: str, payload: Any) -> str:
    preimage = b"actions.json/transcript-event/v1\x00" + canonical_json(
        {"kind": kind, "payload": payload}
    ).encode("utf-8")
    return hashlib.sha256(preimage).hexdigest()


def _prepare_event(kind: str, payload: Any, idempotency_key: str) -> tuple[Any, str, int]:
    if kind not in EVENT_KINDS:
        raise ValueError("unsupported transcript event kind")
    if not isinstance(idempotency_key, str) or not idempotency_key:
        raise ValueError("idempotency_key must be non-empty")
    if _depth(payload) > MAX_NESTING_DEPTH:
        raise ResourceLimitExceeded("event nesting exceeds 32 levels")
    safe = redact(copy.deepcopy(payload))
    encoded = canonical_json(safe).encode("utf-8")
    if len(encoded) > MAX_EVENT_BYTES:
        raise ResourceLimitExceeded("event exceeds 256 KiB")
    return safe, event_digest(kind, safe), len(encoded)


class TranscriptStore(Protocol):
    def create_session(self, authority: Authority, session_id: str) -> None: ...
    def append(self, authority: Authority, session_id: str, kind: str, payload: Any,
               idempotency_key: str, digest: str, payload_bytes: int) -> tuple[str, TranscriptEvent]: ...
    def session(self, authority: Authority, session_id: str) -> _Session | None: ...
    def list_sessions(self, authority: Authority, after: str, limit: int) -> list[_Session]: ...
    def events(self, authority: Authority, session_id: str, after: int, limit: int) -> list[TranscriptEvent]: ...
    def audit(self, authority: Authority, action: str, session_id: str) -> AuditEvent: ...
    def soft_delete(self, authority: Authority, session_id: str, purge_after: float) -> None: ...
    def restore_with_audit(self, authority: Authority, session_id: str) -> None: ...
    def uninstall(self, authority: Authority) -> None: ...
    def purge_expired(self, now: float | None = None, limit: int = 100) -> int: ...


class InMemoryTranscriptStore:
    def __init__(self) -> None:
        self.sessions: dict[str, _Session] = {}
        self._events: dict[str, list[TranscriptEvent]] = {}
        self._keys: dict[tuple[str, str], TranscriptEvent] = {}
        self.audit_events: list[AuditEvent] = []
        self.fail_appends = False
        self.fail_audit = False
        self._lock = threading.RLock()

    def create_session(self, authority: Authority, session_id: str) -> None:
        with self._lock:
            if session_id in self.sessions:
                raise IdempotencyConflict("session identifier already exists")
            self.sessions[session_id] = _Session(*authority.scope, session_id)
            self._events[session_id] = []

    def session(self, authority: Authority, session_id: str) -> _Session | None:
        with self._lock:
            value = self.sessions.get(session_id)
            return copy.deepcopy(value) if value else None

    def list_sessions(self, authority: Authority, after: str, limit: int) -> list[_Session]:
        with self._lock:
            values = [
                copy.deepcopy(session)
                for session in self.sessions.values()
                if (session.tenant_id, session.installation_id, session.principal_id) == authority.scope
                and session.deleted_at is None
            ]
        return [
            item
            for item in sorted(values, key=lambda item: item.session_id)
            if item.session_id > after
        ][:limit]

    def append(self, authority: Authority, session_id: str, kind: str, payload: Any,
               idempotency_key: str, digest: str, payload_bytes: int) -> tuple[str, TranscriptEvent]:
        with self._lock:
            if self.fail_appends:
                raise StorageUnavailable("transcript store unavailable")
            session = self.sessions.get(session_id)
            if not session or session.deleted_at is not None or session.principal_id != authority.principal_id or (
                session.tenant_id, session.installation_id
            ) != authority.scope[:2]:
                raise TranscriptNotFound()
            prior = self._keys.get((session_id, idempotency_key))
            if prior:
                if prior.digest != digest or prior.kind != kind:
                    raise IdempotencyConflict("idempotency key already has different content")
                return "already_persisted", copy.deepcopy(prior)
            if len(self._events[session_id]) >= MAX_EVENTS_PER_SESSION or session.total_bytes + payload_bytes > MAX_SESSION_BYTES:
                raise ResourceLimitExceeded("session quota exceeded")
            event = TranscriptEvent(session.next_sequence, kind, copy.deepcopy(payload), idempotency_key, digest, time.time())
            session.next_sequence += 1
            session.total_bytes += payload_bytes
            self._events[session_id].append(event)
            self._keys[(session_id, idempotency_key)] = event
            return "persisted", copy.deepcopy(event)

    def events(self, authority: Authority, session_id: str, after: int, limit: int) -> list[TranscriptEvent]:
        with self._lock:
            return copy.deepcopy([event for event in self._events.get(session_id, []) if event.sequence > after][:limit])

    def audit(self, authority: Authority, action: str, session_id: str) -> AuditEvent:
        with self._lock:
            if self.fail_audit:
                raise StorageUnavailable("audit store unavailable")
            event = AuditEvent(len(self.audit_events) + 1, authority.tenant_id, authority.installation_id,
                               authority.principal_id, action, session_id, time.time())
            self.audit_events.append(event)
            return event

    def soft_delete(self, authority: Authority, session_id: str, purge_after: float) -> None:
        with self._lock:
            session = self.sessions.get(session_id)
            if not session or session.principal_id != authority.principal_id or authority.scope[:2] != (session.tenant_id, session.installation_id):
                raise TranscriptNotFound()
            session.deleted_at = time.time()
            session.purge_after = purge_after

    def restore_with_audit(self, authority: Authority, session_id: str) -> None:
        with self._lock:
            session = self.sessions.get(session_id)
            now = time.time()
            if not session or session.deleted_at is None or (session.purge_after is not None and session.purge_after <= now):
                raise TranscriptNotFound()
            self.audit(authority, "developer_restore", session_id)
            session.deleted_at = None
            session.purge_after = None

    def uninstall(self, authority: Authority) -> None:
        with self._lock:
            doomed = [sid for sid, s in self.sessions.items() if (s.tenant_id, s.installation_id) == authority.scope[:2]]
            for session_id in doomed:
                self.sessions.pop(session_id, None)
                self._events.pop(session_id, None)
                for key in [key for key in self._keys if key[0] == session_id]:
                    self._keys.pop(key, None)

    def purge_expired(self, now: float | None = None, limit: int = 100) -> int:
        now = time.time() if now is None else now
        with self._lock:
            doomed = [sid for sid, s in self.sessions.items() if s.purge_after is not None and s.purge_after <= now][:limit]
            for session_id in doomed:
                self.sessions.pop(session_id, None)
                self._events.pop(session_id, None)
                for key in [key for key in self._keys if key[0] == session_id]:
                    self._keys.pop(key, None)
            return len(doomed)


class TranscriptService:
    def __init__(self, store: TranscriptStore, membership: MembershipResolver,
                 *, token_factory: Callable[[], str] | None = None,
                 outbox: EncryptedSQLiteOutbox | None = None) -> None:
        self.store = store
        self.membership = membership
        self._token_factory = token_factory or (lambda: secrets.token_urlsafe(32))
        self._outbox = outbox

    def create_session(self, authority: Authority) -> str:
        session_id = secrets.token_urlsafe(24)
        self.store.create_session(authority, session_id)
        return session_id

    def _owned_session(self, authority: Authority, session_id: str, *, visible: bool = True) -> _Session:
        session = self.store.session(authority, session_id)
        if not session or (session.tenant_id, session.installation_id, session.principal_id) != authority.scope:
            raise TranscriptNotFound()
        if visible and session.deleted_at is not None:
            raise TranscriptNotFound()
        return session

    def append_event(self, authority: Authority, session_id: str, kind: str, payload: Any,
                     idempotency_key: str) -> AppendResult:
        self._owned_session(authority, session_id)
        safe, digest, size = _prepare_event(kind, payload, idempotency_key)
        if kind == "correction":
            target = safe.get("corrects_sequence") if isinstance(safe, dict) else None
            if not isinstance(target, int) or target < 1:
                raise TranscriptNotFound()
            prior = self.store.events(authority, session_id, target - 1, 1)
            if not prior or prior[0].sequence != target:
                raise TranscriptNotFound()
        try:
            status, event = self.store.append(authority, session_id, kind, safe, idempotency_key, digest, size)
            return AppendResult(status, event)
        except StorageUnavailable:
            if self._outbox is None:
                return AppendResult("history_not_persisted", recoverable=False)
            token = self._token_factory()
            try:
                self._outbox.put(
                    token,
                    _OutboxEntry(authority, session_id, kind, safe, idempotency_key, digest,
                                 time.time() + RECONCILIATION_TTL_SECONDS),
                )
            except Exception:
                return AppendResult("history_not_persisted", recoverable=False)
            return AppendResult("history_not_persisted", reconciliation_token=token, recoverable=True)

    def reconcile(self, authority: Authority, token: str) -> AppendResult:
        if self._outbox is None:
            raise TranscriptNotFound()
        entry = self._outbox.claim(token)
        if not entry or entry.authority != authority or entry.expires_at <= time.time():
            if entry:
                self._outbox.release(token)
            raise TranscriptNotFound()
        try:
            self._owned_session(authority, entry.session_id)
            size = len(canonical_json(entry.payload).encode("utf-8"))
            status, event = self.store.append(authority, entry.session_id, entry.kind, entry.payload,
                                              entry.idempotency_key, entry.digest, size)
            self._outbox.settle(token)
            return AppendResult(status, event)
        except StorageUnavailable:
            self._outbox.release(token)
            raise
        except Exception:
            self._outbox.settle(token)
            raise

    def clear_memory(self, authority: Authority, session_id: str, idempotency_key: str) -> TranscriptEvent:
        result = self.append_event(authority, session_id, "memory_cleared", {}, idempotency_key)
        if result.event is None:
            raise StorageUnavailable("memory boundary was not persisted")
        return result.event

    def read_transcript(self, authority: Authority, session_id: str, *, after: int = 0,
                        limit: int = DEFAULT_PAGE_SIZE) -> TranscriptPage:
        session = self._owned_session(authority, session_id)
        return self._page(authority, session, after, limit)

    def list_sessions(
        self,
        authority: Authority,
        *,
        after: str = "",
        limit: int = DEFAULT_PAGE_SIZE,
    ) -> tuple[tuple[str, ...], str | None]:
        if not isinstance(limit, int) or limit < 1 or limit > MAX_PAGE_SIZE:
            raise ResourceLimitExceeded("session list limit must be between 1 and 500")
        if not isinstance(after, str):
            raise ValueError("session list cursor must be a string")
        sessions = self.store.list_sessions(authority, after, limit + 1)
        more = len(sessions) > limit
        sessions = sessions[:limit]
        identifiers = tuple(session.session_id for session in sessions)
        return identifiers, identifiers[-1] if more else None

    def _page(self, authority: Authority, session: _Session, after: int, limit: int) -> TranscriptPage:
        if not isinstance(limit, int) or limit < 1 or limit > MAX_PAGE_SIZE:
            raise ResourceLimitExceeded("page limit must be between 1 and 500")
        events = self.store.events(authority, session.session_id, after, limit + 1)
        more = len(events) > limit
        events = events[:limit]
        return TranscriptPage(session.session_id, tuple(events), events[-1].sequence if more else None,
                              sum(len(canonical_json(e.payload).encode("utf-8")) for e in events))

    def read_memory(self, authority: Authority, session_id: str,
                    *, max_bytes: int = DEFAULT_MEMORY_BYTES) -> TranscriptPage:
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or not 1 <= max_bytes <= DEFAULT_MEMORY_BYTES
        ):
            raise ResourceLimitExceeded("memory limit must be between 1 and 65536 bytes")
        session = self._owned_session(authority, session_id)
        all_events = self.store.events(authority, session_id, 0, MAX_EVENTS_PER_SESSION)
        boundary = max((event.sequence for event in all_events if event.kind == "memory_cleared"), default=0)
        candidates = [event for event in all_events if event.sequence > boundary and event.kind != "memory_cleared"]
        groups: list[list[TranscriptEvent]] = []
        for event in candidates:
            group_key = event.payload.get("causal_group") if isinstance(event.payload, dict) else None
            if group_key is not None and groups:
                previous = groups[-1][0]
                previous_key = previous.payload.get("causal_group") if isinstance(previous.payload, dict) else None
                if previous_key == group_key:
                    groups[-1].append(event)
                    continue
            groups.append([event])
        selected_groups: list[list[TranscriptEvent]] = []
        used = 0
        for group in reversed(groups):
            size = sum(
                len(canonical_json({"kind": event.kind, "payload": event.payload}).encode("utf-8"))
                for event in group
            )
            if size > max_bytes - used:
                break
            selected_groups.append(group)
            used += size
        selected = [event for group in reversed(selected_groups) for event in group]
        return TranscriptPage(session_id, tuple(selected), canonical_bytes=used)

    def developer_read(self, authority: Authority, session_id: str, *, after: int = 0,
                       limit: int = DEFAULT_PAGE_SIZE) -> TranscriptPage:
        if self.membership.role_for(authority) not in {"owner", "developer"}:
            raise TranscriptNotFound()
        session = self.store.session(authority, session_id)
        if not session or (session.tenant_id, session.installation_id) != authority.scope[:2] or session.deleted_at is not None:
            raise TranscriptNotFound()
        try:
            self.store.audit(authority, "developer_read", session_id)
        except StorageUnavailable as error:
            raise TranscriptNotFound() from error
        return self._page(authority, session, after, limit)

    def soft_delete(self, authority: Authority, session_id: str, *, recovery_seconds: int = 30 * 86400) -> None:
        self._owned_session(authority, session_id)
        self.store.soft_delete(authority, session_id, time.time() + recovery_seconds)

    def restore(self, authority: Authority, session_id: str) -> None:
        if self.membership.role_for(authority) not in {"owner", "developer"}:
            raise TranscriptNotFound()
        session = self.store.session(authority, session_id)
        if not session or (session.tenant_id, session.installation_id) != authority.scope[:2]:
            raise TranscriptNotFound()
        try:
            self.store.restore_with_audit(authority, session_id)
        except StorageUnavailable as error:
            raise TranscriptNotFound() from error

    def uninstall(self, authority: Authority) -> None:
        if self.membership.role_for(authority) not in {"owner", "developer"}:
            raise TranscriptNotFound()
        self.store.uninstall(authority)

    def purge_expired(self, *, now: float | None = None, limit: int = 100) -> int:
        if not isinstance(limit, int) or limit < 1 or limit > 1000:
            raise ResourceLimitExceeded("purge limit must be between 1 and 1000")
        return self.store.purge_expired(now, limit)


class TranscriptTurnCoordinator:
    """Serialize complete turns and user memory-clear boundaries per session."""

    def __init__(self, service: TranscriptService) -> None:
        self.service = service
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()

    def _session_lock(self, session_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(session_id, threading.RLock())

    def append_turn(
        self,
        authority: Authority,
        session_id: str,
        events: list[tuple[str, Any, str]],
    ) -> tuple[AppendResult, ...]:
        with self._session_lock(session_id):
            return tuple(
                self.service.append_event(authority, session_id, kind, payload, key)
                for kind, payload, key in events
            )

    def clear_memory(
        self, authority: Authority, session_id: str, idempotency_key: str
    ) -> TranscriptEvent:
        with self._session_lock(session_id):
            return self.service.clear_memory(authority, session_id, idempotency_key)


class SQLiteTranscriptStore:
    """File-backed adapter using BEGIN IMMEDIATE for atomic sequence allocation."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        try:
            connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            return connection
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error

    def _initialize(self) -> None:
        try:
            with self._connect() as db:
                db.executescript(SQLITE_MIGRATION)
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error

    def create_session(self, authority: Authority, session_id: str) -> None:
        try:
            with self._connect() as db:
                db.execute("INSERT INTO transcript_sessions VALUES (?, ?, ?, ?, 1, 0, NULL, NULL)",
                           (session_id, *authority.scope))
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error

    def session(self, authority: Authority, session_id: str) -> _Session | None:
        try:
            with self._connect() as db:
                row = db.execute("SELECT * FROM transcript_sessions WHERE session_id = ?", (session_id,)).fetchone()
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error
        return _Session(row["tenant_id"], row["installation_id"], row["principal_id"], row["session_id"],
                        row["next_sequence"], row["total_bytes"], row["deleted_at"], row["purge_after"]) if row else None

    def list_sessions(self, authority: Authority, after: str, limit: int) -> list[_Session]:
        try:
            with self._connect() as db:
                rows = db.execute(
                    "SELECT * FROM transcript_sessions WHERE tenant_id=? AND installation_id=? AND principal_id=? AND deleted_at IS NULL AND session_id>? ORDER BY session_id LIMIT ?",
                    (*authority.scope, after, limit),
                ).fetchall()
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error
        return [
            _Session(row["tenant_id"], row["installation_id"], row["principal_id"], row["session_id"],
                     row["next_sequence"], row["total_bytes"], row["deleted_at"], row["purge_after"])
            for row in rows
        ]

    def append(self, authority: Authority, session_id: str, kind: str, payload: Any,
               idempotency_key: str, digest: str, payload_bytes: int) -> tuple[str, TranscriptEvent]:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM transcript_sessions WHERE session_id = ?", (session_id,)).fetchone()
            if not row or row["deleted_at"] is not None or tuple(row[key] for key in ("tenant_id", "installation_id", "principal_id")) != authority.scope:
                raise TranscriptNotFound()
            prior = db.execute("SELECT * FROM transcript_events WHERE session_id=? AND idempotency_key=?",
                               (session_id, idempotency_key)).fetchone()
            if prior:
                if prior["digest"] != digest or prior["kind"] != kind:
                    raise IdempotencyConflict("idempotency key already has different content")
                db.commit()
                return "already_persisted", _sqlite_event(prior)
            if row["next_sequence"] > MAX_EVENTS_PER_SESSION or row["total_bytes"] + payload_bytes > MAX_SESSION_BYTES:
                raise ResourceLimitExceeded("session quota exceeded")
            now = time.time()
            sequence = row["next_sequence"]
            db.execute("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (session_id, sequence, kind, canonical_json(payload), idempotency_key, digest, now))
            db.execute("UPDATE transcript_sessions SET next_sequence=?, total_bytes=total_bytes+? WHERE session_id=?",
                       (sequence + 1, payload_bytes, session_id))
            db.commit()
            return "persisted", TranscriptEvent(sequence, kind, copy.deepcopy(payload), idempotency_key, digest, now)
        except TranscriptError:
            db.rollback()
            raise
        except sqlite3.Error as error:
            db.rollback()
            raise StorageUnavailable("SQLite transcript store unavailable") from error
        finally:
            db.close()

    def events(self, authority: Authority, session_id: str, after: int, limit: int) -> list[TranscriptEvent]:
        try:
            with self._connect() as db:
                rows = db.execute("SELECT * FROM transcript_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
                                  (session_id, after, limit)).fetchall()
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error
        return [_sqlite_event(row) for row in rows]

    def audit(self, authority: Authority, action: str, session_id: str) -> AuditEvent:
        try:
            with self._connect() as db:
                now = time.time()
                cursor = db.execute("INSERT INTO transcript_audit(tenant_id,installation_id,actor_id,action,session_id,created_at) VALUES (?,?,?,?,?,?)",
                                    (*authority.scope, action, session_id, now))
                return AuditEvent(cursor.lastrowid, *authority.scope[:2], authority.principal_id, action, session_id, now)
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error

    def read_audit(self) -> list[AuditEvent]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM transcript_audit ORDER BY audit_sequence").fetchall()
        return [AuditEvent(row["audit_sequence"], row["tenant_id"], row["installation_id"], row["actor_id"],
                           row["action"], row["session_id"], row["created_at"]) for row in rows]

    def soft_delete(self, authority: Authority, session_id: str, purge_after: float) -> None:
        with self._connect() as db:
            cursor = db.execute("UPDATE transcript_sessions SET deleted_at=?,purge_after=? WHERE session_id=? AND tenant_id=? AND installation_id=? AND principal_id=?",
                                (time.time(), purge_after, session_id, *authority.scope))
            if cursor.rowcount != 1:
                raise TranscriptNotFound()

    def restore_with_audit(self, authority: Authority, session_id: str) -> None:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM transcript_sessions WHERE session_id=?", (session_id,)).fetchone()
            if not row or row["deleted_at"] is None or (row["purge_after"] is not None and row["purge_after"] <= time.time()):
                raise TranscriptNotFound()
            now = time.time()
            db.execute("INSERT INTO transcript_audit(tenant_id,installation_id,actor_id,action,session_id,created_at) VALUES (?,?,?,?,?,?)",
                       (*authority.scope, "developer_restore", session_id, now))
            db.execute("UPDATE transcript_sessions SET deleted_at=NULL,purge_after=NULL WHERE session_id=?", (session_id,))
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def uninstall(self, authority: Authority) -> None:
        try:
            with self._connect() as db:
                db.execute("DELETE FROM transcript_sessions WHERE tenant_id=? AND installation_id=?", authority.scope[:2])
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error

    def purge_expired(self, now: float | None = None, limit: int = 100) -> int:
        now = time.time() if now is None else now
        try:
            with self._connect() as db:
                rows = db.execute(
                    "SELECT session_id FROM transcript_sessions WHERE purge_after IS NOT NULL AND purge_after<=? ORDER BY purge_after,session_id LIMIT ?",
                    (now, limit),
                ).fetchall()
                session_ids = [row[0] for row in rows]
                if session_ids:
                    db.executemany("DELETE FROM transcript_sessions WHERE session_id=?", [(sid,) for sid in session_ids])
                return len(session_ids)
        except sqlite3.Error as error:
            raise StorageUnavailable("SQLite transcript store unavailable") from error


def _sqlite_event(row: sqlite3.Row) -> TranscriptEvent:
    return TranscriptEvent(row["sequence"], row["kind"], json.loads(row["payload_json"]),
                           row["idempotency_key"], row["digest"], row["created_at"])


SQLITE_MIGRATION = """
CREATE TABLE IF NOT EXISTS transcript_sessions(
 session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL,
 principal_id TEXT NOT NULL, next_sequence INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
 deleted_at REAL, purge_after REAL
);
CREATE TABLE IF NOT EXISTS transcript_events(
 session_id TEXT NOT NULL REFERENCES transcript_sessions(session_id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, digest TEXT NOT NULL, created_at REAL NOT NULL,
 PRIMARY KEY(session_id, sequence), UNIQUE(session_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS transcript_audit(
 audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
 installation_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
 session_id TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TRIGGER IF NOT EXISTS transcript_audit_no_update BEFORE UPDATE ON transcript_audit
BEGIN SELECT RAISE(ABORT, 'transcript audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_audit_no_delete BEFORE DELETE ON transcript_audit
BEGIN SELECT RAISE(ABORT, 'transcript audit is append-only'); END;
"""


class PostgreSQLTranscriptStore:
    """PostgreSQL adapter with transaction-local scope hooks for RLS.

    ``connection_factory`` must return a new DB-API connection. Production
    factories must enforce TLS verification and use a non-owner runtime role.
    """

    def __init__(self, connection_factory: Callable[[], Any], *, initialize: bool = True) -> None:
        self._connect_factory = connection_factory
        if initialize:
            self._initialize()

    def _connect(self):
        try:
            return self._connect_factory()
        except Exception as error:
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error

    def _initialize(self) -> None:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(POSTGRES_MIGRATION)
            db.commit()
        finally:
            db.close()

    @staticmethod
    def _set_scope(cursor: Any, authority: Authority) -> None:
        """Bind RLS variables from trusted host authority for this transaction only."""
        cursor.execute("SET LOCAL actions_json.tenant_id = %s", (authority.tenant_id,))
        cursor.execute("SET LOCAL actions_json.installation_id = %s", (authority.installation_id,))

    @staticmethod
    def production_requirements() -> dict[str, str]:
        return {
            "sslmode": "verify-full",
            "runtime_role": "non-owner, no BYPASSRLS",
            "migration_role": "separate owner role",
            "secrets": "host-managed and rotatable",
        }

    def create_session(self, authority: Authority, session_id: str) -> None:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute(
                    "INSERT INTO transcript_sessions(session_id,tenant_id,installation_id,principal_id) VALUES (%s,%s,%s,%s)",
                    (session_id, *authority.scope),
                )
            db.commit()
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()

    def session(self, authority: Authority, session_id: str) -> _Session | None:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("SELECT tenant_id,installation_id,principal_id,session_id,next_sequence,total_bytes,deleted_at,purge_after FROM transcript_sessions WHERE session_id=%s", (session_id,))
                row = cursor.fetchone()
        except Exception as error:
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()
        return _Session(*row) if row else None

    def list_sessions(self, authority: Authority, after: str, limit: int) -> list[_Session]:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute(
                    "SELECT tenant_id,installation_id,principal_id,session_id,next_sequence,total_bytes,deleted_at,purge_after FROM transcript_sessions WHERE tenant_id=%s AND installation_id=%s AND principal_id=%s AND deleted_at IS NULL AND session_id>%s ORDER BY session_id LIMIT %s",
                    (*authority.scope, after, limit),
                )
                rows = cursor.fetchall()
        except Exception as error:
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()
        return [_Session(*row) for row in rows]

    def append(self, authority: Authority, session_id: str, kind: str, payload: Any,
               idempotency_key: str, digest: str, payload_bytes: int) -> tuple[str, TranscriptEvent]:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("SELECT tenant_id,installation_id,principal_id,next_sequence,total_bytes,deleted_at FROM transcript_sessions WHERE session_id=%s FOR UPDATE", (session_id,))
                row = cursor.fetchone()
                if not row or row[5] is not None or tuple(row[:3]) != authority.scope:
                    raise TranscriptNotFound()
                cursor.execute("SELECT sequence,kind,payload_json,idempotency_key,digest,created_at FROM transcript_events WHERE session_id=%s AND idempotency_key=%s", (session_id, idempotency_key))
                prior = cursor.fetchone()
                if prior:
                    if prior[4] != digest or prior[1] != kind:
                        raise IdempotencyConflict("idempotency key already has different content")
                    db.commit()
                    return "already_persisted", _postgres_event(prior)
                if row[3] > MAX_EVENTS_PER_SESSION or row[4] + payload_bytes > MAX_SESSION_BYTES:
                    raise ResourceLimitExceeded("session quota exceeded")
                sequence, now = row[3], time.time()
                cursor.execute(
                    "INSERT INTO transcript_events(session_id,sequence,kind,payload_json,idempotency_key,digest,created_at) VALUES (%s,%s,%s,%s::jsonb,%s,%s,%s)",
                    (session_id, sequence, kind, canonical_json(payload), idempotency_key, digest, now),
                )
                cursor.execute("UPDATE transcript_sessions SET next_sequence=%s,total_bytes=total_bytes+%s WHERE session_id=%s", (sequence + 1, payload_bytes, session_id))
            db.commit()
            return "persisted", TranscriptEvent(sequence, kind, copy.deepcopy(payload), idempotency_key, digest, now)
        except TranscriptError:
            db.rollback()
            raise
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()

    def events(self, authority: Authority, session_id: str, after: int, limit: int) -> list[TranscriptEvent]:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("SELECT sequence,kind,payload_json,idempotency_key,digest,created_at FROM transcript_events WHERE session_id=%s AND sequence>%s ORDER BY sequence LIMIT %s", (session_id, after, limit))
                rows = cursor.fetchall()
        except Exception as error:
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()
        return [_postgres_event(row) for row in rows]

    def audit(self, authority: Authority, action: str, session_id: str) -> AuditEvent:
        db = self._connect()
        try:
            now = time.time()
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("INSERT INTO transcript_audit(tenant_id,installation_id,actor_id,action,session_id,created_at) VALUES (%s,%s,%s,%s,%s,%s) RETURNING audit_sequence", (*authority.scope, action, session_id, now))
                sequence = cursor.fetchone()[0]
            db.commit()
            return AuditEvent(sequence, *authority.scope[:2], authority.principal_id, action, session_id, now)
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()

    def read_audit(self) -> list[AuditEvent]:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                cursor.execute("SELECT audit_sequence,tenant_id,installation_id,actor_id,action,session_id,created_at FROM transcript_audit ORDER BY audit_sequence")
                rows = cursor.fetchall()
        except Exception as error:
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()
        return [AuditEvent(*row) for row in rows]

    def soft_delete(self, authority: Authority, session_id: str, purge_after: float) -> None:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("UPDATE transcript_sessions SET deleted_at=%s,purge_after=%s WHERE session_id=%s AND tenant_id=%s AND installation_id=%s AND principal_id=%s", (time.time(), purge_after, session_id, *authority.scope))
                if cursor.rowcount != 1:
                    raise TranscriptNotFound()
            db.commit()
        except TranscriptError:
            db.rollback()
            raise
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()

    def restore_with_audit(self, authority: Authority, session_id: str) -> None:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("SELECT deleted_at,purge_after FROM transcript_sessions WHERE session_id=%s FOR UPDATE", (session_id,))
                row = cursor.fetchone()
                if not row or row[0] is None or (row[1] is not None and row[1] <= time.time()):
                    raise TranscriptNotFound()
                cursor.execute("INSERT INTO transcript_audit(tenant_id,installation_id,actor_id,action,session_id,created_at) VALUES (%s,%s,%s,%s,%s,%s)", (*authority.scope, "developer_restore", session_id, time.time()))
                cursor.execute("UPDATE transcript_sessions SET deleted_at=NULL,purge_after=NULL WHERE session_id=%s", (session_id,))
            db.commit()
        except TranscriptError:
            db.rollback()
            raise
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()

    def uninstall(self, authority: Authority) -> None:
        db = self._connect()
        try:
            with db.cursor() as cursor:
                self._set_scope(cursor, authority)
                cursor.execute("DELETE FROM transcript_sessions WHERE tenant_id=%s AND installation_id=%s", authority.scope[:2])
            db.commit()
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()

    def purge_expired(self, now: float | None = None, limit: int = 100) -> int:
        now = time.time() if now is None else now
        db = self._connect()
        try:
            with db.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM transcript_sessions WHERE session_id IN ("
                    "SELECT session_id FROM transcript_sessions WHERE purge_after IS NOT NULL "
                    "AND purge_after<=%s ORDER BY purge_after,session_id LIMIT %s FOR UPDATE SKIP LOCKED"
                    ") RETURNING session_id",
                    (now, limit),
                )
                count = len(cursor.fetchall())
            db.commit()
            return count
        except Exception as error:
            db.rollback()
            raise StorageUnavailable("PostgreSQL transcript store unavailable") from error
        finally:
            db.close()


def _postgres_event(row: tuple[Any, ...]) -> TranscriptEvent:
    payload = row[2] if isinstance(row[2], (dict, list)) else json.loads(row[2])
    return TranscriptEvent(row[0], row[1], payload, row[3], row[4], float(row[5]))


POSTGRES_MIGRATION = """
CREATE TABLE IF NOT EXISTS transcript_sessions(
 session_id text PRIMARY KEY, tenant_id text NOT NULL, installation_id text NOT NULL,
 principal_id text NOT NULL, next_sequence bigint NOT NULL DEFAULT 1,
 total_bytes bigint NOT NULL DEFAULT 0, deleted_at double precision, purge_after double precision
);
CREATE TABLE IF NOT EXISTS transcript_events(
 session_id text NOT NULL REFERENCES transcript_sessions(session_id) ON DELETE CASCADE,
 sequence bigint NOT NULL, kind text NOT NULL, payload_json jsonb NOT NULL,
 idempotency_key text NOT NULL, digest text NOT NULL, created_at double precision NOT NULL,
 PRIMARY KEY(session_id,sequence), UNIQUE(session_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS transcript_audit(
 audit_sequence bigserial PRIMARY KEY, tenant_id text NOT NULL, installation_id text NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, session_id text NOT NULL,
 created_at double precision NOT NULL
);
REVOKE UPDATE, DELETE ON transcript_audit FROM PUBLIC;
"""


POSTGRES_RLS_POLICY = """
ALTER TABLE transcript_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE transcript_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transcript_session_scope ON transcript_sessions;
CREATE POLICY transcript_session_scope ON transcript_sessions
 USING (tenant_id = current_setting('actions_json.tenant_id', true)
    AND installation_id = current_setting('actions_json.installation_id', true));
DROP POLICY IF EXISTS transcript_event_scope ON transcript_events;
CREATE POLICY transcript_event_scope ON transcript_events
 USING (EXISTS (SELECT 1 FROM transcript_sessions s
                WHERE s.session_id = transcript_events.session_id));
"""
