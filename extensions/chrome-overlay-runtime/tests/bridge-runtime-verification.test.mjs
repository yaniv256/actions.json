import assert from "node:assert/strict";
import test from "node:test";

import {
  bridgeHttpOrigin,
  waitForBridgeRuntime,
} from "../src/agent/bridge-runtime-verification.mjs";

test("bridge HTTP origin removes the websocket path and query", () => {
  assert.equal(
    bridgeHttpOrigin("ws://127.0.0.1:17345/extension?secret=hidden"),
    "http://127.0.0.1:17345",
  );
  assert.equal(
    bridgeHttpOrigin("wss://bridge.example/extension"),
    "https://bridge.example",
  );
});

test("runtime verification waits until the exact runtime is registered", async () => {
  const payloads = [
    { runtimes: [] },
    { runtimes: [{ runtime_id: "runtime-other" }] },
    { runtimes: [{ runtime_id: "runtime-target" }] },
  ];
  let calls = 0;
  const result = await waitForBridgeRuntime({
    bridgeUrl: "ws://127.0.0.1:17345/extension",
    runtimeId: "runtime-target",
    fetchImpl: async () => ({
      ok: true,
      json: async () => payloads[Math.min(calls++, payloads.length - 1)],
    }),
    timeoutMs: 100,
    pollMs: 0,
    sleep: async () => {},
  });

  assert.deepEqual(result, { ok: true, runtimeId: "runtime-target" });
  assert.equal(calls, 3);
});

test("runtime verification fails instead of reporting an optimistic connection", async () => {
  let clock = 0;
  await assert.rejects(
    waitForBridgeRuntime({
      bridgeUrl: "ws://127.0.0.1:17345/extension",
      runtimeId: "runtime-missing",
      fetchImpl: async () => ({ ok: true, json: async () => ({ runtimes: [] }) }),
      timeoutMs: 20,
      pollMs: 10,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    /did not register/,
  );
});
