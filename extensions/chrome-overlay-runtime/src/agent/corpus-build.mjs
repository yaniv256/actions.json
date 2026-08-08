// Build a corpus vector artifact from a text index the map already ships.
//
// This runs IN THE EXTENSION rather than as a standalone CLI, deliberately. A
// Node tool would need its own OpenAI key passed in, which means either a
// credential in an agent's session or a second implementation of "where does the
// key live" that can drift from the bridge's. The bridge already resolves it
// (ACTIONS_JSON_OPENAI_API_KEY, then .actions-json.local.json — lib.rs:1043) and
// hydrates it into chrome.storage.local, which is where corpus.search reads it.
// Building through the same path means one resolution order, one place to fix,
// and no credential ever touches a calling agent (a tester + the product owner, 2026-07-27).
//
// Symmetric with corpus-search.mjs: no credentials held here, no network client
// of its own, every dependency injected so every failure path is testable.

import { buildCorpusIndex } from "./corpus-embedding.mjs";

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

// Reads a bundle entry DIRECTLY, for the same reason corpus-index does: the
// model-facing reader applies a 64KB budget and truncates past it, and a
// truncated SOURCE silently produces a short corpus.
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

function resolveRecords(parsed, recordsAt) {
  if (!recordsAt) {
    return Array.isArray(parsed) ? parsed : null;
  }
  let cursor = parsed;
  for (const segment of String(recordsAt).split(".")) {
    if (cursor == null || typeof cursor !== "object") return null;
    cursor = cursor[segment];
  }
  return Array.isArray(cursor) ? cursor : null;
}

/**
 * Reads a text index from the storage bundle, embeds it, and returns the
 * artifact to write. Never returns a partial index — buildCorpusIndex abandons
 * the whole build on any batch failure.
 */
export async function buildCorpusArtifact({
  bundle,
  sourcePath,
  recordsAt = null,
  idField,
  textFields,
  apiKey,
  fetchImpl,
  dimensions,
  batchSize,
} = {}) {
  if (typeof sourcePath !== "string" || sourcePath === "") {
    return failure("corpus_source_path_required", "A corpus source path is required.");
  }
  if (typeof idField !== "string" || idField === "") {
    return failure("corpus_id_field_required", "An id field name is required.");
  }
  if (!Array.isArray(textFields) || textFields.length === 0) {
    return failure(
      "corpus_text_fields_required",
      "At least one text field is required; a corpus embedded on ids alone reproduces the vocabulary mismatch this feature exists to fix.",
    );
  }
  if (typeof apiKey !== "string" || apiKey === "") {
    // Checked here, before any read or network call, so a missing key costs
    // nothing and says so plainly.
    return failure(
      "openai_api_key_missing",
      "Building a corpus index needs an OpenAI API key; none is configured for this extension.",
    );
  }

  const text = bundleEntryText(bundle, sourcePath);
  if (text === null) {
    return failure(
      "corpus_source_not_found",
      `No storage bundle entry at ${sourcePath}.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failure(
      "corpus_source_parse_failed",
      `Corpus source at ${sourcePath} is not valid JSON: ${error.message}`,
    );
  }

  const records = resolveRecords(parsed, recordsAt);
  if (!records) {
    // "No records at that key" and "the corpus is empty" are different facts. A
    // typo'd path that built an empty index would ship a table that ranks
    // nothing while looking structurally valid.
    return failure(
      "corpus_records_not_found",
      recordsAt
        ? `No array of records at "${recordsAt}" in ${sourcePath}.`
        : `${sourcePath} is not an array and no records path was given.`,
    );
  }
  if (records.length === 0) {
    return failure("corpus_empty", `${sourcePath} contains no records.`);
  }

  const documents = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const id = record?.[idField];
    if (typeof id !== "string" || id === "") {
      return failure(
        "corpus_record_id_missing",
        `Record at position ${index} in ${sourcePath} has no "${idField}".`,
      );
    }
    // Join every named field. Embedding a slug alone is how a corpus ends up
    // unreachable from a visitor's actual phrasing — the failure this whole
    // feature exists to remove.
    const body = textFields
      .map((field) => record?.[field])
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .join(" — ");
    if (body === "") {
      return failure(
        "corpus_record_text_blank",
        `Record ${id} in ${sourcePath} has no text in any of: ${textFields.join(", ")}.`,
      );
    }
    documents.push({ id, text: body });
  }

  const built = await buildCorpusIndex(documents, {
    apiKey,
    fetchImpl,
    dimensions,
    batchSize,
  });
  if (!built.ok) {
    return built;
  }
  return {
    ok: true,
    index: built.index,
    documents_embedded: built.index.docs.length,
    source_path: sourcePath,
  };
}
