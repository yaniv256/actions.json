import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./corpus-embedding.mjs";
import { cosineSimilarity } from "./corpus-index.mjs";
import { resolveProjectionSemanticPolicy } from "./projection-semantic-policy.mjs";

const IDENTITY_BASE = Object.freeze({
  provider: "openai",
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  normalization: "nfc-lf",
  schemaVersion: 1,
});

function textFor(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compactLexical(prepared) {
  const lexical = prepared?.lexical_result && typeof prepared.lexical_result === "object"
    ? structuredClone(prepared.lexical_result)
    : { mode: "lexical", status: "incomplete", matches: [], coverage: { complete: false } };
  lexical.mode = "lexical";
  return lexical;
}

function degraded(prepared, reason, details = {}) {
  return {
    ...compactLexical(prepared),
    semantic: { status: "degraded", reason, ...details },
  };
}

function exactLexicalMatches(matches, query) {
  const normalized = query.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  return (Array.isArray(matches) ? matches : []).filter((match) => (
    match.fields?.some((field) => String(field.snippet || "").trim().normalize("NFKC").toLocaleLowerCase("en-US") === normalized)
  ));
}

export async function runProjectionSemanticSearch({
  prepared,
  config,
  trustedCatalog,
  query,
  cache,
  cacheScope,
  apiKey,
  loadApiKey,
  embedTexts,
  evaluateJsonata,
  pageSize = 5,
  batchSize = 32,
  minimumScore = 0.25,
  labelBoost = 0.03,
} = {}) {
  const lexical = compactLexical(prepared);
  if (!prepared || prepared.catalog_revision !== cacheScope?.catalogRevision) {
    return degraded(prepared, "catalog_revision_mismatch");
  }
  const authorization = await resolveProjectionSemanticPolicy({
    policy: config?.policy,
    candidates: prepared.candidates,
    query,
    trusted_catalog: trustedCatalog === true,
    evaluate_jsonata: evaluateJsonata,
  });
  if (authorization.mode !== "semantic") {
    return degraded(prepared, authorization.semantic.reason, authorization.semantic.code ? { code: authorization.semantic.code } : {});
  }
  const selected = authorization.selected_records;
  if (selected.length === 0) return degraded(prepared, "no_eligible_fields");
  if (!cache || typeof embedTexts !== "function") return degraded(prepared, "semantic_runtime_unavailable");
  if (!apiKey && typeof loadApiKey === "function") {
    try { apiKey = await loadApiKey(); } catch (error) {
      return degraded(prepared, "openai_api_key_missing", { detail: error?.message || String(error) });
    }
  }
  if (!apiKey) return degraded(prepared, "openai_api_key_missing");
  const vectors = new Map();
  const missing = [];
  const preparedFields = selected.map((record) => {
    const text = textFor(record.value);
    const identity = { ...IDENTITY_BASE, text };
    return { record, text, identity };
  });
  const cachedBatch = typeof cache.getVectors === "function"
    ? await cache.getVectors(cacheScope, preparedFields.map((item) => item.identity))
    : null;
  for (let index = 0; index < preparedFields.length; index += 1) {
    const { record, text, identity } = preparedFields[index];
    const cached = cachedBatch?.ok ? cachedBatch.results[index] : await cache.getVector(cacheScope, identity);
    if (cached.ok && cached.status === "hit") vectors.set(record.id, cached.vector);
    else missing.push({ record, text, identity });
  }

  let providerFailure = null;
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    const embedded = await embedTexts(batch.map((item) => item.text), { apiKey });
    if (!embedded.ok) {
      providerFailure = embedded.error;
      break;
    }
    const admissions = [];
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const vector = embedded.vectors[index];
      vectors.set(item.record.id, vector);
      admissions.push({ identity: item.identity, vector });
    }
    if (typeof cache.putVectors === "function") {
      await cache.putVectors(cacheScope, admissions, { snapshotId: prepared.snapshot_id });
    } else {
      for (const admission of admissions) {
        await cache.putVector(cacheScope, admission.identity, admission.vector, { snapshotId: prepared.snapshot_id });
      }
    }
  }

  if (vectors.size === 0 && providerFailure) {
    return degraded(prepared, providerFailure.code || "embedding_unavailable", {
      progress: { completed_fields: 0, total_fields: selected.length, complete: false },
    });
  }
  const queryResult = await embedTexts([query], { apiKey });
  if (!queryResult.ok) {
    return degraded(prepared, queryResult.error?.code || "embedding_unavailable", {
      progress: { completed_fields: vectors.size, total_fields: selected.length, complete: vectors.size === selected.length },
    });
  }

  const byNode = new Map();
  for (const record of selected) {
    const vector = vectors.get(record.id);
    if (!vector) continue;
    let score;
    try { score = cosineSimilarity(vector, queryResult.vectors[0]); } catch { continue; }
    if (record.field === "$label") score += labelBoost;
    if (score < minimumScore) continue;
    const current = byNode.get(record.node_ref) || {
      ref: record.node_ref,
      type: record.node_type,
      score,
      fields: [],
    };
    current.score = Math.max(current.score, score);
    current.fields.push({
      field: record.field,
      path: record.path,
      snippet: textFor(record.value).slice(0, 160),
      score,
    });
    byNode.set(record.node_ref, current);
  }
  const semanticMatches = [...byNode.values()].sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  for (const match of semanticMatches) {
    match.fields.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    match.fields = match.fields.slice(0, 4);
  }
  const exact = exactLexicalMatches(lexical.matches, query);
  const seen = new Set(exact.map((match) => match.ref));
  const rankedMatches = exact.slice();
  for (const match of semanticMatches) {
    if (!seen.has(match.ref)) {
      rankedMatches.push(match);
      seen.add(match.ref);
    }
  }
  const matches = rankedMatches.slice(0, pageSize);
  const complete = !providerFailure && vectors.size === selected.length;
  return {
    ok: true,
    operation: "search",
    mode: "hybrid",
    snapshot_id: prepared.snapshot_id,
    status: complete ? (matches.length ? "matches" : "no_confident_match") : "incomplete",
    matches,
    // Internal-only handoff to the content-realm cursor owner. The background
    // removes this field before returning a model-visible answer.
    internal_ranked_matches: rankedMatches,
    coverage: {
      ...(prepared.coverage || {}),
      semantic: { complete, eligible_fields: selected.length, embedded_fields: vectors.size },
    },
    semantic: {
      status: complete ? "complete" : "incomplete",
      ...(providerFailure ? { reason: providerFailure.code || "embedding_unavailable" } : {}),
      progress: { completed_fields: vectors.size, total_fields: selected.length, complete },
    },
  };
}
