// U9 — the Debug tab: outcome classification, diagnostic extraction, the
// unread-error dot, and the empty state.
//
// WHY THIS SUITE EXISTS AT ALL
// ----------------------------
// a user hit a failure during a live install (ext 0.1.248, 2026-07-27): the
// agent ran a tool successfully, issued a post-tool response, and the
// continuation failed ~135-256ms later. The user saw SILENCE. The investigation
// could prove WHERE it broke and could never learn WHY, because the logging
// path dropped `status_details` before writing. Commit 5f8dc90 fixed the
// writer. This unit fixes the fact that nothing ever READ it.
//
// WHAT LIVES HERE vs WHAT LIVES IN PLAYWRIGHT
// -------------------------------------------
// Everything below exercises `src/agent/debug-log-presentation.mjs`, which is
// the real decision layer: which outcome an entry resolves to, whether a failed
// response reads as a failure, how a status_details message is truncated, and
// whether the unread dot is lit. That is logic, and logic belongs in node —
// where it can be asserted EXHAUSTIVELY rather than on whichever states a
// browser run happens to drive.
//
// What is NOT here, deliberately:
//   * that #debugTab is absent from a real DOM with devMode off, and appears
//     with devMode on;
//   * that the three outcomes paint three visually distinct entries;
//   * that clicking the tab clears the dot in a real document.
// Those are DOM and rendering facts about agent-surface.js, which reaches for
// `document` at import time and cannot be imported here at all. A node test
// that stubbed a DOM to assert them would be asserting its own stub. They are
// in tests/agent-surface.spec.js against a real browser.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEBUG_OUTCOMES,
  DEBUG_OUTCOME_TOKENS,
  INDETERMINATE_FAILURE_CLASSES,
  STATUS_DETAIL_DISPLAY_LIMIT,
  createUnreadErrorTracker,
  entryIsError,
  extractFailureClass,
  extractStatusDetails,
  presentLogEntry,
  presentSessionLog,
  resolveEntryOutcome,
  truncateFromStart,
} from "../src/agent/debug-log-presentation.mjs";

import {
  realtimeDiagnosticPayload,
  realtimeEventIsFailure,
} from "../src/agent/realtime-session-manager.mjs";

function logOf(...events) {
  return { ok: true, visitorId: "local-agent-test", eventCount: events.length, events };
}

// ---------------------------------------------------------------------------
// THE REGRESSION GUARD.
//
// This is the assertion that matters most in the file. A response.done carrying
// status:"failed" is recorded ok:false by the writer 5f8dc90 fixed. If the
// debug tab renders that entry as a success, the log says "fine" again — just
// in a different font — and Greg's silence is re-created one layer up.
//
// The chain is exercised END TO END on purpose: the real event goes through the
// real `realtimeEventIsFailure` and the real `realtimeDiagnosticPayload`, and
// only then into the presenter. A test that hand-wrote `{ok: false}` would pass
// even if the two layers disagreed about what a failure is.
// ---------------------------------------------------------------------------
test("REGRESSION: a failed response renders as a FAILURE, never a success", () => {
  const failedEvent = {
    type: "response.done",
    response: {
      id: "resp_greg",
      status: "failed",
      status_details: {
        type: "failed",
        error: {
          type: "invalid_request_error",
          code: "context_length_exceeded",
          message: "The conversation exceeds the model context window.",
        },
      },
    },
  };

  // The writer's own classification, not a re-implementation of it.
  assert.equal(realtimeEventIsFailure(failedEvent), true, "writer must class this as a failure");

  const stored = {
    id: "event-failed",
    type: "realtime",
    name: "response.done",
    ok: !realtimeEventIsFailure(failedEvent),
    summary: "Realtime event response.done did NOT complete (status: failed).",
    output: realtimeDiagnosticPayload(failedEvent, null),
  };

  const presented = presentLogEntry(stored);

  assert.equal(presented.outcome, "failure");
  assert.notEqual(presented.outcome, "success", "a failed response must never read as success");
  assert.equal(presented.token.hue, DEBUG_OUTCOME_TOKENS.failure.hue);
  assert.equal(presented.token.label, "Failed");
  assert.equal(presented.isError, true, "a failed response must be able to light the unread dot");
});

test("a completed response still renders as a success", () => {
  const okEvent = { type: "response.done", response: { id: "resp_ok", status: "completed" } };
  assert.equal(realtimeEventIsFailure(okEvent), false);
  const presented = presentLogEntry({
    id: "event-ok",
    type: "realtime",
    name: "response.done",
    ok: true,
    summary: "Realtime event response.done.",
    output: realtimeDiagnosticPayload(okEvent, null),
  });
  assert.equal(presented.outcome, "success");
  assert.equal(presented.isError, false);
});

