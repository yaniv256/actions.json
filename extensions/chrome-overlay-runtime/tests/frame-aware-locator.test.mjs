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
  assert.deepEqual(resolveFrameRoot([".outer", ".inner"], top), {
    ok: true,
    root: innermost,
  });
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

// Invariant guard (Yaniv 2026-07-05: wrong-frame is a recurring failure mode).
// Every user-facing element/scope resolver must route its query root through
// frameRootFor so `frame` is honored universally. A new resolver that queries
// document.querySelector* directly for a user-supplied selector/scope is a
// frame-blind regression — this asserts the known resolvers stay frame-aware.
test("all user-facing DOM resolvers route through frameRootFor", () => {
  const src = contentSource;
  // The four handlers that read by selector/scope must each obtain a root from
  // frameRootFor before querying.
  const handlers = [
    "const findScopedElement =",   // browser.extract_elements scope
    "const domObserveVisible =",   // dom.observe.visible
    "const domSnapshotText =",     // dom.snapshot_text
  ];
  for (const marker of handlers) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${marker} must exist`);
    const body = src.slice(start, start + 1200);
    assert.ok(
      body.includes("frameRootFor("),
      `${marker.trim()} must resolve its root via frameRootFor (frame-aware)`,
    );
    assert.ok(
      !/=\s*Array\.from\(\s*document\.querySelectorAll/.test(body) &&
        !body.includes("push(...Array.from(document.querySelectorAll"),
      `${marker.trim()} must not query document directly (frame-blind)`,
    );
  }
  // dom.list_sections handler (no distinctive const name at the top) — assert
  // by its primitive string neighbourhood.
  const ls = src.indexOf('primitiveError("dom.list_sections", "invalid_selector"');
  assert.ok(ls >= 0, "dom.list_sections handler must exist");
  const lsBody = src.slice(ls - 800, ls + 100);
  assert.ok(lsBody.includes("frameRootFor("), "dom.list_sections must use frameRootFor");
  assert.ok(
    lsBody.includes("root.querySelectorAll(selector)"),
    "dom.list_sections must query the frame root, not document",
  );
});
