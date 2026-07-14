import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executeWorkflowAction } from "../../../extensions/chrome-overlay-runtime/src/agent/workflow-actions.mjs";

// RED->GREEN for card #170's headline symptom: "delete reports success but the
// card is still on the board."
//
// trello.card.delete used to certify nothing IN EITHER DIRECTION:
//   * `confirmDelete.settle_after` waited for state:"hidden", which the runtime
//     does not implement — locator.wait_for resolves only when the element IS
//     found. So on a SUCCESSFUL delete it burned its full 8s timeout, and the
//     failure was discarded (runSettle's result is recorded, never checked).
//   * `verifyCardGone` was a locator.element_info presence read with
//     `on_error: "continue"`. element_info ERRORS on absence, so a successful
//     delete was swallowed; a failed delete resolved the element and "passed".
// Both outcomes returned ok:true.
//
// The fix: assert absence positively with dom.observe.visible, the only primitive
// that returns success with `match_count: 0` on no-match, driven by a retry_until
// whose exhaustion hard-fails (workflow_retry_exhausted ignores on_error).
//
// These tests execute the REAL workflow engine over the REAL stored map, so they
// fail if either the map or the engine contract regresses. They need no browser:
// the defect lived in the workflow logic, not in the DOM.

const mapPath = path.resolve("../actions.json.storage/scopes/public/sites/trello.com/board/actions.json");

async function loadTool(t, name) {
  let source;
  try {
    source = await readFile(mapPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("Sibling actions.json.storage checkout is not available.");
      return null;
    }
    throw error;
  }
  const tool = JSON.parse(source).tools.find((candidate) => candidate.name === name);
  if (!tool) {
    t.skip(`${name} is not present in the public Trello map.`);
    return null;
  }
  return tool;
}

// Mirror the runtime's primitiveSuccess shape: { ok, output }. normalizeStepResult
// only synthesizes `.output` from a bare value or a `.value` key, so an object
// returned without it leaves steps.<id>.output undefined and every retry_until
// exhausts — a fake that lies this way turns these tests into fiction.
const ok = (output) => ({ ok: true, output });

async function runWithTarget(tool, { targetPresent, selector }) {
  let observeCalls = 0;
  const result = await executeWorkflowAction({
    actionName: tool.name,
    workflow: tool.workflow,
    input: {},
    executePrimitive: async ({ name, arguments: args }) => {
      if (name === "dom.observe.visible") {
        observeCalls += 1;
        const matches = targetPresent && args.selector === selector ? [{ tag_name: "div", text: "still here" }] : [];
        return ok({ matches, match_count: matches.length });
      }
      if (name === "locator.element_info") return ok({ clickable_center: { x: 5, y: 5 }, candidates: [] });
      if (name === "locator.wait_for") return ok({ matched: true });
      if (name === "locator.text_content") return ok({ text: "" });
      return ok({});
    },
  });
  return { result, observeCalls };
}

const CASES = [
  { tool: "trello.card.delete", selector: "[data-testid='card-back-name']" },
  { tool: "trello.list.archive", selector: "[data-testid='list-name']" },
  { tool: "trello.board.planner.close", selector: "[data-testid='planner']" },
];

for (const { tool: name, selector } of CASES) {
  test(`${name} SUCCEEDS when its target is gone`, async (t) => {
    const tool = await loadTool(t, name);
    if (!tool) return;
    const { result } = await runWithTarget(tool, { targetPresent: false, selector });
    assert.equal(result.ok, true, `${name} must succeed once the target is actually gone`);
  });

  test(`${name} FAILS when its target is still present`, async (t) => {
    const tool = await loadTool(t, name);
    if (!tool) return;
    const { result, observeCalls } = await runWithTarget(tool, { targetPresent: true, selector });
    assert.equal(result.ok, false, `${name} must not report success while ${selector} is still on the page`);
    assert.equal(
      result.error?.code,
      "workflow_retry_exhausted",
      "absence must be asserted by a retry_until whose exhaustion hard-fails",
    );
    assert(observeCalls > 1, "the absence assertion must actually re-observe, not check once");
  });
}

