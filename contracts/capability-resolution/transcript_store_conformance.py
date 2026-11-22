"""Executable conformance checks for actions.json transcript-store adapters.

Consumers can run this against a disposable backing store without copying the
upstream test suite. The factory must return independent adapter instances
connected to the same disposable database or schema.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable
from typing import Any


class TranscriptStoreConformanceFailure(AssertionError):
    """A store violated one of the observable transcript contracts."""


def _require(condition: bool, check: str) -> None:
    if not condition:
        raise TranscriptStoreConformanceFailure(check)


def verify_transcript_store(
    transcript: Any,
    store_factory: Callable[[], Any],
    *,
    concurrency: int = 4,
    concurrent_actor_factory: Callable[[], tuple[Any, str]] | None = None,
) -> tuple[str, ...]:
    """Exercise one disposable store and return the passed check names.

    The randomized authority scope is removed through ``uninstall`` in
    ``finally``. Callers must independently inspect the required audit row,
    because the language-neutral store protocol intentionally has no audit-read
    operation. Snowflake callers must pass ``concurrent_actor_factory``. Each
    call returns an adapter whose append transaction is bound to one dedicated
    backend connection plus that exact connection's session ID; probing a
    different connection is not proof. The service may use an earlier separate
    connection for its ownership read.
    """
    if (
        isinstance(concurrency, bool)
        or not isinstance(concurrency, int)
        or concurrency < 2
    ):
        raise ValueError("concurrency must be an integer of at least 2")

    suffix = secrets.token_hex(12)
    tenant = f"conformance-{suffix}"
    installation = f"installation-{suffix}"
    owner = transcript.Authority(tenant, installation, f"owner-{suffix}")
    other = transcript.Authority(tenant, installation, f"other-{suffix}")
    developer = transcript.Authority(tenant, installation, f"developer-{suffix}")
    membership = transcript.StaticMembershipResolver()
    membership.set_role(owner, "owner")
    membership.set_role(developer, "developer")
    service = transcript.TranscriptService(store_factory(), membership)
    passed: list[str] = []

    try:
        session_id = service.create_session(owner)
        first = service.append_event(
            owner, session_id, "user", {"text": "one"}, "event-1"
        )
        replay = service.append_event(
            owner, session_id, "user", {"text": "one"}, "event-1"
        )
        _require(first.status == "persisted", "first append must persist")
        _require(
            replay.status == "already_persisted",
            "same idempotency key must replay",
        )
        try:
            service.append_event(
                owner,
                session_id,
                "user",
                {"text": "different"},
                "event-1",
            )
        except transcript.IdempotencyConflict:
            pass
        else:
            raise TranscriptStoreConformanceFailure(
                "same idempotency key with different content must conflict"
            )
        passed.append("idempotent_append")

        service.append_event(
            owner, session_id, "assistant", {"text": "two"}, "event-2"
        )
        page = service.read_transcript(owner, session_id)
        _require(
            [event.sequence for event in page.events] == [1, 2],
            "events must be ordered",
        )
        _require(
            session_id in service.list_sessions(owner)[0],
            "owner must list own session",
        )
        try:
            service.read_transcript(other, session_id)
        except transcript.TranscriptNotFound:
            pass
        else:
            raise TranscriptStoreConformanceFailure(
                "another principal must not read the session"
            )
        passed.append("ordered_and_scoped_read")

        developer_page = service.developer_read(developer, session_id)
        _require(
            len(developer_page.events) == 2,
            "developer read must return the authorized transcript",
        )
        passed.append("developer_read_requires_audit")

        service.clear_memory(owner, session_id, "memory-clear")
        service.append_event(
            owner, session_id, "user", {"text": "new"}, "event-3"
        )
        memory = service.read_memory(owner, session_id)
        _require(
            [event.payload["text"] for event in memory.events] == ["new"],
            "memory clear must hide prior context",
        )
        _require(
            len(service.read_transcript(owner, session_id).events) == 4,
            "memory clear must preserve transcript history",
        )
        passed.append("memory_clear_preserves_history")

        service.soft_delete(owner, session_id)
        try:
            service.read_transcript(owner, session_id)
        except transcript.TranscriptNotFound:
            pass
        else:
            raise TranscriptStoreConformanceFailure(
                "soft-deleted session must be hidden"
            )
        service.restore(developer, session_id)
        _require(
            len(service.read_transcript(owner, session_id).events) == 4,
            "authorized restore must recover history",
        )
        passed.append("soft_delete_and_audited_restore")

        concurrent_session = service.create_session(owner)
        if concurrent_actor_factory is None:
            concurrent_actors = [
                (store_factory(), None) for _ in range(concurrency)
            ]
        else:
            concurrent_actors = [
                concurrent_actor_factory() for _ in range(concurrency)
            ]
        concurrent_stores = [actor[0] for actor in concurrent_actors]
        _require(
            len({id(store) for store in concurrent_stores}) == concurrency,
            "store_factory must return distinct adapter instances",
        )
        if concurrent_actor_factory is not None:
            connection_ids = [actor[1] for actor in concurrent_actors]
            _require(
                all(isinstance(value, str) and value for value in connection_ids),
                "connection identities must be non-empty strings",
            )
            _require(
                len(set(connection_ids)) == concurrency,
                "concurrency proof requires distinct backend sessions",
            )
        barrier = threading.Barrier(concurrency)
        errors: list[BaseException] = []

        def append_concurrently(index: int) -> None:
            try:
                barrier.wait()
                separate = transcript.TranscriptService(
                    concurrent_stores[index], membership
                )
                separate.append_event(
                    owner,
                    concurrent_session,
                    "user",
                    {"index": index},
                    f"concurrent-{index}",
                )
            except BaseException as error:  # surfaced on the caller thread below
                errors.append(error)

        threads = [
            threading.Thread(target=append_concurrently, args=(index,))
            for index in range(concurrency)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        _require(not errors, f"concurrent appends failed: {errors!r}")
        concurrent_events = service.read_transcript(
            owner, concurrent_session
        ).events
        _require(
            [event.sequence for event in concurrent_events]
            == list(range(1, concurrency + 1)),
            "concurrent appends must allocate unique contiguous sequences",
        )
        passed.append("concurrent_sequence_allocation")

        expiring = [service.create_session(owner) for _ in range(3)]
        expiry = time.time() - 1
        for expiring_session in expiring:
            service.store.soft_delete(owner, expiring_session, expiry)
        _require(
            service.purge_expired(now=time.time(), limit=2) == 2,
            "purge must honor its limit",
        )
        _require(
            service.purge_expired(now=time.time(), limit=2) == 1,
            "purge must remove the remainder",
        )
        passed.append("bounded_purge")

        service.uninstall(owner)
        _require(
            service.store.session(owner, session_id) is None,
            "uninstall must remove installation sessions",
        )
        _require(
            service.store.session(owner, concurrent_session) is None,
            "uninstall must remove all installation sessions",
        )
        passed.append("installation_uninstall")
        return tuple(passed)
    finally:
        try:
            service.uninstall(owner)
        except Exception:
            pass
