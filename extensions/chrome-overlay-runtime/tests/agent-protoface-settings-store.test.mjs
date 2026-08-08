import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROTOFACE_SETTINGS,
  PROTOFACE_SETTINGS_STORAGE_KEY,
  getProtofaceSettings,
  normalizeProtofaceSettings,
  saveProtofaceSettings,
} from "../src/agent/protoface-settings-store.mjs";

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(update) {
      Object.assign(values, update);
    },
  };
}

test("Protoface settings default to a disabled local-demo configuration", async () => {
  const storage = memoryStorage();
  assert.deepEqual(await getProtofaceSettings(storage), DEFAULT_PROTOFACE_SETTINGS);
});

test("Protoface settings trim and persist an enabled HTTPS broker", async () => {
  const storage = memoryStorage();
  const saved = await saveProtofaceSettings(storage, {
    enabled: true,
    brokerUrl: " https://avatar.example/session-token ",
    avatarId: " av_demo ",
  });

  assert.deepEqual(saved, {
    enabled: true,
    connectionMode: "broker",
    brokerUrl: "https://avatar.example/session-token",
    avatarId: "av_demo",
  });
  assert.deepEqual(storage.values[PROTOFACE_SETTINGS_STORAGE_KEY], saved);
});

test("Protoface settings persist direct credential mode without weakening URL validation", async () => {
  const storage = memoryStorage();
  const saved = await saveProtofaceSettings(storage, {
    enabled: true,
    connectionMode: "direct",
    brokerUrl: "https://avatar.example/session-token",
    avatarId: "av_demo",
  });

  assert.equal(saved.connectionMode, "direct");
  assert.equal(storage.values[PROTOFACE_SETTINGS_STORAGE_KEY].connectionMode, "direct");
});

test("Protoface settings reject unknown connection modes", () => {
  assert.throws(
    () => normalizeProtofaceSettings({ connectionMode: "page", avatarId: "av_demo" }),
    /connection mode/i,
  );
});

test("Protoface settings allow loopback HTTP for the local starter", () => {
  for (const brokerUrl of [
    "http://127.0.0.1:3000/api/protoface/session-token",
    "http://localhost:3000/api/protoface/session-token",
    "http://[::1]:3000/api/protoface/session-token",
  ]) {
    assert.equal(normalizeProtofaceSettings({ enabled: true, brokerUrl, avatarId: "av_stock_001" }).brokerUrl, brokerUrl);
  }
});

test("Protoface settings reject insecure remote and non-HTTP broker URLs", () => {
  for (const brokerUrl of [
    "http://avatar.example/session-token",
    "ws://127.0.0.1:3000/session-token",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.throws(
      () => normalizeProtofaceSettings({ enabled: true, brokerUrl, avatarId: "av_stock_001" }),
      /broker/i,
    );
  }
});

test("Protoface enabled settings require an avatar id", () => {
  assert.throws(
    () => normalizeProtofaceSettings({ enabled: true, brokerUrl: "https://avatar.example/session", avatarId: "  " }),
    /avatar/i,
  );
});

test("disabled settings normalize without requiring a custom broker or avatar", () => {
  assert.deepEqual(normalizeProtofaceSettings({ enabled: false, brokerUrl: "", avatarId: "" }), DEFAULT_PROTOFACE_SETTINGS);
});
