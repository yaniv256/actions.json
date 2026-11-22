# Transcript storage contract v1

This contract is independent of the globally keyed page-content provider. A
trusted host derives `tenant_id`, `installation_id`, and `principal_id` from
authenticated server state. Browser or model input may supply only opaque lookup
tokens and event content; it cannot select or widen authority.

## Durable behavior

- Redact recursively, then canonicalize and digest. A retry with the same
  session/idempotency key and the same redacted event is `already_persisted`;
  different durable content is a conflict.
- Allocate sequence numbers atomically from the session row. `MAX(sequence)+1`
  is not conforming.
- A `memory_cleared` event is an append-only context boundary, not transcript
  deletion. Model context contains only complete causal groups after the newest
  boundary, but authorized transcript reads retain the complete history.
- Corrections are new events and must name an earlier sequence in the same
  session. Durable history is never overwritten.
- A refused action is persisted synchronously as an `action_refusal` event
  before its browser-safe terminal envelope is returned. It records the stable
  public refusal code and an opaque correlation identifier, never raw provider
  errors. Refusals without a `say` or successful `action` therefore remain
  visible in the transcript rather than disappearing at teardown.
- A developer read must re-resolve current installation membership and durably
  append a content-free audit record before disclosing any content. Each page or
  export chunk repeats this check.
- A failed append is recoverable only when an encrypted trusted outbox has
  durably custodied the redacted event. Reconciliation tokens are opaque,
  single-settlement, scope-bound, and expire after 24 hours.
- Soft-deleted sessions are uniformly absent for users and agents. An authorized
  developer may restore within 30 days in one audited transaction. Purge and
  installation uninstall are terminal and override append/reconciliation.

## Resource contract

The v1 maxima are 256 KiB and 32 nesting levels per event, 10,000 events or
64 MiB per session, 100 events per page by default, 500 events per page maximum,
and 64 KiB for reconstructed model context. Restored roles and provenance remain
data; transcript text never becomes system or developer authority.

SQLite conformance uses a real file database and independent connections.
PostgreSQL conformance uses a non-owner runtime role with row-level security as
defense in depth. Production PostgreSQL connections require host-managed,
rotatable credentials and TLS hostname/certificate verification.

Third-party stores must run `transcript_store_conformance.verify_transcript_store`
against a disposable database or schema. The factory passed to the harness must
return independent adapter instances connected to that same backing store. The
harness covers idempotency conflicts, ordered/scoped reads, developer-read and
restore paths, memory clearing without transcript deletion, concurrent sequence
allocation, bounded purge, and installation uninstall. Because the portable
store protocol deliberately exposes no audit-read method, the host integration
must separately prove that the developer read and restore emitted their durable,
content-free audit rows.

Snowflake adapters must also pass `concurrent_actor_factory`. Each call returns
an adapter whose append transaction is bound to one dedicated backend
connection and that exact connection's Snowflake session ID. An earlier
ownership read may use another connection. The harness rejects repeated IDs:
querying an unrelated probe connection, or opening multiple cursors on one
Streamlit-cached connection, is not a concurrency proof.

For a Snowflake standard-table adapter, follow
[`snowflake-standard-store.md`](snowflake-standard-store.md). A legacy
caller-indexed append table is not a conforming store, and standard-table key
constraints are not enforcement.
