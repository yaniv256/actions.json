import assert from "node:assert/strict";
import test from "node:test";

import { build } from "esbuild";
import { readFile } from "node:fs/promises";

test("the public embed export exposes the reusable host boundary", async () => {
  const runtime = await import("@actions-json/runtime/embed");

  assert.equal(typeof runtime.EmbedHost, "function");
  assert.equal(typeof runtime.PrimitiveRegistry, "function");
  assert.equal(typeof runtime.resolveCatalog, "function");
  assert.equal(runtime.canonicalDictionary.version, 1);
  assert.ok(runtime.canonicalDictionary.primitives.length > 0);
});

test("the public embed export publishes its TypeScript contract", async () => {
  const declarations = await readFile(
    new URL("../src/embed/index.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declarations, /export class EmbedHost/);
  assert.match(declarations, /export class PrimitiveRegistry/);
  assert.match(declarations, /canonicalDictionary/);
});

test("the public embed export bundles for a browser without Node polyfills", async () => {
  const result = await build({
    entryPoints: [new URL("../src/embed/index.mjs", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });

  assert.equal(result.errors.length, 0);
  const output = result.outputFiles[0].text;
  assert.match(output, /EmbedHost/);
  assert.doesNotMatch(output, /node:(?:crypto|fs)/);
});
