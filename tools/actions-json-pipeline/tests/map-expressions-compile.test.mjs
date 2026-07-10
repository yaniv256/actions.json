import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import test from "node:test";

import jsonata from "jsonata";

// Every JSONata expression in every stored map MUST COMPILE.
//
// Found 2026-07-09, while trying to tick a checklist item. `validateWorkflow`
// returns ok:true for a workflow whose `output` expression cannot be parsed —
// it checks structure, not that the expressions compile. So the action ships,
// the engine dispatches EVERY step (including `pointer.click`, which checks the
// box), and only then does `evaluateWorkflowValue(workflow.output)` throw
// `invalid_expression`. The action returns ok:false.
//
//   A destructive mutation that LANDS and then reports FAILURE.
//
// That is worse than the silent-no-op family: a false negative on a *toggle*
// invites the caller to retry, and the retry undoes the work. It is why
// trello.card.checklist_item.complete/uncomplete were "unreliable".
//
// The cause: `'THIS item\'s checkbox'`. JSONata single-quoted strings accept
// NEITHER a backslash escape NOR a doubled quote — verified against jsonata@2:
//
//   { 'v': 'item\'s box' }   -> Unsupported escape sequence
//   { 'v': 'item''s box' }   -> Expected "}", got "s box"
//   { "v": "item's box" }    -> compiles
//
// Do not guard by grepping for `\'` — that is a proxy for the property. Compile
// the expressions; it catches this and every future syntax error.

const SLOT = /^\s*\{%\s*([\s\S]*?)\s*%\}\s*$/;

function expressionsOf(tool) {
  const found = [];
  const workflow = tool.workflow;
  if (!workflow) return found;
  const push = (where, value) => {
    if (typeof value !== "string") return;
    const match = value.match(SLOT);
    if (match) found.push({ where, source: match[1] });
  };
  const walk = (where, value) => {
    if (typeof value === "string") return push(where, value);
    if (Array.isArray(value)) return value.forEach((v, i) => walk(`${where}[${i}]`, v));
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${where}.${k}`, v);
    }
  };
  push("workflow.output", workflow.output);
  for (const step of workflow.steps ?? []) {
    walk(`steps.${step.id}.args`, step.args);
    push(`steps.${step.id}.when`, step.when);
    push(`steps.${step.id}.retry_until`, step.retry_until);
    walk(`steps.${step.id}.after_each`, step.after_each);
    walk(`steps.${step.id}.settle_after`, step.settle_after);
  }
  return found;
}

// State projections carry JSONata too — the snapshot projection, its summaries, and the
// per-action postconditions. A postcondition that cannot compile behaves exactly like one
// that returns false: the mutation LANDS and the tool reports failure, which on a toggle
// invites a retry that UNDOES the work. Same danger class as an uncompilable workflow.output.
function projectionExpressionsOf(projection) {
  const found = [];
  const push = (where, value) => {
    if (typeof value !== "string") return;
    const match = value.match(SLOT);
    if (match) found.push({ where, source: match[1] });
  };
  const name = projection.name ?? "?";
  push(`projection.${name}.snapshot.projection`, projection.snapshot?.projection?.expression);
  for (const summary of projection.summaries ?? []) {
    push(`projection.${name}.summaries.${summary.name ?? "?"}`, summary.expression);
  }
  for (const [action, pc] of Object.entries(projection.postconditions ?? {})) {
    push(`projection.${name}.postconditions.${action}`, pc?.verify?.expression);
  }
  return found;
}

function storedMaps() {
  try {
    return execSync("ls /home/agent-zara/actions.json.storage/scopes/*/sites/*/*/actions.json")
      .toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("every JSONata expression in every stored map compiles", (t) => {
  const maps = storedMaps();
  if (maps.length === 0) return t.skip("Sibling actions.json.storage checkout is not available.");

  const broken = [];
  for (const path of maps) {
    let map;
    try { map = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    for (const tool of map.tools ?? []) {
      for (const { where, source } of expressionsOf(tool)) {
        try {
          jsonata(source);
        } catch (error) {
          broken.push(`${path.split("scopes/")[1]}  ${tool.name}  [${where}]  ${error.message}`);
        }
      }
    }
    for (const projection of map.state_projections ?? []) {
      for (const { where, source } of projectionExpressionsOf(projection)) {
        try {
          jsonata(source);
        } catch (error) {
          broken.push(`${path.split("scopes/")[1]}  [${where}]  ${error.message}`);
        }
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    `these expressions cannot compile — the workflow validates, dispatches every step, then fails at evaluation:\n  ${broken.join("\n  ")}`,
  );
});
