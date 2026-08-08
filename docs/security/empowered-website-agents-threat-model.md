# Website-Agent Delegation Security Model

The extension can delegate a bounded set of browser actions to an approved
website agent. The extension remains the trusted capability broker. The
principal is the exact top-level source origin together with its currently
leased top-level document; any script executing in that origin shares that
principal's authority.

This document describes the security boundaries implemented under
`extensions/chrome-overlay-runtime/src/delegated-agent/`. It is not an
implementation plan.

## Authority chain

A delegated call proceeds only while all of the following are valid:

1. A durable approval identifies the source origin, repository, full commit,
   manifest path, and canonical bundle digest.
2. The calling sender matches a live top-level home-document lease.
3. The website group exclusively owns the target tab through an opaque target
   handle.
4. The requested action exists in the approved immutable bundle and the
   target's current URL remains within its declared scope.
5. The result conforms to the declared output schema and size bounds.

Failure at any layer removes or withholds delegated authority. It does not fall
back to the ordinary hosted-agent executor or MCP bridge.

## Approval and package integrity

`approval-store.mjs` validates durable approval records and binds them to
immutable bundle bytes. Package retrieval accepts canonical public GitHub blob
identities with full commit hashes, validates redirects and file closure, and
checks the canonical digest before persistence. Mutable refs, abbreviated
commits, symlinks, submodules, LFS pointers, executable content, traversal, and
unknown file roles are rejected.

Changing the origin, repository identity, commit, manifest path, or digest
creates a different approval identity and requires a new review.

## Document-bound transport

`home-lease.mjs` derives authority from browser-authenticated sender metadata,
including the top-level origin, tab, frame, and document identity. Subframes,
sibling tabs, replaced documents, and stale documents do not inherit a lease.
Nonces and private message ports are scoped to the current document, and losing
the home document dissolves its live routes.

## Target isolation

Website groups and tab leases are stored separately from the ordinary
`extension:default` session. A tab has at most one delegated owner. Delegated
lookups require both the group identity and an activation-scoped opaque target
handle; raw Chrome tab IDs are not exposed to page code.

The dispatcher revalidates ownership and the committed URL before execution
and after navigation effects. Calls to one target run through a serialized,
bounded lane so a lease or scope change can cancel work between steps.

## Tool isolation

Website agents receive direct schemas only for actions declared in their
approved bundle. They do not receive `actions.site`, the general primitive
dictionary, debugger or arbitrary-JavaScript tools, extension storage, bridge
routing, ordinary agent memory, OpenAI credentials, or default-active-tab
resolution.

The delegated dispatcher uses an explicit primitive allowlist and a separate
entry point from ordinary hosted and MCP execution. Unknown or forbidden names
fail before target execution.

## Result and audit containment

Results are projected through the action's output schema, sanitized, and size
checked before they return on the invoking document's private port. Schema
failure or excessive output is rejected rather than truncated into a different
valid-looking value.

Delegated audit records contain bounded, redacted policy and lifecycle metadata
and are partitioned by approval and group. Website code has no reader for
extension diagnostics, ordinary agent logs, or another group's results.

## Persistence and recovery

Persisted approval, group, bundle, and lease records are versioned and
validated before they grant authority. Unknown or malformed state fails
closed. Startup recovery restores only relationships that can be proved from
valid records; it removes unprovable delegated routes and leaves user tabs open.

Revocation removes the selected approval and its delegated authority. Ending a
session removes live routes and target leases without closing the user's tabs.

## Required denial behavior

- Same-origin compromise is contained to that approved origin and bundle; it
  is not treated as compromise of ordinary agent authority or another group.
- Replay from an old document, nonce, port, group, lease, or target handle is
  denied.
- Encoded separators, origin confusion, redirects, and out-of-scope navigation
  are revalidated rather than accepted by string-prefix matching.
- A timed-out mutation remains indeterminate until an independent state read
  resolves it; callers must not retry blindly.
- Quota pressure never silently evicts an approval or partially installs a
  bundle.

The delegated-agent unit and integration suites exercise approval integrity,
sender and lease matching, package closure, URL scope, group isolation,
dispatcher allowlists, output projection, restart recovery, and denial paths.
