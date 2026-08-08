import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectionGraphError,
  graphifyProjection,
  validateExplicitGraph,
} from "../src/agent/projection-graph.mjs";

test("default graphification is deterministic and preserves every JSON shape", () => {
  const state = {
    title: "Board",
    empty: {},
    lists: [{ title: "Doing", cards: ["Alpha", "Alpha", null] }],
  };
  const first = graphifyProjection(state);
  const second = graphifyProjection(state);

  assert.deepEqual(first, second);
  assert.equal(first.schema_version, 1);
  assert.deepEqual(first.roots, ["n0"]);
  assert.equal(first.nodes[0].attributes.title, "Board");
  assert.equal(first.coverage.graph.complete, true);
  assert.equal(first.coverage.lexical.complete, true);

  const cards = first.edges.find((edge) => edge.type === "cards");
  const cardItems = first.edges.filter(
    (edge) => edge.from === cards.to && edge.type === "item",
  );
  assert.deepEqual(cardItems.map((edge) => edge.measures.position), [0, 1, 2]);
  assert.deepEqual(
    cardItems.map((edge) => first.nodes.find((node) => node.ref === edge.to).attributes.value),
    ["Alpha", "Alpha", null],
  );
});

test("scalar and empty-array roots remain navigable", () => {
  const scalar = graphifyProjection("hello");
  assert.deepEqual(scalar.nodes, [{ ref: "n0", type: "value", attributes: { value: "hello" } }]);
  assert.equal(scalar.lexical_index.records[0].text, "hello");

  const empty = graphifyProjection([]);
  assert.equal(empty.nodes[0].type, "array");
  assert.equal(empty.edges.length, 0);
});

test("default graphification rejects forbidden JSON and configured overflows by name", () => {
  assert.throws(
    () => graphifyProjection({ bad: Number.NaN }),
    (error) => error instanceof ProjectionGraphError && error.code === "graph_value_forbidden",
  );
  assert.throws(
    () => graphifyProjection({ a: { b: { c: 1 } } }, { limits: { max_depth: 1 } }),
    (error) => error.code === "graph_depth_exceeded",
  );
  assert.throws(
    () => graphifyProjection([1, 2], { limits: { max_nodes: 2 } }),
    (error) => error.code === "graph_node_limit_exceeded",
  );
  assert.throws(
    () => graphifyProjection({ value: "long" }, { limits: { max_scalar_bytes: 3 } }),
    (error) => error.code === "graph_scalar_limit_exceeded",
  );
});

test("explicit graph validation normalizes local refs to runtime refs", () => {
  const graph = validateExplicitGraph({
    roots: ["board"],
    nodes: [
      { local_ref: "board", type: "board", label: "Roadmap" },
      { local_ref: "card", type: "card", attributes: { title: "Ship" } },
    ],
    edges: [{ from: "board", to: "card", type: "contains", measures: { probability: 0.7 } }],
    containment_edge_types: ["contains"],
    measure_definitions: {
      probability: { meaning: "likelihood", min: 0, max: 1, order: "descending" },
    },
  });

  assert.deepEqual(graph.roots, ["n0"]);
  assert.equal(graph.nodes[0].ref, "n0");
  assert.equal(graph.nodes[0].local_ref, undefined);
  assert.deepEqual(graph.edges[0], {
    from: "n0",
    to: "n1",
    type: "contains",
    measures: { probability: 0.7 },
  });
  assert.deepEqual(graph.containment_edge_types, ["contains"]);
});

test("explicit validation rejects broken identity, roots, links, and measures", () => {
  const base = {
    roots: ["a"],
    nodes: [{ local_ref: "a" }, { local_ref: "b" }],
    edges: [],
  };
  const rejects = [
    [{ ...base, nodes: [{ local_ref: "a" }, { local_ref: "a" }] }, "graph_duplicate_local_ref"],
    [{ ...base, roots: ["missing"] }, "graph_root_invalid"],
    [{ ...base, edges: [{ from: "a", to: "missing", type: "x" }] }, "graph_dangling_ref"],
    [{ ...base, edges: [{ from: "a", to: "b", type: "x", measures: { score: 1 } }] }, "graph_measure_undeclared"],
    [{
      ...base,
      measure_definitions: { score: { meaning: "score", min: 0, max: 1 } },
      edges: [{ from: "a", to: "b", type: "x", measures: { score: 2 } }],
    }, "graph_measure_out_of_range"],
  ];
  for (const [input, code] of rejects) {
    assert.throws(() => validateExplicitGraph(input), (error) => error.code === code, code);
  }
});

test("lexical index reports bounded incomplete coverage instead of implying absence", () => {
  const graph = graphifyProjection(
    { first: "one", second: "two", third: "three" },
    { limits: { max_lexical_records: 2 } },
  );
  assert.equal(graph.lexical_index.records.length, 2);
  assert.deepEqual(graph.coverage.lexical, {
    complete: false,
    candidate_count: 3,
    indexed_count: 2,
    omitted_count: 1,
    reason: "record_limit",
  });
});
