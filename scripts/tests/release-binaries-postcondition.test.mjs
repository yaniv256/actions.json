import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// REGRESSION GUARD (found 2026-07-09 while prepping the 0.1.188 public release).
//
// `release-binaries.sh --version 0.1.188 --no-upload` produced only THREE of four
// tarballs — win-x64 was missing — and still EXITED 0, printing "built artifacts"
// as if all was well. Two defects:
//
//  1. SILENT FAILURE. The dispatch loop calls `collect < <(build_windows)`. A
//     process substitution's exit status is NOT propagated to the parent, so
//     `set -euo pipefail` cannot see it. build_windows died (its Windows-side
//     `git checkout <tag>` failed) and the failure was silently discarded.
//  2. NO POSTCONDITION. Nothing asserted that each REQUESTED platform actually
//     produced its tarball — "the loop ran" was treated as "the artifacts exist".
//
// Shipping that would have released WITHOUT the Windows bridge binary — the
// platform the browser host runs on; npx users on Windows would 404 on the pin.
//
// The durable fix is the postcondition: after building, assert every requested
// platform has a non-empty tarball, and fail loud naming what is missing. These
// tests guard that the script keeps that contract (source-level, matching the
// repo's existing source-inspection guard style).

const source = await readFile(
  new URL("../release-binaries.sh", import.meta.url),
  "utf8",
);

test("release-binaries.sh verifies every requested platform produced a tarball", () => {
  assert.match(
    source,
    /verify_artifacts|missing=\(\)/,
    "the script must contain a postcondition that checks each requested platform's tarball exists",
  );
});

test("the postcondition fails loud (non-zero exit) when a tarball is missing", () => {
  // Slice the whole verify_artifacts() body (declaration to its closing brace at
  // column 0) rather than a fixed byte window — a fixed window silently breaks
  // when the error message grows, which is exactly the brittleness that let the
  // original silent-failure hide.
  const start = source.indexOf("verify_artifacts() {");
  assert.ok(start >= 0, "expected a verify_artifacts() function");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "expected verify_artifacts() to be closed");
  const body = source.slice(start, end);
  assert.match(
    body,
    /\bexit\s+1\b/,
    "a missing platform tarball must abort the release with a non-zero exit, never a silent success",
  );
});

test("the postcondition runs BEFORE any upload", () => {
  const verifyIdx = source.indexOf("verify_artifacts");
  const uploadIdx = source.indexOf("gh release upload");
  assert.ok(verifyIdx >= 0 && uploadIdx >= 0, "expected both a verify step and an upload step");
  assert.ok(
    verifyIdx < uploadIdx,
    "artifacts must be verified before uploading — otherwise a partial release is published",
  );
});

test("platform build failures propagate without process substitution", () => {
  const idx = source.indexOf("collect_build()");
  assert.ok(idx >= 0, "expected the collect_build() helper");
  const dispatch = source.slice(source.indexOf("for p in \"${wanted[@]}\"; do\n  case"), source.indexOf("log \"built artifacts\""));
  assert.doesNotMatch(dispatch, /collect < <\(/);
  assert.match(source, /if "\$@" >"\$output_file"; then status=0; else status=\$\?; fi/);
  assert.match(source, /return "\$status"/);
});

test("publication stages a draft and only publishes after exact remote byte verification", () => {
  const create = source.indexOf('gh release create "$tag"');
  const upload = source.indexOf('gh release upload "$tag"');
  const compare = source.indexOf('cmp --silent');
  const publish = source.indexOf('gh release edit "$tag"');
  assert.ok(create >= 0 && upload > create && compare > upload && publish > compare);
  assert.match(source.slice(create, upload), /--draft/);
  assert.match(source.slice(compare, publish), /release tag moved during staging/);
});

test("a complete release cannot opt out of the extension or any native platform", () => {
  assert.match(source, /complete releases require the extension and all four native platforms/);
  assert.match(source, /wanted=\(linux-x64 win-x64 macos-arm64 macos-x64\)/);
  assert.match(source, /--no-extension\).*complete releases require/);
});

test("publication requires the remote tag to resolve to exact local HEAD", () => {
  assert.match(source, /remote_tag_commit=.*repos\/\$\{repo\}\/commits\/\$\{tag\}/);
  assert.match(source, /remote_tag_commit.*release_commit/);
});

test("macOS builds use an exact-commit GitHub-hosted workflow and verify downloaded archives", () => {
  const start = source.indexOf("build_macos_on_github() {");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  assert.match(body, /git[^\n]+rev-parse HEAD/);
  assert.match(body, /workflow_dispatch/);
  assert.match(body, /head_sha/);
  assert.match(body, /gh run watch/);
  assert.match(body, /gh run download/);
  assert.match(body, /tar -xOf[^\n]+VERSION/);
  assert.doesNotMatch(body, /ssh|scp|MAC_HOST|MAC_REPO/);
});

test("Windows source transfer is credential-independent and exact-commit", () => {
  const start = source.indexOf("windows_prepare() {");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  assert.match(body, /git[^\n]+archive/);
  assert.match(body, /release-commit/);
  assert.doesNotMatch(body, /git clone|git fetch|gh auth token/);
});

test("Windows PowerShell output uses a Windows-backed file and every build step fails closed", () => {
  const winPsStart = source.indexOf("win_ps() {");
  const winPsEnd = source.indexOf("\n}\n", winPsStart);
  const winPs = source.slice(winPsStart, winPsEnd);
  assert.match(winPs, /mktemp "\$WIN_BUILD_ROOT_WSL\/powershell-output-/);
  assert.match(winPs, /"\$PWSH" -NoProfile -NonInteractive -Command/);
  assert.match(winPs, /cd "\$WIN_BUILD_ROOT_WSL" && "\$PWSH"/);

  const buildStart = source.indexOf("build_windows() {");
  const buildEnd = source.indexOf("\n}\n", buildStart);
  const build = source.slice(buildStart, buildEnd);
  assert.equal((build.match(/win_ps /g) ?? []).length, 3);
  assert.equal((build.match(/\|\| return 1/g) ?? []).length, 5);
});

test("temporary native build trees are removed through validated exact paths", () => {
  const start = source.indexOf("cleanup_release_workspace() {");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  assert.match(body, /WIN_REPO_WSL.*WIN_BUILD_ROOT_WSL/);
});
