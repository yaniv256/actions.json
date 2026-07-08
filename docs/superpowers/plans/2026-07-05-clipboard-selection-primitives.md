# Clipboard & Selection Primitive Family — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five browser-runtime primitives — `text.select`, `clipboard.copy`, `clipboard.paste`, `clipboard.read`, `clipboard.write` — so agents can select page text, move it to/from the system clipboard, and write into iframe-hosted editors (Google Docs/Sheets/Slides).

**Architecture:** Each primitive is a handler in `extensions/chrome-overlay-runtime/src/content.js`, wired into the `executeAction` dispatch and declared in both `overlay.actions.json` tool surfaces (`tools[]` for the bridge, `primitive_dictionary.primitives[]` for the hosted-agent catalog). Handlers reuse existing helpers (`syntheticClipboardEvent`, `clipboardHtmlFromText`, `selectEditableContents`, `resolveEditableTarget`). Tests follow the repo idiom: slice a pure helper out of `content.js` source with `new Function` and assert on it (see `tests/clipboard-html-newlines.test.mjs`).

**Tech Stack:** Vanilla browser JS (content script, isolated world), `node:test`, the actions.json overlay manifest.

## Global Constraints

- Content script runs in the browser isolated world; handlers are async and return via `primitiveSuccess(name, obj)` / `primitiveError(name, code, message, evidence)` (existing helpers in content.js).
- A new generic primitive MUST be declared in BOTH `overlay.actions.json` `tools[]` AND `primitive_dictionary.primitives[]`, AND wired into `executeAction`; missing any surface = `unknown_action` or catalog-invisible. (verbatim project rule)
- `primitive_dictionary` entries require: `support: "supported"`, non-empty `summary`, object `input_schema`, `capability_class: "portable"`, `portable: true`.
- iframe guard (family-wide): if a resolved target is an `<iframe>`, discard it and use `document.activeElement`; never pierce `contentDocument`.
- Success flags mean "the event/API call was issued," not "the effect is confirmed."
- Bare `clipboard.paste`/`clipboard.read` use `navigator.clipboard.readText()`; `clipboard.write`/`clipboard.copy` use `navigator.clipboard.writeText()`. On rejection return `clipboard_read_denied` / `clipboard_write_denied` with the browser reason — never silently succeed empty.
- No change to `text.insert`.

---

## File Structure

- `extensions/chrome-overlay-runtime/src/content.js` — add 5 handlers + 5 dispatch arms; add one pure helper `pasteTargetKind(target, activeElement)` and one `resolvePasteTarget(...)` factored so tests can slice them. Reuse existing `syntheticClipboardEvent`, `clipboardHtmlFromText`, `selectEditableContents`, `resolveEditableTarget`, `isEditableElement`, `primitiveSuccess`, `primitiveError`.
- `extensions/chrome-overlay-runtime/actions/overlay.actions.json` — 5 entries in `tools[]`, 5 in `primitive_dictionary.primitives[]`.
- `extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs` — NEW test file (source-slice tests for the pure helpers + manifest-shape assertions).
- `extensions/chrome-overlay-runtime/tests/bridge-background-action-routing.test.mjs` — MODIFY if it has a content-route allow-list, add the 5 names.

---

### Task 1: Manifest declarations for all five primitives