// ---------------------------------------------------------------------------
// status_details — error type, code, and the BEGINNING of the message.
// ---------------------------------------------------------------------------
test("a realtime entry with status_details displays error type, code, and the START of the message", () => {
  // The cause lives at the FRONT of the string; the tail is an echo of the
  // offending payload. A long message must keep its head, not its tail.
  const head = "context_length_exceeded: the conversation exceeds the model context window";
  const message = `${head} ${"x".repeat(4000)}`;

  const event = {
    type: "response.done",
    status: "failed",
    status_details: {
      type: "failed",
      reason: "max_output_tokens",
      error: { type: "invalid_request_error", code: "context_length_exceeded", message },
    },
  };

  const presented = presentLogEntry({
    id: "event-details",
    type: "realtime",
    name: "response.done",
    ok: false,
    summary: "Realtime event response.done did NOT complete (status: failed).",
    output: realtimeDiagnosticPayload(event, null),
  });

  const details = presented.statusDetails;
  assert.ok(details, "status_details must survive to the screen");
  assert.equal(details.errorType, "invalid_request_error");
  assert.equal(details.code, "context_length_exceeded");
  assert.equal(details.type, "failed");
  assert.equal(details.reason, "max_output_tokens");

  // The start is preserved...
  assert.ok(details.message.startsWith(head), "truncation must preserve the beginning");
  // ...and the message is actually bounded, with the cut marked.
  assert.equal(details.message.length, STATUS_DETAIL_DISPLAY_LIMIT + 1);
  assert.ok(details.message.endsWith("…"), "a truncated message must be marked as truncated");
  // Most of the 4000-character payload echo is gone. This is the assertion that
  // would catch a truncation that kept the TAIL instead of the head: cutting
  // from the other end yields a string that is all `x` and no cause.
  const droppedChars = message.length - details.message.length;
  assert.ok(droppedChars > 3700, `expected the payload echo to be dropped, kept ${details.message.length}`);
  assert.ok(details.message.includes("context_length_exceeded"), "the cause must survive");
});

test("an entry with no status_details grows no diagnostic block", () => {
  const presented = presentLogEntry({
    id: "event-clean",
    type: "realtime",
    name: "response.created",
    ok: true,
    summary: "Realtime event response.created.",
    output: realtimeDiagnosticPayload({ type: "response.created" }, null),
  });
  assert.equal(presented.statusDetails, null);
});

// ---------------------------------------------------------------------------
// Three outcome states, never two.
// ---------------------------------------------------------------------------
test("mutation_outcome_indeterminate renders distinctly from BOTH success and failure", () => {
  // Post-mutation verification failure is indeterminate, not proof of failure:
  // retry_safe false, recoverable true, the mutation MAY have committed.
  const indeterminate = presentLogEntry({
    id: "event-indeterminate",
    type: "tool",
    name: "workflow.run",
    ok: false,
    summary: "Workflow verification could not confirm the mutation.",
    output: {
      failure_class: "mutation_outcome_indeterminate",
      failed_state: "postcondition",
      outcome: "indeterminate",
      mutation_may_have_committed: true,
      retry_safe: false,
      recoverable: true,
    },
  });

  const failure = presentLogEntry({ id: "f", type: "tool", name: "pointer.click", ok: false });
  const success = presentLogEntry({ id: "s", type: "tool", name: "pointer.click", ok: true });

  assert.equal(indeterminate.outcome, "indeterminate");
  assert.notEqual(indeterminate.outcome, failure.outcome);
  assert.notEqual(indeterminate.outcome, success.outcome);

  // Distinct in the two channels the renderer actually uses: the hue and the
  // word. Both must differ, or the state is distinct only in a data attribute
  // the user cannot see.
  const hues = new Set([indeterminate.token.hue, failure.token.hue, success.token.hue]);
  assert.equal(hues.size, 3, "three outcomes must carry three different hues");
  const labels = new Set([indeterminate.token.label, failure.token.label, success.token.label]);
  assert.equal(labels.size, 3, "three outcomes must carry three different words");

  // And the classification reaches the screen as text.
  assert.equal(indeterminate.failureClass, "mutation_outcome_indeterminate");

  // It is still an alert-worthy entry — distinct from failure, not benign.
  assert.equal(indeterminate.isError, true);
});

test("indeterminate wins over the ok:false that accompanies it", () => {
  // An indeterminate outcome ALSO carries ok:false. If `ok` were checked first
  // the state would collapse into "failed", which tells the user to retry a
  // mutation that may already have landed.
  for (const failureClass of INDETERMINATE_FAILURE_CLASSES) {
    assert.equal(
      resolveEntryOutcome({ type: "tool", ok: false, output: { failure_class: failureClass } }),
      "indeterminate",
    );
  }
});

