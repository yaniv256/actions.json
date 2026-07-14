---
title: "Verify Trello comments semantically when URLs become smart cards"
date: 2026-07-14
problem_type: ui_bug
module: trello-map
component: trello.card.comment.add
tags: [trello, verification, smart-links, actions-json]
---

# Verify Trello comments semantically when URLs become smart cards

## Symptom

`trello.card.comment.add` successfully inserted and saved comments, but returned
`verified: false` whenever the comment contained a URL. Trello renders pasted URLs
as smart-card or restricted-content UI, so the literal URL no longer appeared in
the posted comment container.

## Root cause

The workflow treated the serialized input string as the exact postcondition. That
was too strict for a rich editor whose rendering intentionally transforms URLs.
The mutation path and Save click were healthy; only the verifier was wrong.

## Fix

The public Trello map now verifies the URL-free prose against the posted
`[data-testid='comment-container']` activity surface. URL tokens are excluded
only from the semantic comparison, and the output reports the normalized expected
prose plus `verification_ignores_urls` so the boundary is explicit. The verifier
still reads posted activity, never the draft editor.

## Prevention

- Treat rich-editor rendering as a representation boundary: verify stable semantic
  content, not a raw serialization that the site is expected to transform.
- Keep the postcondition scoped to the durable activity/comment surface.
- Add a contract test whenever a map verifier intentionally normalizes input.

## Evidence

- Public storage PR #22 merged: smart-link-aware verifier and contract test.
- Storage sync PR #9 merged into `actions.json.storage`.
- actions.json.dev PR #217 merged with the updated storage pin.
- JSONata expression compiled and evaluated against a URL-containing comment;
  the semantic prose verification returned `verified: true`.