Declares the five primitives in both manifest surfaces so the bridge advertises them and the hosted catalog exposes them. This is inert (no handler yet) but independently reviewable: a reviewer can accept the tool contracts before any behavior exists.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/actions/overlay.actions.json`
- Test: `extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`

**Interfaces:**
- Produces: five tool names — `text.select`, `clipboard.copy`, `clipboard.paste`, `clipboard.read`, `clipboard.write` — each present in `tools[]` and `primitive_dictionary.primitives[]`.

- [ ] **Step 1: Write the failing test** (create the test file)

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(
    new URL("../actions/overlay.actions.json", import.meta.url),
    "utf8",
  ),
);

const FAMILY = ["text.select", "clipboard.copy", "clipboard.paste", "clipboard.read", "clipboard.write"];

test("all five primitives are advertised in tools[]", () => {
  const names = new Set(manifest.tools.map((t) => t.name));
  for (const n of FAMILY) assert.ok(names.has(n), `tools[] missing ${n}`);
});

test("all five primitives are in primitive_dictionary with required fields", () => {
  const prims = manifest.primitive_dictionary.primitives;
  const byName = new Map(prims.map((p) => [p.name, p]));
  for (const n of FAMILY) {
    const p = byName.get(n);
    assert.ok(p, `primitive_dictionary missing ${n}`);
    assert.equal(p.support, "supported", `${n} must be supported`);
    assert.ok(typeof p.summary === "string" && p.summary.length, `${n} needs summary`);
    assert.equal(typeof p.input_schema, "object", `${n} needs input_schema`);
  }
});

test("clipboard.read and clipboard.write appear exactly once per surface", () => {
  for (const n of ["clipboard.read", "clipboard.write"]) {
    assert.equal(manifest.tools.filter((t) => t.name === n).length, 1, `duplicate ${n} in tools[]`);
    assert.equal(
      manifest.primitive_dictionary.primitives.filter((p) => p.name === n).length,
      1,
      `duplicate ${n} in primitive_dictionary`,
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`
Expected: FAIL — missing `text.select`, `clipboard.copy`, `clipboard.paste`; and (if pre-existing) possibly duplicate/handlerless `clipboard.read`/`clipboard.write`.

- [ ] **Step 3: Add the five `tools[]` entries**

Add to `overlay.actions.json` `tools[]` (reconcile any pre-existing `clipboard.read`/`clipboard.write` to exactly one entry each):

```json
{ "name": "text.select",
  "description": "Select a range on the page (a target's editable contents, or the focused element's contents). Precursor to clipboard.copy.",
  "input_schema": { "type": "object", "properties": {
    "target": { "type": "object", "description": "Optional locator. Omit to use the focused element." },
    "mode": { "type": "string", "enum": ["all"], "default": "all" } },
    "additionalProperties": false } },
{ "name": "clipboard.copy",
  "description": "Move the current page selection into the system clipboard (page -> clipboard). Dispatches a synthetic copy event so page-side copy handlers run and writes the selection text to the system clipboard.",
  "input_schema": { "type": "object", "properties": {
    "target": { "type": "object", "description": "Optional locator whose selection to copy. Omit to use the current selection / focused element." } },
    "additionalProperties": false } },
{ "name": "clipboard.paste",
  "description": "Paste into a DOM element (clipboard -> page). With text: paste that text. Without text: paste the current system clipboard. Dispatches a synthetic paste event at the target (default: focused element); this is the way to write into iframe-hosted editors like Google Docs where text.insert cannot reach.",
  "input_schema": { "type": "object", "properties": {
    "text": { "type": "string", "description": "Optional. Text to paste. Omit to paste the current system clipboard." },
    "target": { "type": "object", "description": "Optional locator to paste into. Omit to use the focused element. An iframe target falls back to the focused inner element." } },
    "additionalProperties": false } },
{ "name": "clipboard.read",
  "description": "Read the current system clipboard text. Pure clipboard I/O; does not touch the page.",
  "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } },
{ "name": "clipboard.write",
  "description": "Write text to the system clipboard. Pure clipboard I/O; does not touch the page.",
  "input_schema": { "type": "object", "required": ["text"], "properties": {
    "text": { "type": "string" } }, "additionalProperties": false } }
```

- [ ] **Step 4: Add the five `primitive_dictionary.primitives[]` entries**

For each, add (mirroring the `text.insert` dictionary shape) with `support: "supported"`, `capability_class: "portable"`, `portable: true`, `reason: null`, a `summary`, and the same `input_schema` as the tools entry. Example for `clipboard.paste`:

```json
{ "name": "clipboard.paste", "support": "supported", "reason": null,
  "capability_class": "portable", "portable": true,
  "summary": "Paste text (given, or the system clipboard) into a DOM element via a synthetic paste event; reaches iframe-hosted editors.",
  "input_schema": { "type": "object", "properties": {
    "text": { "type": "string" },
    "target": { "type": "object", "description": "Optional. Omit to use the focused element." } },
    "additionalProperties": false } }
```

