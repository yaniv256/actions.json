import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
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
      // Info-ZIP records parent directories as entries when packaging a tree.
      // Chrome ignores them; the package contract is the exact shipped files.
      .filter((entry) => !entry.endsWith("/"))
      .sort();

    assert.deepEqual(listing, [
      "README.md",
      "actions/overlay.actions.json",
      "agent-surface.html",
      "dist/a11y-bundle.js",
      "dist/protoface-broker-bundle.mjs",
      "dist/protoface-client-bundle.mjs",
      "manifest.json",
      "offscreen.html",
      "popup.html",
      "src/a11y/announcer.js",
      "src/a11y/automation_shim.js",
      "src/a11y/gated-repeat.mjs",
      "src/a11y/live_region_observer.js",
      "src/agent-surface.js",
      "src/agent/agent-event-map.mjs",
      "src/agent/amplitude-envelope.mjs",
      "src/agent/amplitude-runtime-message.mjs",
      "src/agent/background-screenshot-capture.mjs",
      "src/agent/bridge-connection-log.mjs",
      "src/agent/bridge-output-delivery.mjs",
      "src/agent/bridge-pairing-settings.mjs",
      "src/agent/bridge-runtime-verification.mjs",
      "src/agent/cloud-store.mjs",
      "src/agent/corpus-build.mjs",
      "src/agent/corpus-embedding.mjs",
      "src/agent/corpus-index.mjs",
      "src/agent/corpus-search.mjs",
      "src/agent/credential-store.mjs",
      "src/agent/debug-log-presentation.mjs",
      "src/agent/debugger-session-manager.mjs",
      "src/agent/extension-operation-receipts.mjs",
      "src/agent/fake-realtime-transport.mjs",
      "src/agent/file-transfer.mjs",
      "src/agent/hosted-tool-executor.mjs",
      "src/agent/indexeddb-adapter.mjs",
      "src/agent/local-actions-catalog.mjs",
      "src/agent/overlay-settings-store.mjs",
      "src/agent/pill-presentation.mjs",
      "src/agent/popup-presentation.mjs",
      "src/agent/projection-cache-policy.mjs",
      "src/agent/projection-cache-store.mjs",
      "src/agent/projection-embedding-cache.mjs",
      "src/agent/projection-graph-query.mjs",
      "src/agent/projection-graph.mjs",
      "src/agent/projection-semantic-policy.mjs",
      "src/agent/projection-semantic-search.mjs",
      "src/agent/projection-snapshot-store.mjs",
      "src/agent/projection-target-resolution.mjs",
      "src/agent/protoface-avatar-controller.mjs",
      "src/agent/protoface-credential-store.mjs",
      "src/agent/protoface-settings-store.mjs",
      "src/agent/realtime-cost.mjs",
      "src/agent/realtime-model.mjs",
      "src/agent/realtime-session-manager.mjs",
      "src/agent/realtime-tool-catalog.mjs",
      "src/agent/realtime-webrtc-transport.mjs",
      "src/agent/runtime-session-client.mjs",
      "src/agent/session-memory-store.mjs",
      "src/agent/sigv4.mjs",
      "src/agent/site-action-args.mjs",
      "src/agent/state-projections.mjs",
      "src/agent/tab-ownership-authority.mjs",
      "src/agent/task-queue.mjs",
      "src/agent/transfer-buffer.mjs",
      "src/agent/usage-reconciler.mjs",
      "src/agent/vendor/jsonata.mjs",
      "src/agent/vendor/siriwave.mjs",
      "src/agent/voice-icons.mjs",
      "src/agent/voice-settings-store.mjs",
      "src/agent/workflow-actions.mjs",
      "src/background.js",
      "src/content.js",
      "src/delegated-agent/approval-store.mjs",
      "src/delegated-agent/bundle-schema.mjs",
      "src/delegated-agent/delegated-policy.mjs",
      "src/delegated-agent/durable-state-commit-log.mjs",
      "src/delegated-agent/group-store.mjs",
      "src/delegated-agent/home-lease.mjs",
      "src/delegated-agent/page-broker.js",
      "src/offscreen-agent.js",
      "src/options.html",
      "src/options.js",
      "src/popup.js",
      "src/storage-bundle.mjs",
    ]);

    const packagedFiles = new Set(listing);
    const backgroundSource = readFileSync("extensions/chrome-overlay-runtime/src/background.js", "utf8");
    const staticImports = [...backgroundSource.matchAll(/from\s+["'](\.\/[^"']+)["']/g)]
      .map((match) => normalize(join("src", dirname("background.js"), match[1])))
      .map((path) => path.replaceAll("\\", "/"));
    for (const importPath of staticImports) {
      assert.equal(
        packagedFiles.has(importPath),
        true,
        `background service worker import is missing from extension package: ${importPath}`,
      );
    }

    // Every page the manifest references must ship in the package — a missing
    // options_ui/popup/offscreen page makes Chrome reject the whole extension
    // at install time (0.1.146 first-publish incident: options.html absent).
    const packagedManifest = JSON.parse(
      execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" }),
    );
    const referencedPages = [
      packagedManifest.options_ui?.page,
      packagedManifest.action?.default_popup,
      packagedManifest.side_panel?.default_path,
      packagedManifest.background?.service_worker,
    ].filter(Boolean);
    for (const page of referencedPages) {
      assert.equal(
        packagedFiles.has(page),
        true,
        `manifest-referenced page missing from extension package: ${page}`,
      );
    }
    if (packagedManifest.options_ui?.page) {
      const optionsScript = packagedManifest.options_ui.page.replace(/\.html$/, ".js");
      assert.equal(
        packagedFiles.has(optionsScript),
        true,
        `options page script missing from extension package: ${optionsScript}`,
      );
    }

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
