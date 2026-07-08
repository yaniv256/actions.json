import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Guards the 2026-07-05 trusted-input design. keyboard.press has TWO paths
// selected by an optional `trusted` flag:
//   - trusted:false (default) → synthetic dispatch in content.js (portable,
//     untrusted; canvas editors ignore it).
//   - trusted:true → routed to the BACKGROUND worker, which dispatches a real
//     key via CDP Input.dispatchKeyEvent (the only kind Google Slides/Docs/Sheets
//     honor — e.g. Control+A selects).
// The dual path is deliberate: trusted is opt-in and always has a non-debugger
// counterpart, so the two can be A/B compared to confirm trusted is truly needed.
// If any leg regresses, either the comparison breaks or trusted stops reaching
// canvas editors.

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);
const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

test("trusted keyboard.press routes to the background worker; synthetic does not", () => {
  const fn = backgroundSource.match(
    /const bridgeItemNeedsBackground = \(item\) => \{([\s\S]*?)\n\};/,
  );
  assert.ok(fn, "bridgeItemNeedsBackground must be declared");
  const body = fn[1];
  assert.ok(
    body.includes('item?.name === "keyboard.press"') && body.includes("arguments.trusted === true"),
    "keyboard.press must route to background ONLY when arguments.trusted === true",
  );
  // The router must use this predicate (not the name-only set) so the trusted flag is honored.
  assert.ok(
    backgroundSource.includes("if (bridgeItemNeedsBackground(item)) {"),
    "routeBridgeItemToTab must gate the background path on bridgeItemNeedsBackground",
  );
});

test("dispatchTrustedKey sends a CDP Input.dispatchKeyEvent (the trusted path)", () => {
  const fn = backgroundSource.match(
    /const dispatchTrustedKey = async \(tabId, rawKey, rawModifiers(?:, rawRepeat)?\) => \{([\s\S]*?)\n\};/,
  );
  assert.ok(fn, "dispatchTrustedKey must be declared");
  const body = fn[1];
  assert.ok(body.includes("acquireDebugger"), "must attach the debugger (refcounted acquire)");
  assert.ok(
    body.includes('"Input.dispatchKeyEvent"'),
    "must dispatch the CDP Input.dispatchKeyEvent (trusted) command",
  );
  assert.ok(body.includes("releaseDebugger"), "must detach the debugger when done (refcounted release)");
  assert.ok(
    body.includes('fidelity: "trusted"'),
    "trusted path must report fidelity:trusted",
  );
});

test("the background handler only takes the trusted branch when trusted===true", () => {
  const idx = backgroundSource.indexOf(
    'if (call.name === "keyboard.press" && call.arguments && call.arguments.trusted === true)',
  );
  assert.ok(idx !== -1, "executeBackgroundHostedToolCall must branch on trusted keyboard.press");
  const branch = backgroundSource.slice(idx, idx + 1200);
  assert.ok(branch.includes("dispatchTrustedKey"), "the trusted branch must call dispatchTrustedKey");
});

test("the synthetic content.js path reports fidelity:synthetic", () => {
  assert.ok(
    contentSource.includes('fidelity: "synthetic"'),
    "content.js keyboard.press (default path) must report fidelity:synthetic so it's distinguishable from trusted",
  );
});

test("keyboard.press declares the optional `trusted` field in BOTH manifest surfaces", () => {
  const prim = manifest.primitive_dictionary.primitives.find((p) => p.name === "keyboard.press");
  const tool = manifest.tools.find((t) => t.name === "keyboard.press");
  assert.ok(prim, "keyboard.press must be in primitive_dictionary.primitives");
  assert.ok(tool, "keyboard.press must be in tools[]");
  assert.ok(
    prim.input_schema.properties.trusted && prim.input_schema.properties.trusted.type === "boolean",
    "primitive_dictionary keyboard.press needs a boolean `trusted` field",
  );
  assert.ok(
    tool.input_schema.properties.trusted && tool.input_schema.properties.trusted.type === "boolean",
    "tools[] keyboard.press needs a boolean `trusted` field",
  );
});
