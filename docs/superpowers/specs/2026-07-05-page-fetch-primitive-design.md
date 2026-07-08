# `page.fetch` Primitive — Design

**Date:** 2026-07-05
**Author:** Tempest (Zara Chen)
**Status:** Approved (Yaniv, voice, 2026-07-05) — ready for implementation plan
**Repo:** actions.json.dev (extension runtime primitive)

## Goal

Add a `page.fetch` primitive that runs an authenticated, same-origin, GET-only
fetch from the page context and returns the raw response body. This gives maps a
canvas-safe READ path: Google editors render text to a `<canvas>` (so DOM reads
are empty), but Google also publishes each document as plain HTML at a
same-origin view — `/mobilebasic` (Docs/Slides), `/htmlview` (Sheets) — which a
same-origin authenticated fetch returns in full. Unblocks the read side of the
Google productivity maps (task #55); the write side (frame-aware `clipboard.paste`)
is already solved.

## Motivation

Live-verified 2026-07-05: `fetch('https://docs.google.com/document/d/<id>/mobilebasic',
{credentials:'include'})` returns the doc as plain HTML (54 KB for a small doc);
regex-stripping tags yields the exact page text (all pasted lines returned
cleanly). `/export?format=txt` does NOT work from page JS (it redirects
cross-origin to googleusercontent → CORS "Failed to fetch"), and a browser
download would land on the USER's disk, not the agent host. So the read
mechanism is: don't fight the canvas — fetch Google's own text rendering of the
same document. That needs a generic same-origin fetch primitive.

## Design Decisions (locked)

- **Security: same-origin + GET-only.** The URL's origin must equal the current
  page's origin; only GET is performed (no method/body params exposed). A read
  primitive stays a read primitive — structurally cannot mutate, cannot reach
  other origins. Covers all read views; rejects everything else.
- **Return the RAW body** (`{ ok, status, content_type, length, body }`); spill
  to the payload file when large (existing big-output mechanism), so raw HTML
  never floods the model's context. **App-specific HTML→data parsing lives in the
  MAP**, not the primitive — the primitive is generic and dumb.
- **Reads are workflow ACTIONS, not state projections.** A state projection reads
  the DOM synchronously (`records.*` from `snapshot.extract`) and cannot call an
  async fetch. So `docs.read` etc. are workflow actions: a `page.fetch` step, then
  the workflow `output` JSONata shapes `steps.<id>.output.body`. (Confirmed the
  workflow engine runs a step calling a named primitive and references its output
  in later JSONata — same shape as existing trello.*/github.* actions.)

## Contract

```
page.fetch { url: string }
```

Behavior:
1. Parse `url`. If it doesn't parse, or its origin ≠ `location.origin` →
   `page_fetch_cross_origin` error (evidence: the requested origin + current
   origin).
2. `await fetch(url, { credentials: "include", method: "GET", redirect: "follow" })`.
   On network failure / thrown error → `page_fetch_failed` (message = the
   browser reason).
3. Return `primitiveSuccess("page.fetch", { ok: response.ok, status:
   response.status, content_type: response.headers.get("content-type"), length:
   text.length, body: text })` where `text = await response.text()`.
   - Non-2xx is NOT an error at the primitive level (returns ok:false, status:404
     etc.) — the caller decides; only a thrown/network failure is `page_fetch_failed`.
4. Large `body` spills to the payload file via the existing oversized-output
   path — the model reads it from `payload_path`, not inline.

Errors: `page_fetch_cross_origin`, `page_fetch_failed`.

## Architecture / Wiring (three surfaces + one pure helper)

- **content.js:** `pageFetch(args)` handler + dispatch arm in `executeAction`.
  Factor the origin check into a pure `isSameOrigin(url, pageOrigin)` helper so
  it's source-sliceable for a unit test.
- **overlay.actions.json `tools[]`:** advertise `page.fetch` (input_schema:
  required `url` string).
- **overlay.actions.json `primitive_dictionary.primitives[]`:** entry with
  `summary`, `support: "supported"`, `capability_class: "portable"`,
  `portable: true`, object `input_schema`.
- Routing: `page.fetch` is a content-script primitive (runs `fetch` in the page
  context for same-origin cookies), so it must NOT be in
  `BACKGROUND_BRIDGE_ACTION_NAMES` — it routes to content by default. (Confirm.)

## How the maps consume it (not in this primitive's scope, but the shape)

```
docs.read (workflow action):
  step fetchDoc: page.fetch { url: "{% 'https://docs.google.com/document/d/' & input.doc_id & '/mobilebasic' %}" }
  output: {% ( $html := steps.fetchDoc.output.body;
               $body := <regex/JSONata strip tags to text>;
               { 'title': <title>, 'body': $body } ) %}
```
Sheets: `/spreadsheets/d/<id>/htmlview` → parse `<table>` rows. Slides:
`/presentation/d/<id>/mobilebasic` → slide text. Note: DOMParser is CSP-blocked
on Google pages (TrustedHTML); extraction is regex/JSONata, not parseFromString.

## Error Handling

- `page_fetch_cross_origin` — requested origin ≠ page origin (or unparsable URL).
- `page_fetch_failed` — the fetch threw (network/CORS/abort); message carries the
  browser reason.
- Non-2xx HTTP → returned as `ok:false` + `status`, not an error (caller decides).

## Testing

- **Unit (source-slice `isSameOrigin`):** same origin → true; different origin →
  false; different scheme/port → false; unparsable → false.
- **Manifest-shape:** `page.fetch` present in both surfaces (extend the existing
  manifest-shape test set).
- **Routing:** `page.fetch` NOT in the background action set (content-routed).
- **Live (fetch, no screenshot needed):** `page.fetch` the test doc's
  `/mobilebasic` on a docs.google.com tab → body contains the pasted text; a
  cross-origin URL → `page_fetch_cross_origin`.
- Packaging test stays green (content.js/manifest are already-packaged files).

## Out of Scope

- The docs.read / sheets.read / slides.read map actions and the write actions —
  they CONSUME this primitive but are their own work (task #55, next).
- Non-GET / cross-origin fetching — deliberately excluded (mutation goes through
  the visible-UI paste path; cross-origin is an unneeded exfiltration surface).
- Any change to state-projection semantics (reads become workflow actions
  instead; the engine already supports that).