test("an entry with no ok field is neutral, not green", () => {
  // Transcript, screenshot and session entries have no outcome at all.
  // Defaulting them to success would paint the log green and dilute the signal.
  for (const type of ["transcript", "screenshot", "session"]) {
    assert.equal(resolveEntryOutcome({ type, summary: "x" }), "neutral");
  }
  assert.equal(DEBUG_OUTCOME_TOKENS.neutral.label, "", "neutral must not claim an outcome word");
});

test("an error entry is a failure regardless of any other field", () => {
  assert.equal(resolveEntryOutcome({ type: "error", code: "boom", message: "m", ok: true }), "failure");
});

// ---------------------------------------------------------------------------
// Every documented type renders with its documented fields.
// ---------------------------------------------------------------------------
test("entries of each type render with their documented fields", () => {
  const cases = [
    {
      event: { id: "t1", type: "transcript", role: "user", text: "open the board" },
      expect: { typeLabel: "Transcript", fields: { role: "user", text: "open the board" } },
    },
    {
      event: { id: "t2", type: "tool", name: "pointer.click", ok: true, summary: "clicked Add" },
      expect: { typeLabel: "Tool", fields: { name: "pointer.click", ok: "true", summary: "clicked Add" } },
    },
    {
      event: {
        id: "t3",
        type: "screenshot",
        metadata: { width: 1280, height: 720 },
        targetUrl: "https://trello.com/b/abc",
        purpose: "verify card",
      },
      expect: {
        typeLabel: "Screenshot",
        fields: { size: "1280x720", targetUrl: "https://trello.com/b/abc", purpose: "verify card" },
      },
    },
    {
      event: { id: "t4", type: "error", code: "no_target", message: "Target not found", summary: "s" },
      expect: { typeLabel: "Error", fields: { code: "no_target", message: "Target not found" } },
    },
    {
      event: { id: "t5", type: "realtime", name: "response.done", ok: true, summary: "Realtime event." },
      expect: { typeLabel: "Realtime", fields: { name: "response.done", summary: "Realtime event." } },
    },
    {
      event: { id: "t6", type: "session", summary: "Stopped session." },
      expect: { typeLabel: "Session", fields: { summary: "Stopped session." } },
    },
  ];

  for (const { event, expect } of cases) {
    const presented = presentLogEntry(event);
    assert.equal(presented.type, event.type);
    assert.equal(presented.typeLabel, expect.typeLabel);
    assert.equal(presented.id, event.id);
    const rendered = Object.fromEntries(presented.fields.map((f) => [f.label, f.value]));
    for (const [label, value] of Object.entries(expect.fields)) {
      assert.equal(rendered[label], value, `${event.type} must render ${label}`);
    }
  }
});

