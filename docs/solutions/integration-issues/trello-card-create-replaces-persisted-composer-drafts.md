---
title: Trello card creation must replace persisted composer drafts
date: 2026-07-14
category: integration-issues
module: trello_card_create
problem_type: integration_issue
component: tooling
severity: high
related_components:
  - actions.json.storage public Trello map
  - Trello card composer
  - workflow postconditions
symptoms:
  - "trello.card.create appended a Trello-persisted composer draft to the requested card title"
  - "Substring verification accepted a malformed concatenated title"
  - "A board-wide fallback could certify an exact-title card outside the requested list"
root_cause: wrong_api
resolution_type: code_fix
tags: [actions-json, trello, card-creation, persisted-draft, exact-replacement, verification]
---

# Trello card creation must replace persisted composer drafts

## Problem

`trello.card.create` could append a requested card title to a Trello-persisted
composer draft instead of replacing it. The workflow could then accept or
misdiagnose the malformed side effect because its local and state-level
verification were weaker than the action's exact-title, exact-list contract.

## Symptoms

- Reopening a canceled card composer restored its previous text.
- Creating `PROBE archive open menu 2026-07-13 1901 CDT` with the restored draft
  `build a system` produced
  `build a systemPROBE archive open menu 2026-07-13 1901 CDT`.
- The workflow submitted before proving that the composer contained only the
  requested title.
- Workflow-local `text_contains` verification matched the malformed title.
- The board postcondition could accept an exact-title duplicate in another list.

## What Didn't Work

Canceling an open composer normalized the visible UI but did not clear Trello's
persisted draft. Trello restored the text when the same list composer reopened.

`clipboard.paste` also had the wrong contract. It inserts at the current
contenteditable cursor; it does not promise to replace restored text. Longer
waits could not repair that semantic mismatch. Submitting immediately after the
write, verifying with `text_contains`, and accepting a board-wide fallback then
allowed three weaker checks to amplify the original defect.

## Solution

The reusable public Trello map now enforces the requested value and destination
at every boundary.

Replace append-style input:

{% raw %}
```json
{
  "id": "insertTitle",
  "primitive": "clipboard.paste",
  "args": {
    "text": "{% input.title %}",
    "target": { "selector": "[data-testid='list-card-composer-textarea']" }
  }
}
```
{% endraw %}

with exact replacement followed by a hard pre-submit equality gate:

{% raw %}
```json
{
  "id": "insertTitle",
  "primitive": "text.insert",
  "args": {
    "text": "{% input.title %}",
    "mode": "replace",
    "target": { "selector": "[data-testid='list-card-composer-textarea']" }
  }
},
{
  "id": "verifyComposerTitle",
  "primitive": "locator.text_content",
  "args": {
    "locator": { "selector": "[data-testid='list-card-composer-textarea']" }
  },
  "retry_until": "{% steps.verifyComposerTitle.output.text = input.title %}",
  "max_attempts": 4,
  "on_error": "stop"
}
```
{% endraw %}

Run `verifyComposerTitle` before `submitCard`. After submission, use
`text_equals` rather than `text_contains`, then scope the state postcondition to
the requested list:

{% raw %}
```json
{
  "language": "jsonata",
  "expression": "{% $exists(state.board.lists[name = $$.input.list_name].cards[title = $$.input.title]) %}"
}
```
{% endraw %}

## Why This Works

The correction establishes four independent guarantees:

1. `text.insert` with `mode: replace` removes inherited composer content.
2. The pre-submit read proves that the browser holds exactly `input.title` and
   stops before a malformed mutation can land.
3. Exact post-submit title matching rejects prefix or suffix contamination.
4. The destination-scoped postcondition proves that the card exists in the
   requested list, not merely somewhere on the board.

Putting these guarantees in `trello.card.create` fixes the shared action-map
contract for coding agents, hosted Realtime agents, and future actions.json
consumers. A client-specific MCP workaround would leave every other agent to
rediscover the same failure.

## Prevention

- Treat reopened editors and composers as stateful even after their visible UI
  was canceled.
- Use replacement for create/set operations that promise an exact field value;
  reserve clipboard paste for intentional insertion or append workflows.
- Before irreversible submission, read the edited control and hard-stop unless
  it exactly equals the requested value.
- Match verifier strength to the action contract. Do not use substring checks
  when equality is required.
- Scope postconditions to every requested identity dimension, including the
  destination list, container, account, or record ID.
- Preserve structural regression tests for the write primitive, pre-submit gate,
  exact post-submit match, destination-scoped postcondition, and skill warning.
- Validate map changes against a live adversarial fixture containing persisted
  state, not only an empty happy-path composer.

## Evidence

- Investigation:
  `investigations/trello-card-create-persisted-draft-2026-07-13.md`
- Public map fix: <https://github.com/yaniv256/actions.json.storage.public/pull/16>
- Full-storage pin: <https://github.com/yaniv256/actions.json.storage.full/pull/19>
- Public example-storage pin: <https://github.com/yaniv256/actions.json.storage/pull/11>
- actions.json.dev pin and closure record:
  Development-source pin and closure record
- Regression contract:
  `tests/trello-card-create-replaces-persisted-draft.test.mjs`
- Live validation on extension `0.1.214` seeded the 32-character draft
  `PERSISTED DRAFT MUST BE REPLACED`, created exactly
  `PROBE exact replacement 2026-07-14 0208 CDT` in `Backlog`, independently
  verified the list state, archived the disposable card, and independently
  proved that `Backlog` was empty again.

## Related Solutions

- [Verify Trello comments semantically when URLs become smart cards](../ui-bugs/trello-comment-smart-link-verification.md)
- [Verify Trello checklist adds with semantic item identity](../ui-bugs/trello-checklist-add-semantic-verification.md)
- [Prove remediation publication before closing investigations](../best-practices/prove-remediation-publication-before-closing-investigations.md)
