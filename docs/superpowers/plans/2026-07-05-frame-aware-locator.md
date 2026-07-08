# Frame-Aware Locator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `frame` field (CSS selector or array of selectors, outer→inner) to the locator object so every primitive that takes a locator can target elements inside iframes, resolved centrally in the locator layer.

**Architecture:** Add a pure `resolveFrameRoot(frame, topDocument)` helper in `content.js` that folds over frame selectors to reach the innermost same-origin document (or returns a `frame_cross_origin` / `frame_not_found` error). `resolveLocatorCandidates` uses it to pick the query root instead of hardcoding `document`; `queryRelative(root, …)` already takes a root, so all `resolveSingle*` wrappers and every primitive inherit frame targeting. Revert the paste-specific `pasteTargetKind` auto-descent (superseded).

**Tech Stack:** Vanilla browser JS (content script, isolated world), `node:test` source-slice unit tests.

## Global Constraints

- Content script, isolated world; handlers return via `primitiveSuccess`/`primitiveError`.
- `frame` is `string | string[]`; a single string is treated as `[string]`. No frame → query the top `document` (byte-for-byte current behavior).
- Cross-origin frame (contentDocument throws or is null) → `frame_cross_origin` error naming the selector. Frame selector matching no `<iframe>`/`<frame>` → `frame_not_found`.
- Unit tests slice a pure helper from `content.js` source with `new Function` (repo idiom; see `tests/clipboard-selection-primitives.test.mjs` `sliceConst`).
- No behavior change for locators without a `frame`.

---

## File Structure

- `extensions/chrome-overlay-runtime/src/content.js` — add `resolveFrameRoot` (pure), wire it into `resolveLocatorCandidates` (line ~2726), record a module-scoped `lastLocatorFrameError`, surface it in `locatorElementInfo`'s empty path, and REVERT `pasteTargetKind` (lines ~3319-3341) to the simple form.
- `extensions/chrome-overlay-runtime/tests/frame-aware-locator.test.mjs` — NEW: source-slice unit tests for `resolveFrameRoot`.
- `extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs` — MODIFY: update the `pasteTargetKind` tests back to the simple form after the revert.

---

### Task 1: `resolveFrameRoot` pure helper

The fold that walks frame selectors to the innermost document, with the two error shapes. Pure and source-sliceable.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js` (add helper just above `resolveLocatorCandidates`, ~line 2725)
- Test: `extensions/chrome-overlay-runtime/tests/frame-aware-locator.test.mjs` (new)

**Interfaces:**
- Produces: `resolveFrameRoot(frame, topDocument)` → `{ ok: true, root: Document }` or `{ ok: false, error: { code, frame, message? } }`. `code` ∈ `"frame_cross_origin" | "frame_not_found"`.

- [ ] **Step 1: Write the failing test** (create the file)

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);

const sliceConst = (name) => {
  const start = contentSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist in content.js`);
  const marker = "\n  };";
  const end = contentSource.indexOf(marker, start);
  assert.ok(end > start, `${name} body end not found`);
  return contentSource.slice(start, end + marker.length);
};

const buildResolveFrameRoot = () =>
  new Function(`${sliceConst("resolveFrameRoot")}\n return resolveFrameRoot;`)();

// Minimal fake iframe/document graph.
const makeDoc = (frames = {}) => ({
  __isDoc: true,
  querySelector(sel) {
    return Object.prototype.hasOwnProperty.call(frames, sel) ? frames[sel] : null;
  },
});
const makeIframe = (contentDocument) => ({ tagName: "IFRAME", contentDocument });
const makeCrossOriginIframe = () => ({
  tagName: "IFRAME",
  get contentDocument() {
    throw new Error("cross-origin");
  },
});

test("no frame returns the top document", () => {
  const resolveFrameRoot = buildResolveFrameRoot();
  const top = makeDoc();
  assert.deepEqual(resolveFrameRoot(undefined, top), { ok: true, root: top });
});

