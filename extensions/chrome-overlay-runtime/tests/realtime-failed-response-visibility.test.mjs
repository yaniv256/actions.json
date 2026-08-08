import assert from "node:assert/strict";
import test from "node:test";

import {
  realtimeDiagnosticPayload,
  realtimeEventIsFailure,
} from "../src/agent/realtime-session-manager.mjs";

// A Realtime response that reaches status:"failed" was recorded as ok:true with
// status_details discarded. The runtime then cleared its busy state and returned
// {handled:true, toolCalls:0} — so the user saw SILENCE, and the log said
// SUCCESS.
//
// a user hit this on a fresh install (extension 0.1.248): the agent replied,
// ran an actions.json tool successfully, issued the post-tool response.create,
// and the continuation failed ~135-256ms later. The investigation could prove
// WHERE it broke and could never learn WHY, because our own logging path removed
// the decisive field before writing (2026-07-27).
//
// Two separate defects, both asserted here:
//   1. a failed terminal response must not be logged as ok:true
//   2. status_details must survive into the record, bounded

test("a response.done with status failed is NOT a success", () => {
  const event = {
    type: "response.done",
    response: {
      id: "resp_1",
      status: "failed",
      status_details: {
        type: "failed",
        error: { type: "server_error", code: "internal_error", message: "boom" },
      },
    },
  };
  assert.equal(
    realtimeEventIsFailure(event),
    true,
    "a terminal response that did not complete must be reportable as a failure",
  );
});

test("a completed response IS a success", () => {
  assert.equal(
    realtimeEventIsFailure({
      type: "response.done",
      response: { id: "resp_2", status: "completed" },
    }),
    false,
  );
});

test("an incomplete response is not a success", () => {
  // "It stopped early" and "it finished" are different outcomes. Treating the
  // first as done is what produced the silence.
  assert.equal(
    realtimeEventIsFailure({ type: "response.done", response: { id: "r", status: "incomplete" } }),
    true,
  );
});

test("a CANCELLED response is NOT flagged — barging in is a feature", () => {
  // My first cut included "cancelled" and an existing VAD test caught it. A user
  // interrupting the agent mid-answer produces response.cancelled, and that is
  // the system working as designed. Flagging it would fill the log with false
  // alarms and re-create this same bug in the other direction: a failure signal
  // nobody trusts is a failure signal nobody reads.
  //
  // The line is NOT "did it complete" — it is "did an outcome occur that NOBODY
  // ASKED FOR."
  assert.equal(
    realtimeEventIsFailure({ type: "response.cancelled", response: { id: "r", status: "cancelled" } }),
    false,
  );
  assert.equal(
    realtimeEventIsFailure({ type: "response.done", response: { id: "r", status: "cancelled" } }),
    false,
  );
});

test("a non-terminal event is never marked a failure by this check", () => {
  // Deltas and lifecycle events carry no terminal status; classifying them would
  // make every stream look broken.
  assert.equal(
    realtimeEventIsFailure({ type: "response.audio_transcript.delta", delta: "hi" }),
    false,
  );
  assert.equal(realtimeEventIsFailure({ type: "response.created" }), false);
});

test("status_details survives into the diagnostic payload", () => {
  // THE decisive field. Without it the investigator can prove the response
  // failed and can never learn why — which is exactly what happened.
  const payload = realtimeDiagnosticPayload({
    type: "response.done",
    response: {
      id: "resp_3",
      status: "failed",
      status_details: {
        type: "failed",
        error: { type: "invalid_request_error", code: "context_length_exceeded", message: "too long" },
      },
    },
  });
  assert.ok(payload.status_details, "status_details must be retained");
  assert.equal(payload.status_details.type, "failed");
  assert.equal(payload.status_details.error.code, "context_length_exceeded");
  assert.equal(payload.status_details.error.type, "invalid_request_error");
});

test("status_details is BOUNDED so a large rejection cannot blow the record", () => {
  // The whole point is a durable record. An unbounded copy of a rejection that
  // echoes a huge payload would push the log past its own limits and lose the
  // field a second way.
  const payload = realtimeDiagnosticPayload({
    type: "response.done",
    response: {
      id: "resp_4",
      status: "failed",
      status_details: {
        type: "failed",
        error: { type: "invalid_request_error", code: "x", message: "m".repeat(50_000) },
      },
    },
  });
  const serialized = JSON.stringify(payload.status_details);
  assert.ok(
    serialized.length < 4000,
    `status_details serialized to ${serialized.length} bytes; it must be bounded`,
  );
  assert.match(
    payload.status_details.error.message,
    /^m+/,
    "the beginning of the message must survive truncation — that is where the cause is",
  );
});

test("a response with no status_details does not invent one", () => {
  const payload = realtimeDiagnosticPayload({
    type: "response.done",
    response: { id: "resp_5", status: "completed" },
  });
  assert.equal(payload.status_details, null);
});
