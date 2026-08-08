// Proof-first authorization boundary for projection semantic egress. This
// module selects fields only; provider, network, caching, and ranking live on
// the other side of the returned egress contract.

export const DEFAULT_PROJECTION_SEMANTIC_POLICY_LIMITS = Object.freeze({
  max_candidates: 100_000,
  max_value_bytes: 8_000_000,
  max_query_bytes: 16_384,
  max_candidate_depth: 8,
  max_output_ids: 100_000,
  max_evaluation_ms: 250,
});

const textEncoder = new TextEncoder();
const CANDIDATE_KEYS = ["id", "node_ref", "field", "path", "node_type", "ancestry", "value"];

function lexical(reason, details = {}) {
  return {
    mode: "lexical",
    semantic: { authorized: false, reason, ...details },
    selected_records: [],
    egress: { query: null, values: [] },
  };
}

function byteLength(value) {
  return textEncoder.encode(value).byteLength;
}

function valueDepth(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return 0;
  if (seen.has(value)) return Number.POSITIVE_INFINITY;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  let depth = 1;
  for (const child of values) depth = Math.max(depth, 1 + valueDepth(child, seen));
  seen.delete(value);
  return depth;
}

function limitsWith(overrides = {}) {
  const limits = { ...DEFAULT_PROJECTION_SEMANTIC_POLICY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid semantic policy limit ${name}.`);
  }
  return limits;
}

function normalizeCandidates(candidates, limits) {
  if (!Array.isArray(candidates) || candidates.length > limits.max_candidates) {
    throw new Error("candidate_count_exceeded");
  }
  const ids = new Set();
  const records = [];
  let valueBytes = 0;
  for (const source of candidates) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("candidate_invalid");
    if (valueDepth(source) > limits.max_candidate_depth) throw new Error("candidate_depth_exceeded");
    if (typeof source.id !== "string" || source.id === "" || ids.has(source.id)) throw new Error("candidate_id_invalid");
    if (typeof source.field !== "string" || source.field === "") throw new Error("candidate_field_invalid");
    const encoded = JSON.stringify(source.value);
    if (encoded === undefined) throw new Error("candidate_value_invalid");
    valueBytes += byteLength(encoded);
    if (valueBytes > limits.max_value_bytes) throw new Error("candidate_value_bytes_exceeded");
    ids.add(source.id);
    const record = {};
    for (const key of CANDIDATE_KEYS) {
      if (source[key] !== undefined) record[key] = structuredClone(source[key]);
    }
    records.push(record);
  }
  return { records, ids };
}

function validFieldList(fields) {
  return Array.isArray(fields)
    && fields.length > 0
    && fields.every((field) => typeof field === "string" && field !== "");
}

async function evaluateBounded(evaluate, args, maxMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("selector_time_exceeded")), maxMs);
  });
  const started = performance.now();
  try {
    const output = await Promise.race([Promise.resolve().then(() => evaluate(args)), timeout]);
    if (performance.now() - started > maxMs) throw new Error("selector_time_exceeded");
    return output;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveProjectionSemanticPolicy({
  policy,
  candidates,
  query,
  trusted_catalog = false,
  evaluate_jsonata,
  limits: limitOverrides,
} = {}) {
  if (trusted_catalog !== true) return lexical("catalog_untrusted");
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return lexical("policy_missing");

  let limits;
  let normalized;
  try {
    limits = limitsWith(limitOverrides);
    if (typeof query !== "string" || query.trim() === "" || byteLength(query) > limits.max_query_bytes) {
      return lexical("query_invalid");
    }
    normalized = normalizeCandidates(candidates, limits);
  } catch (error) {
    return lexical("policy_input_invalid", { code: error.message });
  }

  let selectedIds;
  try {
    if (policy.mode === "all") {
      selectedIds = normalized.records.map((record) => record.id);
    } else if (policy.mode === "include" || policy.mode === "exclude") {
      if (!validFieldList(policy.fields)) throw new Error("policy_fields_invalid");
      const fields = new Set(policy.fields);
      selectedIds = normalized.records
        .filter((record) => policy.mode === "include" ? fields.has(record.field) : !fields.has(record.field))
        .map((record) => record.id);
    } else if (policy.mode === "jsonata") {
      if (typeof policy.expression !== "string" || policy.expression.trim() === "") throw new Error("selector_invalid");
      if (typeof evaluate_jsonata !== "function") throw new Error("selector_evaluator_missing");
      selectedIds = await evaluateBounded(evaluate_jsonata, {
        expression: policy.expression,
        candidates: normalized.records.map((record) => structuredClone(record)),
      }, limits.max_evaluation_ms);
    } else {
      throw new Error("policy_mode_invalid");
    }

    if (!Array.isArray(selectedIds) || selectedIds.length > limits.max_output_ids) throw new Error("selector_output_invalid");
    const unique = new Set();
    for (const id of selectedIds) {
      if (typeof id !== "string" || !normalized.ids.has(id) || unique.has(id)) throw new Error("selector_id_invalid");
      unique.add(id);
    }
  } catch (error) {
    return lexical("policy_not_proven", { code: error.message });
  }

  const byId = new Map(normalized.records.map((record) => [record.id, record]));
  const selectedRecords = selectedIds.map((id) => structuredClone(byId.get(id)));
  return {
    mode: "semantic",
    semantic: { authorized: true, policy_mode: policy.mode },
    selected_records: selectedRecords,
    egress: {
      query,
      values: selectedRecords.map((record) => structuredClone(record.value)),
    },
  };
}
