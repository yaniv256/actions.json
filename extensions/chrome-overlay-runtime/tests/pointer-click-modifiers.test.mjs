import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Guards the 2026-07-05 marker-projection plan U1: pointer.click accepts an
// optional `modifiers` array (shift, alt/option, control/ctrl, meta/cmd/command)
// so shift-click range selection works — the "select-and-type" edit composes as
// pointer.move_to(start) + click, pointer.move_to(end) + shift-click, overtype.
// pointer.click is a PORTABLE synthetic primitive, so the change must exist in
// BOTH runtimes (extension content.js AND the bookmarklet mirror) and be
// declared in BOTH manifest tool surfaces.

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
const bookmarkletSource = await readFile(
  new URL("../../../runtime/actions-json-runtime/bookmarklet/storage-bookmarklet.js", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

for (const [runtime, source] of [
  ["content.js", contentSource],
  ["bookmarklet", bookmarkletSource],
]) {
  test(`${runtime}: dispatchPointerClick sets modifier keys on the dispatched events`, () => {
    const fn = source.match(
      /dispatchPointerClick(?:\s*=\s*|\s*)\(target, \{ x, y, button, detail = 1, modifiers = \[\] \}\)/,
    );
    assert.ok(fn, "dispatchPointerClick must accept a modifiers array");
    assert.ok(
      source.includes('shiftKey: modifiers.includes("shift")'),
      "shiftKey must derive from the modifiers array",
    );
    assert.ok(
      source.includes('ctrlKey: modifiers.includes("control") || modifiers.includes("ctrl")'),
      "ctrlKey must accept control/ctrl aliases (mirroring keyboard.press)",
    );
  });

  test(`${runtime}: pointerClick validates modifiers and threads them through`, () => {
    assert.ok(
      source.includes('`Unknown pointer modifier "${unknownModifier}"'),
      "unknown modifiers must return a structured invalid_input error",
    );
    assert.ok(
      /dispatchPointerClick\(target, \{ x, y, button: args\.button \|\| "left", modifiers \}\)/.test(source),
      "pointerClick must pass the normalized modifiers to dispatchPointerClick",
    );
    assert.ok(
      /primitiveSuccess\("pointer\.click", \{ clicked: true, x, y, modifiers \}\)/.test(source),
      "the success payload must echo the applied modifiers",
    );
  });
}

test("manifest declares modifiers on pointer.click in BOTH tool surfaces", () => {
  const tool = manifest.tools.find((t) => t.name === "pointer.click");
  assert.ok(tool, "pointer.click must exist in tools[]");
  assert.ok(
    tool.input_schema?.properties?.modifiers?.type === "array",
    "tools[] pointer.click must declare a modifiers array",
  );
  const prim = manifest.primitive_dictionary.primitives.find(
    (p) => p.name === "pointer.click",
  );
  assert.ok(prim, "pointer.click must exist in primitive_dictionary.primitives[]");
  assert.ok(
    prim.input_schema?.properties?.modifiers?.type === "array",
    "primitive_dictionary pointer.click must declare a modifiers array",
  );
});
