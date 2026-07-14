---
title: Verify navigation workflows against destination-route state
date: 2026-07-13
category: logic-errors
module: Trello actions.json card-open postcondition
problem_type: logic_error
component: tooling
severity: high
symptoms:
  - "trello.card.by_title.open navigated from the /b/ board route to the requested /c/ card route but returned ok:false"
  - "The call reported state_projection_not_found even though the requested card was visibly open"
  - "A card-scoped read succeeded against the requested card, proving that the effect and reported status disagreed"
root_cause: scope_issue
resolution_type: code_fix
related_components:
  - testing_framework
  - documentation
tags:
  - trello
  - postcondition
  - state-projection
  - route-transition
  - false-failure
---

# Verify navigation workflows against destination-route state

## Problem

`trello.card.by_title.open` successfully navigated Trello from a `/b/` board route to the requested `/c/` card route, but returned `ok:false`. Its postcondition asked for the board-only `trello.board` projection after navigation, so the runtime correctly reported `state_projection_not_found` even though the requested card was already open.

## Symptoms

- Extension `0.1.201` returned `state_projection_not_found` with “Requested state projection is not declared for this site” ([investigation](../../../investigations/trello-card-open-board-postcondition-card-route-2026-07-11.md)).
- The runtime URL immediately afterward was the exact requested `/c/...` route, and `trello.card.checklist.read` returned that card's exact checklist state.
- Retrying would treat a postcondition error as an interaction error and could operate on a card that was already open.

## What Didn't Work

**Retrying the open action** did not address the failure because the first call had already produced the intended route.

**Using board membership as the final proof** described the action's source state, not its result. The public map scopes `trello.board` to `https://trello.com/b/*`, while the successful action finishes on `/c/`.

**Removing the postcondition** would make the action less trustworthy. A successful pointer dispatch cannot prove that Trello opened the requested card; the correct fix is destination-scoped identity verification.

## Solution

Public storage PR [#11](https://github.com/yaniv256/actions.json.storage.public/pull/11) changed the map, not the generic runtime. Before the fix, the postcondition requested board state:

{% raw %}
```json
{
  "projection": "trello.board",
  "verify": {
    "language": "jsonata",
    "expression": "{% $exists(state.board.lists.cards[title = $$.input.title]) %}"
  }
}
```
{% endraw %}

The merged map instead verifies the destination card state:

{% raw %}
```json
{
  "projection": "trello.card_modal",
  "verify": {
    "language": "jsonata",
    "expression": "{% $split(state.modal.title, '\n')[0] = $$.input.title %}"
  },
  "failure_message": "The requested Trello card title was not present in the open card state after the workflow."
}
```
{% endraw %}

`trello.card_modal` applies across Trello routes and exposes the open card title. Comparing the first line preserves exact identity while tolerating adjacent control text Trello appends after a newline.

The local catalog already permits a postcondition to name a projection other than the projection object that contains it: `findStatePostcondition` prefers `postcondition.projection` ([local-actions-catalog.mjs](../../../extensions/chrome-overlay-runtime/src/agent/local-actions-catalog.mjs)). After the workflow finishes, `executeSiteActionCallInTab` executes that projection and verifies its JSONata assertion against the original input ([background.js](../../../extensions/chrome-overlay-runtime/src/background.js)). No runtime special case was needed.

PR #11 also added a [public route-transition regression test](https://github.com/yaniv256/actions.json.storage.public/blob/main/tests/trello-card-open-postcondition-route.test.mjs). A clean current `main` passes that test. The retained session evidence records a live extension `0.1.208` call returning `ok:true`, `postcondition.ok:true`, and projection `trello.card_modal`.

## Why This Works

A workflow postcondition describes the state after the workflow, not the state from which it started:

1. action discovery and card location occur on `/b/`;
2. the click navigates Trello to `/c/`;
3. postcondition projection lookup runs against the resulting page; and
4. result identity must therefore come from a projection available on `/c/`.

The replacement projection is valid on the destination route and binds success to the exact requested title. The runtime's existing failure propagation remains intact: an action reports success only when both its workflow and its destination-state assertion succeed.

## Prevention

- Model every route-changing action as source state → interaction → destination state. Choose the postcondition projection from the destination URL scope.
- Bind success to the exact result identity; “some modal exists” is weaker than “the requested card is open.”
- Test projection choice and assertion shape together so neither can regress independently.
- Keep map and runtime ownership separate. When the generic executor correctly evaluates a bad site declaration, fix and release the map.
- Before retrying a false-negative navigation or mutation, inspect the current URL and a destination-scoped read.
- Audit every workflow that opens or closes a route to ensure its postcondition projection applies to the final URL.

## Related Issues

- [Investigation: Trello card-open board postcondition fails on card route](../../../investigations/trello-card-open-board-postcondition-card-route-2026-07-11.md)
- [Public storage remediation PR #11](https://github.com/yaniv256/actions.json.storage.public/pull/11)
- [Attest runtime identity across document navigation](../architecture-patterns/attest-runtime-identity-across-document-navigation.md)
- [Prove remediation publication before closing investigations](../best-practices/prove-remediation-publication-before-closing-investigations.md)
