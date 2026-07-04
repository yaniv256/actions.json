import jsonata from "./vendor/jsonata.mjs";

const EXPRESSION_SLOT_PATTERN = /^\s*\{%\s*([\s\S]*?)\s*%\}\s*$/;
const PARTIAL_EXPRESSION_PATTERN = /\{%|%\}/;
const STEP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DISALLOWED_JSONATA_FUNCTIONS = /\$(eval|random|now|millis)\s*\(/i;

const DEFAULT_LIMITS = {
  maxSteps: 25,
  maxLoopItems: 50,
  maxWorkflowOutputBytes: 32_000,
  maxExpressionOutputBytes: 16_000,
};

class WorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    Object.assign(this, details);
  }
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function normalizeJsonValue(value) {
  if (value == null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function expressionFromSlot(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(EXPRESSION_SLOT_PATTERN);
  if (match) {
    return match[1];
  }
  if (PARTIAL_EXPRESSION_PATTERN.test(value)) {
    throw new WorkflowError(
      "partial_expression_unsupported",
      "Partial embedded JSONata expressions are not supported; the whole string must be a {% expression %} slot.",
    );
  }
  return null;
}

async function evaluateExpressionSlot(value, context, limits = DEFAULT_LIMITS) {
  const expressionSource = expressionFromSlot(value);
  if (expressionSource == null) {
    return value;
  }
  if (DISALLOWED_JSONATA_FUNCTIONS.test(expressionSource)) {
    throw new WorkflowError(
      "disallowed_expression_function",
      "Workflow JSONata expressions cannot use dynamic evaluation, randomness, or clock functions.",
      { expression: expressionSource },
    );
  }
  let expression;
  try {
    expression = jsonata(expressionSource);
  } catch (error) {
    throw new WorkflowError("invalid_expression", error.message || String(error), { expression: expressionSource });
  }
  try {
    const evaluated = normalizeJsonValue(await expression.evaluate(context));
    if (byteLength(evaluated) > limits.maxExpressionOutputBytes) {
      throw new WorkflowError("expression_output_too_large", "JSONata expression output exceeded the configured limit.", {
        expression: expressionSource,
      });
    }
    return evaluated;
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw new WorkflowError("expression_evaluation_failed", error.message || String(error), {
      expression: expressionSource,
    });
  }
}

export async function evaluateWorkflowValue(value, context, limits = DEFAULT_LIMITS) {
  if (typeof value === "string") {
    return evaluateExpressionSlot(value, context, limits);
  }
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      output.push(await evaluateWorkflowValue(item, context, limits));
    }
    return output;
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = await evaluateWorkflowValue(nested, context, limits);
    }
    return output;
  }
  return value;
}

const ALLOWED_WORKFLOW_KEYS = new Set(["version", "expression_language", "steps", "output", "x_state_machine"]);
const ALLOWED_STEP_KEYS = new Set([
  "id",
  "primitive",
  "args",
  "when",
  "for_each",
  "max_items",
  "retry_until",
  "max_attempts",
  "after_each",
  "on_error",
  "settle_after",
]);

function unknownPrimitiveError(stepId, primitiveName) {
  return {
    ok: false,
    error: {
      code: "invalid_workflow",
      message: `Workflow step ${stepId} uses unknown primitive ${primitiveName}; it is not in the runtime primitive dictionary.`,
    },
  };
}

