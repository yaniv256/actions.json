import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { HostedRealtimeSessionManager } from "../src/agent/realtime-session-manager.mjs";

// Minimal storage stub (matches the shape the manager expects).
function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(key) {
      if (typeof key === "string") return { [key]: data[key] };
      return { ...data };
    },
    async set(values) { Object.assign(data, values); },
    async remove(key) { delete data[key]; },
  };
}

function newManager() {
  const m = new HostedRealtimeSessionManager({
    storage: createStorage(),
    transportFactory: { create: () => ({ sendEvent() {}, async close() {} }) },
  });
  // Attach a transport so response.done events flow past the unstarted-session
  // guard without needing a full start() (these tests exercise the send/track
  // core, not session lifecycle). A response.done carries no tool calls here.
  m.transport = { sendEvent() {}, async close() {} };
  return m;
}

const created = (id) => ({ type: "response.created", response: { id } });
const done = (id) => ({ type: "response.done", response: { id } });

// --- U1: active-response state tracking ---

test("U1: response.created marks the manager busy with the active id", async () => {
  const m = newManager();
  assert.equal(m.isBusy(), false);
  assert.equal(m.activeResponseId, null);

  await m.handleRealtimeEvent(created("resp_A"));

  assert.equal(m.isBusy(), true);
  assert.equal(m.activeResponseId, "resp_A");
});

test("U1: response.done for the active id clears busy and resolves responseIdle", async () => {
  const m = newManager();
  await m.handleRealtimeEvent(created("resp_A"));

  let resolved = false;
  const idle = m.responseIdle.then(() => { resolved = true; });

  await m.handleRealtimeEvent(done("resp_A"));
  await idle;

  assert.equal(m.isBusy(), false);
  assert.equal(m.activeResponseId, null);
  assert.equal(resolved, true);
});

test("U1: a response.done for a STALE id does not clear a newer active response", async () => {
  const m = newManager();
  await m.handleRealtimeEvent(created("resp_A"));
  await m.handleRealtimeEvent(done("resp_A"));      // A completes
  await m.handleRealtimeEvent(created("resp_B"));    // B starts

  await m.handleRealtimeEvent(done("resp_A"));       // stale done for A

  assert.equal(m.isBusy(), true, "B must still be active");
  assert.equal(m.activeResponseId, "resp_B");
});

test("U1: error and response.cancelled also clear the active response", async () => {
  for (const type of ["error", "response.cancelled"]) {
    const m = newManager();
    await m.handleRealtimeEvent(created("resp_A"));
    await m.handleRealtimeEvent({ type, response: { id: "resp_A" } });
    assert.equal(m.isBusy(), false, `${type} should clear busy`);
  }
});

// --- U2: createResponse() serialization (queue) ---

function managerWithRecordingTransport() {
  const sent = [];
  const m = new HostedRealtimeSessionManager({
    storage: createStorage(),
    transportFactory: { create: () => ({ sendEvent() {}, async close() {} }) },
  });
  m.transport = { sendEvent(e) { sent.push(e); }, async close() {} };
  return { m, sent };
}

const createOf = (sent) => sent.filter((e) => e?.type === "response.create");

test("U2: createResponse fires immediately when idle", async () => {
  const { m, sent } = managerWithRecordingTransport();
  await m.createResponse({ response: { instructions: "hi" } });
  assert.equal(createOf(sent).length, 1);
  assert.deepEqual(createOf(sent)[0].response, { instructions: "hi" });
});

test("U2: createResponse queues while busy, then fires after response.done", async () => {
  const { m, sent } = managerWithRecordingTransport();
  await m.handleRealtimeEvent(created("resp_A")); // now busy

  let fired = false;
  const p = m.createResponse({ response: {} }).then(() => { fired = true; });

  // give the microtask queue a tick; the send must NOT have fired yet
  await Promise.resolve();
  assert.equal(fired, false, "must wait while a response is active");
  assert.equal(createOf(sent).length, 0);

  await m.handleRealtimeEvent(done("resp_A")); // idle now
  await p;
  assert.equal(fired, true);
  assert.equal(createOf(sent).length, 1);
});

test("U2: two queued sends serialize in order", async () => {
  const { m, sent } = managerWithRecordingTransport();
  await m.handleRealtimeEvent(created("resp_A"));
  const order = [];
  const p1 = m.createResponse({ response: { tag: 1 } }).then(() => order.push(1));
  const p2 = m.createResponse({ response: { tag: 2 } }).then(() => order.push(2));
  await m.handleRealtimeEvent(done("resp_A"));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});

// --- U3: ungated sites routed through createResponse ---

test("U3/U6: only createResponse constructs a response.create event", () => {
  // All response.create emission now flows through createResponse: no other site
  // constructs a `type: "response.create"` event object. sendUserMessage, the
  // post-tool-call path, and the session-start greet all call createResponse.
  // Strip line comments so a comment mentioning the string doesn't count.
  const src = readFileSync(new URL("../src/agent/realtime-session-manager.mjs", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const createResponseStart = src.indexOf("async createResponse(");
  const nextMethod = src.indexOf("\n  async _awaitResponseIdle(", createResponseStart);
  // Every response.create EVENT literal must live inside createResponse's body.
  const eventLiterals = [...src.matchAll(/\{\s*type:\s*"response\.create"/g)];
  assert.ok(eventLiterals.length >= 1, "createResponse constructs the response.create event");
  for (const m of eventLiterals) {
    assert.ok(
      m.index > createResponseStart && m.index < nextMethod,
      `response.create event literal at ${m.index} must be inside createResponse`,
    );
  }
});

// --- U4: interrupt mode + tool-result discard ---

test("U4: interrupt cancels the active response then sends", async () => {
  const { m, sent } = managerWithRecordingTransport();
  await m.handleRealtimeEvent(created("resp_A")); // busy

  const p = m.createResponse({ mode: "interrupt", response: {} });
  await Promise.resolve();
  // a response.cancel should have gone out; the new response.create waits for
  // the cancellation to land
  assert.ok(sent.some((e) => e?.type === "response.cancel"), "cancel sent");
  assert.ok(m._cancelledResponseIds.has("resp_A"), "resp_A marked cancelled");

  await m.handleRealtimeEvent({ type: "response.cancelled", response: { id: "resp_A" } });
  await p;
  assert.equal(createOf(sent).length, 1, "new response.create fired after cancel");
});

test("U4: a tool result from a cancelled response is marked for discard", () => {
  const { m } = managerWithRecordingTransport();
  const liveJob = { id: "c1", originResponseId: "resp_LIVE" };
  const cancelledJob = { id: "c2", originResponseId: "resp_A" };
  m._cancelledResponseIds.add("resp_A");

  assert.equal(m._shouldDiscardToolResult(liveJob), false, "a live response's result is delivered");
  assert.equal(m._shouldDiscardToolResult(cancelledJob), true, "a cancelled response's result is discarded");
  assert.equal(m._shouldDiscardToolResult({ id: "c3" }), false, "no origin id → not discarded");
});

// --- U5: getState() exposes busy + activeResponseId ---

test("U5: getState() reports busy and activeResponseId", async () => {
  const m = newManager();
  assert.equal(m.getState().busy, false);
  assert.equal(m.getState().activeResponseId, null);
  await m.handleRealtimeEvent(created("resp_A"));
  assert.equal(m.getState().busy, true);
  assert.equal(m.getState().activeResponseId, "resp_A");
  await m.handleRealtimeEvent(done("resp_A"));
  assert.equal(m.getState().busy, false);
});
