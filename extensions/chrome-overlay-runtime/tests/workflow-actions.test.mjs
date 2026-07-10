import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateWorkflowValue,
  executeWorkflowAction,
  validateWorkflow,
} from "../src/agent/workflow-actions.mjs";

test("workflow evaluator replaces raw JSONata expression slots with typed values", async () => {
  const context = {
    input: { title: "Demo", count: 3 },
    steps: {},
    item: null,
    index: null,
  };

  assert.equal(await evaluateWorkflowValue("{% input.count + 2 %}", context), 5);
  assert.deepEqual(await evaluateWorkflowValue("{% {'title': input.title, 'ready': true} %}", context), {
    title: "Demo",
    ready: true,
  });
  assert.deepEqual(
    await evaluateWorkflowValue({ label: "{% 'Card: ' & input.title %}", static: "unchanged" }, context),
    { label: "Card: Demo", static: "unchanged" },
  );
});

test("workflow evaluator rejects partial embedded expressions", async () => {
  await assert.rejects(
    () => evaluateWorkflowValue("Card: {% input.title %}", { input: { title: "Demo" }, steps: {} }),
    { code: "partial_expression_unsupported" },
  );
});

test("workflow evaluator rejects dynamic, random, and clock JSONata functions", async () => {
  for (const expression of ["{% $eval('input.title') %}", "{% $random() %}", "{% $now() %}", "{% $millis() %}"]) {
    await assert.rejects(
      () => evaluateWorkflowValue(expression, { input: { title: "Demo" }, steps: {} }),
      { code: "disallowed_expression_function" },
    );
  }
});

test("workflow validation rejects unsupported language, duplicate ids, and unbounded loops", () => {
  assert.deepEqual(validateWorkflow({ version: 1, expression_language: "jsonata", steps: [] }), { ok: true });
  assert.equal(validateWorkflow({ version: 1, expression_language: "jq", steps: [] }).error.code, "invalid_workflow");
  assert.match(
    validateWorkflow({
      version: 1,
      expression_language: "jsonata",
      steps: [
        { id: "find", primitive: "locator.element_info", args: {} },
        { id: "find", primitive: "pointer.click", args: {} },
      ],
    }).error.message,
    /duplicate/i,
  );
  assert.match(
    validateWorkflow({
      version: 1,
      expression_language: "jsonata",
      steps: [{ id: "read", primitive: "locator.element_info", for_each: "{% input.items %}", args: {} }],
    }).error.message,
    /max_items/i,
  );
});

test("workflow executes geometry-to-click without exposing direct fallback reports", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "trello.add_card.open_composer",
    input: { list_name: "In Progress" },
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "findButton",
          primitive: "locator.element_info",
          args: {
            locator: {
              selector: "[data-testid='list-add-card-button']",
              text_contains: "Add a card",
            },
          },
        },
        {
          id: "clickButton",
          primitive: "pointer.click",
          args: {
            x: "{% steps.findButton.output.candidates[0].clickable_center.x %}",
            y: "{% steps.findButton.output.candidates[0].clickable_center.y %}",
          },
        },
      ],
      output: "{% {'clicked': true, 'button': steps.findButton.output.candidates[0].text} %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call);
      if (call.name === "locator.element_info") {
        return {
          ok: true,
          output: {
            candidates: [
              {
                text: "Add a card",
                clickable_center: { x: 122.5, y: 430 },
              },
            ],
          },
        };
      }
      return { ok: true, output: { clicked: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(primitiveCalls, [
    {
      name: "locator.element_info",
      arguments: {
        locator: {
          selector: "[data-testid='list-add-card-button']",
          text_contains: "Add a card",
        },
      },
    },
    {
      name: "pointer.click",
      arguments: { x: 122.5, y: 430 },
    },
  ]);
  assert.deepEqual(result.output.value, { clicked: true, button: "Add a card" });
  assert.equal(result.steps[1].primitive, "pointer.click");
});

