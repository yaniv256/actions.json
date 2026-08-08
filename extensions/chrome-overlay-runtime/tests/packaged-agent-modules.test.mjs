import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, "..");
const repoRoot = join(extensionRoot, "..", "..");

// scripts/package-extension.sh lists every shipped file EXPLICITLY. A new module
// that background.js imports but the script does not name is not a build error
// and not a test failure — it is a release that loads and then dies at the first
// import, because an MV3 service worker whose module graph fails to resolve goes
// INERT with no visible error.
//
// This guard asserts the PROPERTY (everything imported is packaged) rather than
// a file list, so it keeps working as modules are added. Caught corpus-index,
// corpus-embedding, and corpus-search on 2026-07-27, all three of which would
// have shipped missing.
test("every agent module background.js imports is named in the packaging script", () => {
  const background = readFileSync(join(extensionRoot, "src", "background.js"), "utf8");
  const packager = readFileSync(join(repoRoot, "scripts", "package-extension.sh"), "utf8");

  const imported = new Set();
  for (const match of background.matchAll(/from\s+"\.\/(agent\/[\w.-]+\.mjs)"/g)) {
    imported.add(match[1]);
  }
  assert.ok(
    imported.size > 0,
    "the import scan found nothing — the regex has drifted from background.js's import style, " +
      "which would make this guard silently vacuous",
  );

  const missing = [...imported].filter((path) => !packager.includes(`src/${path}`));
  assert.deepEqual(
    missing,
    [],
    `background.js imports these modules but package-extension.sh does not ship them: ${missing.join(", ")}. ` +
      "The extension would install and then go inert on first import.",
  );
});
