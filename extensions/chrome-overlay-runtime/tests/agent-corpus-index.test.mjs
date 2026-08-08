import assert from "node:assert/strict";
import test from "node:test";

import {
  cosineSimilarity,
  loadCorpusIndexFromBundle,
  rankByCosine,
} from "../src/agent/corpus-index.mjs";

const MODEL = "text-embedding-3-small";

function bundleWith(path, text) {
  return { entries: [{ path, content: text }] };
}

function indexJson(overrides = {}) {
  return JSON.stringify({
    schema_version: 1,
    model: MODEL,
    dimensions: 2,
    docs: [
      { id: "east", vector: [1, 0] },
      { id: "north", vector: [0, 1] },
    ],
    ...overrides,
  });
}

test("cosine similarity matches hand-computed values", () => {
  // Identical direction is 1, orthogonal is 0, opposite is -1. These are the
  // three points where an implementation that has confused dot-product for
  // cosine, or forgotten to normalize, gives a different answer.
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);

  // Magnitude must NOT change the score — this is the property that separates
  // cosine from dot-product, and the one a "works on my fixture" test misses
  // because fixtures are usually unit vectors already.
  assert.equal(cosineSimilarity([1, 0], [7, 0]), 1);
  assert.equal(
    cosineSimilarity([3, 4], [3, 4]),
    cosineSimilarity([3, 4], [30, 40]),
  );

  // 45 degrees between them.
  const diagonal = cosineSimilarity([1, 0], [1, 1]);
  assert.ok(Math.abs(diagonal - Math.SQRT1_2) < 1e-12, `got ${diagonal}`);
});

test("cosine similarity refuses a zero vector instead of returning NaN", () => {
  // A zero vector has no direction, so cosine is undefined. Returning NaN would
  // sort as neither greater nor less than anything and silently drop the doc to
  // the bottom of a ranking rather than announcing the corrupt row.
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /zero vector/i);
});

test("cosine similarity refuses mismatched lengths", () => {
  assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /length/i);
});

test("a well-formed index loads from a bundle entry", () => {
  const bundle = bundleWith("scopes/public/sites/example.com/vectors.json", indexJson());
  const result = loadCorpusIndexFromBundle(bundle, {
    path: "scopes/public/sites/example.com/vectors.json",
  });
  assert.equal(result.ok, true);
  assert.equal(result.index.model, MODEL);
  assert.equal(result.index.dimensions, 2);
  assert.equal(result.index.docs.length, 2);
});

test("loading a corpus index is NOT subject to the 64KB reader budget", () => {
  // readSiteStorageFileFromBundle truncates at 64_000 bytes by default
  // (local-actions-catalog.mjs:213). A truncated vector table parses as invalid
  // JSON if you are lucky and as a SHORT CORPUS if you are not — a search that
  // silently stops covering the tail of the corpus. This loader must read the
  // bundle entry directly, so a >64KB index must round-trip intact.
  const docs = Array.from({ length: 4000 }, (_, i) => ({
    id: `doc-${i}`,
    vector: [i, 1],
  }));
  const text = JSON.stringify({ schema_version: 1, model: MODEL, dimensions: 2, docs });
  assert.ok(text.length > 64_000, `fixture must exceed the budget, got ${text.length}`);

  const result = loadCorpusIndexFromBundle(bundleWith("vectors.json", text), {
    path: "vectors.json",
  });
  assert.equal(result.ok, true);
  assert.equal(result.index.docs.length, 4000);
});

test("an unknown schema_version is refused, not coerced", () => {
  // Failing closed on an unrecognized version is what lets the format change
  // later without a silently-misread index in the field.
  const result = loadCorpusIndexFromBundle(
    bundleWith("vectors.json", indexJson({ schema_version: 99 })),
    { path: "vectors.json" },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.code, /schema/i);
});

test("a doc whose vector length disagrees with the header is refused", () => {
  // The header says 2 dimensions; this doc has 3. Ranking would still "work"
  // and return a plausible ordering, which is why this must be caught at load.
  const broken = indexJson({
    docs: [
      { id: "east", vector: [1, 0] },
      { id: "bad", vector: [1, 0, 0] },
    ],
  });
  const result = loadCorpusIndexFromBundle(bundleWith("vectors.json", broken), {
    path: "vectors.json",
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /dimension/i);
  assert.match(result.error.message, /bad/, "the message must name the offending doc");
});

test("a missing bundle entry is refused with the path it looked for", () => {
  const result = loadCorpusIndexFromBundle(bundleWith("other.json", indexJson()), {
    path: "vectors.json",
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /not_found/i);
  assert.match(result.error.message, /vectors\.json/);
});

test("malformed JSON is refused rather than throwing", () => {
  const result = loadCorpusIndexFromBundle(bundleWith("vectors.json", "{not json"), {
    path: "vectors.json",
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /parse/i);
});

test("ranking orders by similarity and carries the score", () => {
  const index = loadCorpusIndexFromBundle(bundleWith("v.json", indexJson()), {
    path: "v.json",
  }).index;
  const ranked = rankByCosine(index, [1, 0]);
  assert.equal(ranked[0].id, "east");
  assert.equal(ranked[0].score, 1);
  assert.equal(ranked[1].id, "north");
  assert.equal(ranked[1].score, 0);
});

test("ranking refuses a query whose dimensions disagree with the index", () => {
  // A 512-dim query against a 1536-dim index would otherwise throw deep inside
  // the loop, or worse, be silently truncated by a zip-style implementation.
  const index = loadCorpusIndexFromBundle(bundleWith("v.json", indexJson()), {
    path: "v.json",
  }).index;
  assert.throws(() => rankByCosine(index, [1, 0, 0]), /dimension/i);
});

test("ranking respects a limit without changing the order", () => {
  const index = loadCorpusIndexFromBundle(bundleWith("v.json", indexJson()), {
    path: "v.json",
  }).index;
  const ranked = rankByCosine(index, [1, 0], { limit: 1 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "east");
});
