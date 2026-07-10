import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// `scripts/package-extension.sh` zips an EXPLICIT, hand-maintained list of files. Nothing checked
// that the list is complete, so adding a runtime module and forgetting the list ships a zip whose
// module graph cannot instantiate.
//
// That failure is silent and total: a static import of a file Chrome cannot find makes the MV3
// service worker REGISTER, run ZERO statements of its module body, and log NOTHING — no
// `Runtime.exceptionThrown`, no entry on chrome://extensions. The extension is simply inert.
//
// docs/development-cycle.md's release gate names this in step 4 ("New runtime FILES added to the
// change -> add them to the explicit list in scripts/package-extension.sh or the zip ships
// broken"). It is a rule you can read and then not do. So: check it.
//
// Found 2026-07-09: src/agent/realtime-model.mjs (added in fec9f4d to centralize DEFAULT_MODEL)
// was imported by src/background.js and absent from the zip list. 0.1.189 would have shipped
// with a background worker that never initializes.

const REPO = path.resolve(import.meta.dirname, "../..");
const EXT = path.join(REPO, "extensions/chrome-overlay-runtime");

// Everything Chrome loads as a module graph root. manifest.json's service_worker, plus each
// `<script type="module">` an extension page pulls in.
const ENTRY_POINTS = [
  "src/background.js",
  "src/content.js",
  "src/offscreen-agent.js",
  "src/popup.js",
  "src/sidepanel.js",
];

function zippedFiles() {
  const sh = readFileSync(path.join(REPO, "scripts/package-extension.sh"), "utf8");
  // the `zip -q -r "$out" \` block lists one path per line, four-space indented, backslash-continued
  return new Set([...sh.matchAll(/^ {4}([\w./-]+\.(?:js|mjs|json|html|md))\s*\\?$/gm)].map((m) => m[1]));
}

// Resolve the transitive closure of RELATIVE static imports. A bare specifier would be a bug of a
// different kind (extensions have no node_modules), and there are none today.
function reachableModules(entries) {
  const seen = new Set();
  const missingOnDisk = [];
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const abs = path.join(EXT, rel);
    if (!existsSync(abs)) {
      missingOnDisk.push(rel);
      return;
    }
    const source = readFileSync(abs, "utf8");
    for (const [, spec] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      if (!spec.startsWith(".")) continue;
      walk(path.relative(EXT, path.resolve(path.dirname(abs), spec)));
    }
  };
  for (const entry of entries) walk(entry);
  return { seen, missingOnDisk };
}

test("every module reachable from an extension entry point is in the packaging file list", () => {
  const zipped = zippedFiles();
  assert.ok(zipped.size > 20, `parsed only ${zipped.size} files from package-extension.sh — the regex is wrong, not the script`);

  const { seen, missingOnDisk } = reachableModules(ENTRY_POINTS);
  assert.deepEqual(missingOnDisk, [], `these are imported but do not exist on disk:\n  ${missingOnDisk.join("\n  ")}`);

  const missing = [...seen].filter((f) => !zipped.has(f)).sort();
  assert.deepEqual(
    missing,
    [],
    "these modules are imported by the extension but NOT zipped — the packaged worker's module " +
      "graph will fail to instantiate, silently, with no exception and no log:\n  " + missing.join("\n  "),
  );
});

// The entry points themselves must ship, and so must the non-module assets the manifest names.
test("the manifest's service worker and every entry point are in the packaging file list", () => {
  const zipped = zippedFiles();
  const manifest = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const required = [manifest.background?.service_worker, ...ENTRY_POINTS].filter(Boolean);
  const missing = required.filter((f) => !zipped.has(f));
  assert.deepEqual(missing, [], `not zipped: ${missing.join(", ")}`);
});

// `node --check` validates SCRIPT syntax. Every extension entry point is loaded as an ES MODULE
// (manifest `"type": "module"`, `<script type="module">`), and module-only early errors — `await`
// in a non-async function, a duplicate top-level binding, a bad export — are invisible to it.
//
// A module that fails to LINK does not throw. Chrome registers the service worker, evaluates ZERO
// statements of its body, registers no listeners, and reports nothing: no `Runtime.exceptionThrown`,
// no entry on chrome://extensions. The extension is inert and silent.
//
// Found 2026-07-09 after eleven refuted hypotheses: 8cb0a831 put `await` inside
// `attachRuntimeToOpenBridge`, a non-async arrow. `node --check` passed. Every unit test passed
// (they import background.js's leaf modules, never background.js). The extension had been broken on
// main for eight commits, and #188's live gate had been red the whole time.
test("every extension entry point parses as an ES module, not just as a script", async () => {
  const { parse } = await import("acorn");
  const broken = [];
  for (const entry of ENTRY_POINTS) {
    const source = readFileSync(path.join(EXT, entry), "utf8");
    try {
      parse(source, { ecmaVersion: 2022, sourceType: "module" });
    } catch (error) {
      broken.push(`${entry}: ${error.message}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    "these fail to parse as ES modules — Chrome will register the worker and never evaluate it, " +
      "silently, with no exception and no log:\n  " + broken.join("\n  "),
  );
});
