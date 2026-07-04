import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadPipelineTarget } from "../src/storage-loader.mjs";

const execFileAsync = promisify(execFile);

test("loads a direct actions.json path and identifies the containing site folder", async () => {
  const root = await makeFixtureSite({
    files: [{ path: "SKILL.md", content: "# Skill\n" }],
  });

  const context = await loadPipelineTarget(path.join(root, "actions.json"));

  assert.equal(context.siteFolder, root);
  assert.equal(context.map.name, "fixture.actions");
  assert.equal(context.declaredFiles.length, 1);
  assert.equal(context.declaredFiles[0].path, path.join(root, "SKILL.md"));
  assert.equal(context.declaredFiles[0].exists, true);
});

test("loads a site folder and finds its primary map", async () => {
  const root = await makeFixtureSite();

  const context = await loadPipelineTarget(root);

  assert.equal(context.mapPath, path.join(root, "actions.json"));
  assert.equal(context.siteFolder, root);
});

test("normalizes declared sibling files without allowing path traversal", async () => {
  const root = await makeFixtureSite({
    declarations: [{ path: "../secret.md", kind: "reference" }],
  });

  await assert.rejects(
    () => loadPipelineTarget(path.join(root, "actions.json")),
    /Unsafe declared file path: \.\.\/secret\.md/,
  );
});

test("returns clear errors for missing maps and invalid JSON", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "actions-pipeline-"));
  await assert.rejects(() => loadPipelineTarget(root), /No actions\.json map found/);

  const invalid = path.join(root, "actions.json");
  await fs.writeFile(invalid, "{not json", "utf8");
  await assert.rejects(() => loadPipelineTarget(invalid), /Invalid JSON/);
});

test("CLI routes audit, score, and package handlers", async () => {
  const root = await makeFixtureSite();
  const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");

  const auditResult = await execFileAsync(process.execPath, [cli, "audit", root], {
    cwd: path.resolve("."),
  });
  const audit = JSON.parse(auditResult.stdout);
  assert.equal(audit.ok, true);
  assert.equal(audit.map_path, path.join(root, "actions.json"));
  assert.deepEqual(audit.findings, [
    {
      status: "open",
      id: "missing-file:SKILL.md",
      code: "missing_declared_file",
      severity: "high",
      action: null,
      context: "x_actions.files",
      evidence: {
        path: path.join(root, "SKILL.md"),
        relative_path: "SKILL.md",
        kind: "skill",
      },
      message: "Declared skill file is missing: SKILL.md.",
      recommendation: "Create the declared file or remove the declaration from x_actions.files.",
    },
  ]);

  const scoreResult = await execFileAsync(process.execPath, [cli, "score", root], {
    cwd: path.resolve("."),
  });
  const score = JSON.parse(scoreResult.stdout);
  assert.equal(score.ok, true);
  assert.equal(score.map_path, path.join(root, "actions.json"));
  assert.equal(score.mechanical.score, 88);

  const { stdout } = await execFileAsync(process.execPath, [cli, "package", root], {
    cwd: path.resolve("."),
  });
  const output = JSON.parse(stdout);
  assert.equal(output.ok, true);
  assert.equal(output.manifest.map_path, path.join(root, "actions.json"));
  assert.equal(output.manifest.files.some((file) => file.relative_path === "manifest.json"), true);
});

async function makeFixtureSite({ declarations = null, files = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "actions-pipeline-"));
  const map = {
    protocol: "actions.json",
    name: "fixture.actions",
    x_actions: {
      files: declarations ?? [{ path: "SKILL.md", kind: "skill" }],
    },
    tools: [
      {
        name: "fixture.echo",
        description: "Echo fixture input.",
        input_schema: { type: "object" },
        x_actions: { static_output: { ok: true } },
      },
    ],
  };
  await fs.writeFile(path.join(root, "actions.json"), JSON.stringify(map, null, 2), "utf8");
  for (const file of files) {
    const filePath = path.join(root, file.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.content, "utf8");
  }
  return root;
}
