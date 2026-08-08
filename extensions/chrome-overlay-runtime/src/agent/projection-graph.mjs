// Pure projection graph construction. Lifecycle, authorization, continuity, and
// external semantic I/O deliberately live outside this module.

export const PROJECTION_GRAPH_SCHEMA_VERSION = 1;

export const DEFAULT_GRAPH_LIMITS = Object.freeze({
  max_depth: 128,
  max_nodes: 100_000,
  max_edges: 200_000,
  max_scalar_bytes: 1_000_000,
  max_lexical_records: 100_000,
  max_lexical_bytes: 8_000_000,
});

export class ProjectionGraphError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProjectionGraphError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ProjectionGraphError(code, message, details);
}

function limitsWith(overrides = {}) {
  const limits = { ...DEFAULT_GRAPH_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 0) {
      fail("graph_limit_invalid", `${name} must be a non-negative integer.`, { name, value });
    }
  }
  return limits;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function scalarBytes(value) {
  if (value === null) return 4;
  return new TextEncoder().encode(String(value)).byteLength;
}

function assertJsonScalar(value, path) {
  const type = typeof value;
  if (value === null || type === "string" || type === "boolean") return;
  if (type === "number" && Number.isFinite(value)) return;
  fail("graph_value_forbidden", `Projection contains a non-JSON value at ${path}.`, { path, type });
}

function pathPart(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizeAttributes(attributes, path, accountScalar) {
  if (attributes === undefined) return {};
  if (!isObject(attributes) || Array.isArray(attributes)) {
    fail("graph_attributes_invalid", `Node attributes at ${path} must be an object.`, { path });
  }
  const normalized = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (isObject(value)) {
      fail("graph_attribute_non_scalar", `Attribute ${key} at ${path} must be scalar.`, { path, key });
    }
    assertJsonScalar(value, `${path}/${pathPart(key)}`);
    accountScalar(value, `${path}/${pathPart(key)}`);
    normalized[key] = value;
  }
  return normalized;
}

function buildLexicalIndex(nodes, limits) {
  const candidates = [];
  for (const node of nodes) {
    if (typeof node.label === "string" && node.label !== "") {
      candidates.push({ node_ref: node.ref, field: "$label", path: `${node.ref}/$label`, text: node.label });
    }
    for (const [field, value] of Object.entries(node.attributes ?? {})) {
      if (value === null) continue;
      candidates.push({
        node_ref: node.ref,
        field,
        path: `${node.ref}/${pathPart(field)}`,
        text: String(value),
      });
    }
  }

  const records = [];
  let encodedBytes = 0;
  let reason;
  for (const candidate of candidates) {
    if (records.length >= limits.max_lexical_records) {
      reason = "record_limit";
      break;
    }
    const normalized = candidate.text.normalize("NFKC").toLocaleLowerCase("en-US");
    const bytes = new TextEncoder().encode(normalized).byteLength;
    if (encodedBytes + bytes > limits.max_lexical_bytes) {
      reason = "byte_limit";
      break;
    }
    encodedBytes += bytes;
    records.push({
      ...candidate,
      normalized,
      tokens: [...new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? [])],
    });
  }
  const omitted = candidates.length - records.length;
  return {
    index: { schema_version: 1, records },
    coverage: {
      complete: omitted === 0,
      candidate_count: candidates.length,
      indexed_count: records.length,
      omitted_count: omitted,
      ...(reason ? { reason } : {}),
    },
  };
}

function finishGraph({ nodes, edges, roots, containmentEdgeTypes, measureDefinitions, limits }) {
  const lexical = buildLexicalIndex(nodes, limits);
  return {
    schema_version: PROJECTION_GRAPH_SCHEMA_VERSION,
    roots,
    nodes,
    edges,
    containment_edge_types: containmentEdgeTypes,
    measure_definitions: measureDefinitions,
    coverage: {
      graph: { complete: true, node_count: nodes.length, edge_count: edges.length },
      lexical: lexical.coverage,
    },
    lexical_index: lexical.index,
  };
}

