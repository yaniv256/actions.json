// Embedding: the write side (build-time corpus) and the one live call
// (runtime query). Splitting them this way is the whole cost model — the corpus
// is embedded ONCE by a build tool and shipped as a table, so the hosted agent
// only ever embeds the short query it was just asked.
//
// Every failure here returns {ok:false,error} rather than throwing or returning
// an empty result. A failed embed that reads as "no matches" is indistinguishable
// from a corpus that genuinely does not cover the topic, and the agent answers
// from its own memory in both cases — which is the exact defect this feature
// exists to remove (2026-07-27).

const EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

// Pinned, not configurable per call. The index and the query must come from the
// same model at the same width or cosine similarity compares incomparable
// spaces — silently, with a plausible ranking. `dimensions` is overridable only
// so tests can use small vectors.
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 512;

export const CORPUS_INDEX_SCHEMA_VERSION = 1;

const DEFAULT_BATCH_SIZE = 96;

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function secureEmbeddingEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return failure("embedding_endpoint_invalid", "Embedding endpoint is not a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    return failure("embedding_endpoint_insecure", "Embedding endpoint must use HTTPS.");
  }
  return { ok: true, url: parsed.href };
}

async function requestEmbeddings(input, { apiKey, fetchImpl, dimensions, endpoint = EMBEDDINGS_URL }) {
  const secured = secureEmbeddingEndpoint(endpoint);
  if (!secured.ok) return secured;
  let response;
  try {
    response = await fetchImpl(secured.url, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input, dimensions }),
    });
  } catch (error) {
    // A hosted tool call must not die mid-turn on a network blip. Return a
    // reason the caller can turn into a hedge.
    return failure(
      "embedding_unavailable",
      `Embedding request failed: ${error.message}`,
    );
  }
  if (!response?.ok) {
    return failure(
      "embedding_request_failed",
      `Embedding request returned status ${response?.status}.`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return failure(
      "embedding_response_invalid",
      `Embedding response was not JSON: ${error.message}`,
    );
  }
  const vectors = Array.isArray(payload?.data)
    ? payload.data.map((row) => row?.embedding)
    : null;
  if (!vectors || vectors.some((vector) => !Array.isArray(vector))) {
    return failure(
      "embedding_response_invalid",
      "Embedding response did not contain an embedding for every input.",
    );
  }
  return { ok: true, vectors };
}

/**
 * Embeds one query for runtime search. The only live network call in the
 * feature.
 */
export async function embedQuery(
  query,
  {
    apiKey,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    dimensions = EMBEDDING_DIMENSIONS,
    endpoint = EMBEDDINGS_URL,
  } = {},
) {
  if (typeof query !== "string" || query.trim() === "") {
    return failure("query_empty", "A non-empty query is required.");
  }
  if (typeof apiKey !== "string" || apiKey === "") {
    return failure(
      "openai_api_key_missing",
      "Semantic search needs an OpenAI API key; none is configured.",
    );
  }
  if (typeof fetchImpl !== "function") {
    return failure("fetch_unavailable", "No fetch implementation is available.");
  }

  const result = await requestEmbeddings(query, { apiKey, fetchImpl, dimensions, endpoint });
  if (!result.ok) {
    return result;
  }
  const [vector] = result.vectors;
  if (!vector || vector.length !== dimensions) {
    // If the API ever ignores `dimensions`, the width silently disagrees with
    // the shipped index. Catch it at the boundary, not deep inside ranking.
    return failure(
      "embedding_dimension_mismatch",
      `Query embedding has ${vector?.length ?? 0} components, expected ${dimensions}.`,
    );
  }
  return { ok: true, vector };
}

/** Embed a bounded batch of already-authorized field values. Authorization is
 * intentionally not accepted here; callers must prove it before invoking this
 * privileged transport boundary. */
export async function embedTexts(
  texts,
  {
    apiKey,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    dimensions = EMBEDDING_DIMENSIONS,
    endpoint = EMBEDDINGS_URL,
  } = {},
) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== "string" || text.trim() === "")) {
    return failure("embedding_input_invalid", "Embedding input must be a non-empty array of non-empty strings.");
  }
  if (typeof apiKey !== "string" || apiKey === "") {
    return failure("openai_api_key_missing", "Semantic search needs an OpenAI API key; none is configured.");
  }
  if (typeof fetchImpl !== "function") return failure("fetch_unavailable", "No fetch implementation is available.");
  const result = await requestEmbeddings(texts, { apiKey, fetchImpl, dimensions, endpoint });
  if (!result.ok) return result;
  if (result.vectors.length !== texts.length) {
    return failure("embedding_count_mismatch", `Embedding batch returned ${result.vectors.length} vectors for ${texts.length} inputs.`);
  }
  if (result.vectors.some((vector) => vector.length !== dimensions || !vector.every(Number.isFinite))) {
    return failure("embedding_dimension_mismatch", `Embedding batch did not return ${dimensions} finite components per input.`);
  }
  return { ok: true, vectors: result.vectors };
}

/**
 * Embeds a whole corpus at build time and returns the artifact to ship.
 * Never emits a partial index: a half-built table loads, ranks, and is silently
 * missing whatever the failed batch covered.
 */
export async function buildCorpusIndex(
  documents,
  {
    apiKey,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    dimensions = EMBEDDING_DIMENSIONS,
    batchSize = DEFAULT_BATCH_SIZE,
  } = {},
) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return failure("corpus_empty", "A corpus with at least one document is required.");
  }
  if (typeof apiKey !== "string" || apiKey === "") {
    return failure(
      "openai_api_key_missing",
      "Building a corpus index needs an OpenAI API key; none is configured.",
    );
  }

  const seen = new Set();
  for (const doc of documents) {
    if (typeof doc?.id !== "string" || doc.id === "") {
      return failure("corpus_doc_id_missing", "Every corpus document needs an id.");
    }
    if (seen.has(doc.id)) {
      // Ambiguous ranking and an undiagnosable rebuild. Name it.
      return failure(
        "corpus_duplicate_id",
        `Corpus contains more than one document with id ${doc.id}.`,
      );
    }
    seen.add(doc.id);
    if (typeof doc.text !== "string" || doc.text.trim() === "") {
      return failure(
        "corpus_doc_text_blank",
        `Corpus document ${doc.id} has blank text; a blank document embeds to noise.`,
      );
    }
  }

  const docs = [];
  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = documents.slice(start, start + batchSize);
    const result = await requestEmbeddings(
      batch.map((doc) => doc.text),
      { apiKey, fetchImpl, dimensions },
    );
    if (!result.ok) {
      // Abandon the whole build. Emitting nothing is strictly better than
      // emitting a table that lies about its coverage.
      return result;
    }
    if (result.vectors.length !== batch.length) {
      return failure(
        "embedding_count_mismatch",
        `Embedding batch returned ${result.vectors.length} vectors for ${batch.length} documents.`,
      );
    }
    for (let index = 0; index < batch.length; index += 1) {
      const vector = result.vectors[index];
      if (vector.length !== dimensions) {
        return failure(
          "embedding_dimension_mismatch",
          `Document ${batch[index].id} embedded to ${vector.length} components, expected ${dimensions}.`,
        );
      }
      docs.push({ id: batch[index].id, vector });
    }
  }

  return {
    ok: true,
    index: {
      schema_version: CORPUS_INDEX_SCHEMA_VERSION,
      model: EMBEDDING_MODEL,
      dimensions,
      docs,
    },
  };
}
