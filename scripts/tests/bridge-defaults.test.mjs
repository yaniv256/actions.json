import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const extensionSource = path.join(root, "extensions/chrome-overlay-runtime/src");
const defaultUrl = 'const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";';
const surfaces = [
  "popup.js",
  "sidepanel.js",
  "background.js",
  "agent/hosted-tool-executor.mjs",
];

test("all user-facing extension surfaces default to the local bridge", async () => {
  for (const relativePath of surfaces) {
    const source = await readFile(path.join(extensionSource, relativePath), "utf8");
    assert.ok(source.includes(defaultUrl), `${relativePath} must use the localhost bridge default`);
    assert.doesNotMatch(source, /100\.99\.150\.49/, `${relativePath} must not ship a private host default`);
  }
});
