// Two-tier corpus search: cheap lexical first, semantic only where lexical is
// not confident.
//
// The ordering is the cost model. Embedding every query would pay a network
// round-trip for work a rarity-weighted lexical match already does well; gating
// on the lexical tier's own confidence signal makes the spend proportional to
// lexical FAILURE rather than to traffic, and it degrades gracefully when the
// embeddings API is unreachable.
//
// The confidence signal comes from a tester measurement (2026-07-27): a real
// lexical match SEPARATES from the pack (226 against a runner-up of 134) while
// noise PLATEAUS (31 results tied at exactly 109, all matching one common
// term). So "did we find something" is answerable without embeddings, and
// that answer is the handoff trigger.
//
// Everything here exists to prevent one specific failure: the hosted agent
// receiving an empty or weak result, not reporting it, and answering from its
// own model memory instead — fluently, and without disclosing it never opened
// the documentation.

import { rankByCosine } from "./corpus-index.mjs";

// Below this cosine score a semantic hit is not offered as an answer.
//
// Cosine returns a number for EVERY pair, so the semantic tier always produces
// a ranking — including for a query the corpus does not cover at all. Without a
// floor, the tier added to stop fabrication becomes its most convincing enabler:
// a confidently-presented nearest neighbour for a topic that simply is not
// there. Calibrate against real visitor queries; this is a starting value, not
// a measured one.
export const DEFAULT_MINIMUM_SIMILARITY = 0.35;

// Instruction text is returned in the TOOL RESULT, never left to the map's
// prose rules. Verified independently twice on 2026-07-27: a prompt-level rule
// was overridden by the model, a tool-result field was obeyed. A model reasons
// over what is in front of it, so anything it must obey belongs in the most
// recent thing it read.
const NO_MATCH_INSTRUCTION =
  "NO USABLE MATCH. You have NOT consulted the documentation for this question. " +
  "Do NOT answer from your own knowledge. Tell the visitor plainly that you could not " +
  "find a page covering this, then offer the closest listed topic as a maybe, or point " +
  "them outside this corpus.";

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function lexicalOutcome(results, { degraded } = {}) {
  return {
    ok: true,
    tier: "lexical",
    confident: false,
    results: Array.isArray(results) ? results : [],
    degraded,
    // A weak result and a degraded result carry the SAME instruction on
    // purpose. From the model's side they are one situation: it does not have a
    // documented answer, and whether that is because the corpus lacks the topic
    // or because the embeddings call failed changes nothing about what it must
    // tell the visitor. The `degraded` field carries the distinction for
    // operators without offering the model a reason to hedge less.
    instruction: NO_MATCH_INSTRUCTION,
  };
}

/**
 * Runs the lexical tier, then the semantic tier only if needed.
 *
 * Dependencies are injected so this module holds no credentials, no storage
 * handle, and no network client of its own — and so every degradation path is
 * reachable from a test.
 */
export async function searchCorpus(
  query,
  {
    lexicalSearch,
    embedQuery,
    loadIndex,
    limit = 5,
    minimumSimilarity = DEFAULT_MINIMUM_SIMILARITY,
  } = {},
) {
  if (typeof query !== "string" || query.trim() === "") {
    return failure("query_empty", "A non-empty query is required.");
  }

  // Tier 1. A failure here is not fatal: the lexical tier is a map-side
  // workflow and can break on its own, which must not take the whole search
  // down when vectors are available.
  let lexical = null;
  if (typeof lexicalSearch === "function") {
    try {
      lexical = await lexicalSearch(query);
    } catch (error) {
      lexical = { ok: false, error: { code: "lexical_failed", message: error.message } };
    }
  }

  if (lexical?.ok && lexical.confident) {
    // An exact match wins outright. Semantic exists to reach what lexical
    // cannot, not to overrule it where it was sure.
    return {
      ok: true,
      tier: "lexical",
      confident: true,
      results: (lexical.results ?? []).slice(0, limit),
    };
  }

  const lexicalResults = lexical?.ok ? (lexical.results ?? []) : [];

  // Tier 2.
  const loaded = typeof loadIndex === "function" ? await loadIndex() : { ok: false, error: { code: "corpus_index_unavailable", message: "No corpus index loader was provided." } };
  if (!loaded?.ok) {
    return lexicalOutcome(lexicalResults.slice(0, limit), { degraded: loaded?.error });
  }

  const embedded = typeof embedQuery === "function"
    ? await embedQuery(query)
    : { ok: false, error: { code: "embedding_unavailable", message: "No query embedder was provided." } };
  if (!embedded?.ok) {
    // Degrade to whatever lexical found, WITH the hedge. Returning an empty
    // success here would be the fabrication bug: indistinguishable from a
    // corpus that genuinely does not cover the topic.
    return lexicalOutcome(lexicalResults.slice(0, limit), { degraded: embedded?.error });
  }

  let ranked;
  try {
    ranked = rankByCosine(loaded.index, embedded.vector, { limit });
  } catch (error) {
    return lexicalOutcome(lexicalResults.slice(0, limit), {
      degraded: { code: "corpus_rank_failed", message: error.message },
    });
  }

  const best = ranked[0];
  if (!best || best.score < minimumSimilarity) {
    return {
      ok: true,
      tier: "semantic",
      confident: false,
      results: ranked,
      instruction: NO_MATCH_INSTRUCTION,
    };
  }

  return { ok: true, tier: "semantic", confident: true, results: ranked };
}
