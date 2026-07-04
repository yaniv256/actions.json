import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runAudit } from "../src/audit.mjs";
import { writeProofPackage } from "../src/proof-package.mjs";
import { runScore } from "../src/score.mjs";
import { loadPipelineTarget } from "../src/storage-loader.mjs";

const execFileAsync = promisify(execFile);
const fixturesRoot = path.resolve("tools/actions-json-pipeline/fixtures");

test("package writer creates a proof directory under the site folder", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const report = await writeProofPackage(context, { packageName: "proof-test" });

  assert.equal(report.ok, true);
  assert.equal(report.package_dir, path.join(site, "proof", "proof-test"));
  assert.equal(await exists(report.manifest_path), true);
});

test("package includes map, task list, action log, score report, and ledger when supplied", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const audit = runAudit(context);
  const score = runScore(context, { auditReport: audit });
  const report = await writeProofPackage(context, {
    packageName: "complete-proof",
    taskListPath: path.join(fixturesRoot, "proof-input", "task-list.json"),
    actionLogPath: path.join(fixturesRoot, "proof-input", "action-log.json"),
    failuresPath: path.join(fixturesRoot, "proof-input", "failures-fixes.json"),
    scoreReport: score,
    ledger: { accepted_gaps: [] },
  });

  const relativePaths = report.manifest.files.map((file) => file.relative_path).sort();
  assert.deepEqual(relativePaths, [
    "accepted-gaps.json",
    "action-log.json",
    "actions.json",
    "failures-fixes.json",
    "manifest.json",
    "score-report.json",
    "screenshots.json",
    "task-list.json",
  ]);
});

test("missing optional screenshots do not fail packaging", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const report = await writeProofPackage(context, { packageName: "no-screenshots" });

  const screenshots = JSON.parse(await fs.readFile(path.join(report.package_dir, "screenshots.json"), "utf8"));
  assert.deepEqual(screenshots, { screenshots: [] });
});

test("screenshot entries require explicit proof metadata", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-proof-"));
  const screenshotsPath = path.join(temp, "screenshots.json");
  await fs.writeFile(screenshotsPath, JSON.stringify({ screenshots: [{ path: "card.png" }] }), "utf8");

  await assert.rejects(
    () => writeProofPackage(context, { packageName: "bad-screenshots", screenshotsPath }),
    /Screenshot entry 0 must include purpose/,
  );
});

test("package CLI writes a manifest with every packaged file", async () => {
  const site = await copyFixtureSite("good-map");
  const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      "package",
      site,
      "--name",
      "cli-proof",
      "--task-list",
      path.join(fixturesRoot, "proof-input", "task-list.json"),
      "--action-log",
      path.join(fixturesRoot, "proof-input", "action-log.json"),
      "--failures",
      path.join(fixturesRoot, "proof-input", "failures-fixes.json"),
      "--screenshots",
      path.join(fixturesRoot, "proof-input", "screenshots.json"),
    ],
    { cwd: path.resolve(".") },
  );
  const report = JSON.parse(stdout);
  const manifest = JSON.parse(await fs.readFile(report.manifest_path, "utf8"));

  assert.equal(manifest.files.length, 8);
  assert(manifest.files.every((file) => file.purpose && file.relative_path));
});

async function copyFixtureSite(name) {
  const source = path.join(fixturesRoot, name);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "actions-proof-site-"));
  await fs.cp(source, target, { recursive: true });
  return target;
}

async function exists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}
