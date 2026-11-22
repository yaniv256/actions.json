import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/build-macos-native.yml", import.meta.url),
  "utf8",
);

test("macOS release assets build exclusively on GitHub-hosted runners", () => {
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /self-hosted|ssh|scp|MAC_HOST/);
});

test("macOS matrix covers both supported native targets", () => {
  assert.match(workflow, /slug: macos-x64[\s\S]*target: x86_64-apple-darwin/);
  assert.match(workflow, /slug: macos-arm64[\s\S]*target: aarch64-apple-darwin/);
});

test("workflow binds source and package identity to explicit release inputs", () => {
  assert.match(workflow, /ref: \$\{\{ inputs\.commit \|\| github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /inputs\.request_id/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /Cargo\.toml/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /if-no-files-found: error/);
});