Repeat for `text.select`, `clipboard.copy`, `clipboard.read`, `clipboard.write` with their matching schemas and one-line summaries.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`
Expected: PASS (3 manifest tests).

- [ ] **Step 6: Commit**

```bash
git add extensions/chrome-overlay-runtime/actions/overlay.actions.json extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs
git commit -m "feat(primitives): declare clipboard/selection family in both manifest surfaces"
```

---

### Task 2: Pure target-resolution helper + iframe guard

The one piece of non-trivial branching (which element to dispatch at, with the iframe guard) is factored into a pure function so it can be unit-tested by source-slicing, matching the repo's test idiom.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js` (add `pasteTargetKind`)
- Test: `extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`

**Interfaces:**
- Produces: `pasteTargetKind(resolved, activeElement)` → returns `{ target, target_kind }` where `target_kind` is `"resolved-locator"` when `resolved` is a non-iframe element, else `"activeElement"` (used when `resolved` is null OR an iframe).

- [ ] **Step 1: Write the failing test** (append to the test file)

```js
const contentSource = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const slice = (name) => {
  const start = contentSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist in content.js`);
  const end = contentSource.indexOf("\n  };", start);
  return contentSource.slice(start, end + 4);
};

test("pasteTargetKind falls back to activeElement for null or iframe", () => {
  const src = slice("pasteTargetKind");
  const pasteTargetKind = new Function(`${src} return pasteTargetKind;`)();
  const active = { tagName: "DIV" };
  const iframe = { tagName: "IFRAME" };
  const input = { tagName: "INPUT" };
  assert.deepEqual(pasteTargetKind(null, active), { target: active, target_kind: "activeElement" });
  assert.deepEqual(pasteTargetKind(iframe, active), { target: active, target_kind: "activeElement" });
  assert.deepEqual(pasteTargetKind(input, active), { target: input, target_kind: "resolved-locator" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`
Expected: FAIL — "pasteTargetKind must exist in content.js".

- [ ] **Step 3: Add the helper to content.js** (near `syntheticClipboardEvent`, ~line 3308)

```js
  const pasteTargetKind = (resolved, activeElement) => {
    const isIframe = resolved && (resolved.tagName === "IFRAME" || resolved.tagName === "iframe");
    if (!resolved || isIframe) {
      return { target: activeElement, target_kind: "activeElement" };
    }
    return { target: resolved, target_kind: "resolved-locator" };
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs
git commit -m "feat(primitives): pure paste-target resolver with iframe guard"
```

---

### Task 3: `clipboard.paste` handler + dispatch

Implements the highest-value primitive (the Google write unblock) end to end, wired into `executeAction`.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js`

**Interfaces:**
- Consumes: `pasteTargetKind` (Task 2), `syntheticClipboardEvent`, `resolveEditableTarget`, `primitiveSuccess`, `primitiveError`.
- Produces: `clipboardPaste(args)` → success `{ pasted: true, inserted_length, input_method: "synthetic-paste", default_prevented, target_kind, source }`; errors `no_paste_target`, `clipboard_read_denied`.

- [ ] **Step 1: Add the handler** (after `textInsert`, ~line 3380)

```js
  const clipboardPaste = async (args = {}) => {
    const resolved = args.target ? resolveEditableTarget(args.target) : null;
    const { target, target_kind } = pasteTargetKind(resolved, document.activeElement);
    if (!target) {
      return primitiveError("clipboard.paste", "no_paste_target",
        "No focused or resolvable element to paste into; click into the editor first.", {});
    }
    let payload = args.text;
    let source = "argument";
    if (payload === undefined || payload === null) {
      source = "system-clipboard";
      try {
        payload = await navigator.clipboard.readText();
      } catch (error) {
        return primitiveError("clipboard.paste", "clipboard_read_denied",
          `Could not read the system clipboard: ${error?.message || error}`, {});
      }
    }
    payload = String(payload);
    target.focus?.();
    const pasteEvent = syntheticClipboardEvent(payload);
    target.dispatchEvent(pasteEvent);
    return primitiveSuccess("clipboard.paste", {
      pasted: true,
      inserted_length: payload.length,
      input_method: "synthetic-paste",
      default_prevented: pasteEvent.defaultPrevented,
      target_kind,
      source,
    });
  };
```

- [ ] **Step 2: Add the dispatch arm** in `executeAction` (near the `text.insert` arm, ~line 3576)

```js
    } else if (message.name === "clipboard.paste") {
      output = await clipboardPaste(message.arguments || {});
```

- [ ] **Step 3: Verify content.js still parses**

Run: `node --check extensions/chrome-overlay-runtime/src/content.js`
Expected: no output (valid syntax).

- [ ] **Step 4: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js
git commit -m "feat(primitives): clipboard.paste handler (iframe write path)"
```

---

### Task 4: `clipboard.read` and `clipboard.write` handlers + dispatch

The two pure clipboard-I/O primitives.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js`

**Interfaces:**
- Produces: `clipboardRead()` → `{ text, length }` or `clipboard_read_denied`; `clipboardWrite(args)` → `{ written: true, length }` or `clipboard_write_denied`.

- [ ] **Step 1: Add both handlers** (after `clipboardPaste`)

```js
  const clipboardRead = async () => {
    try {
      const text = await navigator.clipboard.readText();
      return primitiveSuccess("clipboard.read", { text, length: text.length });
    } catch (error) {
      return primitiveError("clipboard.read", "clipboard_read_denied",
        `Could not read the system clipboard: ${error?.message || error}`, {});
    }
  };

  const clipboardWrite = async (args = {}) => {
    const text = String(args.text ?? "");
    try {
      await navigator.clipboard.writeText(text);
      return primitiveSuccess("clipboard.write", { written: true, length: text.length });
    } catch (error) {
      return primitiveError("clipboard.write", "clipboard_write_denied",
        `Could not write the system clipboard: ${error?.message || error}`, {});
    }
  };
```

- [ ] **Step 2: Add the dispatch arms** in `executeAction`

```js
    } else if (message.name === "clipboard.read") {
      output = await clipboardRead();
    } else if (message.name === "clipboard.write") {
      output = await clipboardWrite(message.arguments || {});
```

- [ ] **Step 3: Verify content.js parses**

Run: `node --check extensions/chrome-overlay-runtime/src/content.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js
git commit -m "feat(primitives): clipboard.read and clipboard.write handlers"
```

---

### Task 5: `text.select` and `clipboard.copy` handlers + dispatch

The page-selection primitive and the selection→clipboard bridge.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js`

**Interfaces:**
- Consumes: `selectEditableContents`, `resolveEditableTarget`, `pasteTargetKind`.
- Produces: `textSelect(args)` → `{ selected: true, selected_length, target_kind }`; `clipboardCopy(args)` → `{ copied: true, copied_length, clipboard_write }`.

- [ ] **Step 1: Add both handlers** (after `clipboardWrite`)

```js
  const textSelect = (args = {}) => {
    const resolved = args.target ? resolveEditableTarget(args.target) : null;
    const { target, target_kind } = pasteTargetKind(resolved, document.activeElement);
    if (!target) {
      return primitiveError("text.select", "no_select_target",
        "No focused or resolvable element to select.", {});
    }
    target.focus?.();
    const selected = selectEditableContents(target, "replace");
    return primitiveSuccess("text.select", {
      selected: true,
      selected_length: (selected || "").length,
      target_kind,
    });
  };

  const clipboardCopy = async (args = {}) => {
    const resolved = args.target ? resolveEditableTarget(args.target) : null;
    const { target } = pasteTargetKind(resolved, document.activeElement);
    // page-side copy handlers (e.g. Google) run on the synthetic event
    const copyEvent = new ClipboardEvent("copy", { bubbles: true, cancelable: true, composed: true });
    target?.dispatchEvent?.(copyEvent);
    const selectionText = String(document.getSelection?.() || "");
    let clipboard_write = "ok";
    try {
      if (selectionText) await navigator.clipboard.writeText(selectionText);
      else clipboard_write = "empty_selection";
    } catch (error) {
      clipboard_write = "denied";
    }
    return primitiveSuccess("clipboard.copy", {
      copied: true,
      copied_length: selectionText.length,
      clipboard_write,
    });
  };
```

- [ ] **Step 2: Add the dispatch arms** in `executeAction`

```js
    } else if (message.name === "text.select") {
      output = textSelect(message.arguments || {});
    } else if (message.name === "clipboard.copy") {
      output = await clipboardCopy(message.arguments || {});
```

- [ ] **Step 3: Verify content.js parses**

Run: `node --check extensions/chrome-overlay-runtime/src/content.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js
git commit -m "feat(primitives): text.select and clipboard.copy handlers"
```

---

### Task 6: Routability allow-list + packaging + full suite

Ensures the five primitives route to the content script and ship in the package, and the whole suite is green.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/tests/bridge-background-action-routing.test.mjs` (if it has a content-route allow-list)
- Test: whole extension test suite

- [ ] **Step 1: Check for a content-route allow-list**

Run: `grep -n "text.insert\|content.*route\|allow" extensions/chrome-overlay-runtime/tests/bridge-background-action-routing.test.mjs`
Expected: shows whether `text.insert` (a content primitive) is in an explicit list. If yes, the five new names must join it.

- [ ] **Step 2: Add the five names to the allow-list** (only if Step 1 found one)

Add `"text.select", "clipboard.copy", "clipboard.paste", "clipboard.read", "clipboard.write"` alongside `text.insert` in that list.

- [ ] **Step 3: Run the full extension test suite**

Run: `node --test extensions/chrome-overlay-runtime/tests/`
Expected: PASS — all existing tests plus the new `clipboard-selection-primitives.test.mjs`.

- [ ] **Step 4: Run the packaging test**

Run: `node --test tests/package-extension.test.mjs`
Expected: PASS (content.js/manifest changes are in already-packaged files; no new files to add to the package list, so this should stay green).

- [ ] **Step 5: Commit**

```bash
git add -A extensions/chrome-overlay-runtime/tests/
git commit -m "test(primitives): route + suite coverage for clipboard/selection family"
```

---

### Task 7: Live validation on Google Docs (the acceptance bar)

The unit tests prove wiring and pure logic; the real acceptance is a live paste into a Google Doc. This task is manual/supervised (needs a running browser on 0.1.148+ with the rebuilt extension) and is the gate before promoting any productivity map's write action.

**Steps (supervised, not automated):**

- [ ] **Step 1:** Rebuild + reload the extension from this branch (the released zip or an unpacked checkout — a bridge restart alone does not reload content.js).
- [ ] **Step 2:** Open a Google Doc; `pointer.click` into the canvas to focus the iframe target.
- [ ] **Step 3:** Call `clipboard.paste { text: "hello from clipboard.paste" }`; then read `docs.read` and assert the body contains the text. Record the result.
- [ ] **Step 4:** Cross-app: `clipboard.write { text: "transfer probe" }`, click the Docs canvas, `clipboard.paste {}` (bare), `docs.read` contains it.
- [ ] **Step 5:** iframe guard: call `clipboard.paste { text, target: <the iframe selector> }`; assert it still pastes (does not return `target_not_editable`).
- [ ] **Step 6:** Record findings in the map/notes; only after this passes do the productivity maps gain write actions (task #55).

---

## Self-Review

**Spec coverage:** All five primitives (Tasks 1,3,4,5) ✓; iframe guard (Task 2, reused in 3/5) ✓; optional text + system-clipboard bare mode (Task 3) ✓; read/write implemented for real + reconciled to one declaration (Tasks 1,4) ✓; both manifest surfaces (Task 1) ✓; error codes `no_paste_target`/`clipboard_read_denied`/`clipboard_write_denied` (Tasks 3,4) ✓; routability + packaging (Task 6) ✓; live Docs acceptance (Task 7) ✓. No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows the code; every run step shows the command + expected output.

**Type consistency:** `pasteTargetKind(resolved, activeElement)` returns `{target, target_kind}` — consumed identically in Tasks 3 and 5. Handler names (`clipboardPaste`, `clipboardRead`, `clipboardWrite`, `textSelect`, `clipboardCopy`) match their dispatch arms. Success/error field names consistent across tasks and the spec.

**Note for implementer:** Line numbers are approximate (content.js is large and evolves) — locate by the named anchors (`syntheticClipboardEvent`, `textInsert`, the `text.insert` dispatch arm) rather than trusting exact line numbers. Verify each new handler by `node --check`; the browser-only handlers are validated live in Task 7, not by unit tests (only the pure `pasteTargetKind` and the manifest shapes are unit-tested, matching the repo idiom).
