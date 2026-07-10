import assert from "node:assert/strict";
import test from "node:test";

import { executeWorkflowAction } from "../src/agent/workflow-actions.mjs";

// FAILURE-PATH TESTS for `settle_after` (Level-1 finding, incident
// investigations/trello-delete-confirm-anchor-and-silent-noop-family.md).
//
// `runSettle` returns { ok:false, reason:"timeout" } when its locator never
// resolves. The caller then does:
//
//     settle = await runSettle({ settle: step.settle_after, executePrimitive });
//     stepSummaries.push(summarizeStep({ step, result, startedAt, settle }));
//
// It RECORDS the failure into the step summary and never checks it. So a step
// whose settle_after times out proceeds exactly as if the surface had appeared.
//
// This is a silencer, not the cause, of the delete incident: `clickDelete` waited
// up to 6s for a confirmation selector that matched nothing, timed out, and the
// workflow marched into `findConfirmDelete` regardless. Every subsequent failure
// was reported at the wrong step.
//
// A settle_after is an author saying "this step is not finished until X is on the
// page." If X never arrives, the step did not finish.

const ok = (output = {}) => ({ ok: true, output });

function workflowWithSettle(onError) {
  return {
    version: 1,
    expression_language: "jsonata",
    steps: [
      {
        id: "clickThing",
        primitive: "pointer.click",
        args: { x: 1, y: 2 },
        settle_after: {
          locator: { selector: "[data-testid='never-appears']" },
          state: "visible",
          timeout_ms: 50,
        },
        ...(onError ? { on_error: onError } : {}),
      },
      { id: "afterwards", primitive: "locator.text_content", args: { locator: { selector: "body" } } },
    ],
  };
}

async function run(onError) {
  const reached = [];
  const result = await executeWorkflowAction({
    actionName: "probe",
    workflow: workflowWithSettle(onError),
    executePrimitive: async ({ name }) => {
      reached.push(name);
      // The settle's wait never resolves — exactly the live `clickDelete` case.
      if (name === "locator.wait_for") return { ok: false, error: { code: "timeout" } };
      if (name === "pointer.click") return ok({ clicked: true });
      return ok({ text: "" });
    },
  });
  return { reached, result };
}

test("a settle_after that times out must FAIL its step, not be recorded and ignored", async () => {
  const { result } = await run(undefined);
  assert.equal(
    result.ok,
    false,
    "a step whose settle_after never resolved did not finish; the workflow must not report success",
  );
});

test("a timed-out settle_after must not let the workflow proceed to the next step", async () => {
  const { reached } = await run(undefined);
  assert.ok(
    !reached.includes("locator.text_content"),
    `the step after the un-settled one ran anyway: ${reached.join(" -> ")}`,
  );
});

test("on_error:'continue' still permits a timed-out settle_after to be tolerated", async () => {
  const { result } = await run("continue");
  assert.equal(
    result.ok,
    true,
    "an author who wrote on_error:'continue' opted into tolerating this step's failure",
  );
});

test("a settle_after that resolves leaves the workflow succeeding", async () => {
  const reached = [];
  const result = await executeWorkflowAction({
    actionName: "probe",
    workflow: workflowWithSettle(undefined),
    executePrimitive: async ({ name }) => {
      reached.push(name);
      if (name === "locator.wait_for") return ok({ matched: true });
      if (name === "pointer.click") return ok({ clicked: true });
      return ok({ text: "" });
    },
  });
  assert.equal(result.ok, true);
  assert.ok(reached.includes("locator.text_content"), "the following step must run once the surface settles");
});
