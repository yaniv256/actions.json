// Pure control logic for the accessibility-gated key-repeat primitive.
// (docs/plans/2026-07-07-004-feat-accessibility-gated-key-repeat-plan.md)
//
// The DISPATCH (real CDP keypress) and the real a11y READ live in background.js;
// this module owns only the surface-agnostic decision logic — arg normalization,
// per-step regex gate + polarity, stop-mode advance, R5 halt, and budget/partial —
// so it is unit-testable with a fake surface. background.js supplies a `surface`
// with async `press(key, modifiers)` and async `read()` (the current a11y value
// after the last press) and calls runGatedRepeat().

const STOP_MODES = new Set(["count", "until", "path"]);
const POLARITIES = new Set(["match", "no_match"]);
const DEFAULT_MAX_PRESSES = 200;
const MAX_MAX_PRESSES = 2000;

// Compile one caller-supplied pattern into a RegExp, surfacing a clean error.
const compileRegex = (pattern) => {
  try {
    return new RegExp(String(pattern));
  } catch (e) {
    throw new Error(`gated_repeat: invalid regex pattern ${JSON.stringify(pattern)}: ${e.message}`);
  }
};

// Normalize + validate the caller args into a resolved plan.
// Throws on invalid input (missing key, unknown stop mode, missing count,
// invalid regex). Returns { key, modifiers, stop, count?, expect: RegExp[],
// polarity: (string|string[]), max_presses }.
export function normalizeGatedRepeatArgs(raw = {}) {
  const key = String(raw.key || "");
  if (!key) throw new Error("gated_repeat: key is required");

  const modifiers = Array.isArray(raw.modifiers) ? raw.modifiers.map(String) : [];

  const stop = String(raw.stop || "");
  if (!STOP_MODES.has(stop)) {
    throw new Error(`gated_repeat: stop must be one of count|until|path (got ${JSON.stringify(raw.stop)})`);
  }

  const polarity = raw.polarity === undefined ? "match" : raw.polarity;
  // polarity may be a single value or a per-step array; validate each.
  const polarities = Array.isArray(polarity) ? polarity : [polarity];
  for (const p of polarities) {
    if (!POLARITIES.has(String(p))) {
      throw new Error(`gated_repeat: polarity must be match|no_match (got ${JSON.stringify(p)})`);
    }
  }

  const maxRaw = raw.max_presses === undefined ? DEFAULT_MAX_PRESSES : Math.floor(Number(raw.max_presses));
  const max_presses = Number.isFinite(maxRaw) ? Math.min(MAX_MAX_PRESSES, Math.max(0, maxRaw)) : DEFAULT_MAX_PRESSES;

  const plan = { key, modifiers, stop, polarity, max_presses };

  if (stop === "count") {
    if (raw.count === undefined || raw.count === null) {
      throw new Error("gated_repeat: count mode requires a count");
    }
    const count = Math.floor(Number(raw.count));
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`gated_repeat: count must be a non-negative integer (got ${JSON.stringify(raw.count)})`);
    }
    plan.count = count;
    plan.expect = [];
    return plan;
  }

  // until / path both take `expect`: a single pattern (until) or an ordered list (path).
  const rawExpect = raw.expect;
  const list = Array.isArray(rawExpect) ? rawExpect : [rawExpect];
  if (list.length === 0 || list.some((p) => p === undefined || p === null || p === "")) {
    throw new Error(`gated_repeat: ${stop} mode requires expect (a regex, or a list of regexes for path)`);
  }
  if (stop === "until" && list.length !== 1) {
    throw new Error("gated_repeat: until mode takes a single expect regex");
  }
  plan.expect = list.map(compileRegex);
  return plan;
}

// The gate: does this a11y value satisfy the step, given polarity?
// positive ("match") advances on a regex match; negative ("no_match") advances
// on a non-match.
export function evaluateGate(a11yValue, regex, polarity) {
  const matched = regex.test(String(a11yValue ?? ""));
  return String(polarity) === "no_match" ? !matched : matched;
}

const polarityForStep = (polarity, index) =>
  Array.isArray(polarity) ? String(polarity[Math.min(index, polarity.length - 1)] ?? "match") : String(polarity);

// Drive the gated loop against a surface { press(key, modifiers), read() }.
// - count: press N times, no gate.
// - path:  press once per expected regex, gate each read; halt on mismatch.
// - until: press until a read matches the single expect regex (bounded).
// Returns a structured result: { ok, stop, steps_done, position?, final_a11y?,
// halted?, expected?, actual?, reason? }.
export async function runGatedRepeat(plan, surface) {
  const { key, modifiers, stop, expect, polarity, max_presses } = plan;

  if (stop === "count") {
    const n = Math.min(plan.count, max_presses);
    for (let i = 0; i < n; i += 1) {
      await surface.press(key, modifiers);
    }
    return { ok: true, stop: "count", steps_done: n };
  }

  if (stop === "path") {
    let steps = 0;
    for (let i = 0; i < expect.length; i += 1) {
      if (steps >= max_presses) {
        return { ok: true, stop: "partial", steps_done: steps, reason: "max_presses" };
      }
      await surface.press(key, modifiers);
      steps += 1;
      const value = await surface.read();
      const pol = polarityForStep(polarity, i);
      // An empty/absent read is treated as a divergence (OQ2 default: halt).
      if (value === "" || value === undefined || value === null) {
        return { ok: false, stop: "path", halted: true, steps_done: steps - 1, expected: expect[i].source, actual: "", reason: "empty_read" };
      }
      if (!evaluateGate(value, expect[i], pol)) {
        return { ok: false, stop: "path", halted: true, steps_done: steps - 1, expected: expect[i].source, actual: String(value) };
      }
    }
    return { ok: true, stop: "path", steps_done: steps };
  }

  // until: single regex; press until it matches (or negative polarity: until it stops matching).
  const regex = expect[0];
  const pol = polarityForStep(polarity, 0);
  let steps = 0;
  let last = "";
  while (steps < max_presses) {
    await surface.press(key, modifiers);
    steps += 1;
    last = await surface.read();
    if (evaluateGate(last, regex, pol)) {
      return { ok: true, stop: "until", steps_done: steps, final_a11y: String(last ?? "") };
    }
  }
  return { ok: true, stop: "partial", steps_done: steps, final_a11y: String(last ?? ""), reason: "max_presses" };
}
