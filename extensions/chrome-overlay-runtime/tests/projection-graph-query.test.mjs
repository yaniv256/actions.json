import assert from "node:assert/strict";
import test from "node:test";

import { graphifyProjection, validateExplicitGraph } from "../src/agent/projection-graph.mjs";
import { searchLexicalIndex, traverseGraph } from "../src/agent/projection-graph-query.mjs";

test("cycle-safe traversal follows selected containment edges once", () => {
  const graph = validateExplicitGraph({
    roots: ["a"],
    nodes: [{ local_ref: "a" }, { local_ref: "b" }, { local_ref: "c" }],
    edges: [
      { from: "a", to: "b", type: "contains" },
      { from: "b", to: "c", type: "contains" },
      { from: "c", to: "a", type: "contains" },
    ],
    containment_edge_types: ["contains"],
  });
  assert.deepEqual(traverseGraph(graph, { start_refs: graph.roots }), ["n0", "n1", "n2"]);
});

test("ordinary traversal ignores measures unless ordering is requested", () => {
  const graph = graphifyProjection(["zero", "one", "two"]);
  const root = graph.roots[0];
  assert.deepEqual(traverseGraph(graph, { start_refs: [root], max_depth: 1 }), ["n0", "n1", "n2", "n3"]);
  assert.deepEqual(
    traverseGraph(graph, { start_refs: [root], max_depth: 1, order_by_measure: "position", descending: true }),
    ["n0", "n3", "n2", "n1"],
  );
});

test("an explicit graph with no declared containment edges does not traverse arbitrary links", () => {
  const graph = validateExplicitGraph({
    roots: ["a"],
    nodes: [{ local_ref: "a" }, { local_ref: "b" }],
    edges: [{ from: "a", to: "b", type: "related" }],
  });
  assert.deepEqual(traverseGraph(graph), ["n0"]);
  assert.deepEqual(traverseGraph(graph, { edge_types: ["related"] }), ["n0", "n1"]);
});

test("lexical search returns field-level provenance and honest coverage", () => {
  const graph = graphifyProjection({ title: "Alpha launch", body: "Alpha details", other: "Beta" });
  const result = searchLexicalIndex(graph, "alpha", { limit: 5 });
  assert.equal(result.status, "matches");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].ref, "n0");
  assert.deepEqual(result.matches[0].fields.map((field) => field.field), ["body", "title"]);
  assert.equal(result.coverage.complete, true);

  const bounded = searchLexicalIndex(
    graphifyProjection({ one: "alpha", two: "beta" }, { limits: { max_lexical_records: 1 } }),
    "missing",
  );
  assert.equal(bounded.status, "incomplete");
  assert.equal(bounded.coverage.complete, false);
});

test("lexical search distinguishes exact identity from partial retrieval", () => {
  const graph = graphifyProjection({ cards: [{ title: "Maximum pain", url: "https://trello.com/c/example" }] });
  const exact = searchLexicalIndex(graph, "Maximum pain");
  const partial = searchLexicalIndex(graph, "Maximum");

  assert.equal(exact.matches[0].match_kind, "exact");
  assert.equal(partial.matches[0].match_kind, "partial");
});
