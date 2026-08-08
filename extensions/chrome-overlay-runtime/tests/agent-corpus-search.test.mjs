import assert from "node:assert/strict";
import test from "node:test";

import { searchCorpus } from "../src/agent/corpus-search.mjs";

// A tiny two-dimensional corpus: "east" and "north" are orthogonal, so a query
// vector picks one unambiguously.
const INDEX = {
  model: "text-embedding-3-small",
  dimensions: 2,
  docs: [
    { id: "add-layer-masks", vector: [1, 0] },
    { id: "rotate-or-flip-images", vector: [0, 1] },
  ],
};

function lexical(results, { confident }) {
  return async () => ({ ok: true, confident, results });
}

const NEVER = async () => {
  throw new Error("semantic tier must not be reached");
};

test("a confident lexical hit returns without embedding anything", async () => {
  // The cost model. Semantic must engage only where lexical FAILS, or every
  // query pays a network round-trip for work the cheap tier already did.
  const result = await searchCorpus("add a layer mask", {
    lexicalSearch: lexical([{ id: "add-layer-masks", score: 226 }], { confident: true }),
    embedQuery: NEVER,
    loadIndex: () => {
      throw new Error("index must not be loaded when lexical is confident");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.confident, true);
  assert.equal(result.tier, "lexical");
  assert.equal(result.results[0].id, "add-layer-masks");
});

test("a weak lexical result escalates to the semantic tier", async () => {
  const result = await searchCorpus("cloud backup photos", {
    lexicalSearch: lexical(
      [
        { id: "backup-and-restore-preferences", score: 109 },
        { id: "rotate-or-flip-images", score: 109 },
      ],
      { confident: false },
    ),
    embedQuery: async () => ({ ok: true, vector: [1, 0] }),
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tier, "semantic");
  assert.equal(result.results[0].id, "add-layer-masks");
});

test("a zero-result lexical search escalates rather than refusing early", async () => {
  const result = await searchCorpus("anything", {
    lexicalSearch: lexical([], { confident: false }),
    embedQuery: async () => ({ ok: true, vector: [0, 1] }),
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.tier, "semantic");
  assert.equal(result.results[0].id, "rotate-or-flip-images");
});

test("a semantic result below the floor is reported as NOT confident", async () => {
  // Cosine returns a number for every pair, so semantic ALWAYS produces a
  // ranking — including for a query the corpus does not cover. Without a floor
  // the tier that exists to stop fabrication becomes its best enabler.
  const result = await searchCorpus("3d models", {
    lexicalSearch: lexical([], { confident: false }),
    embedQuery: async () => ({ ok: true, vector: [1, 1] }), // 45 deg from both
    loadIndex: () => ({ ok: true, index: INDEX }),
    minimumSimilarity: 0.9,
  });
  assert.equal(result.ok, true);
  assert.equal(result.confident, false);
  assert.match(result.instruction, /NOT consulted|could not find/i);
});

test("an embed failure degrades to lexical WITH a hedge, never to silence", async () => {
  // R6. The whole point: a failed embed must not read as "no matches", which is
  // indistinguishable from a corpus that does not cover the topic.
  const result = await searchCorpus("cloud backup photos", {
    lexicalSearch: lexical([{ id: "backup-and-restore-preferences", score: 109 }], {
      confident: false,
    }),
    embedQuery: async () => ({
      ok: false,
      error: { code: "embedding_unavailable", message: "network down" },
    }),
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.ok, true, "the search still answers");
  assert.equal(result.tier, "lexical");
  assert.equal(result.confident, false);
  assert.equal(result.degraded.code, "embedding_unavailable");
  assert.ok(result.results.length > 0, "the lexical results are still offered");
  assert.match(result.instruction, /NOT consulted|could not find/i);
});

test("a missing index degrades to lexical with a hedge", async () => {
  const result = await searchCorpus("query", {
    lexicalSearch: lexical([{ id: "something", score: 100 }], { confident: false }),
    embedQuery: NEVER,
    loadIndex: () => ({
      ok: false,
      error: { code: "corpus_index_not_found", message: "no vectors.json" },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tier, "lexical");
  assert.equal(result.degraded.code, "corpus_index_not_found");
  assert.match(result.instruction, /NOT consulted|could not find/i);
});

test("a genuinely empty result carries the refusal instruction", async () => {
  const result = await searchCorpus("nonsense", {
    lexicalSearch: lexical([], { confident: false }),
    embedQuery: async () => ({ ok: true, vector: [1, 1] }),
    loadIndex: () => ({ ok: true, index: INDEX }),
    minimumSimilarity: 0.99,
  });
  assert.equal(result.confident, false);
  assert.match(
    result.instruction,
    /do not answer from your own knowledge/i,
    "the instruction must forbid the memory answer explicitly, not merely report absence",
  );
});

test("a confident result carries NO refusal instruction", async () => {
  // An instruction present on every result is an instruction the model learns
  // to ignore.
  const result = await searchCorpus("add a layer mask", {
    lexicalSearch: lexical([{ id: "add-layer-masks", score: 226 }], { confident: true }),
    embedQuery: NEVER,
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.confident, true);
  assert.equal(result.instruction, undefined);
});

test("an exact lexical hit still wins after semantic re-ranking", async () => {
  // a tester rarity-weighted lexical tier is good; semantic exists to cover what
  // it cannot reach, not to overrule it where it was confident.
  const result = await searchCorpus("rotate or flip", {
    lexicalSearch: lexical([{ id: "rotate-or-flip-images", score: 300 }], {
      confident: true,
    }),
    embedQuery: async () => ({ ok: true, vector: [1, 0] }),
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.results[0].id, "rotate-or-flip-images");
  assert.equal(result.tier, "lexical");
});

test("an empty query is refused before any tier runs", async () => {
  const result = await searchCorpus("   ", {
    lexicalSearch: async () => {
      throw new Error("must not run");
    },
    embedQuery: NEVER,
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /query/i);
});

test("a lexical tier failure still escalates instead of aborting", async () => {
  // The lexical tier is a map-side workflow and can fail on its own; that must
  // not take the whole search down when vectors are available.
  const result = await searchCorpus("cloud backup photos", {
    lexicalSearch: async () => ({
      ok: false,
      error: { code: "workflow_failed", message: "selector missing" },
    }),
    embedQuery: async () => ({ ok: true, vector: [1, 0] }),
    loadIndex: () => ({ ok: true, index: INDEX }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tier, "semantic");
  assert.equal(result.results[0].id, "add-layer-masks");
});