test("workflow normalizes extension primitive value results into output slots", async () => {
  const result = await executeWorkflowAction({
    actionName: "trello.card.open",
    input: { title: "Demo" },
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "findCard",
          primitive: "locator.element_info",
          args: {
            locator: {
              selector: "[data-testid='card-name']",
              text_contains: "{% input.title %}",
            },
          },
        },
        {
          id: "clickCard",
          primitive: "pointer.click",
          args: {
            x: "{% steps.findCard.output.clickable_center.x %}",
            y: "{% steps.findCard.output.clickable_center.y %}",
          },
        },
      ],
      output: "{% {'clicked_x': steps.findCard.output.clickable_center.x} %}",
    },
    async executePrimitive(call) {
      if (call.name === "locator.element_info") {
        return {
          ok: true,
          primitive: "locator.element_info",
          value: {
            clickable_center: { x: 42, y: 84 },
          },
        };
      }
      return { ok: true, primitive: "pointer.click", value: { clicked: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output.value, { clicked_x: 42 });
});

test("workflow binds two geometry outputs into a drag primitive", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "trello.card.move_between_lists",
    input: { card_title: "Demo", target_list: "Done" },
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "sourceCard",
          primitive: "locator.element_info",
          args: { locator: { selector: "[data-testid='card-name']", text_contains: "{% input.card_title %}" } },
        },
        {
          id: "targetList",
          primitive: "locator.element_info",
          args: { locator: { selector: "[data-testid='list-name']", text_contains: "{% input.target_list %}" } },
        },
        {
          id: "drag",
          primitive: "pointer.drag",
          args: {
            from: "{% steps.sourceCard.output.clickable_center %}",
            to: "{% steps.targetList.output.clickable_center %}",
          },
        },
      ],
    },
    async executePrimitive(call) {
      primitiveCalls.push(call);
      if (call.arguments.locator?.selector === "[data-testid='card-name']") {
        return { ok: true, output: { clickable_center: { x: 10, y: 20 } } };
      }
      if (call.arguments.locator?.selector === "[data-testid='list-name']") {
        return { ok: true, output: { clickable_center: { x: 300, y: 80 } } };
      }
      return { ok: true, output: { dragged: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(primitiveCalls.at(-1), {
    name: "pointer.drag",
    arguments: {
      from: { x: 10, y: 20 },
      to: { x: 300, y: 80 },
    },
  });
});

test("workflow skips false when steps and runs bounded for_each sequentially", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "trello.cards.read_visible",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "maybeSkip",
          when: "{% false %}",
          primitive: "pointer.click",
          args: { x: 1, y: 1 },
        },
        {
          id: "readCards",
          for_each: "{% [{'selector':'#a'}, {'selector':'#b'}, {'selector':'#c'}] %}",
          max_items: 2,
          primitive: "locator.element_info",
          args: { locator: { selector: "{% item.selector %}" } },
        },
      ],
    },
    async executePrimitive(call) {
      primitiveCalls.push(call);
      return { ok: true, output: { selector: call.arguments.locator.selector } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(primitiveCalls.map((call) => call.arguments.locator.selector), ["#a", "#b"]);
  assert.equal(result.steps[0].skipped, true);
  assert.equal(result.output.steps.readCards.items.length, 2);
});

