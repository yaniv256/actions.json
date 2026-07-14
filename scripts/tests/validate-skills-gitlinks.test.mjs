import assert from "node:assert/strict";
import test from "node:test";

import { parseGitlinkPaths } from "../lib/gitlinks.mjs";

test("gitlink discovery identifies initialized skill submodules generically", () => {
  const entries = [
    "100644 0123456789abcdef0123456789abcdef01234567 0\tREADME.md",
    "160000 1111111111111111111111111111111111111111 0\tskills/agent-task-os",
    "160000 2222222222222222222222222222222222222222 0\tskills/jsonata-syntax",
    "160000 3333333333333333333333333333333333333333 0\tthird_party/chromevox",
    "",
  ].join("\n");

  assert.deepEqual(parseGitlinkPaths(entries), [
    "skills/agent-task-os",
    "skills/jsonata-syntax",
    "third_party/chromevox",
  ]);
});
