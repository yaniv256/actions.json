import assert from "node:assert/strict";
import test from "node:test";

import {
  BridgeOutputDeliveryQueue,
} from "../src/agent/bridge-output-delivery.mjs";

const actionOutput = (callId, extra = {}) => ({
  type: "action_call_output",
  call_id: callId,
  runtime_id: "runtime-1",
  output: { ok: true, call_id: callId },
  ...extra,
});

test("bridge output queue holds completed action output until a sender accepts it", () => {
  const diagnostics = [];
  const sent = [];
  const queue = new BridgeOutputDeliveryQueue({
    now: () => 1000,
    emitDiagnostic: (event) => diagnostics.push(event),
  });

  assert.equal(queue.deliver(actionOutput("call-1"), () => false), false);
  assert.equal(queue.size, 1);

  const flushed = queue.flush((item) => {
    sent.push(item);
    return true;
  });

  assert.deepEqual(flushed, { sent: 1, remaining: 0, expired: 0 });
  assert.equal(queue.size, 0);
  assert.deepEqual(sent, [actionOutput("call-1")]);
  assert.equal(diagnostics[0].name, "background.bridge.output_queued");
  assert.equal(diagnostics[1].name, "background.bridge.output_delivered");
});

test("bridge output queue suppresses duplicate completed outputs by call id and runtime id", () => {
  const diagnostics = [];
  const queue = new BridgeOutputDeliveryQueue({
    now: () => 1000,
    emitDiagnostic: (event) => diagnostics.push(event),
  });

  assert.equal(queue.deliver(actionOutput("call-1"), () => false), false);
  assert.equal(queue.deliver(actionOutput("call-1"), () => false), false);

  assert.equal(queue.size, 1);
  assert.equal(diagnostics.at(-1).name, "background.bridge.output_duplicate");
});

test("bridge output queue expires stale outputs instead of keeping them forever", () => {
  const diagnostics = [];
  let now = 1000;
  const queue = new BridgeOutputDeliveryQueue({
    ttlMs: 500,
    now: () => now,
    emitDiagnostic: (event) => diagnostics.push(event),
  });

  queue.deliver(actionOutput("call-1"), () => false);
  now = 1601;

  const flushed = queue.flush(() => {
    throw new Error("expired output must not be sent");
  });

  assert.deepEqual(flushed, { sent: 0, remaining: 0, expired: 1 });
  assert.equal(queue.size, 0);
  assert.equal(diagnostics.at(-1).name, "background.bridge.output_expired");
  assert.equal(diagnostics.at(-1).output.failure_class, "output_delivery_failed");
  assert.equal(diagnostics.at(-1).output.retryable, false);
  assert.equal(diagnostics.at(-1).input.call_id, "call-1");
});

test("bridge output queue only retains bridge protocol outputs with call ids", () => {
  const diagnostics = [];
  const queue = new BridgeOutputDeliveryQueue({
    now: () => 1000,
    emitDiagnostic: (event) => diagnostics.push(event),
  });

  assert.equal(queue.deliver({ type: "ready", runtime_id: "runtime-1" }, () => false), false);
  assert.equal(queue.deliver({ type: "action_error", runtime_id: "runtime-1", error: {} }, () => false), false);

  assert.equal(queue.size, 0);
  assert.equal(diagnostics.length, 0);
});
