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

test("screenshot entries require surface identity and a freshness classification", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-proof-"));
  const screenshotsPath = path.join(temp, "screenshots.json");
  await fs.writeFile(
    screenshotsPath,
    JSON.stringify({
      screenshots: [{
        path: "card.png",
        purpose: "Visible card",
        source: "browser.screenshot",
        captured_at: "2026-07-12T10:00:00Z",
      }],
    }),
    "utf8",
  );

  await assert.rejects(
    () => writeProofPackage(context, { packageName: "missing-identity", screenshotsPath }),
    /surface_identity/,
  );
});

test("unverified screenshots are accepted only as positive-only evidence", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-proof-"));
  const screenshotsPath = path.join(temp, "screenshots.json");
  const base = {
    path: "card.png",
    purpose: "Visible card",
    source: "browser.screenshot",
    captured_at: "2026-07-12T10:00:00Z",
    surface_identity: {
      kind: "url",
      value: "https://trello.com/c/example",
      method: "verified active tab",
    },
    freshness: { status: "unverified" },
  };
  await fs.writeFile(
    screenshotsPath,
    JSON.stringify({ screenshots: [{ ...base, evidence_policy: "bidirectional" }] }),
    "utf8",
  );
  await assert.rejects(
    () => writeProofPackage(context, { packageName: "unsafe-negative-proof", screenshotsPath }),
    /positive_only/,
  );

  await fs.writeFile(
    screenshotsPath,
    JSON.stringify({ screenshots: [{ ...base, evidence_policy: "positive_only" }] }),
    "utf8",
  );
  const report = await writeProofPackage(context, {
    packageName: "positive-only-proof",
    screenshotsPath,
  });
  const manifest = JSON.parse(
    await fs.readFile(path.join(report.package_dir, "screenshots.json"), "utf8"),
  );
  assert.equal(manifest.screenshots[0].freshness.status, "unverified");
  assert.equal(manifest.screenshots[0].evidence_policy, "positive_only");
});

test("bidirectional screenshot evidence requires independent freshness proof", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-proof-"));
  const screenshotsPath = path.join(temp, "screenshots.json");
  await fs.writeFile(
    screenshotsPath,
    JSON.stringify({
      screenshots: [{
        path: "card.png",
        purpose: "Visible card",
        source: "browser.screenshot",
        captured_at: "2026-07-12T10:00:00Z",
        surface_identity: {
          kind: "url",
          value: "https://trello.com/c/example",
          method: "verified active tab",
        },
        freshness: {
          status: "independently_verified",
          method: "pixel sentinel changed after semantic state transition",
          evidence: "action-log.json#call-42",
          verified_at: "2026-07-12T10:00:01Z",
        },
        evidence_policy: "bidirectional",
      }],
    }),
    "utf8",
  );
  const report = await writeProofPackage(context, {
    packageName: "fresh-proof",
    screenshotsPath,
  });
  const manifest = JSON.parse(
    await fs.readFile(path.join(report.package_dir, "screenshots.json"), "utf8"),
  );
  assert.equal(
    manifest.screenshots[0].freshness.status,
    "independently_verified",
  );
});

test("a capture timestamp cannot serve as independent freshness evidence", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "actions-proof-"));
  const screenshotsPath = path.join(temp, "screenshots.json");
  const capturedAt = "2026-07-12T10:00:00Z";
  await fs.writeFile(
    screenshotsPath,
    JSON.stringify({
      screenshots: [{
        path: "card.png",
        purpose: "Visible card",
        source: "browser.screenshot",
        captured_at: capturedAt,
        surface_identity: {
          kind: "url",
          value: "https://trello.com/c/example",
          method: "verified active tab",
        },
        freshness: {
          status: "independently_verified",
          method: "timestamp comparison",
          evidence: capturedAt,
          verified_at: "2026-07-12T10:00:01Z",
        },
        evidence_policy: "bidirectional",
      }],
    }),
    "utf8",
  );

  await assert.rejects(
    () => writeProofPackage(context, { packageName: "self-certified-freshness", screenshotsPath }),
    /independent of captured_at/,
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
