import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePrimitiveDictionary } from "../src/primitives/dictionary-schema.mjs";

const dictionaryPath = new URL("../src/primitives/dictionary.v1.json", import.meta.url);

const requiredStage1Primitives = [
  "browser.claimed_tabs.activate",
  "browser.claimed_tabs.list",
  "browser.screenshot",
  "pointer.move",
  "pointer.click",
  "pointer.double_click",
  "pointer.drag",
  "viewport.scroll",
  "text.insert",
  "keyboard.press",
  "runtime.session.name",
  "runtime.session.finalize_tabs",
  "page.info",
  "dom.observe.visible",
  "dom.list_sections",
  "dom.snapshot_text",
  "locator.element_info",
  "locator.text_content",
  "locator.wait_for",
  "overlay.open",
  "overlay.register_launcher",
  "overlay.close",
];

async function loadDictionary() {
  return JSON.parse(await readFile(dictionaryPath, "utf8"));
}

test("Stage 1 primitive dictionary contains each required primitive exactly once", async () => {
  const dictionary = await loadDictionary();
  const names = dictionary.primitives.map((primitive) => primitive.name);

  assert.deepEqual([...names].sort(), [...new Set(names)].sort(), "primitive names must be unique");
  assert.deepEqual([...names].sort(), [...requiredStage1Primitives].sort());
});

test("primitive dictionary validation reports missing required metadata", () => {
  const dictionary = {
    version: 1,
    stage: 1,
    primitives: [{ name: "browser.screenshot" }],
  };
  const result = validatePrimitiveDictionary(dictionary);

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => error.path === "primitives[0].version"),
    "missing primitive version should be reported",
  );
  assert.ok(
    result.errors.some((error) => error.path === "primitives[0].summary"),
    "missing primitive summary should be reported",
  );
  assert.ok(
    result.errors.some((error) => error.path === "primitives[0].input_schema"),
    "missing input schema should be reported",
  );
});

test("canonical Stage 1 primitive dictionary validates required metadata", async () => {
  const dictionary = await loadDictionary();
  const result = validatePrimitiveDictionary(dictionary);

  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("primitive dictionary validation rejects duplicate primitive names", () => {
  const dictionary = {
    version: 1,
    stage: 1,
    primitives: [{ name: "pointer.click" }, { name: "pointer.click" }],
  };
  const result = validatePrimitiveDictionary(dictionary);

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) => error.path === "primitives[1].name" && error.message.includes("Duplicate"),
    ),
    "duplicate primitive name should be reported",
  );
});
