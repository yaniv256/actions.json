import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

import { auditWorkflowStorageRoots } from "../audit-workflow-safety.mjs";

async function writeMap(root, value, relative = "scopes/public/sites/example.test/page/actions.json") {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function actionWithSteps(steps) {
  return {
    actions: [{
      name: "example.item.open",
      workflow: { version: 1, expression_language: "jsonata", steps },
    }],
  };
}

function runAuditCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../audit-workflow-safety.mjs"), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("reports missing and invalid effects with stable map/action/step provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeMap(root, actionWithSteps([
    { id: "findItem", primitive: "locator.element_info", effect: "observation", args: {} },
    { id: "clickItem", primitive: "pointer.click", args: {} },
    { id: "verify", primitive: "locator.element_info", effect: "read", args: {} },
  ]));

  const report = await auditWorkflowStorageRoots([root], { strict: true });

  assert.equal(report.ok, false);
  assert.equal(report.counts.by_code.effect_metadata_missing, 1);
  assert.equal(report.counts.by_code.effect_metadata_invalid, 1);
  assert.deepEqual(
    report.findings.filter((finding) => finding.code.startsWith("effect_metadata")).map((finding) => ({
      action: finding.action,
      step: finding.step,
    })),
    [
      { action: "example.item.open", step: "clickItem" },
      { action: "example.item.open", step: "verify" },
    ],
  );
});

test("audits retry after_each primitives as executable workflow steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeMap(root, actionWithSteps([{
    id: "findItem",
    primitive: "locator.element_info",
    effect: "observation",
    retry_until: "{% $exists(steps.findItem.output.text) %}",
    after_each: { primitive: "viewport.scroll" },
  }]));

  const report = await auditWorkflowStorageRoots([root], { strict: true });

  assert.equal(report.counts.by_code.effect_metadata_missing, 1);
  assert.equal(report.findings[0].step, "findItem.after_each");
});

test("flags a consumed discovery output followed by mutation without a uniqueness gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeMap(root, actionWithSteps([
    { id: "findItem", primitive: "locator.element_info", effect: "observation", args: {} },
    {
      id: "clickItem",
      primitive: "pointer.click",
      effect: "irreversible_mutation",
      args: { x: "{% steps.findItem.output.clickable_center.x %}" },
    },
  ]));

  const report = await auditWorkflowStorageRoots([root], { strict: true });

  assert.equal(report.counts.by_code.discovery_effect_without_uniqueness_gate, 1);
  assert.equal(report.findings.find((finding) => finding.code === "discovery_effect_without_uniqueness_gate").step, "clickItem");
});

test("accepts an explicit exact-count gate or opaque reference gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeMap(root, {
    actions: [
      {
        name: "example.exact.open",
        workflow: {
          version: 1,
          expression_language: "jsonata",
          steps: [
            {
              id: "findItem",
              primitive: "locator.element_info",
              effect: "observation",
              retry_until: "{% steps.findItem.output.candidate_count = 1 %}",
            },
            {
              id: "clickItem",
              primitive: "pointer.click",
              effect: "irreversible_mutation",
              args: { x: "{% steps.findItem.output.clickable_center.x %}" },
            },
          ],
        },
      },
      {
        name: "example.ref.open",
        workflow: {
          version: 1,
          expression_language: "jsonata",
          steps: [
            { id: "resolveRef", primitive: "locator.element_info", effect: "observation", args: { node_ref: "{% input.node_ref %}" } },
            { id: "clickRef", primitive: "pointer.click", effect: "irreversible_mutation", args: { x: "{% steps.resolveRef.output.clickable_center.x %}" } },
          ],
        },
      },
      {
        name: "example.guarded.open",
        workflow: {
          version: 1,
          expression_language: "jsonata",
          steps: [
            { id: "findGuarded", primitive: "locator.element_info", effect: "observation" },
            {
              id: "clickGuarded",
              primitive: "pointer.click",
              effect: "reversible_mutation",
              target_guard: { source_step: "findGuarded", candidate_count: 1 },
              args: { x: "{% steps.findGuarded.output.clickable_center.x %}" },
            },
          ],
        },
      },
    ],
  });

  const report = await auditWorkflowStorageRoots([root], { strict: true });

  assert.equal(report.ok, true);
  assert.equal(report.counts.by_code.discovery_effect_without_uniqueness_gate ?? 0, 0);
});

test("missing roots and uninitialized declared submodules make coverage explicitly incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeFile(path.join(root, ".gitmodules"), [
    '[submodule "scopes/public"]',
    "\tpath = scopes/public",
    "\turl = https://example.test/public.git",
    "",
  ].join("\n"));
  await mkdir(path.join(root, "scopes/public"), { recursive: true });

  const report = await auditWorkflowStorageRoots([root, path.join(root, "absent")], { strict: true });

  assert.equal(report.ok, false);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.counts.by_code.root_missing, 1);
  assert.equal(report.counts.by_code.submodule_uninitialized, 1);
});

test("an existing but empty root cannot silently pass coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));

  const report = await auditWorkflowStorageRoots([root], { strict: true });

  assert.equal(report.ok, false);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.counts.by_code.no_action_maps_found, 1);
});

test("bounds emitted findings while preserving total counts and truncation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeMap(root, actionWithSteps(Array.from({ length: 12 }, (_, index) => ({
    id: `step${index}`,
    primitive: "page.info",
  }))));

  const report = await auditWorkflowStorageRoots([root], { strict: false, maxFindings: 3 });

  assert.equal(report.ok, true);
  assert.equal(report.counts.findings_total, 12);
  assert.equal(report.counts.findings_emitted, 3);
  assert.equal(report.counts.findings_truncated, 9);
  assert.equal(report.findings.length, 3);
});

test("CLI exits nonzero for unsafe omissions only when strict mode is requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-audit-"));
  await writeMap(root, actionWithSteps([{ id: "unsafe", primitive: "pointer.click" }]));

  const advisory = await runAuditCli(["--max-findings", "1", root]);
  const strict = await runAuditCli(["--strict", "--max-findings", "1", root]);

  assert.equal(advisory.code, 0, advisory.stderr);
  assert.equal(JSON.parse(advisory.stdout).counts.findings_total, 1);
  assert.equal(strict.code, 1, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).ok, false);
});
