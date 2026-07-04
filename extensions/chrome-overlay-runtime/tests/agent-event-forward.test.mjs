import assert from "node:assert/strict";
import test from "node:test";
import { agentEventFromSessionEvent } from "../src/agent/agent-event-map.mjs";

test("assistant transcript maps to a transcript kind", () => {
  assert.deepEqual(
    agentEventFromSessionEvent({ type: "transcript", role: "assistant", text: "hello" }),
    { kind: "transcript", payload: { role: "assistant", text: "hello" } },
  );
});

test("user-role transcript is dropped (only agent output is forwarded)", () => {
  assert.equal(
    agentEventFromSessionEvent({ type: "transcript", role: "user", text: "task" }),
    null,
  );
});

test("tool event maps to a tool kind with ok flag and error", () => {
  assert.deepEqual(
    agentEventFromSessionEvent({ type: "tool", name: "actions.site", ok: true }),
    { kind: "tool", payload: { name: "actions.site", ok: true, error: null } },
  );
  assert.deepEqual(
    agentEventFromSessionEvent({ type: "tool", name: "pointer.click", ok: false, error: "boom" }),
    { kind: "tool", payload: { name: "pointer.click", ok: false, error: "boom" } },
  );
});

test("policy_exception maps to a refusal kind", () => {
  assert.deepEqual(
    agentEventFromSessionEvent({ type: "policy_exception", tool: "pointer.click", reason: "no site action" }),
    { kind: "refusal", payload: { tool: "pointer.click", reason: "no site action" } },
  );
});

test("session lifecycle maps to a lifecycle kind", () => {
  assert.deepEqual(
    agentEventFromSessionEvent({ type: "session", state: "stopped" }),
    { kind: "lifecycle", payload: { state: "stopped" } },
  );
});

test("realtime delta is dropped", () => {
  assert.equal(
    agentEventFromSessionEvent({ type: "realtime", name: "response.audio_transcript.delta", delta: "x" }),
    null,
  );
});

test("actions_json duplicate transcript is dropped (avoids double-forward)", () => {
  assert.equal(
    agentEventFromSessionEvent({ type: "actions_json.transcript", role: "assistant", text: "dup" }),
    null,
  );
});

test("non-object input is dropped safely", () => {
  assert.equal(agentEventFromSessionEvent(null), null);
  assert.equal(agentEventFromSessionEvent(undefined), null);
  assert.equal(agentEventFromSessionEvent("nope"), null);
});
