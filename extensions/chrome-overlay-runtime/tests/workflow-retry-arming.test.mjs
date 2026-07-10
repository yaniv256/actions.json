import assert from "node:assert/strict";
import test from "node:test";

import { executeWorkflowAction } from "../src/agent/workflow-actions.mjs";

// EXECUTABLE PROOF of the retry_until contract (established 2026-07-09, card #170).
//
// A `retry_until` ladder is ARMED BY `on_error: "continue"` — the opposite of what
// the field name suggests. Inside the loop, an attempt whose primitive returns
// `ok:false` aborts the whole workflow immediately unless on_error is "continue".
// And `locator.element_info` errors on precisely the states one retries for:
// `target_not_found` (no match) and `target_not_actionable` (matched, not
// clickable). So `retry_until` + `on_error: "stop"` means "abort on attempt 1":
// the ladder, and its `after_each`, are dead code.
//
// Exhausting max_attempts raises `workflow_retry_exhausted`, which fails the
// workflow IGNORING on_error. So "continue" inside a retry loop is the STRICT
// combination: it lets the loop run, and exhaustion still hard-fails.
//
// This mattered: 31 of 48 self-referential retry_until steps in the public Trello
// map could never retry, and the pipeline's own "good map" fixture was disarmed.
// The static guard lives in tools/actions-json-pipeline (code: disarmed_retry_loop);
// this test pins the runtime behaviour that guard is derived from.

function alwaysNotFound(counters) {
  return async ({ name }) => {
    if (name === "locator.element_info") {
      counters.attempts += 1;
      return { ok: false, error: { code: "target_not_found", message: "No visible element matched the locator." } };
    }
    if (name === "locator.wait_for") {
      counters.afterEach += 1;
      return { ok: false, error: { code: "timeout" } };
    }
    return { ok: true };
  };
}

function workflowWith(onError) {
  return {
    version: 1,
    expression_language: "jsonata",
    steps: [
      {
        id: "findTarget",
        primitive: "locator.element_info",
        args: { locator: { selector: "[data-testid='target']" } },
        retry_until: "{% $exists(steps.findTarget.output.clickable_center.x) %}",
        max_attempts: 4,
        after_each: {
          primitive: "locator.wait_for",
          args: { locator: { selector: "[data-testid='target']" }, state: "visible", timeout_ms: 10 },
        },
        ...(onError ? { on_error: onError } : {}),
      },
    ],
  };
}

async function run(onError) {
  const counters = { attempts: 0, afterEach: 0 };
  const result = await executeWorkflowAction({
    actionName: "probe",
    workflow: workflowWith(onError),
    executePrimitive: alwaysNotFound(counters),
  });
  return { ...counters, result };
}

test("retry_until with on_error:'stop' aborts on attempt 1 — the ladder never runs", async () => {
  const { attempts, afterEach, result } = await run("stop");
  assert.equal(attempts, 1, "a retrying step must not be disarmed into a single attempt");
  assert.equal(afterEach, 0, "after_each must not run when the loop aborted immediately");
  assert.equal(result.ok, false);
  assert.notEqual(result.error?.code, "workflow_retry_exhausted", "it never reached exhaustion; it aborted");
});

test("retry_until with no on_error behaves as 'stop' (also disarmed)", async () => {
  const { attempts, afterEach } = await run(undefined);
  assert.equal(attempts, 1);
  assert.equal(afterEach, 0);
});

test("retry_until with on_error:'continue' runs the full ladder", async () => {
  const { attempts, afterEach } = await run("continue");
  assert.equal(attempts, 4, "max_attempts attempts must actually execute");
  // after_each is skipped on the final attempt (attemptIndex < maxAttempts - 1).
  assert.equal(afterEach, 3, "after_each runs between attempts, not after the last one");
});

test("an armed loop still HARD-FAILS on exhaustion, ignoring on_error:'continue'", async () => {
  const { result } = await run("continue");
  assert.equal(result.ok, false, "on_error:'continue' must not swallow retry exhaustion");
  assert.equal(
    result.error?.code,
    "workflow_retry_exhausted",
    "exhaustion is the fail-loud guarantee that makes on_error:'continue' the STRICT choice",
  );
});

test("an armed loop succeeds as soon as retry_until is satisfied", async () => {
  let attempts = 0;
  const result = await executeWorkflowAction({
    actionName: "probe",
    workflow: workflowWith("continue"),
    executePrimitive: async ({ name }) => {
      if (name !== "locator.element_info") return { ok: true };
      attempts += 1;
      // Absent, then absent, then ready — the readiness race this ladder exists for.
      if (attempts < 3) return { ok: false, error: { code: "target_not_actionable" } };
      // Shape matters: the runtime's primitiveSuccess() nests the payload under
      // `output`, and normalizeStepResult only synthesizes `output` from a bare
      // value or a `.value` key. A fake returning `clickable_center` at the top
      // level leaves `steps.<id>.output` undefined, so retry_until never fires and
      // the loop runs to exhaustion — which reads exactly like an engine bug.
      return { ok: true, output: { clickable_center: { x: 10, y: 20 } } };
    },
  });
  assert.equal(attempts, 3, "the loop must stop at the first satisfied attempt");
  assert.equal(result.ok, true, "a target that becomes ready mid-ladder must succeed");
});

// R11 (Phase-10 remediation of
// investigations/trello-delete-confirm-anchor-and-silent-noop-family.md).
//
// `after_each` is a WAIT SLOT — it runs between retry attempts to let the page
// settle. The validator only checked "is this a known primitive", so it accepted:
//
//   after_each: { primitive: "keyboard.press", args: { key: "Shift" } }   // placebo
//   after_each: { primitive: "pointer.click",  args: { x, y } }           // a MUTATION
//
// The first waits for nothing (the ladder's attempts then run back-to-back in
// milliseconds — this is what made trello.card.delete's confirm ladder useless).
// The second fires a real click up to max_attempts-1 extra times.
//
// A wait slot must hold something observational or idempotent.

import { validateWorkflow } from "../src/agent/workflow-actions.mjs";

const ladder = (afterEachPrimitive) => ({
  version: 1,
  expression_language: "jsonata",
  steps: [
    {
      id: "find",
      primitive: "locator.element_info",
      args: { locator: { selector: "[data-testid='x']" } },
      retry_until: "{% $exists(steps.find.output.clickable_center.x) %}",
      max_attempts: 3,
      after_each: { primitive: afterEachPrimitive, args: {} },
      on_error: "continue",
    },
  ],
});

test("after_each rejects a mutating primitive — a wait slot must not click", () => {
  const result = validateWorkflow(ladder("pointer.click"));
  assert.equal(result.ok, false, "pointer.click between retry attempts is a mutation, not a wait");
  assert.match(String(result.error?.message), /after_each/i);
});

test("after_each rejects keyboard.press — the placebo that waits for nothing", () => {
  const result = validateWorkflow(ladder("keyboard.press"));
  assert.equal(result.ok, false, "keyboard.press: Shift is a no-op that inserts no delay");
});

test("after_each accepts locator.wait_for", () => {
  assert.equal(validateWorkflow(ladder("locator.wait_for")).ok, true);
});

test("after_each accepts viewport.scroll and dom.observe.visible and overlay.menu.hide", () => {
  for (const p of ["viewport.scroll", "dom.observe.visible", "overlay.menu.hide", "locator.element_info"]) {
    assert.equal(validateWorkflow(ladder(p)).ok, true, `${p} is observational or idempotent`);
  }
});
