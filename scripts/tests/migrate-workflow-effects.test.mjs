import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateWorkflowEffects } from "../migrate-workflow-effects.mjs";

test("adds conservative explicit effects without replacing author declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "actions-effect-migration-"));
  const file = path.join(root, "actions.json");
  await writeFile(file, JSON.stringify({ tools: [{ name: "card.delete", workflow: { version: 1, steps: [
    { id: "find", primitive: "locator.element_info" },
    { id: "hideOverlay", primitive: "overlay.menu.hide" },
    { id: "delete", primitive: "pointer.click" },
    { id: "verifyGone", primitive: "a11y.query" },
    { id: "authored", primitive: "pointer.click", effect: "readiness" },
  ] } }] }));

  const dry = await migrateWorkflowEffects(root);
  assert.equal(dry.changed, 4);
  assert.equal((JSON.parse(await readFile(file, "utf8"))).tools[0].workflow.steps[0].effect, undefined);

  const written = await migrateWorkflowEffects(root, { write: true });
  assert.equal(written.changed, 4);
  const steps = (JSON.parse(await readFile(file, "utf8"))).tools[0].workflow.steps;
  assert.deepEqual(steps.map((step) => step.effect), [
    "observation", "cleanup", "irreversible_mutation", "verification", "readiness",
  ]);
});

test("classifies interaction defaults as reversible and retry cleanup independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "actions-effect-after-each-"));
  const file = path.join(root, "actions.json");
  await writeFile(file, JSON.stringify({ actions: [{ name: "card.open", workflow: { version: 1, steps: [{
    id: "submit", primitive: "pointer.click", retry_until: "{% true %}", max_attempts: 2,
    after_each: { primitive: "viewport.scroll", args: { delta_y: 100 } },
  }] } }] }));
  await migrateWorkflowEffects(root, { write: true });
  const step = (JSON.parse(await readFile(file, "utf8"))).actions[0].workflow.steps[0];
  assert.equal(step.effect, "reversible_mutation");
  assert.equal(step.after_each.effect, "readiness");
});

test("adds an executable exact-one guard when a mutation consumes locator geometry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "actions-target-guard-"));
  const file = path.join(root, "actions.json");
  await writeFile(file, JSON.stringify({ tools: [{ name: "card.archive", workflow: { version: 1, steps: [
    { id: "findArchive", primitive: "locator.element_info" },
    { id: "clickArchive", primitive: "pointer.click", args: { x: "{% steps.findArchive.output.clickable_center.x %}" } },
  ] } }] }));
  await migrateWorkflowEffects(root, { write: true });
  const steps = (JSON.parse(await readFile(file, "utf8"))).tools[0].workflow.steps;
  assert.equal(steps[1].effect, "reversible_mutation");
  assert.deepEqual(steps[1].target_guards, [{ source_step: "findArchive", candidate_count: 1 }]);
});
