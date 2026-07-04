import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { writeProofPackage } from "../src/proof-package.mjs";
import { writeReviewBundle } from "../src/review-bundle.mjs";
import { loadPipelineTarget } from "../src/storage-loader.mjs";

const execFileAsync = promisify(execFile);
const fixturesRoot = path.resolve("tools/actions-json-pipeline/fixtures");

test("review bundle manifest lists candidate files and proof evidence", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const proof = await writeProofPackage(context, { packageName: "proof-for-review" });
  const review = await writeReviewBundle(context, {
    bundleName: "review-test",
    proofPackagePath: proof.package_dir,
    redactionStatus: "complete",
    attributionStatus: "complete",
  });

  assert.deepEqual(
    review.manifest.candidate_files.map((file) => file.kind).sort(),
    ["map", "skill"],
  );
  assert.equal(review.manifest.proof.manifest_path, proof.manifest_path);
  assert(review.manifest.proof.files.some((file) => file.relative_path === "score-report.json"));
});

test("review bundle records redaction and attribution status when incomplete", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const review = await writeReviewBundle(context, {
    bundleName: "draft-review",
    draft: true,
  });

  assert.equal(review.manifest.redaction.status, "incomplete");
  assert.equal(review.manifest.attribution.status, "incomplete");
  assert.equal(review.manifest.draft, true);
});

test("promotion prep does not write to shared or public storage paths", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const proof = await writeProofPackage(context, { packageName: "proof-boundary" });
  const review = await writeReviewBundle(context, {
    bundleName: "boundary-review",
    proofPackagePath: proof.package_dir,
  });

  assert.equal(review.bundle_dir.startsWith(path.join(site, "review")), true);
  assert.deepEqual(review.manifest.blocked_writes, ["scopes/shared", "scopes/public"]);
  assert.equal(review.manifest.approval_boundary.includes("no shared or public storage writes"), true);
});

test("missing proof package blocks review bundle creation unless draft is explicit", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);

  await assert.rejects(() => writeReviewBundle(context, { bundleName: "blocked" }), /requires --proof/);
  const draft = await writeReviewBundle(context, { bundleName: "allowed-draft", draft: true });
  assert.equal(draft.manifest.proof, null);
});

test("promotion-prep CLI writes a review manifest", async () => {
  const site = await copyFixtureSite("good-map");
  const context = await loadPipelineTarget(site);
  const proof = await writeProofPackage(context, { packageName: "cli-proof" });
  const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      "promotion-prep",
      site,
      "--name",
      "cli-review",
      "--proof",
      proof.package_dir,
      "--redaction-status",
      "incomplete",
      "--attribution-status",
      "complete",
    ],
    { cwd: path.resolve(".") },
  );
  const report = JSON.parse(stdout);
  const manifest = JSON.parse(await fs.readFile(report.manifest_path, "utf8"));

  assert.equal(manifest.attribution.status, "complete");
  assert.equal(manifest.redaction.status, "incomplete");
  assert.equal(manifest.proof.manifest_path, proof.manifest_path);
});

async function copyFixtureSite(name) {
  const source = path.join(fixturesRoot, name);
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "actions-review-site-"));
  await fs.cp(source, target, { recursive: true });
  return target;
}
