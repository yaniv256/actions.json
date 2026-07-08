# Marker Projection Primitives — Design

**Goal:** Let a projection author embed stable positional *markers* (by index) into a
projection, and later resolve any marker — live, at call time — to a cursor location
and/or a mouse-pointer location on the rendered surface, so agents can move the caret
or pointer to a precise content anchor without re-deriving the whole projection on
every scroll.

**Origin:** Yaniv, 2026-07-05. Motivated by editing canvas-rendered Google Docs, where
there are no DOM character coordinates and string-based find-and-replace fails across
styled-run boundaries. Generalizes to any canvas/opaque surface.

## The problem it solves

- Google Docs (and Slides) render text to a **canvas bitmap**: no per-character DOM
  nodes, no SVG text runs — so you cannot look up "where is sentence 3 on screen" from
  the DOM. (Probed live: `canvasTiles:2` but `lineViews:0, wordNodes:0, svgText:0`.)
- String matching (find-and-replace) breaks when the target **straddles a styled run**
  (proven: `"mark up ."` where "up" is bold silently no-ops).
- The only reliable coordinate source is the **caret**: click into the doc and Docs
  draws `.kix-cursor-caret` with a real `getBoundingClientRect()` (proven: click
  (400,300) → caret x:406 y:296 w:2 h:17). Selection is **canvas-painted**, so it must
  be verified by **screenshot**, not DOM (`.kix-selection-overlay` reads empty).

## Core separation of concerns (the key design point)

A marker is a **stable logical anchor** (an index into content). A coordinate is
**ephemeral** — scroll moves every position. So the two must never be baked together:

1. **Placement** happens once, when a projection is authored. It records *what* anchors
   exist (indexes), not *where* they are.
2. **Query** happens on demand, later. It resolves a marker to *where it is now*.

You re-query after scrolling; you never rebuild the projection just because the page
moved.

## Two primitives

### 1. Marker placement (projection-authoring side)
`projection.marker.place { index, anchor }` (name TBD)
- Called while emitting/authoring a projection. Embeds a marker keyed by `index` (e.g.
  `"s3.start"`, `"s3.end"`) describing a content anchor — a sentence start/end, a word,
  a paragraph boundary — in a **content-relative, scroll-independent** form (e.g. "the
  Nth sentence's first character," or a text signature to Find on).
- Output: the projection now carries these markers. No coordinates stored.

### 2. Marker query (resolve side — available only after markers exist)
`projection.marker.locate { index } -> { cursor: {x,y}, pointer: {x,y} }` (name TBD)
- Resolves the marker to its **current** on-screen locations, computed live:
  - drive the caret to the anchor (Ctrl+F to the anchor's text signature → read
    `.kix-cursor-caret` rect; or navigate by keyboard from a known point),
  - return the caret rect as `cursor`, and the same/nearby point as `pointer`.
- Ephemeral by design — call it again after scroll for fresh coordinates.

### Consumers
- `cursor.move_to { index }` — resolve marker → click that coord to place the caret.
- `pointer.move_to { index }` — resolve marker → move the mouse there.
- **Select-and-type edit** = `cursor.move_to(start)` → shift-select to `end` (shift+
  arrow, or shift-click at end coord) → type/paste to overtype. **Verify the selection
  by SCREENSHOT** (canvas-painted).

## Proven foundations (live, doc 17tqpGmJ, 2026-07-05)
- Caret screen coords readable via `.kix-cursor-caret` bounding rect once a caret is
  active (click into the doc first).
- `pointer.click(x,y)` places the caret at ~that point.
- Selection is canvas-painted → verify by screenshot, not DOM.
- Scroll invalidates coordinates → hence the placement/query split.

## Open questions for the build session
- Marker anchor representation: index-into-sentences vs. text signature vs. both.
- Does the Find caret land at the start or end of a match? (affects shift direction)
- Does trusted shift+arrow reliably extend a selection from a live caret? (screenshot-
  verify; DOM overlay is unreliable)
- Where do these primitives live: generic (extension content/background) vs. a Docs
  map action `docs.edit`. Placement/query feel generic; `docs.edit` is the site-level
  consumer.
- This touches extension content.js/background.js → three-artifact version bump +
  PR-on-branch (actions.json.dev CODE). Private release for testing.

## Not doing yet
Building it. This spec de-risks it; the focused build session (scheduled) implements
and validates each step live before shipping. Do NOT ship any step whose selection/
overtype is unconfirmed by a screenshot.