test("single same-origin frame returns the inner document", () => {
  const resolveFrameRoot = buildResolveFrameRoot();
  const inner = makeDoc();
  const top = makeDoc({ ".f": makeIframe(inner) });
  assert.deepEqual(resolveFrameRoot(".f", top), { ok: true, root: inner });
});

test("nested frames fold outer-to-inner", () => {
  const resolveFrameRoot = buildResolveFrameRoot();
  const innermost = makeDoc();
  const mid = makeDoc({ ".inner": makeIframe(innermost) });
  const top = makeDoc({ ".outer": makeIframe(mid) });
  assert.deepEqual(resolveFrameRoot([".outer", ".inner"], top), { ok: true, root: innermost });
});

test("cross-origin frame errors", () => {
  const resolveFrameRoot = buildResolveFrameRoot();
  const top = makeDoc({ ".x": makeCrossOriginIframe() });
  const r = resolveFrameRoot(".x", top);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "frame_cross_origin");
  assert.equal(r.error.frame, ".x");
});

test("missing frame selector errors frame_not_found", () => {
  const resolveFrameRoot = buildResolveFrameRoot();
  const top = makeDoc({});
  const r = resolveFrameRoot(".nope", top);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "frame_not_found");
  assert.equal(r.error.frame, ".nope");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test extensions/chrome-overlay-runtime/tests/frame-aware-locator.test.mjs`
Expected: FAIL — "resolveFrameRoot must exist in content.js".

- [ ] **Step 3: Add the helper** to content.js just above `resolveLocatorCandidates` (~line 2725)

```js
  // Resolve the document a locator should query, given an optional `frame`.
  // `frame` is a CSS selector (or array, outer->inner) for iframe(s) to step
  // into. Same-origin only: a cross-origin frame's contentDocument is
  // unreachable from page JS -> frame_cross_origin. Returns {ok:true, root} or
  // {ok:false, error:{code, frame, message?}}.
  const resolveFrameRoot = (frame, topDocument) => {
    if (frame === undefined || frame === null || frame === "") {
      return { ok: true, root: topDocument };
    }
    const selectors = Array.isArray(frame) ? frame : [frame];
    let root = topDocument;
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      const isFrame = el && (el.tagName === "IFRAME" || el.tagName === "FRAME");
      if (!isFrame) {
        return { ok: false, error: { code: "frame_not_found", frame: sel } };
      }
      let innerDoc = null;
      try {
        innerDoc = el.contentDocument;
      } catch (_error) {
        innerDoc = null;
      }
      if (!innerDoc) {
        return {
          ok: false,
          error: {
            code: "frame_cross_origin",
            frame: sel,
            message: "Frame is cross-origin; its contents cannot be targeted from page JS.",
          },
        };
      }
      root = innerDoc;
    }
    return { ok: true, root };
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test extensions/chrome-overlay-runtime/tests/frame-aware-locator.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js extensions/chrome-overlay-runtime/tests/frame-aware-locator.test.mjs
git commit -m "feat(locator): resolveFrameRoot helper (folds frame selectors to inner document)"
```

---

### Task 2: Wire `resolveFrameRoot` into `resolveLocatorCandidates`

Make the resolver query the frame's document and record a frame error for surfacing.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js` (`resolveLocatorCandidates` ~line 2726; add a module-scoped `lastLocatorFrameError`)

**Interfaces:**
- Consumes: `resolveFrameRoot` (Task 1), existing `queryRelative`.
- Produces: `resolveLocatorCandidates` queries inside `locator.frame`; sets `lastLocatorFrameError` (module-scoped `let`, reset to null each call, set to the error object on frame failure).

- [ ] **Step 1: Add the module-scoped error holder** near the other locator helpers (just above `resolveLocatorCandidates`, after `resolveFrameRoot`)

```js
  let lastLocatorFrameError = null;
```

- [ ] **Step 2: Replace the body of `resolveLocatorCandidates`** (current lines ~2726-2750). The current first lines are:

```js
  const resolveLocatorCandidates = (locator) => {
    if (!locator || typeof locator !== "object") return [];
    let candidates = [];
    if (typeof locator.selector === "string" && locator.selector.trim()) {
      candidates = queryRelative(document, locator.selector.trim(), { visible_only: false });
    } else {
      candidates = Array.from(
        document.querySelectorAll("button, a, input, textarea, select, [role], [aria-label], [data-testid], [data-test], [data-actions-json-target]")
      );
    }
```

Change to resolve the frame root first and query against it:

```js
  const resolveLocatorCandidates = (locator) => {
    lastLocatorFrameError = null;
    if (!locator || typeof locator !== "object") return [];
    const frameResult = resolveFrameRoot(locator.frame, document);
    if (!frameResult.ok) {
      lastLocatorFrameError = frameResult.error;
      return [];
    }
    const root = frameResult.root;
    let candidates = [];
    if (typeof locator.selector === "string" && locator.selector.trim()) {
      candidates = queryRelative(root, locator.selector.trim(), { visible_only: false });
    } else {
      candidates = Array.from(
        root.querySelectorAll("button, a, input, textarea, select, [role], [aria-label], [data-testid], [data-test], [data-actions-json-target]")
      );
    }
```

(Leave the rest of the function — the `text` filtering — unchanged.)

- [ ] **Step 3: Verify content.js parses**

Run: `node --check extensions/chrome-overlay-runtime/src/content.js`
Expected: no output.

- [ ] **Step 4: Run the full extension suite (no regressions on the no-frame path)**

Run: `node --test "extensions/chrome-overlay-runtime/tests/*.test.mjs"`
Expected: PASS (all existing tests; frame path unused by them so unchanged).

- [ ] **Step 5: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js
git commit -m "feat(locator): resolveLocatorCandidates queries inside locator.frame"
```

---

### Task 3: Surface `frame_*` errors in `locator.element_info`

When candidates are empty because of a frame error, report it instead of a bare `target_not_found`.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js` (`locatorElementInfo` empty-result branch)

**Interfaces:**
- Consumes: `lastLocatorFrameError` (Task 2).

- [ ] **Step 1: Update the empty branch of `locatorElementInfo`.** Current:

```js
    if (!element) {
      return primitiveError("locator.element_info", "target_not_found", "No visible element matched the locator.", {
        locator
      });
    }
```

Change to prefer a recorded frame error:

```js
    if (!element) {
      if (lastLocatorFrameError) {
        return primitiveError(
          "locator.element_info",
          lastLocatorFrameError.code,
          lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`,
          { locator, frame: lastLocatorFrameError.frame },
        );
      }
      return primitiveError("locator.element_info", "target_not_found", "No visible element matched the locator.", {
        locator
      });
    }
