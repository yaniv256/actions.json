---
title: "Resolve Trello label controls before scrolling the card modal"
date: 2026-07-13
category: ui-bugs
module: actions.json Trello map
problem_type: ui_bug
component: tooling
symptoms:
  - "Trello label application spent 9–23 seconds retrying a row that never appeared."
  - "The workflow reported a successful pointer click even though the labels popover did not open."
root_cause: unnecessary_scroll
resolution_type: code_fix
severity: high
related_components: [testing_framework, chrome_extension]
tags: [actions-json, trello, labels, workflow, readiness, scrolling]
---

# Resolve Trello label controls before scrolling the card modal

## Problem

`trello.card.label.apply` was designed to survive offscreen controls, so it always scrolled the card modal before looking for the label opener. In ordinary board-maintenance cards the opener was already visible. The defensive scroll made the common path worse: Trello temporarily removed the control from the actionable tree, every opener lookup returned without a usable center, and the workflow dispatched a click with no effective target.

The click primitive reported dispatch success, so the visible symptom appeared later as a requested label row that never mounted. Each label then consumed its settle timeout plus three row retries.

## Investigation trap

The first remediation bound readiness to the requested row rather than the empty popover shell. That made the contract more precise, but it did not open the popover. Live cold validation remained essential: source review and focused tests alone could not reveal that the workflow had already lost the opener before the readiness boundary.

A second validation mistake reinforced the same lesson. Pressing Escape defensively while no popover was open closed the Trello card itself. A test must verify the current state before using a context-sensitive dismissal key.

## Solution

Resolve the visible label control before introducing any scroll:

1. Check the card for an already-present exact label.
2. Check whether the requested row is already visible in an open label popover.
3. Resolve `Add a label`, then `Labels`, then the icon-label fallback.
4. Click the resolved opener and wait for the exact requested checkbox row.
5. If that row is still absent, retry the same verified opener once.
6. Click the exact row, close the popover, and verify the card label container.

The unconditional `scrollCardControlsIntoView` and `revealLabelControlsInShortViewport` steps were removed. Locator actionability remains the fallback for genuinely offscreen controls; it should not preemptively perturb a control that is already usable.

## Why this works

The workflow now follows the cheapest verified state transition:

```text
visible opener -> requested row -> exact click -> card-level postcondition
```

Every retry is conditioned on missing evidence from the preceding boundary. A click is not treated as proof that a popover opened, and a popover shell is not treated as proof that the requested row mounted.

Live existing-tab runs applied and verified `Agent runnable` in 2.112 seconds and `Priority: Normal` in 2.109 seconds, replacing the 9–23 second failure path.

## Prevention

- Do not add unconditional scrolling to a workflow whose target may already be visible.
- Resolve identity before changing viewport state.
- Bind readiness to the requested semantic control, not an ancestor shell.
- Treat click dispatch as an attempt; verify the next state before continuing.
- Test cold missing-state paths, not only idempotent or warmed UI paths.
- Never dismiss a context-sensitive UI with Escape unless the popover/dialog state has first been verified.
- Keep investigations open through publish, deployment, and live verification.

## Evidence

- Public map PRs: `yaniv256/actions.json.storage.public#12`, `#13`
- Public storage pins: `yaniv256/actions.json.storage#6`, `#7`
- Investigation: `investigations/trello-label-operations-slow-2026-07-13.md`

