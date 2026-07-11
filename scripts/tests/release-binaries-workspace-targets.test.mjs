import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(
  new URL("../release-binaries.sh", import.meta.url),
  "utf8",
);

test("release builds and packages from explicit workspace target directories", () => {
  assert.match(script, /local target_dir="\$repo_root\/mcp\/target"/);
  assert.match(script, /--target-dir "\$target_dir"/);
  assert.ok(
    script.includes("--target-dir '$WIN_REPO_WIN\\\\mcp\\\\target'"),
    "Windows Cargo builds must share the explicit workspace target directory",
  );
  assert.match(script, /remote="\$MAC_REPO\/mcp\/target\/\$target\/release\/actions-json-mcp"/);

  assert.doesNotMatch(
    script,
    /mcp\/actions-json-mcp\/target\/release\/actions-json-mcp/,
  );
  assert.doesNotMatch(
    script,
    /mcp\/chrome-launcher-helper\/target\/release\/chrome-launcher-helper/,
  );
});

test("release verification cannot inherit same-version artifacts from a prior run", () => {
  assert.match(
    script,
    /rm -f "\$dist\/actions-json-overlay-runtime-\$\{version\}\.zip"/,
  );
  assert.match(
    script,
    /"\$dist"\/actions-json-mcp-"\$version"-\*\.tar\.gz/,
  );
  assert.match(
    script,
    /"\$dist"\/chrome-launcher-helper-"\$version"-\*\.tar\.gz/,
  );
});

test("quiet successful Windows commands are not converted into failures by log filtering", () => {
  assert.match(script, /local output status/);
  assert.match(script, /status=\$\?/);
  assert.match(script, /grep -ivE [^\n]+ \|\| true/);
  assert.match(script, /return "\$status"/);
  assert.match(script, /exit \\\$LASTEXITCODE/);
});
