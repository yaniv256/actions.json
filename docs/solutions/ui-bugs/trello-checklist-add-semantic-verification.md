---
title: Verify Trello checklist adds with semantic item identity
date: 2026-07-14
category: ui-bugs
module: actions.json Trello map
problem_type: ui_bug
component: tooling
symptoms:
  - "trello.card.checklist_item.add returned workflow_retry_exhausted at verifyItem even though the item was created."
  - "Independent checklist reads saw the exact item after the add workflow reported failure."
root_cause: weak_verification
resolution_type: code_fix
severity: high
related_components:
  - actions.json.storage public Trello map
  - Trello checklist projections
  - workflow postconditions
tags: [actions-json, trello, checklist, semantic-verification, aria-label, false-negative]
---

# Verify Trello checklist adds with semantic item identity

## Problem

`trello.card.checklist_item.add` could create a checklist item and still report failure. The failing step was the add workflow's verifier, not Trello's mutation: after the workflow returned `workflow_retry_exhausted`, `trello.card.checklist.read` independently saw the exact newly added item.

The defect appeared on cards with multiple checklist sections. Retrying the add was unsafe because the mutation had already landed and a retry could duplicate the user's checklist item.

## Symptoms

- The add workflow failed at `verifyItem`.
- The reported primitive was `locator.text_content`.
- The error was `workflow_retry_exhausted`.
- A separate checklist projection read reported the item present.
- Live reproduction on the investigation card showed the old map add `Live verification: multi-section semantic add verifier synced 2026-07-14`, returned failure, and immediately appeared in a two-section checklist read.

## What Didn't Work

Increasing waits or retry counts was the wrong fix. The original failure was not a slow Trello write. The item existed; the verifier was reading the wrong authority.

Visible text containment was also insufficient. Trello checklist item identity is exposed semantically on checkbox inputs via `aria-label`, while the old verifier read visible/container text from `[data-testid='checklist-items']` and checked substring containment.

## Solution

Use the same semantic identity authority for mutation verification that the read projection uses:

- observe checkbox inputs with `[data-testid='checklist-items'] input[type='checkbox'][aria-label]`;
- read `aria-label` and `aria-checked`;
- require exact equality between `attributes.\`aria-label\`` and the requested `item_text`;
- expose `match_count` in the action output;
- make the card-modal postcondition check `state.modal.checklist_items[text = input.item_text]` instead of modal visible text containment.

The public storage fix landed in the public storage repositories and then propagated to the extension source.

## Why This Works

The verifier now asks the same question a human-safe read model asks: "does this card contain a checklist checkbox whose accessible item name exactly equals the requested item text?"

That survives:

- multiple checklist sections;
- offscreen or partially mounted visual text containers;
- UI text that is duplicated or concatenated for layout;
- substring collisions where one item contains another item's text.

The live fixed-map verification on the same Trello investigation card returned `verified:true`, `match_count:1`, and a passing `trello.card_modal` postcondition for `Live verification: fixed multi-section semantic add verifier 2026-07-14`. An independent `trello.card.checklist.read` then reported `section_count: 2`, `item_count: 3`, and all three exact evidence items present.

## Prevention

- Mutation verification must use at least the same semantic authority as the read projection that agents use for independent verification.
- Do not verify entity creation with ancestor visible text when exact entity attributes are available.
- Prefer exact identity plus count over substring containment.
- If a workflow can mutate before verification fails, document retry safety explicitly. For Trello checklist adds, blind retry is unsafe because it can duplicate items.
- Live-verify false-negative UI fixes at the original failing boundary after the map is merged and synced, not only with source-level tests.

## Evidence

- Investigation: `investigations/trello-checklist-item-add-false-negative-multiple-sections-2026-07-14.md`
- Public storage PR: <https://github.com/yaniv256/actions.json.storage.public/pull/21>
- Full storage PR: <https://github.com/yaniv256/actions.json.storage.full/pull/14>
- Example storage PR: <https://github.com/yaniv256/actions.json.storage/pull/8>
- Extension-source pin sync change
- Live-proof follow-up change
