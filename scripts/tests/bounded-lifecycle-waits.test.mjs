import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { findUnboundedAnimationFrameWaits } from "../check-bounded-lifecycle-waits.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");

test("release guard rejects a paint callback used as an unbounded async barrier", () => {
  const findings = findUnboundedAnimationFrameWaits(new Map([
    ["unsafe.js", `const settle = () => new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });`],
  ]));
  assert.deepEqual(findings.map(({ file }) => file), ["unsafe.js"]);
});

test("release guard accepts an animation-frame callback with a competing timer", () => {
  const findings = findUnboundedAnimationFrameWaits(new Map([
    ["bounded.js", `const settle = () => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(finish);
      setTimeout(finish, 50);
    });`],
  ]));
  assert.deepEqual(findings, []);
});

test("all production extension and browser-runtime frame waits have a bounded competitor", async () => {
  const files = [
    "extensions/chrome-overlay-runtime/src/content.js",
    "extensions/chrome-overlay-runtime/src/background.js",
    "runtime/actions-json-runtime/bookmarklet/storage-bookmarklet.js",
  ];
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(path.join(REPO, file), "utf8"),
  ])));
  assert.deepEqual(findUnboundedAnimationFrameWaits(sources), []);
});
