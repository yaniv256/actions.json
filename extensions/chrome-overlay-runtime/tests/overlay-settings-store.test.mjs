import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_STORAGE_KEY,
  OVERLAY_REDUCED_MOTION_MODES,
  OVERLAY_RESTING_CORNERS,
  getOverlaySettings,
  normalizeOverlaySettings,
  saveOverlaySettings,
} from "../src/agent/overlay-settings-store.mjs";

function memoryStorage(initial = {}) {
  const values = { ...initial };
  const setCalls = [];
  return {
    values,
    setCalls,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(update) {
      setCalls.push(update);
      Object.assign(values, update);
    },
  };
}

test("overlay settings default to an opt-in cost meter with motion deferred to the OS", async () => {
  const storage = memoryStorage();
  assert.deepEqual(await getOverlaySettings(storage), {
    showCost: false,
    devMode: false,
    restingCorner: "bottom-right",
    reducedMotion: "system",
  });
  assert.deepEqual(await getOverlaySettings(storage), DEFAULT_OVERLAY_SETTINGS);
});

test("overlay settings defaults are frozen so a caller cannot mutate the shared object", () => {
  assert.ok(Object.isFrozen(DEFAULT_OVERLAY_SETTINGS));
});

test("overlay settings return defaults for an empty or absent stored record", () => {
  assert.deepEqual(normalizeOverlaySettings(), DEFAULT_OVERLAY_SETTINGS);
  assert.deepEqual(normalizeOverlaySettings(null), DEFAULT_OVERLAY_SETTINGS);
  assert.deepEqual(normalizeOverlaySettings({}), DEFAULT_OVERLAY_SETTINGS);
});

test("overlay booleans are strict: truthy non-booleans throw instead of coercing", () => {
  for (const showCost of ["true", "false", 1, 0, "yes", [], {}]) {
    assert.throws(() => normalizeOverlaySettings({ showCost }), /showCost/);
  }
  for (const devMode of ["true", "false", 1, 0, "yes", [], {}]) {
    assert.throws(() => normalizeOverlaySettings({ devMode }), /devMode/);
  }
});

test("overlay booleans accept real booleans on both sides", () => {
  assert.equal(normalizeOverlaySettings({ showCost: true }).showCost, true);
  assert.equal(normalizeOverlaySettings({ showCost: false }).showCost, false);
  assert.equal(normalizeOverlaySettings({ devMode: true }).devMode, true);
  assert.equal(normalizeOverlaySettings({ devMode: false }).devMode, false);
});

test("overlay resting corner accepts every supported corner and rejects others", () => {
  assert.deepEqual(OVERLAY_RESTING_CORNERS, [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ]);
  for (const restingCorner of OVERLAY_RESTING_CORNERS) {
    assert.equal(normalizeOverlaySettings({ restingCorner }).restingCorner, restingCorner);
  }
  for (const restingCorner of ["center", "left", "TOP-LEFT", "bottom right", 3, true, ""]) {
    assert.throws(() => normalizeOverlaySettings({ restingCorner }), /restingCorner/);
  }
});

test("overlay reduced motion is tri-state and rejects booleans", () => {
  assert.deepEqual(OVERLAY_REDUCED_MOTION_MODES, ["system", "reduce", "full"]);
  for (const reducedMotion of OVERLAY_REDUCED_MOTION_MODES) {
    assert.equal(normalizeOverlaySettings({ reducedMotion }).reducedMotion, reducedMotion);
  }
  for (const reducedMotion of [true, false, "on", "off", "SYSTEM", 1, ""]) {
    assert.throws(() => normalizeOverlaySettings({ reducedMotion }), /reducedMotion/);
  }
});

test("each field names itself in the error message so a bad save is diagnosable", () => {
  assert.throws(() => normalizeOverlaySettings({ showCost: "true" }), /showCost/);
  assert.throws(() => normalizeOverlaySettings({ devMode: "true" }), /devMode/);
  assert.throws(() => normalizeOverlaySettings({ restingCorner: "middle" }), /restingCorner/);
  assert.throws(() => normalizeOverlaySettings({ reducedMotion: true }), /reducedMotion/);
});

test("an unknown stored key is dropped rather than passed through", async () => {
  const storage = memoryStorage({
    [OVERLAY_SETTINGS_STORAGE_KEY]: {
      showCost: true,
      legacyPillTheme: "midnight",
      __proto__hack: "nope",
    },
  });
  const loaded = await getOverlaySettings(storage);
  assert.deepEqual(Object.keys(loaded).sort(), [
    "devMode",
    "reducedMotion",
    "restingCorner",
    "showCost",
  ]);
  assert.equal(loaded.showCost, true);
  assert.equal("legacyPillTheme" in loaded, false);

  const saved = await saveOverlaySettings(storage, { showCost: true, legacyPillTheme: "midnight" });
  assert.equal("legacyPillTheme" in saved, false);
  assert.equal("legacyPillTheme" in storage.values[OVERLAY_SETTINGS_STORAGE_KEY], false);
});

test("save normalizes before writing: an invalid save throws and never calls storage.set", async () => {
  const storage = memoryStorage();
  await assert.rejects(
    () => saveOverlaySettings(storage, { showCost: "true", devMode: true }),
    /showCost/,
  );
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.values, {});

  await assert.rejects(
    () => saveOverlaySettings(storage, { showCost: true, restingCorner: "middle" }),
    /restingCorner/,
  );
  assert.deepEqual(storage.setCalls, []);
  assert.equal(OVERLAY_SETTINGS_STORAGE_KEY in storage.values, false);
});

test("overlay settings round-trip through save and get unchanged", async () => {
  const storage = memoryStorage();
  const settings = {
    showCost: true,
    devMode: true,
    restingCorner: "top-left",
    reducedMotion: "reduce",
  };
  const saved = await saveOverlaySettings(storage, settings);
  assert.deepEqual(saved, settings);
  assert.deepEqual(storage.values[OVERLAY_SETTINGS_STORAGE_KEY], settings);
  assert.deepEqual(await getOverlaySettings(storage), settings);
});

test("a partially stored record fills only the missing fields from defaults", async () => {
  const storage = memoryStorage({
    [OVERLAY_SETTINGS_STORAGE_KEY]: { devMode: true },
  });
  assert.deepEqual(await getOverlaySettings(storage), {
    ...DEFAULT_OVERLAY_SETTINGS,
    devMode: true,
  });
});

test("the storage key follows the versioned ACTIONS_JSON convention", () => {
  assert.equal(OVERLAY_SETTINGS_STORAGE_KEY, "ACTIONS_JSON_OVERLAY_SETTINGS_V1");
});