test("workflow supports bounded scroll-until-visible retry loops", async () => {
  const primitiveCalls = [];
  let readCount = 0;
  const result = await executeWorkflowAction({
    actionName: "trello.card.scroll_until_visible",
    input: { card_title: "Hidden card" },
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "findCard",
          primitive: "locator.element_info",
          args: {
            locator: {
              selector: "[data-testid='card-name']",
              text_contains: "{% input.card_title %}",
            },
          },
          retry_until: "{% steps.findCard.output.visible = true %}",
          max_attempts: 3,
          after_each: {
            primitive: "viewport.scroll",
            args: { delta_y: 500 },
          },
        },
      ],
      output: "{% steps.findCard.output.clickable_center %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call);
      if (call.name === "locator.element_info") {
        readCount += 1;
        return {
          ok: true,
          output: {
            visible: readCount >= 2,
            clickable_center: readCount >= 2 ? { x: 100, y: 250 } : null,
          },
        };
      }
      return { ok: true, output: { moved: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    primitiveCalls.map((call) => call.name),
    ["locator.element_info", "viewport.scroll", "locator.element_info"],
  );
  assert.deepEqual(result.output.value, { x: 100, y: 250 });
});

test("workflow scroll-until-visible can reset to board start and scan horizontally when caller passes zero x delta", async () => {
  const primitiveCalls = [];
  let readCount = 0;
  const result = await executeWorkflowAction({
    actionName: "trello.card.scroll_until_visible",
    input: { card_title: "Record demo", scroll_delta_x: 0, scroll_delta_y: 0 },
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "scrollToStart",
          primitive: "viewport.scroll",
          args: {
            delta_x: -6000,
            delta_y: 0,
            scope: { selector: "[data-testid='lists']", root_strategy: "scope" },
          },
          on_error: "continue",
        },
        {
          id: "scrollTargetListToTop",
          primitive: "viewport.scroll",
          args: {
            delta_x: 0,
            delta_y: -6000,
            scope: {
              selector: "[data-testid='list-cards']",
              text_contains: "{% input.card_title %}",
              root_strategy: "scope",
            },
          },
          on_error: "continue",
        },
        {
          id: "findCard",
          primitive: "locator.element_info",
          args: {
            locator: {
              selector: "[data-testid='card-name'], a[href*='/c/']",
              text_contains: "{% input.card_title %}",
            },
          },
          on_error: "continue",
          retry_until: "{% $exists(steps.findCard.output.clickable_center.x) %}",
          max_attempts: 3,
          after_each: {
            primitive: "viewport.scroll",
            args: {
              delta_x: "{% input.scroll_delta_x ? input.scroll_delta_x : 900 %}",
              delta_y: "{% input.scroll_delta_y ? input.scroll_delta_y : 520 %}",
              scope: { selector: "[data-testid='lists']", root_strategy: "scope" },
            },
          },
        },
      ],
      output: "{% steps.findCard.output.clickable_center %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call);
      if (call.name === "locator.element_info") {
        readCount += 1;
        return {
          ok: true,
          output: {
            clickable_center: readCount >= 2 ? { x: 420, y: 180 } : null,
          },
        };
      }
      return { ok: true, output: { moved: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    primitiveCalls.map((call) => call.name),
    ["viewport.scroll", "viewport.scroll", "locator.element_info", "viewport.scroll", "locator.element_info"],
  );
  assert.equal(primitiveCalls[0].arguments.delta_x, -6000);
  assert.equal(primitiveCalls[1].arguments.delta_y, -6000);
  assert.equal(primitiveCalls[3].arguments.delta_x, 900);
  assert.deepEqual(result.output.value, { x: 420, y: 180 });
});

test("workflow fails when retry loop exhausts without satisfying retry condition", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "trello.card.scroll_until_visible",
    input: { card_title: "Missing card" },
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "findCard",
          primitive: "locator.element_info",
          args: {
            locator: {
              selector: "[data-testid='card-name']",
              text_contains: "{% input.card_title %}",
            },
          },
          on_error: "continue",
          retry_until: "{% steps.findCard.output.clickable_center.x != null %}",
          max_attempts: 3,
          after_each: {
            primitive: "viewport.scroll",
            args: { delta_y: 500 },
          },
        },
      ],
      output: "{% {'card_title': input.card_title, 'card': steps.findCard.output} %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call);
      if (call.name === "locator.element_info") {
        return {
          ok: false,
          error: {
            code: "target_not_found",
            message: "No visible element matched the locator.",
            recoverable: true,
          },
        };
      }
      return { ok: true, output: { moved: true } };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "workflow_retry_exhausted");
  assert.equal(result.error.step_id, "findCard");
  assert.deepEqual(
    primitiveCalls.map((call) => call.name),
    [
      "locator.element_info",
      "viewport.scroll",
      "locator.element_info",
      "viewport.scroll",
      "locator.element_info",
    ],
  );
});