export function graphifyProjection(value, { limits: limitOverrides } = {}) {
  const limits = limitsWith(limitOverrides);
  const nodes = [];
  const edges = [];
  const activeObjects = new WeakSet();
  let totalScalarBytes = 0;

  const accountScalar = (scalar, path) => {
    totalScalarBytes += scalarBytes(scalar);
    if (totalScalarBytes > limits.max_scalar_bytes) {
      fail("graph_scalar_limit_exceeded", "Projection scalar content exceeds the configured limit.", {
        path,
        max_scalar_bytes: limits.max_scalar_bytes,
      });
    }
  };
  const addNode = (node, path) => {
    if (nodes.length >= limits.max_nodes) {
      fail("graph_node_limit_exceeded", "Projection node count exceeds the configured limit.", { path });
    }
    const ref = `n${nodes.length}`;
    nodes.push({ ref, ...node });
    return ref;
  };
  const addEdge = (edge, path) => {
    if (edges.length >= limits.max_edges) {
      fail("graph_edge_limit_exceeded", "Projection edge count exceeds the configured limit.", { path });
    }
    edges.push(edge);
  };

  const visit = (current, path, depth) => {
    if (depth > limits.max_depth) {
      fail("graph_depth_exceeded", "Projection nesting exceeds the configured limit.", { path, depth });
    }
    if (!isObject(current)) {
      assertJsonScalar(current, path);
      accountScalar(current, path);
      return addNode({ type: "value", attributes: { value: current } }, path);
    }
    if (activeObjects.has(current)) {
      fail("graph_value_forbidden", `Projection contains a cycle at ${path}.`, { path, type: "cycle" });
    }
    activeObjects.add(current);
    const array = Array.isArray(current);
    const attributes = {};
    const ref = addNode({ type: array ? "array" : "object", attributes }, path);
    if (array) {
      for (let index = 0; index < current.length; index += 1) {
        const childPath = `${path}/${index}`;
        const child = visit(current[index], childPath, depth + 1);
        addEdge({ from: ref, to: child, type: "item", measures: { position: index } }, childPath);
      }
    } else {
      for (const key of Object.keys(current).sort()) {
        const childPath = `${path}/${pathPart(key)}`;
        const childValue = current[key];
        if (isObject(childValue)) {
          const child = visit(childValue, childPath, depth + 1);
          addEdge({ from: ref, to: child, type: key, measures: {} }, childPath);
        } else {
          assertJsonScalar(childValue, childPath);
          accountScalar(childValue, childPath);
          attributes[key] = childValue;
        }
      }
    }
    activeObjects.delete(current);
    return ref;
  };

  const root = visit(value, "$", 0);
  return finishGraph({
    nodes,
    edges,
    roots: [root],
    containmentEdgeTypes: ["item", ...new Set(edges.filter((edge) => edge.type !== "item").map((edge) => edge.type))],
    measureDefinitions: {
      position: { meaning: "zero-based array order", min: 0, order: "ascending" },
    },
    limits,
  });
}

function validateMeasureDefinitions(input) {
  if (input === undefined) return {};
  if (!isObject(input) || Array.isArray(input)) {
    fail("graph_measure_definitions_invalid", "measure_definitions must be an object.");
  }
  const definitions = {};
  for (const name of Object.keys(input).sort()) {
    if (name === "" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
      fail("graph_measure_name_invalid", `Invalid measure name ${name}.`, { name });
    }
    const definition = input[name];
    if (!isObject(definition) || Array.isArray(definition) || typeof definition.meaning !== "string" || definition.meaning === "") {
      fail("graph_measure_definition_invalid", `Measure ${name} requires a meaning.`, { name });
    }
    for (const bound of ["min", "max"]) {
      if (definition[bound] !== undefined && !Number.isFinite(definition[bound])) {
        fail("graph_measure_definition_invalid", `Measure ${name} has an invalid ${bound}.`, { name, bound });
      }
    }
    if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) {
      fail("graph_measure_definition_invalid", `Measure ${name} has min greater than max.`, { name });
    }
    if (definition.order !== undefined && !["ascending", "descending", "none"].includes(definition.order)) {
      fail("graph_measure_definition_invalid", `Measure ${name} has an invalid order.`, { name });
    }
    definitions[name] = {
      meaning: definition.meaning,
      ...(definition.min !== undefined ? { min: definition.min } : {}),
      ...(definition.max !== undefined ? { max: definition.max } : {}),
      ...(definition.order !== undefined ? { order: definition.order } : {}),
    };
  }
  return definitions;
}

