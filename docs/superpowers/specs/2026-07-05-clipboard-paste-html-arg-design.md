# `clipboard.paste` optional `html` argument — Design

**Date:** 2026-07-05
**Author:** Tempest (Zara Chen)
**Status:** Approved (Yaniv, voice, 2026-07-05) — "the paste HTML is a wonderful idea… in a document is precisely what we need." Ready for implementation plan.
**Repo:** actions.json.dev (extension runtime primitive)

## Goal

Let a `clipboard.paste` caller supply the exact `text/html` clipboard flavor,
instead of the primitive always deriving it from the plain text as `<p>/<br>`.
This unblocks pasting structured content that the receiving editor expands
according to HTML semantics — most importantly a `<table>` into Google Sheets
(which becomes a real multi-column range) and rich runs into Slides/Docs.

## Motivation (live-verified 2026-07-05)

Pasting a TSV block (`\t` cols, `\n` rows) into Google Sheets via
`clipboard.paste` put ALL data into column A — Sheets ignored the tabs. Root
cause, traced in `content.js`: `syntheticClipboardEvent(text)` sets the
`text/html` flavor via `clipboardHtmlFromText(text)`, which emits only
`<p>…<br>…</p>` — never a `<table>`. Google Sheets reads that html flavor as a
single paragraph with literal tab characters, so every row collapses into one
cell of column A (screenshot-confirmed: range came in as A1:A3, "Count: 3").

Sheets' paste handler DOES expand an HTML `<table>` into a real range
(`<tr>`→row, `<td>`→column). The same is true for Slides text boxes and Docs
rich content. So the fix is not Sheets-specific: give the caller a way to hand
`clipboard.paste` the exact `text/html` payload.

## Design Decision (locked)

Add an **optional `html` string arg** to `clipboard.paste`:

- When `html` is provided, the synthetic paste event's `text/html` flavor is
  **exactly that string** (not derived). `text/plain` remains `args.text` (the
  plain fallback the editor uses if it ignores html).
- When `html` is omitted, behavior is **unchanged** — `text/html` is derived
  from the plain text via the existing `clipboardHtmlFromText` (back-compat: the
  Docs `docs.append` path and every current caller keep working identically).
- `html` is a raw string the caller controls; the caller is responsible for its
  correctness (e.g. a valid `<table>`). The primitive stays generic and dumb —
  app-specific HTML construction lives in the MAP (mirrors the `page.fetch`
  decision: parsing/generation belongs in maps, not primitives).
- `text` becomes effectively optional WHEN `html` is given, but for the
  system-clipboard fallback path (`text` omitted → `navigator.clipboard.readText`)
  we keep `text` as the plain flavor. If both `text` and `html` are omitted,
  the plain text is read from the system clipboard and html is derived from it
  (fully unchanged path).

## Contract

```
clipboard.paste {
  text?: string,     // plain flavor; omitted => read system clipboard
  html?: string,     // NEW: exact text/html flavor; omitted => derived from text
  target?: locator
}
```

Behavior change is isolated to how the `text/html` DataTransfer entry is set:

- `syntheticClipboardEvent(text, html)` — when `html` is a string, use it
  verbatim for `setData("text/html", html)`; otherwise
  `setData("text/html", clipboardHtmlFromText(text))` as today.
- `clipboardPaste` threads `args.html` through to `syntheticClipboardEvent`.

Return payload gains one field: `html_provided: boolean` (whether the caller
supplied an explicit html flavor), so callers/tests can confirm the path taken.
Everything else in the return is unchanged.

## Architecture / Wiring (surfaces to touch)

- **content.js `syntheticClipboardEvent`:** add a second param `html`; when it's
  a non-null string, `setData("text/html", html)` instead of the derived value.
  Keep the single call site in `insertTextIntoEditable` passing only `text`
  (that path never wants a custom html flavor — `text.insert` is plain).
- **content.js `clipboardPaste`:** read `args.html`; pass it to
  `syntheticClipboardEvent(payload, args.html)`. Add `html_provided` to the
  success payload. The system-clipboard fallback (no `text`) still passes
  `args.html` (which may itself be provided independently of `text`).
- **overlay.actions.json `tools[]`:** `clipboard.paste` input_schema gains an
  optional `html` string property (description: exact text/html flavor; use for
  tables/rich runs). `text` stays optional.
- **overlay.actions.json `primitive_dictionary.primitives[]`:** the
  `clipboard.paste` entry's `input_schema` gains the same optional `html`.
- Routing: unchanged — `clipboard.paste` is already a content-script primitive.

## How the maps consume it (shape, not in this primitive's scope)

`sheets.range.paste_tsv` (a workflow action, next task) will build BOTH flavors
from its `tsv` input:
- plain `text` = the TSV as-is (tab/newline);
- `html` = a `<table>` where each `\n`-row is a `<tr>` and each `\t`-cell is a
  `<td>` (HTML-escaped). Then `clipboard.paste { text, html, target: <anchor> }`.
Sheets picks the `<table>` and expands the range. Slides/Docs rich paste will
use the same `html` arg with their own HTML.

## Testing

- **Unit (source-slice `syntheticClipboardEvent`):**
  - given `html` string → the constructed DataTransfer's `text/html` equals that
    string exactly, and `text/plain` equals the text arg.
  - given `html` omitted → `text/html` equals `clipboardHtmlFromText(text)`
    (back-compat).
  - The function is source-sliceable the way the page-fetch test slices
    `isSameOrigin`; if DataTransfer isn't constructible in the test env, assert
    on the branch logic via a thin injectable shim (see plan).
- **Manifest-shape:** `clipboard.paste` in both surfaces has an `html` property
  of type string in its input_schema (extend the existing manifest-shape test).
- **Routing:** `clipboard.paste` still NOT in the background action set
  (content-routed) — unchanged assertion.
- **Live (screenshot):** paste a `<table>` html into the test Sheet at an anchor
  → screenshot shows a real multi-column range (B/C populated, not column A).
  Then `sheets.read` returns multiple cells per row (also validates the
  multi-column read parse that is currently unproven).
- Packaging test stays green (content.js/manifest are already-packaged files).

## Out of Scope

- The `sheets.range.paste_tsv` / Slides / Docs map actions that CONSUME this —
  their own work (task #55).
- Any change to `text.insert` (stays plain).
- Reading the system clipboard's html flavor (we only WRITE a custom html
  flavor; reading richer clipboard types is unneeded here).
- Changing the derived-html default (`clipboardHtmlFromText` stays exactly as-is
  for the omitted-`html` path — back-compat is a hard requirement).