test("workflow failures include normalized class, failed state, recoverability, and recovery guidance", async () => {
  const result = await executeWorkflowAction({
    actionName: "trello.card.due_date.clear",
    workflow: {
      version: 1,
      expression_language: "jsonata",
      x_state_machine: {
        states: ["precondition", "readiness", "mutation", "postcondition", "cleanup"],
      },
      steps: [
        {
          id: "findRemove",
          primitive: "locator.element_info",
          args: { locator: { selector: "[data-testid='date-range-picker'] button", text_contains: "Remove" } },
          retry_until: "{% steps.findRemove.output.clickable_center.x != null %}",
          max_attempts: 2,
          after_each: {
            primitive: "locator.wait_for",
            args: {
              locator: { selector: "[data-testid='date-range-picker'] button", text_contains: "Remove" },
              state: "visible",
              timeout_ms: 1000,
            },
          },
        },
      ],
    },
    async executePrimitive() {
      return { ok: true, output: { candidates: [] } };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "workflow_retry_exhausted");
  assert.equal(result.error.failure_class, "control_not_ready");
  assert.equal(result.error.failed_state, "readiness");
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.recoverable, true);
  assert.match(result.error.safe_recovery, /retry/i);
});

test("workflow failures classify overlay interference from pointer failures", async () => {
  const result = await executeWorkflowAction({
    actionName: "overlay.blocked.click",
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "clickTarget",
          primitive: "pointer.click",
          args: { x: 10, y: 20 },
        },
      ],
    },
    async executePrimitive() {
      return {
        ok: false,
        error: {
          code: "overlay_interference",
          message: "Click target is occluded by the actions overlay.",
          recoverable: true,
        },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.failure_class, "overlay_interference");
  assert.equal(result.error.failed_state, "mutation");
  assert.equal(result.error.retryable, true);
  assert.match(result.error.safe_recovery, /overlay/i);
});

test("workflow failures classify postcondition failures as state verification failures", async () => {
  const result = await executeWorkflowAction({
    actionName: "card.verify.after.click",
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "verifyPostcondition",
          primitive: "locator.element_info",
          args: { locator: { selector: "[data-testid='card-name']" } },
        },
      ],
    },
    async executePrimitive() {
      return {
        ok: false,
        error: {
          code: "postcondition_failed",
          message: "The card due date was still present.",
          recoverable: true,
        },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.failure_class, "postcondition_failed");
  assert.equal(result.error.failed_state, "postcondition");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.safe_recovery, /state projection/i);
});

test("workflow fails fast and identifies the failed step", async () => {
  const result = await executeWorkflowAction({
    actionName: "trello.bad.click",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        { id: "find", primitive: "locator.element_info", args: {} },
        { id: "click", primitive: "pointer.click", args: { x: "{% steps.find.output.x %}", y: 1 } },
      ],
    },
    async executePrimitive(call) {
      if (call.name === "locator.element_info") {
        return { ok: false, error: { code: "not_found", message: "No match" } };
      }
      throw new Error("should not execute after failure");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "workflow_step_failed");
  assert.equal(result.error.step_id, "find");
  assert.equal(result.steps.length, 1);
});

test("workflow validation accepts a well-formed settle_after and rejects malformed ones", () => {
  const base = (settle_after) => ({
    version: 1,
    expression_language: "jsonata",
    steps: [{ id: "open", primitive: "pointer.click", args: {}, settle_after }],
  });
  assert.deepEqual(
    validateWorkflow(base({ locator: { selector: "[data-testid='card-back-name']" }, state: "visible", timeout_ms: 8000 })),
    { ok: true },
  );
  assert.deepEqual(validateWorkflow(base({ delay_ms: 250 })), { ok: true });
  assert.equal(validateWorkflow(base({})).error.code, "invalid_workflow");
  assert.equal(
    validateWorkflow(base({ locator: { selector: "#x" }, delay_ms: 10 })).error.code,
    "invalid_workflow",
  );
  assert.equal(validateWorkflow(base({ delay_ms: 0 })).error.code, "invalid_workflow");
  assert.equal(validateWorkflow(base({ delay_ms: -5 })).error.code, "invalid_workflow");
  assert.equal(validateWorkflow(base({ locator: "#x" })).error.code, "invalid_workflow");
});

test("settle_after locator runs locator.wait_for between a step and the next step", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "trello.card.due_date.set",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "openCard",
          primitive: "pointer.click",
          args: { x: 443, y: 595 },
          settle_after: {
            locator: { selector: "[data-testid='card-back-name']" },
            state: "visible",
            timeout_ms: 8000,
          },
        },
        {
          id: "findDates",
          primitive: "locator.element_info",
          args: { locator: { selector: "[role='dialog'] button", text_contains: "Dates" } },
        },
      ],
      output: "{% steps.findDates.output %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call.name);
      if (call.name === "locator.wait_for") {
        return { ok: true, output: { matched: true } };
      }
      if (call.name === "locator.element_info") {
        return { ok: true, output: { clickable_center: { x: 270, y: 233 } } };
      }
      return { ok: true, output: { clicked: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(primitiveCalls, ["pointer.click", "locator.wait_for", "locator.element_info"]);
  const openStep = result.steps.find((step) => step.id === "openCard");
  assert.equal(openStep.settle.ok, true);
  assert.equal(openStep.settle.mode, "locator");
});

