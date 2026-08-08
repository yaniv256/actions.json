import assert from "node:assert/strict";
import test from "node:test";

import { resolveProjectionSemanticPolicy } from "../src/agent/projection-semantic-policy.mjs";

const candidates = [
  { id: "f1", node_ref: "n1", field: "title", path: "/cards/0/title", node_type: "card", ancestry: ["board", "card"], value: "Launch plan" },
  { id: "f2", node_ref: "n1", field: "secret", path: "/cards/0/secret", node_type: "card", ancestry: ["board", "card"], value: "do not send" },
  { id: "f3", node_ref: "n2", field: "body", path: "/cards/1/body", node_type: "card", ancestry: ["board", "card"], value: "Release checklist" },
];

test("all, include, and exclude authorize only selected original field records", async () => {
  for (const [policy, ids] of [
    [{ mode: "all" }, ["f1", "f2", "f3"]],
    [{ mode: "include", fields: ["title", "body"] }, ["f1", "f3"]],
    [{ mode: "exclude", fields: ["secret"] }, ["f1", "f3"]],
  ]) {
    const result = await resolveProjectionSemanticPolicy({
      policy,
      candidates,
      query: "launch",
      trusted_catalog: true,
    });
    assert.equal(result.mode, "semantic");
    assert.deepEqual(result.selected_records.map((record) => record.id), ids);
    assert.deepEqual(result.egress, {
      query: "launch",
      values: ids.map((id) => candidates.find((record) => record.id === id).value),
    });
    assert.notEqual(result.selected_records[0], candidates[0], "records are copied across the policy boundary");
  }
});

test("jsonata selector receives bounded records once and returns candidate IDs", async () => {
  let calls = 0;
  const result = await resolveProjectionSemanticPolicy({
    policy: { mode: "jsonata", expression: "candidate fields" },
    candidates,
    query: "release",
    trusted_catalog: true,
    evaluate_jsonata: async ({ expression, candidates: input }) => {
      calls += 1;
      assert.equal(expression, "candidate fields");
      assert.deepEqual(Object.keys(input[0]).sort(), ["ancestry", "field", "id", "node_ref", "node_type", "path", "value"]);
      return ["f3", "f1"];
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.selected_records.map((record) => record.id), ["f3", "f1"]);
  assert.deepEqual(result.egress, { query: "release", values: ["Release checklist", "Launch plan"] });
});

test("missing or untrusted policy degrades to a zero-egress lexical contract", async () => {
  for (const args of [
    { policy: undefined, trusted_catalog: true },
    { policy: { mode: "all" }, trusted_catalog: false },
  ]) {
    const result = await resolveProjectionSemanticPolicy({ ...args, candidates, query: "private query" });
    assert.equal(result.mode, "lexical");
    assert.equal(result.semantic.authorized, false);
    assert.deepEqual(result.selected_records, []);
    assert.deepEqual(result.egress, { query: null, values: [] });
  }
});

test("invalid selectors, foreign IDs, and every budget exhaustion fail closed", async () => {
  const cases = [
    { policy: { mode: "wat" } },
    { policy: { mode: "include", fields: [""] } },
    { policy: { mode: "jsonata", expression: "x" }, evaluate_jsonata: async () => ["foreign"] },
    { policy: { mode: "all" }, limits: { max_candidates: 2 } },
    { policy: { mode: "all" }, limits: { max_value_bytes: 4 } },
    { policy: { mode: "all" }, limits: { max_candidate_depth: 1 } },
    { policy: { mode: "jsonata", expression: "x" }, limits: { max_output_ids: 1 }, evaluate_jsonata: async () => ["f1", "f2"] },
    { policy: { mode: "jsonata", expression: "x" }, limits: { max_evaluation_ms: 5 }, evaluate_jsonata: async () => new Promise((resolve) => setTimeout(() => resolve(["f1"]), 30)) },
  ];
  for (const testCase of cases) {
    const result = await resolveProjectionSemanticPolicy({
      candidates,
      query: "must not escape",
      trusted_catalog: true,
      ...testCase,
    });
    assert.equal(result.mode, "lexical");
    assert.equal(result.semantic.authorized, false);
    assert.deepEqual(result.egress, { query: null, values: [] });
  }
});

test("semantic authorization requires an explicit bounded query", async () => {
  for (const query of [undefined, "", "x".repeat(30)]) {
    const result = await resolveProjectionSemanticPolicy({
      policy: { mode: "all" }, candidates, query, trusted_catalog: true, limits: { max_query_bytes: 20 },
    });
    assert.equal(result.mode, "lexical");
    assert.deepEqual(result.egress, { query: null, values: [] });
  }
});
