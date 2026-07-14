---
title: Preserve owner-qualified runtime identity across claimed-tab lifecycle operations
date: 2026-07-13
category: architecture-patterns
module: claimed-tab lifecycle and runtime routing
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - A bridge-global browser inventory aggregates tabs from multiple browser runtimes
  - A lifecycle operation targets a browser-local tab identifier
  - Full-document navigation preserves a tab container while replacing its content runtime
tags:
  - actions-json
  - claimed-tabs
  - runtime-identity
  - owner-qualification
  - browser-lifecycle
  - document-navigation
  - route-attestation
  - multi-runtime
---

# Preserve owner-qualified runtime identity across claimed-tab lifecycle operations

## Context

A claimed tab has two distinct identities that must not be collapsed:

- `tab_id` identifies a browser-local container. Two connected Chrome instances can legitimately expose the same number.
- `runtime_id` identifies the content runtime for the document currently loaded in that container. Full-document navigation replaces that runtime while preserving the tab ID.

This creates two boundary hazards. A bridge-global inventory can contain duplicate `tab_id` values owned by different runtimes, so dispatching an explicit tab ID without its owner can reach the wrong browser. Separately, a navigation response can preserve the correct tab ID while returning the runtime ID of the document that was just replaced.

The owner-identity investigation recorded both failures. Development PRs #176 and #195 established owner-qualified lifecycle addressing and replacement-runtime attestation so document-changing navigation cannot report success with stale identity.

## Guidance

Treat lifecycle identity as an owner-qualified, time-sensitive address.

1. **Pair owner and tab from one inventory row.** For an explicit-tab call to `browser.claimed_tabs.activate`, `browser.navigate`, `browser.close_tab`, or `browser.dismiss_dialog`, copy `runtime_id` and `tab_id` from the same `browser.claimed_tabs.list` row and send the former as `target_runtime_id`. The MCP boundary rejects an explicit `tab_id` without its owner with `owner_runtime_required`; calls that omit `tab_id` retain active-runtime behavior ([lib.rs](../../../mcp/actions-json-mcp/src/lib.rs#L5349)).
2. **Publish complete owner-qualified rows.** A newly registered runtime must include browser-local tab and window identity, title, active state, device, URL, and replay metadata before the bridge exposes it. `decorateReadyItemForReplay` constructs that registration record ([background.js](../../../extensions/chrome-overlay-runtime/src/background.js#L643)).
3. **Model document navigation as an identity transition.** Before navigation, snapshot every runtime ID associated with the tab. Treat fragment-only navigation as same-document; reload and other full-document navigations replace the runtime ([background.js](../../../extensions/chrome-overlay-runtime/src/background.js#L1452)).
4. **Retire before reconnecting.** For a replacement, emit removal for prior runtime IDs and forget their routes before reconnecting the content runtime. Reading routes before retirement allowed the old runtime to win serialization ([background.js](../../../extensions/chrome-overlay-runtime/src/background.js#L1488)).
5. **Attest before returning success.** After reconnect, read registered IDs again. A replacement is proven only by an ID absent from the pre-navigation snapshot. Serialize that attested ID and state whether identity was replaced ([background.js](../../../extensions/chrome-overlay-runtime/src/background.js#L1531)).
6. **Make partial outcomes truthful.** If navigation completes but reconnect fails, return `runtime_reconnect_failed`. If reconnect occurs but no replacement ID can be proven, return `runtime_identity_unattested`. Never present the replaced runtime as a successful result ([background.js](../../../extensions/chrome-overlay-runtime/src/background.js#L1514)).

The boundary invariant is:

```text
explicit lifecycle target = (owner runtime_id, browser-local tab_id)
successful replacement navigation = same tab_id + newly attested runtime_id
```

## Why This Matters

A syntactically valid `(runtime_id, tab_id)` pair is unsafe when either coordinate comes from the wrong ownership row or document generation. Without owner qualification, a duplicate tab number can route a destructive lifecycle action to another browser instance. Without post-navigation attestation, callers can compose a successful response into a follow-up operation targeting a runtime that no longer exists.

Callers cannot reliably repair either ambiguity after dispatch. They would have to poll global inventory, guess which browser owns a local tab number, determine whether registration has settled, and correlate runtime generations across navigation. Enforcing ownership before dispatch and freshness before success keeps those facts at the boundary that owns routing and registration state.

Structured failure is part of the success contract. `owner_runtime_required` prevents ambiguous dispatch; `runtime_reconnect_failed` distinguishes completed browser navigation from transport recovery; and `runtime_identity_unattested` refuses false success when the destination document's identity is not proven.

## When to Apply

- A global registry aggregates resources whose container IDs are unique only within one process, browser, device, tenant, or session.
- A command accepts a locally scoped identifier while routing across multiple owners.
- An operation preserves a container handle while replacing the executable document, process, worker, frame, or session behind it.
- Registration or reconnection happens asynchronously after the visible operation completes.
- Downstream callers reuse identity returned by one operation in the next.
- A partial outcome is possible, such as “navigation completed, but replacement runtime identity was not established.”

Do not require owner qualification when an operation intentionally targets the selected active runtime and supplies no explicit local ID. Do not treat fragment-only URL changes as document replacement. Reload remains a replacement even when the URL text is unchanged.

## Examples

### Reject an ambiguous explicit target

```json
{
  "name": "browser.navigate",
  "arguments": {
    "tab_id": 7,
    "url": "https://example.org"
  }
}
```

The bridge rejects this before dispatch with `owner_runtime_required` and directs the caller to copy both values from one inventory row.

### Send an owner-qualified target

```json
{
  "name": "browser.navigate",
  "target_runtime_id": "rt-mac",
  "arguments": {
    "tab_id": 7,
    "url": "https://example.org"
  }
}
```

Here `rt-mac` and `7` must come from the same bridge-global inventory row. Another row may also contain tab `7`; its runtime ID names a different owner.

### Return only an attested replacement identity

```json
{
  "ok": true,
  "navigated": true,
  "runtime_identity_attested": true,
  "runtime_replaced": true,
  "tab": {
    "tab_id": 7,
    "runtime_id": "rt-new-document"
  }
}
```

If the replacement runtime does not register before the response boundary, the truthful result is `ok:false` with `runtime_identity_unattested`, not success containing the old runtime ID. The investigation's installed-extension acceptance records this contract on version 0.1.208; the current source implements the attestation at the navigation boundary.

## Related

- [Global claimed-tab lifecycle owner identity investigation](../../../investigations/global-claimed-tab-owner-qualified-lifecycle-2026-07-12.md)
- [Verify navigation workflows against destination-route state](../logic-errors/verify-navigation-workflows-against-destination-route-state.md)
- Development PR #176: require owner-qualified claimed-tab lifecycle targets
- Development PR #195: attest claimed-tab identity after navigation
