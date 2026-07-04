import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runAudit } from "../src/audit.mjs";
import { runScore } from "../src/score.mjs";
import { loadPipelineTarget } from "../src/storage-loader.mjs";

const execFileAsync = promisify(execFile);
const fixturesRoot = path.resolve("tools/actions-json-pipeline/fixtures");

test("score lowers readiness for high-severity audit findings", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const auditReport = runAudit(context);
  const report = runScore(context, { auditReport });

  assert.equal(report.mechanical.score, 4);
  assert.equal(report.status, "incomplete");
  assert.equal(report.final_score, null);
  assert(report.mechanical.deductions.some((deduction) => deduction.severity === "high"));
});

test("accepted gaps are shown separately from open mechanical deductions", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const auditReport = runAudit(context, {
    ledger: {
      accepted_gaps: [
        {
          finding_id: "missing-file:SKILL.md",
          rationale: "Fixture intentionally omits the skill.",
        },
      ],
    },
  });
  const report = runScore(context, { auditReport });

  assert(report.mechanical.accepted_gaps.some((gap) => gap.finding_id === "missing-file:SKILL.md"));
  assert.equal(
    report.mechanical.deductions.some((deduction) => deduction.finding_id === "missing-file:SKILL.md"),
    false,
  );
});

test("missing semantic assessments leave the readiness report incomplete", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "good-map"));
  const report = runScore(context, { auditReport: runAudit(context) });

  assert.equal(report.mechanical.score, 100);
  assert.equal(report.semantic.status, "incomplete");
  assert.equal(report.final_score, null);
});

test("complete semantic assessments produce a final score and before-after delta", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "good-map"));
  const report = runScore(context, {
    auditReport: runAudit(context),
    before: 73,
    after: 96,
    semantic: {
      assessments: [
        { key: "task_coverage", score: 20, evidence: "Fixture tasks covered." },
        { key: "persona_guidance", score: 15, evidence: "Fixture skill exists." },
        { key: "proof_quality", score: 20, evidence: "Fixture proof complete." },
        { key: "accepted_gap_reasonableness", score: 15, evidence: "No accepted gaps." },
      ],
    },
  });

  assert.equal(report.semantic.status, "complete");
  assert.equal(report.final_score, 100);
  assert.deepEqual(report.before_after, { before: 73, after: 96, delta: 23 });
});

test("score CLI can consume a saved audit report", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const auditReport = runAudit(context);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-score-"));
  const auditPath = path.join(temp, "audit.json");
  await fs.writeFile(auditPath, JSON.stringify(auditReport), "utf8");

  const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, "score", path.join(fixturesRoot, "bad-map"), "--audit", auditPath, "--before", "40", "--after", "52"],
    { cwd: path.resolve(".") },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.mechanical.score, 4);
  assert.deepEqual(report.before_after, { before: 40, after: 52, delta: 12 });
});
