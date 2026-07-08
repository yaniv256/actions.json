# Frame-Aware Locator — Design

**Date:** 2026-07-05
**Author:** Tempest (Zara Chen)
**Status:** Approved (Yaniv, voice, 2026-07-05) — ready for implementation plan
**Repo:** actions.json.dev (extension runtime — content.js locator layer)

## Goal

Add an optional `frame` field to the locator object so that **any** primitive
that takes a locator can target elements inside an iframe. Fix targeting once,
centrally, in the locator resolver — every primitive (`pointer.click`,
`clipboard.paste`, `text.select`, `locator.element_info`, `locator.wait_for`,
`browser.extract_elements`, …) inherits it with zero per-primitive changes. This
replaces the paste-specific auto-descent hack shipped in 0.1.150.

## Motivation

The locator resolver (`resolveLocatorCandidates` in content.js) queries only the
top `document` via `queryRelative(document, selector, …)`. Confirmed live
(2026-07-05): Google Docs' editable surface is a `[contenteditable=true]` DIV
inside a same-origin `.docs-texteventtarget-iframe`; from the top document it is
UNREACHABLE (top-document `querySelectorAll("[contenteditable='true']")` returns
0; the same query inside the iframe returns 1). So the real gap is in TARGETING,
not in paste. The frame is a property of a locator, orthogonal to `selector` /
`text_*`, and belongs in the locator layer so all primitives get it.

## Design Decisions (locked)

- **`frame` = CSS selector string, OR an array of selectors for NESTED frames**
  (outer → inner), resolved as a fold. One level is just an array of length one.
  (Yaniv: for an agent the general nested case costs ~nothing over the single
  case — it is the same logic in a loop — so build the general form; nested
  frames are real on the web and will be used.)
- **Cross-origin frame → distinct `frame_cross_origin` error** naming the frame
  selector. The runtime genuinely cannot reach a cross-origin frame's contents
  from page JS; say so honestly rather than silently resolving nothing.
- **Frame not found → normal empty result** (same as any non-matching locator).
- **No `frame` → today's behavior exactly** (query top document). Fully backward
  compatible.
- **Revert the paste-specific iframe auto-descent** (`pasteTargetKind` descend
  logic from 0.1.150) — superseded. Paste becomes dumb: it resolves its target
  through the now-frame-aware locator; the Docs map encodes the frame.

## Schema

The locator gains one optional field (everything else unchanged):

```
locator: {
  frame?: string | string[],          // CSS selector(s) for the iframe(s), outer→inner
  selector?: string,                  // queried INSIDE the innermost frame's document
  text_contains?, text_equals?, text? // unchanged, applied within that document
}
```

Examples:
```json
{ "selector": "button[type='submit']" }                       // top document (unchanged)
{ "frame": ".docs-texteventtarget-iframe",
  "selector": "[contenteditable='true']" }                    // one level into Docs
{ "frame": [".outer-embed", ".inner-widget"],
  "selector": ".field" }                                      // nested, outer→inner
```

## Architecture — one central change

`resolveLocatorCandidates(locator)` currently does
`queryRelative(document, selector, …)`. Introduce a pure helper
`resolveFrameRoot(frame, topDocument)` that returns `{ ok, root }` or
`{ ok:false, error }`, and query against `root` instead of `document`.

`resolveFrameRoot(frame, topDocument)`:
1. No `frame` → `{ ok:true, root: topDocument }`.
2. Normalize `frame` to an array (`string` → `[string]`).
3. Fold over the selectors, starting from `topDocument`:
   - In the current root, `root.querySelector(sel)`. If it doesn't match an
     `<iframe>`/`<frame>` element → `{ ok:false, error: { code:'frame_not_found',
     frame: sel } }` (surfaced as empty candidates by the caller, see below).
   - Read `iframeEl.contentDocument`. If it throws OR is null →
     `{ ok:false, error: { code:'frame_cross_origin', frame: sel,
     message:'Frame is cross-origin; its contents cannot be targeted from page JS.' } }`.
   - Set root = that contentDocument; continue.
4. Return `{ ok:true, root }` (the innermost document).

`resolveLocatorCandidates` uses it:
```
const { ok, root, error } = resolveFrameRoot(locator.frame, document);
if (!ok) { LAST_LOCATOR_ERROR = error; return []; }   // frame_cross_origin / frame_not_found
candidates = queryRelative(root, selector, { visible_only:false });
```
`queryRelative` already takes a `root`, so the rest is unchanged. All
`resolveSingle*` wrappers and every primitive inherit frame targeting for free.

**Error surfacing:** `resolveLocatorCandidates` returns `[]` (candidates) as
today, but records the structured `frame_*` error so locator-driven primitives
(`locator.element_info`, `locator.wait_for`, and workflow steps) can report
`frame_cross_origin` / `frame_not_found` instead of a bare "not found". Minimal:
add the error to the `locator.element_info` result when candidates are empty and
a frame error was recorded.

**Coordinates:** same-origin frame elements' `getBoundingClientRect()` returns
viewport-relative coordinates that already account for the iframe offset, so
`pointer.click` geometry from `clickable_center` works inside frames without
extra math. (If a live check shows an offset gap, add the iframe's own rect —
noted as a verification step, not assumed.)

## Data Flow

**Paste into Docs (the driving case):**
`clipboard.paste { text, target: { frame: ".docs-texteventtarget-iframe",
selector: "[contenteditable='true']" } }` → resolver steps into the iframe,
resolves the inner CE, paste dispatches there → text lands (screenshot-verified
mechanism). The Docs map encodes this target; paste has no frame logic.

**Click inside a frame:** `pointer.click` with a `frame` locator resolves the
inner element's `clickable_center` and clicks it.

## Error Handling

- `frame_cross_origin` — a named frame is cross-origin/unreachable.
- `frame_not_found` — a frame selector matched no iframe (or a non-iframe).
- Innermost `selector` matching nothing → empty candidates (unchanged).

## Testing

- **Unit (source-slice `resolveFrameRoot`):** no frame → topDocument; single
  same-origin frame → inner doc; nested (2 frames) → innermost doc;
  cross-origin (contentDocument throws) → `frame_cross_origin`; non-iframe /
  missing selector → `frame_not_found`.
- **Regression:** existing locator tests still pass (no-frame path unchanged).
- **Live (screenshot-verified):** `clipboard.paste` with the Docs frame target
  writes into a Doc; `pointer.click` with a frame target clicks inside an iframe.
- Revert-paste-descent covered by the existing clipboard-selection tests
  (pasteTargetKind returns to the simple resolved/activeElement form).

## Out of Scope

- Reading Docs back (`docs.read` is canvas-blind — separate rebuild around
  screenshot/OCR/export).
- The Docs/Sheets/Slides write map actions (consume this; their own work).
- Cross-origin frame piercing (genuinely impossible from page JS — errored, not
  attempted).
