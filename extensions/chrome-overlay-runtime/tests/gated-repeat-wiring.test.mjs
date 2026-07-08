import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

// Source-guards the background.js wiring of the accessibility-gated key-repeat
// primitive (plan 2026-07-07-004, U1-U3). The gate LOGIC is unit-tested in
// gated-repeat.test.mjs; this file guards that background.js actually routes and
// dispatches keyboard.press_gated through the trusted CDP path + a11y read.
// background.js can't be imported under node:test (service-worker globals), so we
// assert against its source — the same convention as input-key-trusted.test.mjs.

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

test("background.js imports the pure gated-repeat control module", () => {
  assert.ok(
    /import \{[\s\S]*?normalizeGatedRepeatArgs[\s\S]*?runGatedRepeat[\s\S]*?\} from "\.\/a11y\/gated-repeat\.mjs"/.test(backgroundSource),
    "must import normalizeGatedRepeatArgs + runGatedRepeat from ./a11y/gated-repeat.mjs",
  );
});

test("keyboard.press_gated always routes to the background worker", () => {
  const setMatch = backgroundSource.match(/const BRIDGE_BACKGROUND_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(setMatch, "BRIDGE_BACKGROUND_ACTION_NAMES set must exist");
  assert.ok(
    setMatch[1].includes('"keyboard.press_gated"'),
    "keyboard.press_gated must be in the always-background set (trusted-only, no synthetic counterpart)",
  );
});

test("executeBackgroundHostedToolCall handles keyboard.press_gated via dispatchGatedRepeat", () => {
  const idx = backgroundSource.indexOf('if (call.name === "keyboard.press_gated")');
  assert.ok(idx !== -1, "must branch on keyboard.press_gated");
  const branch = backgroundSource.slice(idx, idx + 500);
  assert.ok(branch.includes("dispatchGatedRepeat"), "the branch must call dispatchGatedRepeat");
});

test("dispatchGatedRepeat reuses the trusted CDP dispatch path and the pure loop", () => {
  const fn = backgroundSource.match(/const dispatchGatedRepeat = async \(tabId, rawArgs\) => \{([\s\S]*?)\n\};/);
  assert.ok(fn, "dispatchGatedRepeat must be declared");
  const body = fn[1];
  assert.ok(body.includes("normalizeGatedRepeatArgs"), "must validate args via the pure module");
  assert.ok(body.includes("runGatedRepeat"), "must drive the loop via the pure module");
  assert.ok(body.includes("acquireDebugger"), "must attach the debugger for the trusted press session");
  assert.ok(body.includes("releaseDebugger"), "must release the debugger when done");
  assert.ok(body.includes('"Input.dispatchKeyEvent"'), "each press must be a trusted CDP Input.dispatchKeyEvent");
  assert.ok(body.includes("withHeldModifiers"), "must press held modifiers so Docs' chord layer fires");
  assert.ok(body.includes("readCurrentA11yValue"), "the gate must read the current a11y value between presses");
  assert.ok(body.includes('fidelity: "trusted"'), "must report trusted fidelity");
});

test("readCurrentA11yValue reads the speakable REGION first, announcement buffer as fallback (live-corrected 2026-07-07)", () => {
  const fn = backgroundSource.match(/const readCurrentA11yValue = async \(tabId\) => \{([\s\S]*?)\n\};/);
  assert.ok(fn, "readCurrentA11yValue must be declared");
  const body = fn[1];
  assert.ok(body.includes("chrome.scripting.executeScript"), "must read the page (speakable region) via page script");
  assert.ok(body.includes("docs-aria-speakable"), "must read the #docs-aria-speakable caret-word region");
  assert.ok(body.includes("readA11yAnnouncements"), "must still fall back to the announcement buffer");
  // ORDER GUARD: the region read must come BEFORE the announcement-buffer read.
  // On real Docs the buffer interleaves coarse role echoes ("Application") while
  // the region holds the precise caret word; reading the buffer first (the old
  // order) made the gate halt-loud on a press that actually landed. This is the
  // exact bug the live fixture must now reproduce — see gated-repeat-smoke.mjs.
  const regionAt = body.indexOf("chrome.scripting.executeScript");
  const bufferAt = body.indexOf("readA11yAnnouncements");
  assert.ok(regionAt > -1 && bufferAt > -1, "both sources must be present");
  assert.ok(regionAt < bufferAt, "the speakable-region read MUST precede the announcement-buffer read");
});

// --- U4: dual-surface registration (the "added it but can't call it" trap) ---

test("keyboard.press_gated is declared in BOTH manifest surfaces", () => {
  const tool = (manifest.tools || []).find((t) => t.name === "keyboard.press_gated");
  const prim = manifest.primitive_dictionary.primitives.find((p) => p.name === "keyboard.press_gated");
  assert.ok(tool, "keyboard.press_gated must be in tools[] (bridge advertises it)");
  assert.ok(prim, "keyboard.press_gated must be in primitive_dictionary.primitives (hosted catalog)");
});

test("keyboard.press_gated primitive_dictionary entry carries model-usable metadata", () => {
  const prim = manifest.primitive_dictionary.primitives.find((p) => p.name === "keyboard.press_gated");
  assert.equal(prim.support, "supported");
  assert.ok(prim.summary && prim.summary.length > 0, "needs a non-empty summary");
  assert.equal(prim.input_schema.type, "object");
  assert.deepEqual(prim.input_schema.required, ["key", "stop"], "key + stop are required");
});

test("keyboard.press_gated is routable (a static tool name, so not unroutable)", () => {
  const staticToolNames = new Set((manifest.tools || []).map((t) => t.name));
  assert.ok(staticToolNames.has("keyboard.press_gated"),
    "must be a static tool so the hosted catalog can route it without a content-route entry");
});

test("keyboard.press_gated tool routes to the dispatchGatedRepeat handler", () => {
  const tool = (manifest.tools || []).find((t) => t.name === "keyboard.press_gated");
  assert.equal(tool.x_actions.handler, "dispatchGatedRepeat");
});
