import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("package-extension creates a Chrome-loadable zip and checksum", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "actions-json-extension-package-"));

  try {
    execFileSync("bash", ["scripts/package-extension.sh", "--version", "test", "--out-dir", outputDir], {
      stdio: "pipe",
    });

    const zipPath = join(outputDir, "actions-json-overlay-runtime-test.zip");
    const sumsPath = join(outputDir, "SHA256SUMS.txt");
    const listing = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();

    assert.deepEqual(listing, [
      "README.md",
      "actions/overlay.actions.json",
      "manifest.json",
      "offscreen.html",
      "popup.html",
      "sidepanel.html",
      "src/agent/credential-store.mjs",
      "src/agent/fake-realtime-transport.mjs",
      "src/agent/hosted-tool-executor.mjs",
      "src/agent/local-actions-catalog.mjs",
      "src/agent/realtime-session-manager.mjs",
      "src/agent/realtime-tool-catalog.mjs",
      "src/agent/realtime-webrtc-transport.mjs",
      "src/agent/runtime-session-client.mjs",
      "src/agent/session-memory-store.mjs",
      "src/agent/voice-settings-store.mjs",
      "src/background.js",
      "src/content.js",
      "src/offscreen-agent.js",
      "src/popup.js",
      "src/sidepanel.js",
      "src/storage-bundle.mjs",
    ]);

    const sums = execFileSync("cat", [sumsPath], { encoding: "utf8" });
    assert.match(sums, /actions-json-overlay-runtime-test\.zip/);

    const actionsManifest = JSON.parse(
      execFileSync("unzip", ["-p", zipPath, "actions/overlay.actions.json"], { encoding: "utf8" }),
    );
    const sessionLogTool = actionsManifest.tools.find((tool) => tool.name === "runtime.session.log");
    assert.equal(sessionLogTool.input_schema.properties.limit.maximum, 2000);
    assert.equal(sessionLogTool.input_schema.properties.limit.default, 2000);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("package-extension supports a repo-relative output directory", () => {
  const outputDir = "dist-test-package";

  try {
    execFileSync("bash", ["scripts/package-extension.sh", "--version", "relative", "--out-dir", outputDir], {
      stdio: "pipe",
    });

    assert.equal(existsSync(join(outputDir, "actions-json-overlay-runtime-relative.zip")), true);
    assert.equal(existsSync(join(outputDir, "SHA256SUMS.txt")), true);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
