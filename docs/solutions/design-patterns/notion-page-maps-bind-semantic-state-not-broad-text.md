---
title: Bind published Notion actions to block identity and semantic state
date: 2026-07-14
category: design-patterns
module: notion_site_map_authoring
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "Authoring actions.json maps for published Notion pages"
  - "Operating collapsed toggles whose text also appears on ancestor blocks"
  - "Navigating Notion subpages while preserving verifiable identity"
tags:
  - actions-json
  - notion
  - block-id
  - semantic-state
  - viewport-scoped
  - navigation-verification
---

# Bind published Notion actions to block identity and semantic state

## Context

Published Notion pages look text-addressable, but their useful identity
boundary is structural. Top-level content blocks are direct children of
`.notion-page-content` and carry page-local `data-block-id` values. A toggle
heading is descriptive text inside that block; the actual control is its
descendant `[role="button"][aria-expanded]` element.

Notion repeats text through nested ancestors. A broad text match for a heading
such as `Install Claude Code` can therefore resolve an ancestor containing most
of the page. Clicking the heading itself also does not necessarily operate the
toggle.

Two other boundaries matter:

- `browser.extract_elements` returns viewport-visible items, so an empty result
  may mean "scroll and read again," not "the item does not exist."
- A subpage anchor's DOM `href` can be root-relative while extraction returns
  its resolved absolute URL. Reusing the extracted URL as a DOM attribute
  selector is unreliable.

## Guidance

Treat the page as an ordered collection of top-level blocks, not as one text
blob.

1. Read visible blocks with `:scope > [data-block-id]` under
   `.notion-page-content`.
2. Preserve each returned `block_id` with its exact heading. The pair is the
   operation identity.
3. For a toggle, verify the heading inside that block, then inspect only its
   descendant `[role="button"][aria-expanded]` control.
4. Make open and close idempotent: probe the desired state, click only when
   necessary, wait for the new `aria-expanded` value, and verify it through a
   state projection.
5. Read expanded content from the same top-level block. Notion keeps the
   expanded children nested inside that `data-block-id`.
6. When expected content is absent, scroll `.notion-scroller.vertical` and run
   the same narrow extraction again. Do not broaden the selector.
7. Inventory subpage cards with their `block_id`, exact title, and href.
   Navigate by `block_id` plus exact title, then verify the landed page title.
8. Treat block IDs as page-local state. Rerun discovery after navigation or a
   refresh.

The reading loop is:

```text
map -> outline -> open exact section -> use returned content
    -> read links or close/scroll -> outline again
```

The index-page loop is:

```text
scroll if needed -> read subpage cards -> open exact block_id + title
    -> verify landed title -> read the new outline
```

## Why This Matters

Text expresses intent, but it is not reliable browser identity on a nested
page. Separating semantic discovery from structural execution gives the agent
both: a human-readable title for intent and a narrow block ID for action. The
title guard catches stale or mismatched IDs, while state postconditions prove
that the requested result was reached.

This also gives failures useful meanings. An empty viewport inventory tells
the agent to scroll. An href-shape mismatch tells the author to bind another
stable identity. Neither condition justifies clicking a broader match.

The validated private map passed repeated open and close calls in both initial
states, returned all seven root-index cards after scrolling, navigated to Part
2 with an exact-title postcondition, produced zero strict-audit findings, and
received a final pipeline score of 98/100.

## When to Apply

- Published `notion.site` pages with collapsed toggle sections.
- Long pages whose later blocks are outside the initial viewport.
- Index pages containing top-level Notion subpage cards.
- Pages where visible text occurs in both a target and its ancestors.
- Workflows that must prove open, closed, or landed-page state.

Do not assume these selectors support authenticated `app.notion.com` editing.
That is a separate surface requiring separate measurement.

## Examples

### Toggle identity

Avoid a broad text locator:

```json
{
  "locator": {
    "selector": "h3",
    "text_contains": "Install Claude Code"
  }
}
```

Instead, inventory top-level identity and state:

```json
{
  "scope": {
    "selector": ".notion-page-content",
    "root_strategy": "scope"
  },
  "item_selector": ":scope > [data-block-id]",
  "fields": [
    {"name": "block_id", "selector": ":scope", "attribute": "data-block-id"},
    {"name": "heading", "selector": "h1,h2,h3", "attribute": "text"},
    {"name": "expanded", "selector": "[role='button'][aria-expanded]", "attribute": "aria-expanded"}
  ]
}
```

Then bind the actual control to the returned block:

```text
[data-block-id="<returned block_id>"]
  [role="button"][aria-expanded="false"]
```

After clicking, wait for the same block's control to report
`aria-expanded="true"`. Calling open again should return `already_open: true`
without clicking.

### Subpage identity

Notion may expose these two forms for the same destination:

```text
extracted: https://example.notion.site/Part-2-...-page-id
DOM href:  /Part-2-...-page-id
```

Do not require those strings to be byte-identical. Inventory the containing
`.notion-page-block`, resolve its descendant anchor by the returned `block_id`
and exact title, click that control, then verify the landed H1.

## Related

- [Viewport visibility is not DOM existence](../logic-errors/dom-observe-visible-conflates-viewport-visibility-with-existence.md)
- [Clickable center is a coordinate, not a hit-tested target](../logic-errors/clickable-center-is-a-coordinate-not-a-hit-tested-target.md)
- [Validate the instrument before trusting the experiment](../best-practices/validate-the-instrument-before-trusting-the-experiment.md)
- Private map evidence: `actions.json.storage.full/scopes/private/sites/notion.site/page/`