test("no workflow step waits for the unimplemented state:'hidden'", async (t) => {
  let source;
  try {
    source = await readFile(mapPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("Sibling actions.json.storage checkout is not available.");
    throw error;
  }
  const map = JSON.parse(source);
  const offenders = [];
  for (const tool of map.tools) {
    for (const step of tool.workflow?.steps ?? []) {
      if (step.settle_after?.state === "hidden") offenders.push(`${tool.name}/${step.id}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "locator.wait_for has no 'hidden' state; such a wait resolves while the element is VISIBLE and times out once it is gone",
  );
});

// REGRESSION GUARD (found 2026-07-09 while enforcing task-OS rule 12, "never call
// a card done from memory — read its checklist").
//
// trello.card.checklist.read's DESCRIPTION promised "every item's text and checked
// state plus counts (checked_count / total / complete)". Its OUTPUT emitted only
// `total` and `items`, where `total` came from locator.element_info's
// `candidate_count` — which is built from an isElementVisible filter and is
// therefore VIEWPORT-DEPENDENT. Worse, Trello VIRTUALIZES the checklist: off-screen
// rows are absent from the DOM entirely. On the live board it returned total:2 for a
// card the REST API shows has 3 items, and it reported no checked state at all.
//
// A card whose visible rows are all checked would have read as complete. That is the
// instrument the whole task OS uses to decide whether anything is done.
//
// `checklist.read` derives completion and counts from the same card-wide mounted
// checkbox rows. Candidate-based reads remain viewport-limited diagnostics and
// cannot claim card-wide totals.

test("trello.card.checklist.read derives card-wide completion from one row authority", async (t) => {
  let source;
  try {
    source = await readFile(mapPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("Sibling actions.json.storage checkout is not available.");
    throw error;
  }
  const tool = JSON.parse(source).tools.find((c) => c.name === "trello.card.checklist.read");
  if (!tool) return t.skip("trello.card.checklist.read is not present in the public Trello map.");
  const output = tool.workflow.output;

  assert.doesNotMatch(
    output,
    /'total'|"total"/,
    "the checklist is virtualized; no field may claim to be the total",
  );
  assert.match(output, /'complete'/, "completion must be reported");
  assert.match(output, /percent_complete/, "completion percentage must be reported");
  assert.match(output, /item_count/, "the mounted card-wide row count must be reported");
  assert.match(output, /\$checked := \$count\(\$rows/, "checked_count must use the same card-wide rows as items");

  // Any count emitted from candidate_count is a visible-only count and must not be
  // presented as authoritative. element_info builds candidate_count by filtering with
  // isElementVisible (content.js locatorElementInfo).
  const countsFromCandidateCount = [...output.matchAll(/'(\w+)'\s*:\s*steps\.\w+\.output\.candidate_count/g)]
    .map((m) => m[1]);
  assert.deepEqual(
    countsFromCandidateCount,
    [],
    `these fields are viewport-dependent counts presented as facts: ${countsFromCandidateCount.join(", ")}`,
  );
});

test("trello.card.checklist.read stays bounded for 59 long unchecked items", async (t) => {
  const tool = await loadTool(t, "trello.card.checklist.read");
  if (!tool) return;

  const matches = Array.from({ length: 59 }, (_, index) => ({
    attributes: {
      "aria-label": `Review backlog artifact ${String(index + 1).padStart(2, "0")} — ${"source-backed investigation title ".repeat(4)}`,
      "aria-checked": "false",
    },
  }));

  const result = await executeWorkflowAction({
    actionName: tool.name,
    workflow: tool.workflow,
    input: {},
    executePrimitive: async ({ name, arguments: args }) => {
      if (name === "dom.observe.attributes" && args.selector.includes("input[type='checkbox']")) {
        return ok({ matches, match_count: matches.length });
      }
      if (name === "dom.observe.attributes") {
        return ok({ matches: [{ attributes: { text: "0%" } }], match_count: 1 });
      }
      if (name === "locator.text_content") return ok({ text: "Description" });
      return ok({});
    },
  });

  assert.equal(result.ok, true, result.error?.message);
  const value = result.output.value;
  assert.equal(value.item_count, 59);
  assert.equal(value.items.length, 59);
  assert.equal("unchecked_items" in value, false, "unchecked titles must not be emitted twice");
  assert(Buffer.byteLength(JSON.stringify(value), "utf8") < 16_000, "semantic output needs headroom below the evaluator cap");
});
