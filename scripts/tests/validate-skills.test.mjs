import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("validator recognizes exactly the public operating and authoring skills", () => {
  const stdout = execFileSync(process.execPath, ["scripts/validate-skills.mjs"], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });
  assert.match(stdout, /skills\/operate-actions-json\/SKILL\.md/);
  assert.match(stdout, /skills\/write-actions-json\/SKILL\.md/);
});
