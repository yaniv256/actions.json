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
      "popup.html",
      "src/background.js",
      "src/content.js",
      "src/popup.js",
    ]);

    const sums = execFileSync("cat", [sumsPath], { encoding: "utf8" });
    assert.match(sums, /actions-json-overlay-runtime-test\.zip/);
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