```

- [ ] **Step 2: Verify content.js parses**

Run: `node --check extensions/chrome-overlay-runtime/src/content.js`
Expected: no output.

- [ ] **Step 3: Run the full extension suite**

Run: `node --test "extensions/chrome-overlay-runtime/tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js
git commit -m "feat(locator): surface frame_cross_origin/frame_not_found in element_info"
```

---

### Task 4: Revert the paste-specific `pasteTargetKind` auto-descent

The frame-aware locator supersedes it; paste resolves its target through the locator like everything else.

**Files:**
- Modify: `extensions/chrome-overlay-runtime/src/content.js` (`isIframeElement` + `pasteTargetKind`, ~lines 3319-3341)
- Modify: `extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs` (the pasteTargetKind tests)

**Interfaces:**
- Produces: `pasteTargetKind(resolved, activeElement)` → `{ target, target_kind }`, simple form: resolved non-null → resolved (`resolved-locator`); else activeElement (`activeElement`). No iframe descent.

- [ ] **Step 1: Replace `isIframeElement` + `pasteTargetKind`** (the whole block added in 0.1.150) with the simple form:

```js
  // Where a clipboard/selection event dispatches: the resolved locator target,
  // or the focused element when no locator was given. Frame targeting (reaching
  // inside an iframe) is handled by the locator's `frame` field, not here.
  const pasteTargetKind = (resolved, activeElement) => {
    if (resolved) {
      return { target: resolved, target_kind: "resolved-locator" };
    }
    return { target: activeElement, target_kind: "activeElement" };
  };
