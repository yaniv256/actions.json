import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateStateMarkers,
  validateStateProjection,
  MARKER_RECIPE_PRIMITIVES,
} from "../src/agent/state-projections.mjs";

// Guards the 2026-07-05 marker-projection plan U2: projections may declare
// markers (id + typed promise + declarative recipe of existing primitives) as
// DATA — static array or a JSONata expression slot. The pure projection sandbox
// validates and emits them; the content-script action layer registers them
// per-tab. Coordinates are never stored (resolution is live, at query time).

const validMarker = (over = {}) => ({
  id: "s1.start",
  type: "cursor",
  anchor: { signature: "If you work with AI", ordinal: 1 },
  recipe: [
    { primitive: "keyboard.press", args: { key: "f", modifiers: ["Control"], trusted: true } },
    { primitive: "text.insert", args: { text: "If you work with AI", mode: "replace" } },
    { primitive: "locator.element_info", args: { selector: ".kix-cursor-caret" } },
  ],
  ...over,
});

const validProjection = (over = {}) => ({
  name: "doc.markers",
  snapshot: {
    version: 1,
    source: "dom",
    extract: [],
    projection: { language: "jsonata", expression: "{}" },
  },
  ...over,
});

test("valid markers pass: static array with unique ids and allowed recipes", () => {
  const result = validateStateMarkers([validMarker(), validMarker({ id: "s1.end", type: "pointer" })]);
  assert.equal(result.ok, true);
});

test("duplicate marker ids are rejected", () => {
  const result = validateStateMarkers([validMarker(), validMarker()]);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Duplicate marker id/);
});

test("unknown promise type is rejected (fixed v1 vocabulary: cursor, pointer)", () => {
  const result = validateStateMarkers([validMarker({ type: "gaze" })]);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /"cursor" or "pointer"/);
});

test("recipe steps outside the allowlist are rejected", () => {
  const result = validateStateMarkers([
    validMarker({ recipe: [{ primitive: "debug.run_javascript", args: {} }] }),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /allowed primitive/);
});

test("empty recipe is rejected — a marker must be able to keep its promise", () => {
  const result = validateStateMarkers([validMarker({ recipe: [] })]);
  assert.equal(result.ok, false);
});

test("the allowlist holds only portable primitives, never debugger surfaces", () => {
  assert.ok(MARKER_RECIPE_PRIMITIVES.has("pointer.click"));
  assert.ok(MARKER_RECIPE_PRIMITIVES.has("keyboard.press"));
  assert.ok(!MARKER_RECIPE_PRIMITIVES.has("debug.run_javascript"));
  assert.ok(!MARKER_RECIPE_PRIMITIVES.has("browser.screenshot"));
});

test("projection-level validation accepts static markers, expression slots, and rejects bad markers", () => {
  assert.equal(validateStateProjection(validProjection({ markers: [validMarker()] })).ok, true);
  // expression slot is validated at execute time, not declaration time
  assert.equal(
    validateStateProjection(validProjection({ markers: "{% state.sentences ~> ... %}" })).ok,
    true,
  );
  const bad = validateStateProjection(validProjection({ markers: [validMarker({ id: "" })] }));
  assert.equal(bad.ok, false);
});

test("content.js registers emitted markers per projection and replaces on re-run", async () => {
  const contentSource = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
  assert.ok(
    contentSource.includes("const stateMarkerRegistry = new Map()"),
    "content.js must hold a per-tab marker registry",
  );
  assert.ok(
    contentSource.includes("registerStateMarkers(result.projection || message.projection_name, result.markers)"),
    "successful projection runs must register their emitted markers",
  );
  assert.ok(
    contentSource.includes("if (existing.projection === projectionName) stateMarkerRegistry.delete(id)"),
    "re-running a projection must replace its own markers",
  );
});
