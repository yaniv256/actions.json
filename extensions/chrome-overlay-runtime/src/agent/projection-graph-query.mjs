import { ProjectionGraphError } from "./projection-graph.mjs";

function fail(code, message, details = {}) {
  throw new ProjectionGraphError(code, message, details);
}

export function traverseGraph(
  graph,
  {
    start_refs = graph?.roots,
    direction = "outbound",
    edge_types,
    max_depth = Number.POSITIVE_INFINITY,
    limit = Number.POSITIVE_INFINITY,
    order_by_measure,
    descending = false,
  } = {},
) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) fail("graph_invalid", "A validated graph is required.");
  if (!Array.isArray(start_refs) || start_refs.length === 0) fail("graph_start_required", "At least one start ref is required.");
  if (!["outbound", "inbound"].includes(direction)) fail("graph_direction_invalid", `Invalid direction ${direction}.`);
  if (!(max_depth === Number.POSITIVE_INFINITY || (Number.isInteger(max_depth) && max_depth >= 0))) {
    fail("graph_depth_invalid", "max_depth must be a non-negative integer.");
  }
  if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit > 0))) {
    fail("graph_limit_invalid", "Traversal limit must be a positive integer.");
  }
  const refs = new Set(graph.nodes.map((node) => node.ref));
  for (const ref of start_refs) if (!refs.has(ref)) fail("graph_node_not_found", `Unknown start ref ${ref}.`, { ref });
  if (order_by_measure && !graph.measure_definitions?.[order_by_measure]) {
    fail("graph_measure_undeclared", `Unknown measure ${order_by_measure}.`, { name: order_by_measure });
  }

  const allowedTypes = edge_types === undefined
    ? new Set(graph.containment_edge_types ?? [])
    : new Set(edge_types);
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!allowedTypes.has(edge.type)) continue;
    const origin = direction === "outbound" ? edge.from : edge.to;
    const target = direction === "outbound" ? edge.to : edge.from;
    const list = adjacency.get(origin) ?? [];
    list.push({ target, edge });
    adjacency.set(origin, list);
  }
  if (order_by_measure) {
    for (const list of adjacency.values()) {
      list.sort((left, right) => {
        const a = left.edge.measures?.[order_by_measure];
        const b = right.edge.measures?.[order_by_measure];
        if (a === undefined && b === undefined) return 0;
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        return descending ? b - a : a - b;
      });
    }
  }

  const visited = new Set();
  const result = [];
  const queue = start_refs.map((ref) => ({ ref, depth: 0 }));
  for (let cursor = 0; cursor < queue.length && result.length < limit; cursor += 1) {
    const current = queue[cursor];
    if (visited.has(current.ref)) continue;
    visited.add(current.ref);
    result.push(current.ref);
    if (current.depth >= max_depth) continue;
    for (const neighbor of adjacency.get(current.ref) ?? []) {
      if (!visited.has(neighbor.target)) queue.push({ ref: neighbor.target, depth: current.depth + 1 });
    }
  }
  return result;
}

export function searchLexicalIndex(graph, query, { scope_refs, limit = 5 } = {}) {
  if (typeof query !== "string" || query.trim() === "") fail("graph_query_empty", "A non-empty lexical query is required.");
  if (!Number.isInteger(limit) || limit <= 0) fail("graph_limit_invalid", "Search limit must be a positive integer.");
  const terms = [...new Set(query.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (terms.length === 0) fail("graph_query_empty", "The lexical query contains no searchable terms.");
  const scope = scope_refs === undefined ? null : new Set(scope_refs);
  const nodeByRef = new Map(graph.nodes.map((node) => [node.ref, node]));
  if (scope) {
    for (const ref of scope) if (!nodeByRef.has(ref)) fail("graph_node_not_found", `Unknown scope ref ${ref}.`, { ref });
  }
  const hits = new Map();
  for (const record of graph.lexical_index?.records ?? []) {
    if (scope && !scope.has(record.node_ref)) continue;
    const matched = terms.filter((term) => record.normalized.includes(term));
    if (matched.length === 0) continue;
    const exact = record.normalized === terms.join(" ");
    const entry = hits.get(record.node_ref) ?? { ref: record.node_ref, score: 0, fields: [], exact: false };
    entry.score += matched.length + (exact ? 2 : 0);
    entry.exact ||= exact;
    entry.fields.push({ field: record.field, path: record.path, text: record.text, matched_terms: matched });
    hits.set(record.node_ref, entry);
  }
  const matches = [...hits.values()]
    .map((hit) => ({
      ref: hit.ref,
      score: hit.score,
      match_kind: hit.exact ? "exact" : "partial",
      fields: hit.fields.sort((a, b) => a.field.localeCompare(b.field)),
      node_type: nodeByRef.get(hit.ref)?.type,
    }))
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref, "en", { numeric: true }))
    .slice(0, limit);
  const coverage = graph.coverage?.lexical ?? { complete: false };
  return {
    status: matches.length > 0 ? "matches" : coverage.complete ? "no_confident_match" : "incomplete",
    matches,
    coverage,
  };
}
