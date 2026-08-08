import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_HANDSHAKE_SECRET_KEY,
  BRIDGE_PAIRING_UPDATED_MESSAGE,
  bridgePairingState,
  removeBridgePairingSecret,
  saveBridgePairingSecret,
} from "../src/agent/bridge-pairing-settings.mjs";

const harness = ({ reconnect = { ok: true } } = {}) => {
  const values = new Map();
  const messages = [];
  return {
    values,
    messages,
    storageArea: {
      async get(key) {
        return values.has(key) ? { [key]: values.get(key) } : {};
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      },
      async remove(key) {
        values.delete(key);
      },
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return reconnect;
      },
    },
  };
};

test("an absent secret reports unpaired without exposing a value", async () => {
  const h = harness();
  assert.deepEqual(await bridgePairingState(h.storageArea), { paired: false });
});

test("save trims the secret, stores it, and reconnects without returning it", async () => {
  const h = harness();
  const secret = "a".repeat(64);
  const result = await saveBridgePairingSecret({
    storageArea: h.storageArea,
    runtime: h.runtime,
    value: `  ${secret}  `,
    bridgeUrl: " ws://127.0.0.1:17345/extension ",
  });

  assert.deepEqual(result, { ok: true, saved: true, connected: true });
  assert.equal(h.values.get(BRIDGE_HANDSHAKE_SECRET_KEY), secret);
  assert.deepEqual(h.messages, [{
    type: BRIDGE_PAIRING_UPDATED_MESSAGE,
    bridgeUrl: "ws://127.0.0.1:17345/extension",
  }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(await bridgePairingState(h.storageArea), { paired: true });
});

test("short input fails before storage or reconnect", async () => {
  const h = harness();
  const result = await saveBridgePairingSecret({
    storageArea: h.storageArea,
    runtime: h.runtime,
    value: "not-a-complete-secret",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "secret_too_short");
  assert.equal(h.values.size, 0);
  assert.deepEqual(h.messages, []);
});

test("a refused reconnect preserves the saved secret and names the failure", async () => {
  const h = harness({
    reconnect: {
      ok: false,
      error: { code: "bridge_reconnect_failed", message: "Bridge refused the connection." },
    },
  });
  const secret = "b".repeat(64);
  const result = await saveBridgePairingSecret({
    storageArea: h.storageArea,
    runtime: h.runtime,
    value: secret,
    bridgeUrl: "ws://127.0.0.1:17345/extension",
  });

  assert.equal(result.ok, false);
  assert.equal(result.saved, true);
  assert.equal(result.code, "bridge_reconnect_failed");
  assert.equal(result.message, "Bridge refused the connection.");
  assert.equal(h.values.get(BRIDGE_HANDSHAKE_SECRET_KEY), secret);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("remove clears the secret and notifies the background", async () => {
  const h = harness();
  h.values.set(BRIDGE_HANDSHAKE_SECRET_KEY, "c".repeat(64));

  assert.deepEqual(
    await removeBridgePairingSecret({
      storageArea: h.storageArea,
      runtime: h.runtime,
    }),
    { ok: true, paired: false },
  );
  assert.equal(h.values.has(BRIDGE_HANDSHAKE_SECRET_KEY), false);
  assert.deepEqual(h.messages, [{ type: BRIDGE_PAIRING_UPDATED_MESSAGE }]);
});
