import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../bookmarklet/storage-bookmarklet.js", import.meta.url),
  "utf8",
);
const match = source.match(
  /function waitForEditableHandlers\(\) \{[\s\S]*?\n  \}/,
);
assert.ok(match, "bookmarklet waitForEditableHandlers must be declared");

test("bookmarklet editable settling remains live when animation frames are paused", async () => {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  let outcome;
  try {
    (0, eval)(`${match[0]}; globalThis.__bookmarkletWait = waitForEditableHandlers;`);
    outcome = await Promise.race([
      globalThis.__bookmarkletWait().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
  } finally {
    delete globalThis.__bookmarkletWait;
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
  }
  assert.equal(outcome, "settled");
});
