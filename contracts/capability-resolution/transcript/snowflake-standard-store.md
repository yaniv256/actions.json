# Snowflake standard-table transcript store

This is the contract for a Snowflake persistence adapter when Hybrid Tables and
external PostgreSQL are unavailable. It is not satisfied by forwarding calls to
a legacy append-only transcript table.

## Why the legacy table cannot be the adapter

A legacy row containing caller-selected session and turn identifiers, a
caller-selected ordering index, principal text, role, content, and action lacks
the state required by the transcript contract. In particular it cannot provide:

- server-minted session ownership and resumability;
- store-allocated sequence numbers;
- atomic idempotency-key conflict detection;
- complete-turn and memory-clear boundaries;
- soft deletion, restoration, retention, or uninstall;
- freshly authorized and durably audited developer reads.

Do not invent identity for historical rows whose principal is absent. Preserve
that table as a read-only legacy archive during migration. New sessions start in
the conforming store; there is no dual-write interval and no history is silently
reclassified as owned.

## Required storage shape

Provision three new standard tables under a migration role:

1. `sessions`: authority scope, opaque session ID, next sequence, total bytes,
   deletion/purge timestamps, and a monotonically increasing lock version.
2. `events`: session ID, sequence, kind, canonical redacted payload,
   idempotency key, digest, and creation timestamp.
3. `audit`: installation scope, actor, action, session ID, and creation timestamp.

Exact identifiers remain host configuration. The runtime role receives only the
minimum DML privileges. It must not receive `UPDATE` or `DELETE` on the audit
table. Standard-table `PRIMARY KEY` and `UNIQUE` declarations are documentation,
not integrity mechanisms: Snowflake does not enforce them. Do not set `RELY` on
an invariant until the adapter has independently maintained and verified it.

## Serialized append transaction

Every operation uses a fresh connection. An append runs in one explicit
transaction:

1. Mutate the matching session row's lock version using predicates over tenant,
   installation, principal, and session ID. A no-op read is not a lock.
2. Require exactly one matching, non-deleted session row.
3. Read the event for `(session_id, idempotency_key)` while holding the sessions
   table write lock. Return `already_persisted` only when kind and digest match;
   otherwise return an idempotency conflict.
4. Enforce event-count and byte quotas from the locked session row.
5. Insert the event at the store-owned `next_sequence`.
6. Advance `next_sequence` and `total_bytes`, then commit.

All writers must use this path. Snowflake documents that `UPDATE`, `DELETE`, and
`MERGE` on standard tables acquire partition or table locks that generally block
parallel DML of those kinds, while `INSERT` can proceed concurrently. The lock
therefore comes from the session-row `UPDATE`, not the event `INSERT`. This
serializes more broadly than a Hybrid Table and may be too slow at scale; it is
an initial correctness design, not a performance claim.

## Headless container authentication

For Streamlit container runtime, use Snowflake-provided service credentials,
not `externalbrowser` authentication and not a long-lived customer credential.
Snowpark Container Services mounts a rotating OAuth token at
`/snowflake/session/token` and provides `SNOWFLAKE_HOST` and
`SNOWFLAKE_ACCOUNT`. The adapter's connection factory must read the token file
for every new connection and call the Python connector with
`authenticator="oauth"`, that token, host, and account. The token is scoped to
the service and must never be logged, returned to the browser, or copied out of
the container.

Snowflake states that this OAuth token is not associated with an existing SQL
session and every new connection creates a new session. That makes the
platform-provided connection factory the required implementation of the
independent-actor boundary. `st.connection("snowflake")` remains suitable for
simple reads but is process-cached and cannot prove concurrent mutation
custody. The service user executes with the service owner role; the runtime role
must therefore receive only the transcript tables' minimum DML privileges.
Authenticated end-user identity remains a separate trusted host input and must
not be replaced with the service-user identity.

This Snowflake-internal SQL path does not require an External Access
Integration or a Snowflake secret. Those are needed for external PostgreSQL,
not for connecting from the SPCS container back to Snowflake. A query warehouse
must be supplied either through the Streamlit object's `QUERY_WAREHOUSE` or
explicit application configuration; SPCS does not inject a warehouse name.

Session creation uses a cryptographically random host-minted identifier and must
fail closed if readback does not show exactly one matching row. Restore writes
its audit row and clears deletion state in one transaction. Purge selects a
bounded deterministic set, deletes events and sessions in one transaction, and
returns the exact removed count. Uninstall is scoped to tenant and installation.

## Acceptance gate

The adapter is not production-ready until all of the following pass against a
disposable Snowflake schema:

1. `transcript_store_conformance.verify_transcript_store` using independent
   connections, including concurrent sequence allocation. Pass a
   `concurrent_actor_factory`; each actor must bind one dedicated connection to
   its append transaction to a dedicated connection and return that exact
   connection's `CURRENT_SESSION()` value. An earlier ownership read may use a
   separate connection. All actors must report different append-session IDs.
   Probing unrelated connections or opening separate cursors on one
   Streamlit-cached connection does not satisfy this gate.
2. Direct readback that developer read and restore each wrote one content-free
   audit row.
3. A sabotage test that bypasses the lock-version update and demonstrates the
   concurrency test can detect duplicate or unordered state.
4. A target Streamlit canary proving authenticated principal binding, success
   and refusal persistence, same-call replay, reconstruction, cross-principal
   denial, memory clear with full-history retention, and audited developer read.
5. Query-history evidence that each append used one explicit transaction and no
   statement ran under the migration role.

If the concurrency gate cannot be made reliable on standard tables, use the
enforced Hybrid Table design or the shipped PostgreSQL store. Do not weaken the
contract to match a storage engine.

Snowflake references:

- https://docs.snowflake.com/en/sql-reference/constraints-overview
- https://docs.snowflake.com/en/sql-reference/transactions
- https://docs.snowflake.com/en/user-guide/tables-hybrid
- https://docs.snowflake.com/en/developer-guide/snowpark-container-services/spcs-execute-sql
