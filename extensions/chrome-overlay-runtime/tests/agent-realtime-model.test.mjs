import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEFAULT_MODEL } from "../src/agent/realtime-model.mjs";
import { DEFAULT_MODEL as MANAGER_DEFAULT_MODEL } from "../src/agent/realtime-session-manager.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const HOME = "agent/realtime-model.mjs";

// Every file that names the model is a file that can DISAGREE with it. Before this
// guard existed, six did: the session manager (which sends it to OpenAI) and five
// placeholder-state objects in popup.js / background.js / runtime-session-client.mjs
// that the UI shows before a session connects. Nothing related them.
//
// Proven 2026-07-09 by known-answer test: rewriting DEFAULT_MODEL to "ZZZ-drift-probe"
// — i.e. breaking the model actually sent to OpenAI — left the node suite at its exact
// baseline (371 pass / 4 fail). The only test that read the constant imported it and
// asserted against itself, which proves propagation but is a tautology for the value.
//
// So this guard asserts a PROPERTY, not a list. Enumerating the five known files would
// pass forever while a sixth drifted in. The rule is: the literal lives in exactly one
// place. That catches the file nobody has written yet.

const MODEL_LITERAL = /["'`]gpt-realtime-[\w.-]+["'`]/;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(mjs|js)$/.test(entry.name)) yield full;
  }
}

test("the model literal is written in exactly one source file", () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (rel === HOME) continue;
    const source = readFileSync(file, "utf8");
    source.split("\n").forEach((line, i) => {
      // A comment may name a model (e.g. explaining the 2 -> 2.1 bump) without being
      // a source of truth. Only executable occurrences can drift out of agreement.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (MODEL_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `the model id must be imported from src/${HOME}, never re-typed — each of these can silently ` +
      `disagree with DEFAULT_MODEL and announce a model the session does not use:\n  ${offenders.join("\n  ")}`,
  );
});

test("the session manager re-exports the same constant it sends to OpenAI", () => {
  // realtime-session-manager.mjs re-exports DEFAULT_MODEL for its existing importers.
  // If that re-export is ever replaced by a fresh literal, the guard above catches the
  // literal — but this catches a re-export wired to the wrong symbol, which is invisible
  // to a grep.
  assert.equal(MANAGER_DEFAULT_MODEL, DEFAULT_MODEL);
});

test("the model id is a real gpt-realtime identifier", () => {
  // Cheap tripwire against a placeholder or debug value reaching a release — the exact
  // failure mode the known-answer probe above simulated.
  assert.match(DEFAULT_MODEL, /^gpt-realtime-\d+(\.\d+)?(-mini)?$/);
});
