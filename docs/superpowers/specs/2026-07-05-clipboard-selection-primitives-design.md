# Clipboard & Selection Primitive Family — Design

**Date:** 2026-07-05
**Author:** Tempest (Zara Chen)
**Status:** Approved (Yaniv, voice, 2026-07-05) — build all five together — ready for plan
**Repo:** actions.json.dev (extension runtime primitives)

## Goal

Add a complete, orthogonal family of clipboard/selection primitives so agents can
select text on a page, move it to and from the system clipboard, and write it into
editors — including editors whose real input target lives inside an iframe (Google
Docs / Sheets / Slides). This unblocks the Google-productivity write path (task
#55) and provides the pure cross-app transfer flow (select → copy → paste).

## The model (what each primitive touches)

Yaniv's organizing principle — primitives split by whether they touch the page,
the system clipboard, or bridge the two:

| Primitive | Moves | Touches |
|---|---|---|
| `text.select` | — | the PAGE only (selects a range) |
| `clipboard.copy` | selection → clipboard | PAGE + clipboard |
| `clipboard.paste` | clipboard → DOM element | clipboard + PAGE |
| `clipboard.read` | clipboard → out | CLIPBOARD only (no page) |
| `clipboard.write` | in → clipboard | CLIPBOARD only (no page) |

`read`/`write` are pure clipboard I/O — no page interaction. `copy`/`paste` are
the bridges. `select` is the page-side prerequisite for `copy`. Left-to-right,
the cross-app transfer path is: **select → copy → (switch app) → paste**.

## Motivation

Google's editors render the editable surface inside an iframe event-target.
`text.insert` fails on them: it resolves the target to the `<iframe>` element,
fails the `isEditableElement` gate, and returns `target_not_editable`
(`tag_name: iframe`) before dispatching. content.js already contains the paste
machinery — `syntheticClipboardEvent` + `clipboardHtmlFromText` build a real
`ClipboardEvent("paste")` carrying `text/plain` + `text/html` — but it is gated
and only reachable inside `text.insert`. Google's editor listens for `paste` (and
`copy`) on its internal target and does the work itself. So the unlock is
primitives that dispatch those events at the FOCUSED target without the editable
gate. `read`/`write` are already advertised in the manifest but have no handler;
this implements them for real.

## Design Decisions (locked)

- **Build all five together** — they are small and only make sense as a group;
  paste alone would leave `copy`/`select` as obvious holes in the transfer flow.
- **Namespacing:** `text.select` (page-selection, sibling of `text.insert`);
  `clipboard.copy` / `clipboard.paste` / `clipboard.read` / `clipboard.write`.
- **Optional target + optional payload where sensible** (details per primitive
  below). The **iframe guard** applies to every primitive that resolves a target:
  if a resolved target is an `<iframe>`, do NOT bail and do NOT pierce
  `contentDocument` (cross-origin risk) — fall through to `document.activeElement`.

## Contracts

### `text.select { target?, mode? }`
Select a range on the page.
- `target` given → resolve + focus, select its editable contents (reuse
  `selectEditableContents`); if it's an input/textarea, select its value range.
- `target` omitted → select the current focused element's contents.
- `mode`: `"all"` (default) selects the whole element; future modes reserved.
- Returns `{ selected: true, selected_length, target_kind }`.

### `clipboard.copy { target? }`
Move the current selection into the system clipboard (page → clipboard).
- Reads the current DOM selection (or the given target's selection after
  select), then writes it to the system clipboard via
  `navigator.clipboard.writeText()`. Also dispatches a synthetic `copy`
  `ClipboardEvent` at the target so page-side copy handlers (e.g. Google) run.
- `target` omitted → operate on `document.activeElement` / current selection.
- Returns `{ copied: true, copied_length, source: "selection",
  clipboard_write: <ok|denied> }`. If the system-clipboard write is denied,
  the synthetic copy event may still have populated it page-side — report both.

### `clipboard.paste { text?, target? }`
Move the clipboard (or given text) into a DOM element (clipboard → page).
- `text` given → paste that exact text (synthetic event carries the data; no
  clipboard read needed).
