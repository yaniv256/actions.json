---
title: "Provision Trello label catalogs before applying semantic labels"
date: 2026-07-13
category: ui-bugs
module: actions.json Trello board map
problem_type: ui_bug
component: tooling
symptoms:
  - "trello.card.label.apply exhausted findMatchingLabelRow retries for valid exact inputs."
  - "The Labels popover exposed only unnamed color labels, so semantic executor and priority labels could not match."
  - "After the first label was applied, Trello renamed the opener from Labels to Add a label."
root_cause: incomplete_setup
resolution_type: workflow_improvement
severity: high
tags:
  - trello
  - actions-json
  - label-catalog
  - accessibility
  - agent-kanban
---

# Provision Trello label catalogs before applying semantic labels

## Problem

Agent Kanban required exact executor and priority labels, but a new Trello board contained only unnamed color labels. The stored action treated the deterministic configuration gap as transient UI readiness, retried three times, and returned `control_not_ready` instead of exposing the missing catalog entry.

## Symptoms

- Exact calls such as `{label: "Agent runnable"}` and `{label: "Priority: Normal"}` failed at `findMatchingLabelRow`.
- CSS candidate reads returned empty text, while the accessibility tree showed `Edit Color: <color>, title: none` for every row.
- A broad `text_contains: "label"` opener fallback could match an unrelated card control.
- The exact opener changed from `Labels` to `Add a label` after a card acquired its first label.

## What Didn't Work

- Retrying the requested row did not help because the label did not exist; this was configuration, not delayed rendering.
- Waiting for a requested label inside the opener click's `settle_after` conflated surface readiness with the workflow goal.
- A broad substring fallback was not safe identity. On the incident card it could match text in the card-completion control.

## Solution

The public Trello map now separates catalog setup from card mutation:

1. `trello.board.label.ensure` opens the visible label catalog, preserves an existing exact title, or creates and verifies a missing title.
2. `trello.card.label.apply` resolves only exact accessible opener names: `Labels` and `Add a label`.
3. The opener settles on the label-popover surface, independent of caller data.
4. The requested row lookup is a single exact identity check. A missing label fails at that boundary instead of entering a readiness retry loop.
5. `Close popover` is resolved by exact accessibility identity before card-level verification.

The Elena board was provisioned with:

- `Agent runnable`
- `Human required`
- `Priority: High`
- `Priority: Normal`
- `Priority: Low`

All 59 Agent-runnable Next cards were independently model-read with `Agent runnable` and `Priority: Normal`; the Human-required hardware card was verified with `Human required` and `Priority: High` and placed after the Agent queue.

## Why This Works

Catalog existence and UI readiness are different states. Provisioning establishes the semantic entity before mutation. Exact accessibility identities then bind the workflow to Trello's user-visible contract, while surface-only settle checks prevent absent caller data from masquerading as a slow popover.

The two exact opener names model Trello's real state machine: an unlabeled card exposes `Labels`; a labeled card exposes `Add a label`. No broad substring or geometric inference is needed.

## Prevention

- Test catalog-backed mutations with an empty or unnamed-only catalog, not only the happy path.
- Keep requested-entity existence checks outside readiness retry loops.
- Make `settle_after` prove the surface created by the prior transition, never the caller's final goal.
- Resolve UI controls by exact accessibility name when the page exposes one.
- Verify writes with an independent model projection; action success is not durable-state proof.

## Related Issues

- [Resolve Trello label controls before scrolling the card modal](trello-label-apply-scroll-race.md)
- Public map PRs: `yaniv256/actions.json.storage.public#19`, `#20`
- Full-storage pins: `yaniv256/actions.json.storage.full#12`, `#13`
- Investigation: `investigations/trello-label-operations-slow-2026-07-13.md`