export function validateWorkflow(workflow, limits = DEFAULT_LIMITS) {
  limits = { ...DEFAULT_LIMITS, ...(limits || {}) };
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return { ok: false, error: { code: "invalid_workflow", message: "Workflow must be an object." } };
  }
  for (const key of Object.keys(workflow)) {
    if (!ALLOWED_WORKFLOW_KEYS.has(key)) {
      return {
        ok: false,
        error: { code: "invalid_workflow", message: `Workflow has unrecognized field ${key}.` },
      };
    }
  }
  const knownPrimitives =
    limits?.knownPrimitives instanceof Set
      ? limits.knownPrimitives
      : Array.isArray(limits?.knownPrimitives) && limits.knownPrimitives.length > 0
        ? new Set(limits.knownPrimitives)
        : null;
  if (workflow.version !== 1) {
    return { ok: false, error: { code: "invalid_workflow", message: "Workflow version must be 1." } };
  }
  if (workflow.expression_language !== "jsonata") {
    return {
      ok: false,
      error: { code: "invalid_workflow", message: "Workflow expression_language must be jsonata." },
    };
  }
  if (!Array.isArray(workflow.steps)) {
    return { ok: false, error: { code: "invalid_workflow", message: "Workflow steps must be an array." } };
  }
  if (workflow.steps.length > limits.maxSteps) {
    return { ok: false, error: { code: "invalid_workflow", message: "Workflow has too many steps." } };
  }
  const ids = new Set();
  for (const step of workflow.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return { ok: false, error: { code: "invalid_workflow", message: "Workflow step must be an object." } };
    }
    if (typeof step.id !== "string" || !STEP_ID_PATTERN.test(step.id)) {
      return { ok: false, error: { code: "invalid_workflow", message: "Workflow step has an invalid id." } };
    }
    if (ids.has(step.id)) {
      return { ok: false, error: { code: "invalid_workflow", message: `Workflow has duplicate step id ${step.id}.` } };
    }
    ids.add(step.id);
    for (const key of Object.keys(step)) {
      if (!ALLOWED_STEP_KEYS.has(key)) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} has unrecognized field ${key}.` },
        };
      }
    }
    if (typeof step.primitive !== "string" || !step.primitive) {
      return { ok: false, error: { code: "invalid_workflow", message: `Workflow step ${step.id} needs primitive.` } };
    }
    if (knownPrimitives && !knownPrimitives.has(step.primitive)) {
      return unknownPrimitiveError(step.id, step.primitive);
    }
    if (step.args != null && (typeof step.args !== "object" || Array.isArray(step.args))) {
      return { ok: false, error: { code: "invalid_workflow", message: `Workflow step ${step.id} args must be an object.` } };
    }
    if (step.for_each !== undefined) {
      if (!Number.isFinite(step.max_items) || step.max_items < 1) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} for_each requires max_items.` },
        };
      }
      if (step.max_items > limits.maxLoopItems) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} max_items exceeds runtime limit.` },
        };
      }
    }
    if (step.retry_until !== undefined) {
      if (!Number.isFinite(step.max_attempts) || step.max_attempts < 1) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} retry_until requires max_attempts.` },
        };
      }
      if (step.max_attempts > limits.maxLoopItems) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} max_attempts exceeds runtime limit.` },
        };
      }
      if (
        step.after_each &&
        (typeof step.after_each !== "object" ||
          Array.isArray(step.after_each) ||
          typeof step.after_each.primitive !== "string" ||
          !step.after_each.primitive)
      ) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} after_each must declare primitive.` },
        };
      }
      if (step.after_each && knownPrimitives && !knownPrimitives.has(step.after_each.primitive)) {
        return unknownPrimitiveError(step.id, step.after_each.primitive);
      }
    }
    if (step.on_error && step.on_error !== "stop" && step.on_error !== "continue") {
      return {
        ok: false,
        error: { code: "invalid_workflow", message: `Workflow step ${step.id} on_error must be stop or continue.` },
      };
    }
    if (step.settle_after !== undefined) {
      const settle = step.settle_after;
      if (!settle || typeof settle !== "object" || Array.isArray(settle)) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} settle_after must be an object.` },
        };
      }
      const hasLocator = settle.locator != null;
      const hasDelay = settle.delay_ms !== undefined;
      if (hasLocator === hasDelay) {
        return {
          ok: false,
          error: {
            code: "invalid_workflow",
            message: `Workflow step ${step.id} settle_after needs exactly one of locator or delay_ms.`,
          },
        };
      }
      if (hasLocator && (typeof settle.locator !== "object" || Array.isArray(settle.locator))) {
        return {
          ok: false,
          error: { code: "invalid_workflow", message: `Workflow step ${step.id} settle_after locator must be an object.` },
        };
      }
      if (hasDelay && (!Number.isFinite(settle.delay_ms) || settle.delay_ms <= 0)) {
        return {
          ok: false,
          error: {
            code: "invalid_workflow",
            message: `Workflow step ${step.id} settle_after delay_ms must be a positive number.`,
          },
        };
      }
    }
  }
  return { ok: true };
}

function summarizeStep({ step, result, startedAt, skipped = false, settle = undefined }) {
  const summary = {
    id: step.id,
    primitive: step.primitive,
    ok: result?.ok !== false,
    skipped,
    duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  };
  if (settle !== undefined && !settle?.skipped) {
    summary.settle = settle;
  }
  return summary;
}

function classifyWorkflowFailure({ step, result }) {
  const cause = result?.error || {};
  const causeCode = String(cause.code || "");
  const message = String(cause.message || result?.error?.message || "");
  const stepId = String(step?.id || "");
  const primitive = String(step?.primitive || "");

  if (/overlay|occlud|intercept/i.test(`${causeCode} ${message}`)) {
    return {
      failure_class: "overlay_interference",
      failed_state: "mutation",
      retryable: true,
      recoverable: true,
      safe_recovery: "Hide or collapse the actions.json overlay, return to a known page state, then retry the mutation.",
    };
  }
  if (causeCode === "postcondition_failed" || /postcondition/i.test(stepId)) {
    return {
      failure_class: "postcondition_failed",
      failed_state: "postcondition",
      retryable: false,
      recoverable: true,
      safe_recovery: "Read the current state projection before retrying; the mutation may have partially landed.",
    };
  }
  if (
    causeCode.startsWith("workflow_retry_") ||
    primitive.startsWith("locator.") ||
    /find|verify|ready|badge|button|control/i.test(stepId)
  ) {
    return {
      failure_class: "control_not_ready",
      failed_state: "readiness",
      retryable: true,
      recoverable: true,
      safe_recovery: "Retry from the nearest verified state boundary after waiting for the specific target control.",
    };
  }
  return {
    failure_class: "target_not_found",
    failed_state: "precondition",
    retryable: Boolean(cause.recoverable),
    recoverable: Boolean(cause.recoverable),
    safe_recovery: "Return to a known base state, verify the target identity, then retry only if the target is present.",
  };
}

function workflowFailure({ step, result, steps }) {
  const causeCode = result?.error?.code || "";
  const code = causeCode.startsWith("workflow_retry_") ? causeCode : "workflow_step_failed";
  const classification = classifyWorkflowFailure({ step, result });
  return {
    ok: false,
    error: {
      code,
      step_id: step.id,
      primitive: step.primitive,
      message: result?.error?.message || `Workflow step ${step.id} failed.`,
      cause: result?.error || null,
      ...classification,
    },
    steps,
  };
}

const DEFAULT_SETTLE_TIMEOUT_MS = 8000;

async function runSettle({ settle, executePrimitive }) {
  if (!settle || typeof settle !== "object") {
    return { ok: true, skipped: true };
  }
  if (settle.delay_ms !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, settle.delay_ms));
    return { ok: true, mode: "delay", delay_ms: settle.delay_ms };
  }
  if (settle.locator != null) {
    const waitResult = normalizeStepResult(
      await executePrimitive({
        name: "locator.wait_for",
        arguments: {
          locator: settle.locator,
          state: settle.state || "visible",
          timeout_ms: Number.isFinite(settle.timeout_ms) ? settle.timeout_ms : DEFAULT_SETTLE_TIMEOUT_MS,
        },
      }),
    );
    if (waitResult?.ok === false) {
      return { ok: false, mode: "locator", reason: "timeout" };
    }
    return { ok: true, mode: "locator" };
  }
  return { ok: true, skipped: true };
}

function normalizeStepResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: true, output: result };
  }
  if (Object.hasOwn(result, "output")) {
    return result;
  }
  if (Object.hasOwn(result, "value")) {
    return {
      ...result,
      output: result.value,
    };
  }
  return result;
}

export async function executeWorkflowAction({
  actionName,
  workflow,
  input = {},
  executePrimitive,
  limits = DEFAULT_LIMITS,
} = {}) {
  limits = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const validation = validateWorkflow(workflow, limits);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  if (typeof executePrimitive !== "function") {
    return {
      ok: false,
      error: { code: "invalid_workflow_executor", message: "executeWorkflowAction requires executePrimitive." },
    };
  }

  const context = {
    input: input && typeof input === "object" && !Array.isArray(input) ? input : {},
    steps: {},
    item: null,
    index: null,
  };
  const stepSummaries = [];

  for (const step of workflow.steps) {
    const startedAt = performance.now();
    try {
      if (step.when !== undefined) {
        const shouldRun = await evaluateWorkflowValue(step.when, context, limits);
        if (!shouldRun) {
          const skippedResult = { ok: true, skipped: true };
          context.steps[step.save_as || step.id] = skippedResult;
          stepSummaries.push(summarizeStep({ step, result: skippedResult, startedAt, skipped: true }));
          continue;
        }
      }

      if (step.for_each !== undefined) {
        const items = await evaluateWorkflowValue(step.for_each, context, limits);
        if (!Array.isArray(items)) {
          return {
            ok: false,
            error: {
              code: "workflow_loop_input_invalid",
              step_id: step.id,
              message: `Workflow step ${step.id} for_each did not evaluate to an array.`,
            },
            steps: stepSummaries,
          };
        }
        const boundedItems = items.slice(0, Math.min(step.max_items, limits.maxLoopItems));
        const iterationResults = [];
        for (let index = 0; index < boundedItems.length; index += 1) {
          const iterationContext = { ...context, item: boundedItems[index], index };
          const args = await evaluateWorkflowValue(step.args || {}, iterationContext, limits);
          const result = normalizeStepResult(await executePrimitive({ name: step.primitive, arguments: args }));
          iterationResults.push(result);
          if (result?.ok === false && step.on_error !== "continue") {
            const loopResult = { ok: false, items: iterationResults };
            context.steps[step.save_as || step.id] = loopResult;
            stepSummaries.push(summarizeStep({ step, result: loopResult, startedAt }));
            return workflowFailure({ step, result, steps: stepSummaries });
          }
        }
        const loopResult = {
          ok: iterationResults.every((result) => result?.ok !== false),
          items: iterationResults,
        };
        context.steps[step.save_as || step.id] = loopResult;
        stepSummaries.push(summarizeStep({ step, result: loopResult, startedAt }));
        continue;
      }

      if (step.retry_until !== undefined) {
        const maxAttempts = Math.min(step.max_attempts, limits.maxLoopItems);
        const attempts = [];
        let finalResult = null;
        let retrySatisfied = false;
        for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
          const attemptContext = { ...context, index: attemptIndex, item: null };
          const args = await evaluateWorkflowValue(step.args || {}, attemptContext, limits);
          finalResult = normalizeStepResult(await executePrimitive({ name: step.primitive, arguments: args }));
          context.steps[step.save_as || step.id] = finalResult;
          attempts.push(finalResult);
          if (finalResult?.ok === false && step.on_error !== "continue") {
            const retryResult = { ok: false, attempts };
            stepSummaries.push(summarizeStep({ step, result: retryResult, startedAt }));
            return workflowFailure({ step, result: finalResult, steps: stepSummaries });
          }
          const done = await evaluateWorkflowValue(step.retry_until, context, limits);
          if (done) {
            retrySatisfied = true;
            break;
          }
          if (attemptIndex < maxAttempts - 1 && step.after_each) {
            const afterArgs = await evaluateWorkflowValue(step.after_each.args || {}, context, limits);
            const afterResult = normalizeStepResult(
              await executePrimitive({
                name: step.after_each.primitive,
                arguments: afterArgs,
              }),
            );
            attempts.push(afterResult);
            if (afterResult?.ok === false && step.on_error !== "continue") {
              const retryResult = { ok: false, attempts };
              stepSummaries.push(summarizeStep({ step, result: retryResult, startedAt }));
              return workflowFailure({ step, result: afterResult, steps: stepSummaries });
            }
          }
        }
        const retryResult = {
          ...(finalResult || { ok: false, error: { code: "workflow_retry_not_executed" } }),
          attempts,
        };
        if (!retrySatisfied) {
          retryResult.ok = false;
          retryResult.error = {
            code: "workflow_retry_exhausted",
            step_id: step.id,
            message: `Workflow step ${step.id} did not satisfy retry_until after ${maxAttempts} attempts.`,
            cause: finalResult?.error || null,
          };
        }
        context.steps[step.save_as || step.id] = retryResult;
        if (retryResult?.error?.code === "workflow_retry_exhausted") {
          stepSummaries.push(summarizeStep({ step, result: retryResult, startedAt }));
          return workflowFailure({ step, result: retryResult, steps: stepSummaries });
        }
        if (retryResult?.ok === false && step.on_error !== "continue") {
          stepSummaries.push(summarizeStep({ step, result: retryResult, startedAt }));
          return workflowFailure({ step, result: retryResult, steps: stepSummaries });
        }
        let retrySettle;
        if (step.settle_after !== undefined) {
          retrySettle = await runSettle({ settle: step.settle_after, executePrimitive });
        }
        stepSummaries.push(summarizeStep({ step, result: retryResult, startedAt, settle: retrySettle }));
        continue;
      }

      const args = await evaluateWorkflowValue(step.args || {}, context, limits);
      const result = normalizeStepResult(await executePrimitive({ name: step.primitive, arguments: args }));
      context.steps[step.save_as || step.id] = result;
      if (result?.ok === false && step.on_error !== "continue") {
        stepSummaries.push(summarizeStep({ step, result, startedAt }));
        return workflowFailure({ step, result, steps: stepSummaries });
      }
      let settle;
      if (step.settle_after !== undefined) {
        settle = await runSettle({ settle: step.settle_after, executePrimitive });
      }
      stepSummaries.push(summarizeStep({ step, result, startedAt, settle }));
    } catch (error) {
      const result = {
        ok: false,
        error: {
          code: error.code || "workflow_step_failed",
          message: error.message || String(error),
        },
      };
      context.steps[step.save_as || step.id] = result;
      stepSummaries.push(summarizeStep({ step, result, startedAt }));
      if (step.on_error !== "continue") {
        return workflowFailure({ step, result, steps: stepSummaries });
      }
    }
  }

  let value = { steps: context.steps };
  if (workflow.output !== undefined) {
    try {
      value = await evaluateWorkflowValue(workflow.output, context, limits);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error.code || "workflow_output_failed",
          message: error.message || String(error),
        },
        steps: stepSummaries,
      };
    }
  }
  if (byteLength(value) > limits.maxWorkflowOutputBytes) {
    return {
      ok: false,
      error: {
        code: "workflow_output_too_large",
        message: "Workflow output exceeded the configured limit.",
      },
      steps: stepSummaries,
    };
  }
  return {
    ok: true,
    output: {
      ok: true,
      primitive: "actions.workflow",
      action: actionName || null,
      value,
      ...(workflow.output === undefined ? value : {}),
    },
    steps: stepSummaries,
  };
}