- `text` omitted → paste the CURRENT system clipboard via
  `navigator.clipboard.readText()`. If denied/blocked → `clipboard_read_denied`
  with the browser reason; never silently paste empty.
- `target` given → resolve + focus (iframe guard applies); omitted →
  `document.activeElement`. If none → `no_paste_target`.
- Build with `syntheticClipboardEvent(payload)` (plain + HTML), dispatch at
  target. Returns `{ pasted: true, inserted_length, input_method:
  "synthetic-paste", default_prevented, target_kind, source:
  "argument"|"system-clipboard" }`. `pasted:true` = dispatched, not guaranteed
  inserted — caller VERIFIES with a read.

### `clipboard.read {}`
Pure clipboard read — no page interaction.
- `await navigator.clipboard.readText()`. Returns `{ text, length }` or
  `clipboard_read_denied`.

### `clipboard.write { text }`
Pure clipboard write — no page interaction.
- `await navigator.clipboard.writeText(text)`. Returns `{ written: true,
  length }` or `clipboard_write_denied`.

## Architecture / Wiring (three surfaces per primitive)

Each of the five is a generic primitive → declared in BOTH manifest tool
surfaces and wired into content-script dispatch (the standard two-surface rule):

1. **content.js** — five handlers (`textSelect`, `clipboardCopy`,
   `clipboardPaste`, `clipboardRead`, `clipboardWrite`), reusing
   `syntheticClipboardEvent` / `clipboardHtmlFromText` / `selectEditableContents`
   where applicable, plus five dispatch arms in `executeAction`.
2. **overlay.actions.json `tools[]`** — five entries with input schemas
   (optional `text`/`target` where specified).
3. **overlay.actions.json `primitive_dictionary.primitives[]`** — five entries,
   each with `summary`, `support: "supported"`, object `input_schema`,
   `x_actions.handler`.
4. Content-route allow-list in the routability test updated for all five.

Note: `clipboard.read`/`clipboard.write` already appear advertised somewhere in
the manifest but lack a content.js handler — reconcile so there is exactly one
declaration per surface and a real handler.

## Data Flow

**Google write (known string):** `pointer.click` into the Docs canvas (focuses
the iframe target) → `clipboard.paste { text }` → Google inserts → verify via
`docs.read`.

**Cross-app transfer (Sheets → Docs):** `text.select` the source range in Sheets
→ `clipboard.copy` (selection → clipboard) → switch/click into the Docs canvas →
`clipboard.paste {}` (bare, reads clipboard) → verify.

**Pure clipboard staging:** `clipboard.write { text }` to seed the clipboard →
later `clipboard.paste {}` anywhere.

## Error Handling

- `no_paste_target` — nothing focused/resolvable to paste into.
- `clipboard_read_denied` / `clipboard_write_denied` — the async clipboard API was
  blocked (permission/focus/not-allowed); surface the browser reason. Never
  silently succeed with empty data.
- `default_prevented: false` + unchanged content after paste/copy means the page
  did not accept the event; caller verifies and reports, does not assume success.
- Every mutation primitive's success flag means "the event/API call was issued,"
  not "the effect is confirmed" — verification is the caller's job (project
  discipline).

## Testing

- **Docs write (primary acceptance):** click canvas → `clipboard.paste { text }`
  → `docs.read` body contains the text.
- **Cross-app transfer:** `text.select` + `clipboard.copy` on a source →
  `clipboard.paste {}` on a target → assert the text moved.
- **Pure clipboard:** `clipboard.write { text }` then `clipboard.read` returns it.
- **Normal input:** `<textarea>` with explicit `target` → select/copy/paste →
  assert value.
- **iframe guard:** pass an `<iframe>` selector as `target` → still operates on
  the focused inner target, no `target_not_editable`.
- **Denied clipboard:** `navigator.clipboard.readText/writeText` rejection →
  `clipboard_read_denied` / `clipboard_write_denied`, not silent success.
- Packaging + routability tests updated so all five ship and route.

## Out of Scope

- The Sheets/Slides READ projections and the productivity maps' write actions
  (task #55) — they CONSUME these primitives but are their own work.
- Any change to `text.insert` (left as-is; `clipboard.paste` is the iframe path).
- Rich non-text clipboard formats (images, files) — text/plain + text/html only.
