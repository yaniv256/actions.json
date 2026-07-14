---
title: "a11y.query must attest pointer ownership before returning a click point"
date: 2026-07-14
category: docs/solutions/ui-bugs
module: "Chrome overlay accessibility resolver"
problem_type: ui_bug
component: tooling
symptoms:
  - "a11y.query returned a clickable_center under a sticky header or overlay"
  - "The agent clicked the reported point but the named control did not activate"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - accessibility
  - actionability
  - hit-testing
  - overlays
---

# `a11y.query` must attest pointer ownership before returning a click point

## Problem

Accessibility identity and pointer actionability are different facts. The old
`a11y.query` implementation averaged the CDP AX node's box-model quad and
returned it as `clickable_center`, even when a sticky header or overlay owned
that viewport point.

## Symptoms

- A role/name lookup succeeded, but a subsequent pointer click did nothing.
- The result looked geometrically valid, which encouraged retries at the same
  unsafe coordinate.

## What Didn't Work

Reading `DOM.getBoxModel` alone did not prove event ownership. A non-empty AX
box is useful geometry, but it says nothing about the result of
`document.elementFromPoint` in the target document.

## Solution

`ShimTree.actionability` resolves the backend DOM node and evaluates its
viewport rectangle and hit-test ownership in the owning document:

```js
const hit = document.elementFromPoint(x, y);
const receives = Boolean(hit && (hit === this || this.contains(hit)));
```

The background `a11y.query` response now always includes `visible_center`,
`visible_rect`, `clickable`, `receives_events`, `actionability_attested`, and
`occluded_by`. It adds `clickable_center` only when the attestation is positive.
The extension's live smoke fixture verifies a real fixed overlay and confirms
that the obstruction is reported without losing the AX identity.

## Why This Works

The accessibility tree remains the stable way to identify a control. The
additional CDP `DOM.resolveNode` + `Runtime.callFunctionOn` step measures the
page's actual hit-test surface at the same viewport center. This prevents a
geometry-only result from being consumed as a pointer instruction and gives the
agent a concrete obstruction to remove before re-resolving.

## Prevention

- Treat `visible_center` as geometry only; never pass it to `pointer.click`.
- Require `actionability_attested: true`, `clickable: true`, and
  `receives_events: true` before consuming `clickable_center` from `a11y.query`.
- Keep sticky-overlay fixtures in the a11y live smoke suite and test the
  failure path, not only an unobstructed button.
- Apply the same vocabulary (`visible_center`, `clickable_center`,
  `receives_events`, `occluded_by`) across accessibility, locator, and DOM
  observation producers.

## Related

- [Investigation: a11y.query receives-events attestation](../../../investigations/a11y-query-receives-events-attestation-2026-07-14.md)
- [CDP DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)
- [CDP Runtime domain](https://chromedevtools.github.io/devtools-protocol/v8/Runtime/)
