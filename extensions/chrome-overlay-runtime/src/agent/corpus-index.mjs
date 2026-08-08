// Corpus vector index: the read side of build-time semantic search.
//
// A map declares a corpus and a vector artifact; a build-time tool embeds the
// corpus ONCE and ships the vectors as a sibling file. At runtime the extension
// embeds only the query and ranks locally. This module owns loading and ranking;
// it makes no network calls and holds no credentials.
//
// Every rejection here is deliberate. A vector index that loads "mostly" is
// worse than one that refuses: a short or mis-dimensioned table still returns a
// plausible ranking, so the failure surfaces as bad answers rather than as an
// error (2026-07-27).

export const CORPUS_INDEX_SCHEMA_VERSION = 1;

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

// Reads a bundle entry DIRECTLY rather than through
// readSiteStorageFileFromBundle, which applies a 64KB default budget and
// TRUNCATES past it (local-actions-catalog.mjs:213). A truncated vector table
// does not announce itself — it silently stops covering the tail of the corpus.
function bundleEntryText(bundle, path) {
  if (Array.isArray(bundle?.entries)) {
    const entry = bundle.entries.find((candidate) => candidate?.path === path);
    return entry ? String(entry.content ?? entry.text ?? "") : null;
  }
  if (bundle?.files && typeof bundle.files === "object") {
    const file = bundle.files[path];
    return file ? String(file.text ?? "") : null;
  }
  return null;
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1].
 *
 * Normalizing by both magnitudes is what makes this cosine rather than a dot
 * product: an embedding's magnitude carries no meaning, so a longer vector must
 * not outrank a better-aligned one.
 */
export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    throw new TypeError("cosineSimilarity requires two arrays");
  }
  if (left.length !== right.length) {
    throw new RangeError(
      `cosineSimilarity requires equal length vectors, got ${left.length} and ${right.length}`,
    );
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    // Undefined, not zero. Returning NaN would sort as neither greater nor less
    // than any other score and quietly sink the row instead of reporting it.
    throw new RangeError("cosineSimilarity is undefined for a zero vector");
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Loads and validates a corpus vector index from the storage bundle.
 * Returns `{ ok: true, index }` or `{ ok: false, error: { code, message } }`.
 * Never throws on bad input — a corrupt artifact is a reportable condition, not
 * a crash in the middle of a hosted tool call.
 */
export function loadCorpusIndexFromBundle(bundle, { path } = {}) {
  if (typeof path !== "string" || path === "") {
    return failure("corpus_index_path_required", "A corpus index path is required.");
  }
  const text = bundleEntryText(bundle, path);
  if (text === null) {
    return failure(
      "corpus_index_not_found",
      `No storage bundle entry at ${path}.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failure(
      "corpus_index_parse_failed",
      `Corpus index at ${path} is not valid JSON: ${error.message}`,
    );
  }

  if (parsed?.schema_version !== CORPUS_INDEX_SCHEMA_VERSION) {
    // Fail closed on an unrecognized version so the format can change later
    // without a silently misread index already deployed in the field.
    return failure(
      "corpus_index_schema_unsupported",
      `Corpus index at ${path} declares schema_version ${parsed?.schema_version}, expected ${CORPUS_INDEX_SCHEMA_VERSION}.`,
    );
  }

  const dimensions = parsed.dimensions;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    return failure(
      "corpus_index_dimensions_invalid",
      `Corpus index at ${path} declares invalid dimensions ${dimensions}.`,
    );
  }
  if (typeof parsed.model !== "string" || parsed.model === "") {
    return failure(
      "corpus_index_model_missing",
      `Corpus index at ${path} does not name the embedding model that produced it.`,
    );
  }
  if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) {
    return failure(
      "corpus_index_empty",
      `Corpus index at ${path} contains no documents.`,
    );
  }

  for (const doc of parsed.docs) {
    if (typeof doc?.id !== "string" || doc.id === "") {
      return failure(
        "corpus_index_doc_id_missing",
        `Corpus index at ${path} contains a document without an id.`,
      );
    }
    if (!Array.isArray(doc.vector) || doc.vector.length !== dimensions) {
      // Named, not counted. A ranking built on a mis-dimensioned row still
      // produces an ordering, so this has to be caught at load and has to say
      // WHICH row, or the rebuild is a search through the whole table.
      return failure(
        "corpus_index_dimension_mismatch",
        `Corpus index at ${path}: document ${doc.id} has ${doc.vector?.length ?? 0} components, expected ${dimensions}.`,
      );
    }
  }

  return {
    ok: true,
    index: {
      model: parsed.model,
      dimensions,
      docs: parsed.docs.map((doc) => ({ id: doc.id, vector: doc.vector })),
    },
  };
}

/**
 * Ranks every document in the index against a query vector, highest first.
 * Throws on a dimension disagreement — that is a programming error at the call
 * site (an index and a query built with different `dimensions` settings), not a
 * data condition, and it must not degrade into a plausible wrong ordering.
 */
export function rankByCosine(index, queryVector, { limit } = {}) {
  if (!Array.isArray(queryVector)) {
    throw new TypeError("rankByCosine requires a query vector array");
  }
  if (queryVector.length !== index?.dimensions) {
    throw new RangeError(
      `rankByCosine query has ${queryVector.length} dimensions, index has ${index?.dimensions}`,
    );
  }
  const ranked = index.docs
    .map((doc) => ({ id: doc.id, score: cosineSimilarity(doc.vector, queryVector) }))
    .sort((left, right) => right.score - left.score);
  return Number.isInteger(limit) && limit > 0 ? ranked.slice(0, limit) : ranked;
}
