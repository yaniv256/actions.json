---
title: "Attest locator actionability before pointer drag"
date: 2026-07-14
problem_type: ui_bug
module: chrome-overlay-runtime
component: pointer.drag
tags: [pointer-drag, actionability, identity, occlusion, trello]
---

# Attest locator actionability before pointer drag

## Symptom

Locator-form `pointer.drag` could report a successful drag after converting a
resolved element's rectangle center into coordinates. If the element was occluded,
rerendered, or no longer received pointer events, the event path could target a
different element while the primitive still reported success.

## Root cause

The coordinate handoff discarded the identity and actionability evidence produced
by the locator. A rectangle center is geometry, not permission to activate the
element; dispatch success is not the semantic effect.

## Fix

Both extension and bookmarklet runtimes now resolve locator endpoints through the
shared visibility/actionability geometry policy and require `clickable`,
`receives_events`, and an `action_point`. Non-actionable targets return typed
`target_not_actionable` diagnostics with occlusion and scroll evidence. The Trello
drag map passes identity-bearing locators at dispatch time and keeps its mandatory
source/destination board postcondition.

## Prevention

- Preserve identity-bearing locators across mutation boundaries; do not cache naked
  centers when the page can rerender.
- Treat `clickable_center` as an attested capability only when receives-events
  evidence is present.
- Require an independent semantic postcondition for drag and other board mutations.
- Keep extension and bookmarklet actionability contracts covered by parity tests.

## Evidence

- Playwright locator-drag and occlusion tests: 2 passed.
- Live unpacked-extension smoke: passed.
- Release `extension-v0.1.215` is staged with the verified runtime fix.
- Trello storage PR #23, runtime PR #219, and sync/release PRs are merged.