test("settle_after delay waits before the next step", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "delay.workflow",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        { id: "act", primitive: "pointer.click", args: {}, settle_after: { delay_ms: 5 } },
        { id: "next", primitive: "locator.element_info", args: {} },
      ],
      output: "{% steps.next.output %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call.name);
      return { ok: true, output: {} };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(primitiveCalls, ["pointer.click", "locator.element_info"]);
  assert.equal(result.steps.find((step) => step.id === "act").settle.mode, "delay");
});

// A settle_after is the author saying "this step is not finished until X is on the page."
// If X never arrives, the step did not finish. Before 6a3903f the timeout was recorded into
// the step summary and discarded, so the workflow marched past a surface that never appeared
// and every later failure was reported at the wrong step.
//
// That is not a cosmetic reporting bug. It is the entry condition for a WRONG MUTATION.
// Measured on live Trello 2026-07-09: trello.card.delete's `clickArchive` waits for the
// archive popover; when that settle times out silently, `findDeleteButton` (on_error:
// "continue") resolves its then-unscoped locator to the card's *Delete checklist* button,
// and `clickDelete` (on_error: null) clicks it. The checklist is destroyed, the card
// survives, and verifyCardGone does not object. The map-side locator scoping is the other
// half of that fix (storage.public 3df593b); this test guards the engine half.
test("settle_after locator timeout FAILS its step and halts the workflow", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "settle.timeout",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "openCard",
          primitive: "pointer.click",
          args: {},
          settle_after: { locator: { selector: "#never" }, timeout_ms: 10 },
        },
        { id: "next", primitive: "locator.element_info", args: {} },
      ],
      output: "{% steps.next.output %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call.name);
      if (call.name === "locator.wait_for") {
        return { ok: false, error: { code: "timeout", message: "no match" } };
      }
      return { ok: true, output: { done: true } };
    },
  });

  assert.equal(result.ok, false);
  // The outer code is the generic step failure; `workflow_settle_timeout` is the CAUSE.
  // Assert both: the outer code is what callers switch on, and the cause is the diagnostic
  // that tells an agent the step's surface never appeared rather than its click missing.
  assert.equal(result.error.code, "workflow_step_failed");
  assert.equal(result.error.step_id, "openCard");
  assert.equal(result.error.cause.code, "workflow_settle_timeout");
  assert.equal(result.error.cause.cause.reason, "timeout");
  assert.equal(result.error.retryable, false);
  // The step after the failed settle must NOT run — that marching-on is the whole defect.
  assert.deepEqual(primitiveCalls, ["pointer.click", "locator.wait_for"]);
  const openStep = result.steps.find((step) => step.id === "openCard");
  assert.equal(openStep.settle.ok, false);
  assert.equal(openStep.settle.reason, "timeout");
});

// The escape hatch is explicit, not implicit. An author who genuinely wants an advisory
// settle says so, and then the old behavior is exactly what they get.
test("settle_after timeout stays advisory when the author opts out with on_error: continue", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "settle.timeout.opted-out",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "openCard",
          primitive: "pointer.click",
          args: {},
          on_error: "continue",
          settle_after: { locator: { selector: "#never" }, timeout_ms: 10 },
        },
        { id: "next", primitive: "locator.element_info", args: {} },
      ],
      output: "{% steps.next.output %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call.name);
      if (call.name === "locator.wait_for") {
        return { ok: false, error: { code: "timeout", message: "no match" } };
      }
      return { ok: true, output: { done: true } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(primitiveCalls, ["pointer.click", "locator.wait_for", "locator.element_info"]);
  const openStep = result.steps.find((step) => step.id === "openCard");
  assert.equal(openStep.settle.ok, false);
  assert.equal(openStep.settle.reason, "timeout");
});

