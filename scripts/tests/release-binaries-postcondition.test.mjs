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

test("platform build failures propagate out of the process substitution", () => {
  // `collect < <(build_x)` hides build_x's exit status. The script must either
  // avoid that pattern or explicitly record/propagate the failure.
  const idx = source.indexOf("collect()");
  assert.ok(idx >= 0, "expected the collect() helper");
  const dispatch = source.slice(source.indexOf("for p in \"${wanted[@]}\"; do\n  case"), source.indexOf("log \"built artifacts\""));
  assert.ok(
    /build_failed|PIPESTATUS|\$\?|set -e/.test(dispatch) || /verify_artifacts/.test(source),
    "a failing platform build must not be silently swallowed by the process substitution — either propagate it or catch it in the postcondition",
  );
});
