import assert from "node:assert/strict";
import test from "node:test";

import { resolveProjectionEffectTarget } from "../src/agent/projection-target-resolution.mjs";

const authority = Object.freeze({
  runtime_id: "runtime-1",
  tab_id: 7,
  navigation_epoch: "nav-3",
  snapshot_id: "pss-snapshot-4",
  catalog_revision: "catalog-5",
});

function answer(overrides = {}) {
  return {
    status: "matches",
    complete: true,
    unique: true,
    matches: [{ node_ref: "psn_card_42", match_kind: "exact", confident: true }],
    ...authority,
    ...overrides,
  };
}

async function resolve(input = {}) {
  const calls = [];
  const result = await resolveProjectionEffectTarget({
    search_answer: answer(),
    expected_authority: authority,
    resolveCurrentTarget: async (request) => {
      calls.push(request);
      return { found: true, node_ref: "psn_card_42", ...authority, ...input };
    },
  });
  return { result, calls };
}

test("returns a bounded authority-bound target after immediate identity revalidation", async () => {
  const { result, calls } = await resolve();
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "target_resolved");
  assert.deepEqual(result.target_token, { ...authority, node_ref: "psn_card_42" });
  assert.equal(result.reconciliation_applied, false);
  assert.ok(result.context_bytes <= 2_048);
  assert.deepEqual(calls, [{ node_ref: "psn_card_42", authority: { ...authority } }]);
});

test("rejects ambiguous, incomplete, unconfident, nonopaque, and partial-title search answers before resolving", async () => {
  const cases = [
    [answer({ unique: false, matches: [answer().matches[0], { ...answer().matches[0], node_ref: "psn_other" }] }), "search_ambiguous"],
    [answer({ status: "incomplete", complete: false }), "search_incomplete"],
    [answer({ status: "no_confident_match", matches: [] }), "no_confident_match"],
    [answer({ matches: [{ node_ref: "Launch card", match_kind: "exact", confident: true }] }), "opaque_node_ref_required"],
    [answer({ matches: [{ node_ref: "psn_card_42", match_kind: "partial_title", confident: true }] }), "partial_title_fallback_rejected"],
  ];
  for (const [searchAnswer, reason] of cases) {
    let called = false;
    const result = await resolveProjectionEffectTarget({
      search_answer: searchAnswer,
      expected_authority: authority,
      resolveCurrentTarget: async () => { called = true; },
    });
    assert.equal(result.outcome, "no_effect_performed");
    assert.equal(result.reason, reason);
    assert.equal(called, false);
  }
});

test("rejects stale, moved, missing, and cross-authority targets with no effect", async () => {
  const cases = [
    [{ navigation_epoch: "nav-4" }, "target_stale"],
    [{ node_ref: "psn_other" }, "target_moved"],
    [{ found: false }, "target_missing"],
    [{ runtime_id: "runtime-2" }, "cross_authority_target"],
  ];
  for (const [observed, reason] of cases) {
    const { result } = await resolve(observed);
    assert.equal(result.outcome, "no_effect_performed");
    assert.equal(result.reason, reason);
  }
});

test("allows only explicitly unique forward reconciliation and reports its signal", async () => {
  const moved = "psn_card_42_new";
  const { result } = await resolve({
    node_ref: moved,
    reconciliation: {
      unique: true,
      from_node_ref: "psn_card_42",
      to_node_ref: moved,
      signal: "stable_permalink",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.target_token.node_ref, moved);
  assert.equal(result.reconciliation_applied, true);
  assert.deepEqual(result.context.reconciliation, {
    from_node_ref: "psn_card_42",
    to_node_ref: moved,
    signal: "stable_permalink",
  });

  const nonunique = await resolve({
    node_ref: moved,
    reconciliation: {
      unique: false,
      from_node_ref: "psn_card_42",
      to_node_ref: moved,
      signal: "stable_permalink",
    },
  });
  assert.equal(nonunique.result.reason, "target_moved");
});

test("fails closed when the bounded workflow context cannot fit", async () => {
  const result = await resolveProjectionEffectTarget({
    search_answer: answer(),
    expected_authority: authority,
    max_context_bytes: 256,
    resolveCurrentTarget: async () => ({
      found: true,
      node_ref: `psn_${"x".repeat(300)}`,
      reconciliation: {
        unique: true,
        from_node_ref: "psn_card_42",
        to_node_ref: `psn_${"x".repeat(300)}`,
        signal: "stable_permalink",
      },
      ...authority,
    }),
  });
  assert.equal(result.outcome, "no_effect_performed");
  assert.equal(result.reason, "target_context_too_large");
  assert.ok(result.context_bytes > 256);
});
