# Streamlit on Snowflake acceptance fixture

This is the smallest executable proof that the reusable actions.json embedded
host works inside a Snowflake **container-runtime** Streamlit app.

It proves:

- authenticated `st.user.sub` becomes the trusted principal;
- a Components V2 browser trigger reaches one registered read provider;
- the browser receives a terminal, redacted action envelope;
- Streamlit reconstruction delivers the same response without calling the
  reconstructed host;
- repeating the fixed call ID replays the receipt without a second provider
  invocation.

It deliberately uses the process-persistent JSON receipt-store test double and
`SELECT 1`. This is a read-only transport acceptance, not production mutation
durability. A Snowflake Hybrid Table is relevant only to the separate production
mutation receipt-store acceptance; it is not required for the SQLite or
PostgreSQL transcript stores described below.

## Deploy from this repository

Create or connect a container-runtime Streamlit whose source root is this
repository and whose main file is:

```text
examples/streamlit-snowflake-container/streamlit_app.py
```

The container runtime searches for `requirements.txt` beside the entrypoint,
so no root dependency file is required. The role needs access to an existing
container Streamlit and query warehouse; this fixture does not create account
objects or request administrator changes.

## Acceptance

1. Open the app as an authenticated user.
2. Confirm the evidence panel says `projection=streamlit-container-v2`.
3. Click **Read through Snowflake** once. Record the browser envelope and prove
   `provider_invocations=1`.
4. Click it again. Prove `from_receipt=true` and
   `provider_invocations` remains `1`.
5. When transcript storage is enabled, prove `transcript_event_count=1` and
   `transcript_event_kinds=["tool_result"]`; after a Streamlit reconstruction,
   prove `transcript_session_resumed=true` without the count resetting.
6. Record app identity, Streamlit version, runtime, fixed call ID, redacted
   response, and a screenshot of the evidence panel.

Do not represent this as Hybrid Table or mutation acceptance.

## SQLite and PostgreSQL

Set `ACTIONS_JSON_DATABASE_URL` to use a stored page corpus instead of the
Snowflake `SELECT 1` transport probe. Both backends use the same table and
serve `database.page.read` and `database.page.search`:

```sql
CREATE TABLE IF NOT EXISTS actions_json_pages (
    url TEXT PRIMARY KEY,
    text TEXT NOT NULL
);
```

Supported URLs:

```text
sqlite:///absolute/path/to/pages.sqlite3
postgresql://user:password@host:5432/database
```

The provider never creates or mutates the table. Provision and populate it
before starting the app. SQLite uses Python's standard library. PostgreSQL uses
`psycopg`, included in this example's requirements. Unsupported URL schemes
fail at startup rather than falling back to Snowflake.

Set `ACTIONS_JSON_TRANSCRIPT_DATABASE_URL` to a separate `sqlite://`,
`postgres://`, or `postgresql://` URL to enable durable transcript logging in
the running component. The trusted host creates or resumes an opaque session
from Streamlit Session State and records terminal outcomes during the active
rerun. PostgreSQL production deployments must use the documented
migration/runtime-role split and TLS verification. A container-local SQLite
file is useful for target-runtime acceptance and development and requires no
Snowflake table grant, but does not prove persistence across a container
replacement. PostgreSQL also does not require a Snowflake Hybrid Table; a
Snowflake-hosted app does require an External Access Integration and associated
secret for outbound PostgreSQL connectivity.

## Fresh Snowflake sessions inside the container

Do not use `externalbrowser` authentication and do not reuse
`st.connection("snowflake")` for the Snowflake standard-table transcript
adapter. Snowpark Container Services already supplies service credentials:

- a rotating OAuth token at `/snowflake/session/token`;
- `SNOWFLAKE_HOST` and `SNOWFLAKE_ACCOUNT` environment variables;
- `SNOWFLAKE_DATABASE` and `SNOWFLAKE_SCHEMA` context variables.

`spcs_connection.spcs_service_connection_factory` reads the token file on every
call and invokes `snowflake.connector.connect(...)`. Snowflake documents that
each such connection creates a new SQL session, which is the independent
mutation-session boundary required by the transcript conformance harness. The
factory uses the service user and the service owner role; end-user identity
continues to come from trusted Streamlit authentication and is stored as an
authority scope, never inferred from the database session.

`SNOWFLAKE_WAREHOUSE` is optional application configuration. Container runtime
does not populate it automatically; alternatively configure `QUERY_WAREHOUSE`
on the Streamlit object so it becomes the service user's default warehouse.
Never log, cache, or return the token. This internal Snowflake connection path
does not require an External Access Integration or a separately managed secret.

## Local browser characterization

For local UI testing without Snowflake credentials, set
`ACTIONS_JSON_ACCEPTANCE_LOCAL=1`. This replaces only `SELECT 1` with the same
one-row result; it does not replace the Components V2, trusted-host, receipt,
reconstruction, or browser-delivery paths. Never use that mode as target-account
evidence.

With the repository's Node dependencies installed, the checked-in browser
smoke accepts `ACTIONS_JSON_ACCEPTANCE_URL` and verifies both the live call and
same-call receipt replay:

```text
node examples/streamlit-snowflake-container/browser_smoke.mjs
```
