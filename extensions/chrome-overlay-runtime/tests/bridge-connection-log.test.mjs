import assert from "node:assert/strict";
import test from "node:test";

import {
  bridgeConnectionEntries,
} from "../src/agent/bridge-connection-log.mjs";

test("connection log exposes recent bridge stages without secret material", () => {
  const entries = bridgeConnectionEntries([
    {
      timestamp: "2026-07-29T19:30:00.000Z",
      type: "transport",
      name: "background.bridge.pairing",
      ok: true,
      summary: "Secure bridge pairing requested from the settings page.",
      input: {
        bridge_url: "ws://127.0.0.1:17345/extension",
        secret: "must-never-render",
      },
    },
    {
      timestamp: "2026-07-29T19:30:01.000Z",
      type: "transport",
      name: "background.bridge.websocket",
      ok: false,
      summary: "Extension background failed to open the bridge WebSocket.",
      input: { bridge_url: "ws://127.0.0.1:17345/extension" },
      output: { error_message: "handshake_secret_mismatch" },
    },
    {
      timestamp: "2026-07-29T19:30:02.000Z",
      type: "tool",
      name: "trello.card.create",
      ok: false,
    },
  ], {
    extensionId: "hpfhjegmjhbagbabohjemenfnnjdmhdl",
    extensionVersion: "0.1.255",
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].detail, "handshake_secret_mismatch");
  assert.equal(entries[1].status, "attempt");
  assert.equal(entries[0].extensionVersion, "0.1.255");
  assert.equal(JSON.stringify(entries).includes("must-never-render"), false);
});

test("connection log is newest-first and bounded", () => {
  const events = Array.from({ length: 25 }, (_, index) => ({
    timestamp: `2026-07-29T19:30:${String(index).padStart(2, "0")}.000Z`,
    name: "background.bridge.websocket",
    ok: true,
    summary: `event ${index}`,
  }));

  const entries = bridgeConnectionEntries(events, { limit: 3 });
  assert.deepEqual(entries.map((entry) => entry.summary), [
    "event 24",
    "event 23",
    "event 22",
  ]);
});