export function validateExplicitGraph(input, { limits: limitOverrides } = {}) {
  const limits = limitsWith(limitOverrides);
  if (!isObject(input) || Array.isArray(input)) fail("graph_contract_invalid", "Explicit graph must be an object.");
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges) || !Array.isArray(input.roots)) {
    fail("graph_contract_invalid", "Explicit graph requires roots, nodes, and edges arrays.");
  }
  if (input.nodes.length > limits.max_nodes) fail("graph_node_limit_exceeded", "Explicit graph exceeds the node limit.");
  if (input.edges.length > limits.max_edges) fail("graph_edge_limit_exceeded", "Explicit graph exceeds the edge limit.");

  let totalScalarBytes = 0;
  const accountScalar = (value, path) => {
    totalScalarBytes += scalarBytes(value);
    if (totalScalarBytes > limits.max_scalar_bytes) fail("graph_scalar_limit_exceeded", "Explicit graph scalar content exceeds the configured limit.", { path });
  };
  const refMap = new Map();
  const nodes = input.nodes.map((node, index) => {
    if (!isObject(node) || Array.isArray(node) || typeof node.local_ref !== "string" || node.local_ref === "") {
      fail("graph_local_ref_invalid", `Node ${index} requires a non-empty local_ref.`, { index });
    }
    if (refMap.has(node.local_ref)) fail("graph_duplicate_local_ref", `Duplicate local_ref ${node.local_ref}.`, { local_ref: node.local_ref });
    const ref = `n${index}`;
    refMap.set(node.local_ref, ref);
    if (node.type !== undefined && (typeof node.type !== "string" || node.type === "")) {
      fail("graph_node_type_invalid", `Node ${index} type must be a non-empty string.`, { index });
    }
    const normalized = {
      ref,
      type: typeof node.type === "string" && node.type !== "" ? node.type : "node",
      attributes: normalizeAttributes(node.attributes, `nodes/${index}/attributes`, accountScalar),
    };
    if (node.label !== undefined) {
      if (typeof node.label !== "string") fail("graph_label_invalid", `Node ${index} label must be a string.`, { index });
      accountScalar(node.label, `nodes/${index}/label`);
      normalized.label = node.label;
    }
    if (node.identity_hints !== undefined) {
      normalized.identity_hints = normalizeAttributes(node.identity_hints, `nodes/${index}/identity_hints`, accountScalar);
    }
    return normalized;
  });
  const roots = input.roots.map((root) => {
    if (!refMap.has(root)) fail("graph_root_invalid", `Unknown graph root ${root}.`, { root });
    return refMap.get(root);
  });
  if (new Set(roots).size !== roots.length) fail("graph_root_invalid", "Graph roots must be unique.");

  const measureDefinitions = validateMeasureDefinitions(input.measure_definitions);
  const edges = input.edges.map((edge, index) => {
    if (!isObject(edge) || Array.isArray(edge) || typeof edge.type !== "string" || edge.type === "") {
      fail("graph_edge_invalid", `Edge ${index} requires a non-empty type.`, { index });
    }
    if (!refMap.has(edge.from) || !refMap.has(edge.to)) {
      fail("graph_dangling_ref", `Edge ${index} references an unknown node.`, { index, from: edge.from, to: edge.to });
    }
    if (edge.measures !== undefined && (!isObject(edge.measures) || Array.isArray(edge.measures))) {
      fail("graph_measure_invalid", `Edge ${index} measures must be an object.`, { index });
    }
    const measures = {};
    for (const name of Object.keys(edge.measures ?? {}).sort()) {
      const definition = measureDefinitions[name];
      if (!definition) fail("graph_measure_undeclared", `Edge ${index} uses undeclared measure ${name}.`, { index, name });
      const value = edge.measures[name];
      if (!Number.isFinite(value)) fail("graph_measure_invalid", `Edge ${index} measure ${name} must be finite.`, { index, name });
      if ((definition.min !== undefined && value < definition.min) || (definition.max !== undefined && value > definition.max)) {
        fail("graph_measure_out_of_range", `Edge ${index} measure ${name} is out of range.`, { index, name, value });
      }
      measures[name] = value;
    }
    return { from: refMap.get(edge.from), to: refMap.get(edge.to), type: edge.type, measures };
  });
  const containmentEdgeTypes = input.containment_edge_types ?? [];
  if (!Array.isArray(containmentEdgeTypes) || containmentEdgeTypes.some((type) => typeof type !== "string" || type === "")) {
    fail("graph_containment_types_invalid", "containment_edge_types must be an array of non-empty strings.");
  }

  return finishGraph({
    nodes,
    edges,
    roots,
    containmentEdgeTypes: [...new Set(containmentEdgeTypes)],
    measureDefinitions,
    limits,
  });
}