```

- [ ] **Step 2: Update the pasteTargetKind tests** in `clipboard-selection-primitives.test.mjs`. Replace the `buildPasteTargetKind` helper + the four iframe tests with the simple pair (there is no longer an `isIframeElement` to slice):

```js
test("pasteTargetKind uses the resolved element", () => {
  const src = sliceConst("pasteTargetKind");
  const pasteTargetKind = new Function(`${src} return pasteTargetKind;`)();
  const input = { tagName: "INPUT" };
  const active = { tagName: "DIV" };
  assert.deepEqual(pasteTargetKind(input, active), {
    target: input,
    target_kind: "resolved-locator",
  });
});

test("pasteTargetKind falls back to activeElement when unresolved", () => {
  const src = sliceConst("pasteTargetKind");
  const pasteTargetKind = new Function(`${src} return pasteTargetKind;`)();
  const active = { tagName: "DIV" };
  assert.deepEqual(pasteTargetKind(null, active), {
    target: active,
    target_kind: "activeElement",
  });
});
```

- [ ] **Step 3: Verify content.js parses + run the clipboard tests**

Run: `node --check extensions/chrome-overlay-runtime/src/content.js && node --test extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add extensions/chrome-overlay-runtime/src/content.js extensions/chrome-overlay-runtime/tests/clipboard-selection-primitives.test.mjs
git commit -m "refactor(clipboard.paste): drop iframe auto-descent (superseded by frame-aware locator)"
```

---

### Task 5: Full suite + live validation

**Files:**
- Test: full extension + runtime suites

- [ ] **Step 1: Run the whole extension suite**

Run: `node --test "extensions/chrome-overlay-runtime/tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 2: Run the runtime suite**

Run: `node --test "runtime/actions-json-runtime/tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 3: Run the packaging test**

Run: `node --test tests/package-extension.test.mjs`
Expected: PASS.

- [ ] **Step 4: Live validation (supervised, needs rebuilt extension loaded).** After releasing + reloading:
  - `clipboard.paste { text: "frame-locator probe", target: { frame: ".docs-texteventtarget-iframe", selector: "[contenteditable='true']" } }` on a Google Doc → VERIFY BY SCREENSHOT the text landed (docs.read is canvas-blind — do NOT trust it).
  - `locator.element_info { locator: { frame: ".docs-texteventtarget-iframe", selector: "[contenteditable='true']" } }` returns the inner element (not target_not_found).
  - A cross-origin frame target returns `frame_cross_origin`.

---

## Self-Review

**Spec coverage:** `frame` string|array (Task 1) ✓; central resolve in `resolveLocatorCandidates` (Task 2) ✓; `frame_cross_origin` + `frame_not_found` (Tasks 1,3) ✓; no-frame backward compat (Task 2, current behavior preserved) ✓; revert paste auto-descent (Task 4) ✓; live screenshot validation (Task 5) ✓. Coordinates note (viewport-relative) is a live-verify in Task 5, not a code task — consistent with the spec flagging it as verify-not-assume. No gaps.

**Placeholder scan:** every code step shows the code; every run step shows the command + expected output; no TBD/TODO.

**Type consistency:** `resolveFrameRoot(frame, topDocument)` → `{ok, root}|{ok:false, error:{code, frame, message?}}` used identically in Tasks 1-3. `lastLocatorFrameError` set in Task 2, read in Task 3. `pasteTargetKind(resolved, activeElement)` → `{target, target_kind}` consistent across Task 4 and its tests.

**Implementer note:** content.js line numbers are approximate — locate by the named anchors (`resolveLocatorCandidates`, `locatorElementInfo`, `pasteTargetKind`). Only the pure `resolveFrameRoot` is unit-tested directly; the wiring is covered by the no-regression suite + live Task 5 (browser-only behavior can't be unit-tested in node).