test("settle_after does not run when the step itself fails", async () => {
  const primitiveCalls = [];
  const result = await executeWorkflowAction({
    actionName: "settle.skipped-on-failure",
    input: {},
    workflow: {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "openCard",
          primitive: "pointer.click",
          args: {},
          settle_after: { locator: { selector: "#x" } },
        },
      ],
      output: "{% steps.openCard.output %}",
    },
    async executePrimitive(call) {
      primitiveCalls.push(call.name);
      return { ok: false, error: { code: "click_failed", message: "miss" } };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(primitiveCalls, ["pointer.click"]);
});

test("validateWorkflow rejects a step with an unrecognized field", () => {
  const result = validateWorkflow({
    version: 1,
    expression_language: "jsonata",
    steps: [
      {
        id: "verify",
        primitive: "locator.element_info",
        args: { locator: { selector: "#x" } },
        finally: { primitive: "overlay.menu.show" },
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_workflow");
  assert.match(result.error.message, /finally/);
  assert.match(result.error.message, /verify/);
});

test("validateWorkflow rejects unrecognized top-level workflow keys", () => {
  const result = validateWorkflow({
    version: 1,
    expression_language: "jsonata",
    steps: [],
    cleanup: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_workflow");
  assert.match(result.error.message, /cleanup/);
});

test("validateWorkflow accepts state-machine metadata for mutating workflow authoring", () => {
  const result = validateWorkflow({
    version: 1,
    expression_language: "jsonata",
    x_state_machine: {
      states: ["precondition", "readiness", "mutation", "postcondition", "cleanup"],
      overlay_safe: false,
    },
    steps: [
      {
        id: "hideOverlay",
        primitive: "overlay.menu.hide",
        on_error: "continue",
      },
    ],
  });

  assert.deepEqual(result, { ok: true });
});

test("validateWorkflow accepts every recognized field used together", () => {
  const result = validateWorkflow({
    version: 1,
    expression_language: "jsonata",
    steps: [
      {
        id: "findCard",
        primitive: "locator.element_info",
        args: { locator: { selector: "#x", text_contains: "{% input.title %}" } },
        when: "{% $exists(input.title) %}",
        retry_until: "{% $exists(steps.findCard.output.clickable_center.x) %}",
        max_attempts: 3,
        after_each: { primitive: "viewport.scroll", args: { delta_x: 0, delta_y: 240 } },
        settle_after: { locator: { selector: "#y" }, state: "visible", timeout_ms: 4000 },
        on_error: "continue",
      },
      {
        id: "eachItem",
        primitive: "locator.text_content",
        args: { locator: { selector: "#z" } },
        for_each: "{% steps.findCard.output.candidates %}",
        max_items: 5,
      },
    ],
    output: "{% steps.findCard.output %}",
  });
  assert.deepEqual(result, { ok: true });
});

test("validateWorkflow rejects a step primitive missing from knownPrimitives", () => {
  const limits = { maxSteps: 32, maxLoopItems: 32, knownPrimitives: ["pointer.click", "viewport.scroll"] };
  const result = validateWorkflow(
    {
      version: 1,
      expression_language: "jsonata",
      steps: [
        { id: "scrollIn", primitive: "locator.scroll_into_view", args: {} },
      ],
    },
    limits,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_workflow");
  assert.match(result.error.message, /locator\.scroll_into_view/);
  assert.match(result.error.message, /scrollIn/);
});

test("validateWorkflow rejects an after_each primitive missing from knownPrimitives", () => {
  const limits = { maxSteps: 32, maxLoopItems: 32, knownPrimitives: ["locator.element_info"] };
  const result = validateWorkflow(
    {
      version: 1,
      expression_language: "jsonata",
      steps: [
        {
          id: "findCard",
          primitive: "locator.element_info",
          args: {},
          retry_until: "{% $exists(steps.findCard.output.clickable_center.x) %}",
          max_attempts: 3,
          after_each: { primitive: "viewport.scroll_down", args: {} },
        },
      ],
    },
    limits,
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /viewport\.scroll_down/);
});

test("validateWorkflow accepts any primitive name when knownPrimitives is absent", () => {
  const result = validateWorkflow({
    version: 1,
    expression_language: "jsonata",
    steps: [{ id: "anything", primitive: "totally.unknown", args: {} }],
  });
  assert.deepEqual(result, { ok: true });
});

test("validateWorkflow keeps default caps when limits only provides knownPrimitives", () => {
  const steps = Array.from({ length: 26 }, (_, i) => ({
    id: `step${i}`,
    primitive: "pointer.click",
    args: {},
  }));
  const result = validateWorkflow(
    { version: 1, expression_language: "jsonata", steps },
    { knownPrimitives: ["pointer.click"] },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /too many steps/);
});