test("a screenshot entry never carries an image payload to the screen", () => {
  // The store strips the payload; the presenter must not resurrect one.
  const presented = presentLogEntry({
    id: "shot",
    type: "screenshot",
    metadata: { width: 800, height: 600, format: "png" },
    purpose: "verify",
  });
  const serialized = JSON.stringify(presented);
  assert.ok(!/data:image\//i.test(serialized));
});

// ---------------------------------------------------------------------------
// Empty log.
// ---------------------------------------------------------------------------
test("an empty log renders an empty state, not an error", () => {
  const presentation = presentSessionLog({ ok: true, visitorId: null, eventCount: 0, events: [] });
  assert.equal(presentation.isEmpty, true);
  assert.equal(presentation.entries.length, 0);
  assert.equal(presentation.errorCount, 0);
  assert.ok(presentation.emptyMessage, "the empty state must say something");
  assert.equal(presentation.ok, true, "an empty log is not a failed read");
  // No entry means nothing can be classified as a failure.
  assert.ok(!presentation.entries.some((entry) => entry.isError));
});

test("a missing or malformed log still yields an empty state rather than throwing", () => {
  for (const value of [undefined, null, {}, { events: null }, { events: "nope" }]) {
    const presentation = presentSessionLog(value);
    assert.equal(presentation.isEmpty, true);
    assert.equal(presentation.entries.length, 0);
  }
});

// ---------------------------------------------------------------------------
// The unread-error dot.
// ---------------------------------------------------------------------------
test("the unread dot appears on a new error and clears on view", () => {
  const tracker = createUnreadErrorTracker();

  // A healthy log lights nothing.
  assert.equal(
    tracker.observe(presentSessionLog(logOf(
      { id: "a", type: "tool", name: "pointer.click", ok: true },
      { id: "b", type: "transcript", role: "user", text: "hi" },
    ))),
    false,
  );
  assert.equal(tracker.hasUnread(), false);

  // A new error lights the dot.
  assert.equal(
    tracker.observe(presentSessionLog(logOf(
      { id: "a", type: "tool", name: "pointer.click", ok: true },
      { id: "b", type: "transcript", role: "user", text: "hi" },
      { id: "c", type: "realtime", name: "response.done", ok: false, summary: "did NOT complete" },
    ))),
    true,
  );
  assert.equal(tracker.unreadCount(), 1);

  // Viewing clears it.
  assert.equal(tracker.markRead(), false);
  assert.equal(tracker.hasUnread(), false);

  // Re-reading the SAME log must not re-light it — otherwise the dot is
  // permanently on and means nothing.
  assert.equal(
    tracker.observe(presentSessionLog(logOf(
      { id: "c", type: "realtime", name: "response.done", ok: false, summary: "did NOT complete" },
    ))),
    false,
  );

  // A genuinely new error lights it again.
  assert.equal(
    tracker.observe(presentSessionLog(logOf(
      { id: "c", type: "realtime", name: "response.done", ok: false, summary: "did NOT complete" },
      { id: "d", type: "error", code: "boom", message: "second failure" },
    ))),
    true,
  );
  assert.equal(tracker.unreadCount(), 1);
});

test("an indeterminate outcome also lights the unread dot", () => {
  const tracker = createUnreadErrorTracker();
  assert.equal(
    tracker.observe(presentSessionLog(logOf({
      id: "i",
      type: "tool",
      name: "workflow.run",
      ok: false,
      output: { failure_class: "mutation_outcome_indeterminate" },
    }))),
    true,
  );
});

test("the dot tracks entry identity, not entry count", () => {
  // The stored log is bounded, so old events fall off the front and the count
  // can go DOWN while a new error arrives. A count-based dot would stay dark
  // exactly when it mattered.
  const tracker = createUnreadErrorTracker();
  tracker.observe(presentSessionLog(logOf(
    { id: "e1", type: "error", code: "a", message: "first" },
    { id: "e2", type: "error", code: "b", message: "second" },
    { id: "e3", type: "error", code: "c", message: "third" },
  )));
  tracker.markRead();

  // Log shrank from 3 to 2, but "e9" is new.
  assert.equal(
    tracker.observe(presentSessionLog(logOf(
      { id: "e3", type: "error", code: "c", message: "third" },
      { id: "e9", type: "error", code: "z", message: "brand new" },
    ))),
    true,
  );
  assert.equal(tracker.unreadCount(), 1);
});

// ---------------------------------------------------------------------------
// Small units the above lean on.
// ---------------------------------------------------------------------------
test("truncateFromStart keeps the head and marks the cut", () => {
  assert.equal(truncateFromStart("short", 20), "short");
  const long = "cause_at_the_front" + "!".repeat(300);
  const cut = truncateFromStart(long, 30);
  assert.ok(cut.startsWith("cause_at_the_front"));
  assert.equal(cut.length, 31);
  assert.ok(cut.endsWith("…"));
  assert.equal(truncateFromStart(""), null);
  assert.equal(truncateFromStart(null), null);
});

test("extractFailureClass finds the classification wherever a writer put it", () => {
  assert.equal(extractFailureClass({ output: { failure_class: "x" } }), "x");
  assert.equal(extractFailureClass({ output: { error: { failure_class: "y" } } }), "y");
  assert.equal(extractFailureClass({ failure_class: "z" }), "z");
  assert.equal(extractFailureClass({}), null);
});

test("extractStatusDetails returns null rather than an all-null husk", () => {
  assert.equal(extractStatusDetails({ output: { status_details: null } }), null);
  assert.equal(
    extractStatusDetails({ output: { status_details: { type: null, reason: null, error: null } } }),
    null,
  );
});

test("every outcome has a token and every token is an outcome", () => {
  assert.deepEqual(Object.keys(DEBUG_OUTCOME_TOKENS).sort(), [...DEBUG_OUTCOMES].sort());
  for (const outcome of DEBUG_OUTCOMES) {
    const token = DEBUG_OUTCOME_TOKENS[outcome];
    assert.ok(token.hue, `${outcome} needs a hue`);
    assert.ok(token.background, `${outcome} needs a background`);
  }
});

test("entryIsError agrees with the outcome classification", () => {
  assert.equal(entryIsError({ type: "tool", ok: false }), true);
  assert.equal(entryIsError({ type: "error", message: "m" }), true);
  assert.equal(entryIsError({ type: "tool", ok: true }), false);
  assert.equal(entryIsError({ type: "transcript", role: "user", text: "hi" }), false);
});
