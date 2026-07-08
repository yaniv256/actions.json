import assert from "node:assert/strict";
import test from "node:test";

// Pure gate logic for the accessibility-gated key-repeat primitive
// (docs/plans/2026-07-07-004-feat-accessibility-gated-key-repeat-plan.md, U1-U3).
// The dispatch loop lives in background.js (CDP, source-guarded + live-smoked);
// the CORRECTNESS CORE — stop-mode resolution, per-step regex gate, polarity,
// path advance, R5 halt, budget/partial — is extracted here as a pure module so
// it runs under `node --test` with a fake a11y reader.
import {
  normalizeGatedRepeatArgs,
  evaluateGate,
  runGatedRepeat,
} from "../src/a11y/gated-repeat.mjs";

// ---- arg validation (U1) ----

test("normalizeGatedRepeatArgs: count mode requires a count", () => {
  assert.throws(() => normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "count" }), /count/);
  const ok = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "count", count: 5 });
  assert.equal(ok.stop, "count");
  assert.equal(ok.count, 5);
});

test("normalizeGatedRepeatArgs: rejects missing key and unknown stop mode", () => {
  assert.throws(() => normalizeGatedRepeatArgs({ stop: "count", count: 1 }), /key/);
  assert.throws(() => normalizeGatedRepeatArgs({ key: "x", stop: "sideways" }), /stop/);
});

test("normalizeGatedRepeatArgs: path mode compiles the expect regex list; rejects invalid regex", () => {
  const ok = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "path", expect: ["^a$", "^b$"] });
  assert.equal(ok.expect.length, 2);
  assert.ok(ok.expect[0] instanceof RegExp);
  assert.throws(
    () => normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "path", expect: ["("] }),
    /regex|Invalid|pattern/i,
  );
});

test("normalizeGatedRepeatArgs: until mode takes a single expect regex", () => {
  const ok = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "until", expect: "^done$" });
  assert.equal(ok.expect.length, 1);
});

test("normalizeGatedRepeatArgs: default max_presses is applied and bounded", () => {
  const ok = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "count", count: 3 });
  assert.ok(ok.max_presses >= 3 && Number.isInteger(ok.max_presses));
});

// ---- gate evaluation (U2): regex + polarity ----

test("evaluateGate: positive polarity advances on match", () => {
  assert.equal(evaluateGate("stories", /^stories$/, "match"), true);
  assert.equal(evaluateGate("other", /^stories$/, "match"), false);
});

test("evaluateGate: negative polarity advances on NO match", () => {
  assert.equal(evaluateGate("other", /^regression$/, "no_match"), true);
  assert.equal(evaluateGate("regression", /^regression$/, "no_match"), false);
});

// ---- driven loop (U2/U3) against a fake reader + fake presser ----

// helper: a fake surface that emits a scripted sequence of a11y values, one per press.
function fakeSurface(sequence) {
  let i = -1;
  const presses = [];
  return {
    press: async (key, mods) => { presses.push({ key, mods }); i += 1; },
    read: async () => (i >= 0 && i < sequence.length ? sequence[i] : ""),
    presses,
  };
}

test("runGatedRepeat count mode: presses exactly N, no gating", async () => {
  const s = fakeSurface([]);
  const args = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "count", count: 5 });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, true);
  assert.equal(r.steps_done, 5);
  assert.equal(s.presses.length, 5);
});

test("runGatedRepeat count 0 is a no-op", async () => {
  const s = fakeSurface([]);
  const args = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "count", count: 0 });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.steps_done, 0);
  assert.equal(s.presses.length, 0);
});

test("runGatedRepeat path mode: advances through the expected word sequence", async () => {
  const s = fakeSurface(["other", "stories", "flatter"]);
  const args = normalizeGatedRepeatArgs({
    key: "ArrowRight", stop: "path", expect: ["^other$", "^stories$", "^flatter$"],
  });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, true);
  assert.equal(r.steps_done, 3);
  assert.equal(s.presses.length, 3);
});

test("runGatedRepeat path mode: repeated word disambiguated by POSITION", async () => {
  // "All real. All rare." — two 'All' at different steps; each is its own step.
  const s = fakeSurface(["All", "real.", "All", "rare."]);
  const args = normalizeGatedRepeatArgs({
    key: "ArrowRight", stop: "path", expect: ["^All$", "^real\\.$", "^All$", "^rare\\.$"],
  });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, true);
  assert.equal(r.steps_done, 4);
});

test("runGatedRepeat until mode: stops on the first match", async () => {
  const s = fakeSurface(["other", "stories", "flatter", "regression"]);
  const args = normalizeGatedRepeatArgs({ key: "ArrowRight", stop: "until", expect: "^regression$" });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, true);
  assert.equal(r.steps_done, 4); // pressed 4 times to reach 'regression'
  assert.match(r.final_a11y, /regression/);
});

test("runGatedRepeat: HALTS LOUD on a gate mismatch (R5)", async () => {
  const s = fakeSurface(["other", "WRONG", "flatter"]);
  const args = normalizeGatedRepeatArgs({
    key: "ArrowRight", stop: "path", expect: ["^other$", "^stories$", "^flatter$"],
  });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, false);
  assert.equal(r.halted, true);
  assert.equal(r.steps_done, 1); // 'other' matched (step 1), step 2 mismatched
  assert.equal(r.expected, "^stories$");
  assert.equal(r.actual, "WRONG");
  assert.equal(s.presses.length, 2); // pressed for step 1 and step 2, then stopped
});

test("runGatedRepeat: empty a11y read on a step halts by default (OQ2 default)", async () => {
  const s = fakeSurface(["other", ""]);
  const args = normalizeGatedRepeatArgs({
    key: "ArrowRight", stop: "path", expect: ["^other$", "^stories$"],
  });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, false);
  assert.equal(r.halted, true);
});

// ---- budget / partial (U3) ----

test("runGatedRepeat: returns clean PARTIAL at max_presses, not an error", async () => {
  // path longer than the cap
  const seq = Array.from({ length: 10 }, (_, i) => `w${i}`);
  const s = fakeSurface(seq);
  const args = normalizeGatedRepeatArgs({
    key: "ArrowRight", stop: "path", expect: seq.map((w) => `^${w}$`), max_presses: 4,
  });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, true);
  assert.equal(r.stop, "partial");
  assert.equal(r.steps_done, 4);
  assert.equal(r.reason, "max_presses");
});

test("runGatedRepeat: exact-fit path completes as success, not partial", async () => {
  const seq = ["a", "b", "c"];
  const s = fakeSurface(seq);
  const args = normalizeGatedRepeatArgs({
    key: "ArrowRight", stop: "path", expect: seq.map((w) => `^${w}$`), max_presses: 3,
  });
  const r = await runGatedRepeat(args, s);
  assert.equal(r.ok, true);
  assert.notEqual(r.stop, "partial");
  assert.equal(r.steps_done, 3);
});
