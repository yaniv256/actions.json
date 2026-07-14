import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);

const helperMatch = contentSource.match(
  /const waitForEditableHandlers = \(\) => new Promise\(\(resolve\) => \{[\s\S]*?\n  \}\);/,
);
assert.ok(helperMatch, "waitForEditableHandlers must be declared");

const loadHelper = (requestAnimationFrame) => {
  const source = helperMatch[0].replace(
    "const waitForEditableHandlers = ",
    "globalThis.__waitForEditableHandlers = ",
  );
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = requestAnimationFrame;
  (0, eval)(source);
  const helper = globalThis.__waitForEditableHandlers;
  delete globalThis.__waitForEditableHandlers;
  return {
    helper,
    restore() {
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
    },
  };
};

test("editable-handler settling remains live when animation frames are paused", async () => {
  const { helper: waitForEditableHandlers, restore } = loadHelper(() => 1);
  let outcome;
  try {
    outcome = await Promise.race([
      waitForEditableHandlers().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
  } finally {
    restore();
  }

  assert.equal(
    outcome,
    "settled",
    "a non-visual automation primitive must not depend indefinitely on a paint callback",
  );
});
