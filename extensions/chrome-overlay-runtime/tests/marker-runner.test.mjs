import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Guards the 2026-07-05 marker-projection plan U3: the marker-runner executes a
// marker's declarative recipe in the content-script ACTION layer (never inside
// the pure projection sandbox — KTD1), and the three consumer primitives are
// callable end-to-end: marker.query (pure read → live location),
// cursor.move_to (cursor promise), pointer.move_to (pointer promise).

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

test("the runner executes recipe steps through the existing primitive handlers", () => {
  for (const call of [
    "return keyboardPress(args)",
    "return pointerClick(args)",
    "return locatorElementInfo(args)",
    "return textInsert(args)",
  ]) {
    assert.ok(contentSource.includes(call), `runMarkerRecipeStep must reuse: ${call}`);
  }
});

test("trusted recipe keys relay to the background CDP dispatcher on the sender tab", () => {
  assert.ok(
    contentSource.includes('type: "actions-json:marker-trusted-key"'),
    "content runner must relay trusted keys to the background",
  );
  assert.ok(
    backgroundSource.includes('message?.type === "actions-json:marker-trusted-key"'),
    "background must handle the marker trusted-key relay",
  );
  assert.ok(
    backgroundSource.includes("dispatchTrustedKey(tabId, message.key, message.modifiers || [])"),
    "the relay must dispatch via the existing CDP path on the sender's tab",
  );
});

test("a failed recipe step surfaces its index and primitive in a structured error", () => {
  assert.ok(
    contentSource.includes('code: "marker_recipe_step_failed"'),
    "step failures must carry a stable code",
  );
  assert.ok(
    contentSource.includes("step_index: index"),
    "step failures must name the failing step index",
  );
});

test("missing markers return marker_not_found with the re-run hint", () => {
  assert.ok(
    contentSource.includes('"marker_not_found"') &&
      contentSource.includes("Re-run the projection that mints it"),
    "unknown ids must return marker_not_found with recovery guidance",
  );
});

test("move_to enforces the marker's promise type", () => {
  assert.ok(
    contentSource.includes('"marker_type_mismatch"'),
    "cursor.move_to on a pointer marker (and vice versa) must be a structured error",
  );
  assert.ok(
    contentSource.includes('markerMoveTo("cursor.move_to", "cursor"') &&
      contentSource.includes('markerMoveTo("pointer.move_to", "pointer"'),
    "both movers must be dispatched with their expected type",
  );
});

test("all three primitives are declared in BOTH manifest surfaces (catalog routability)", () => {
  for (const name of ["marker.query", "cursor.move_to", "pointer.move_to"]) {
    const tool = manifest.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must exist in tools[]`);
    assert.equal(tool.input_schema.type, "object", `${name} tools[] schema must be an object`);
    const prim = manifest.primitive_dictionary.primitives.find((p) => p.name === name);
    assert.ok(prim, `${name} must exist in primitive_dictionary.primitives[]`);
    assert.equal(prim.support, "supported", `${name} must be supported`);
    assert.ok(prim.summary, `${name} needs a non-empty summary`);
  }
});

test("a marker's location resolves from anchor {x,y}, a plain {x,y} step, or clickable_center", () => {
  // canvas markers carry a static anchor; pointer.click/move return {x,y}; locators
  // return clickable_center. All three must seed the resolved location.
  assert.ok(
    contentSource.includes("marker.anchor && Number.isFinite(marker.anchor.x)"),
    "the runner must seed location from a static anchor coordinate",
  );
  assert.ok(
    contentSource.includes("Number.isFinite(value?.x) && Number.isFinite(value?.y)"),
    "a plain {x,y} step result (pointer.click/move) must resolve the location",
  );
  assert.ok(
    contentSource.includes("value?.clickable_center && Number.isFinite(value.clickable_center.x)"),
    "a locator's clickable_center must resolve the location",
  );
});

test("dispatch wires the three primitives to the runner", () => {
  for (const wire of [
    'message.name === "marker.query"',
    'message.name === "cursor.move_to"',
    'message.name === "pointer.move_to"',
  ]) {
    assert.ok(contentSource.includes(wire), `executeAction must dispatch ${wire}`);
  }
});
