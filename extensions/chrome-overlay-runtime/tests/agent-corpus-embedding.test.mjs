import assert from "node:assert/strict";
import test from "node:test";

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  buildCorpusIndex,
  embedQuery,
  embedTexts,
} from "../src/agent/corpus-embedding.mjs";

function okResponse(vectors) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: vectors.map((embedding) => ({ embedding })) }),
  };
}

// Responses are consumed IN ORDER and never repeated — a fixture that replays
// its last response cannot express "the second batch failed", which is exactly
// the partial-failure case that matters most here.
function recordingFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[index];
    index += 1;
    if (!next) {
      throw new Error(`fixture exhausted after ${responses.length} responses`);
    }
    return typeof next === "function" ? next() : next;
  };
  return { calls, fetchImpl };
}

test("a query embed requests the pinned model and dimensions", () => {
  // The index and the query MUST be produced by the same model at the same
  // dimensions or cosine similarity compares incomparable spaces — and it does
  // so silently, returning a plausible ranking. Pinning both here is what makes
  // corpus-index's dimension check meaningful rather than decorative.
  // Full-width vector: this test exercises the SHIPPING defaults, so the
  // fixture has to return what the shipping dimensions ask for.
  const wide = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
  const { calls, fetchImpl } = recordingFetch([okResponse([wide])]);
  return embedQuery("backup my catalog", { apiKey: "sk-test", fetchImpl }).then(
    (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.vector.length, EMBEDDING_DIMENSIONS);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
      assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
      assert.equal(calls[0].init.redirect, "error");
      assert.equal(calls[0].body.model, EMBEDDING_MODEL);
      assert.equal(calls[0].body.dimensions, EMBEDDING_DIMENSIONS);
      assert.equal(calls[0].body.input, "backup my catalog");
    },
  );
});

test("embedding transport rejects non-HTTPS endpoints before fetch", async () => {
  let calls = 0;
  const result = await embedTexts(["private page field"], {
    apiKey: "sk-test",
    endpoint: "http://api.openai.com/v1/embeddings",
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /insecure/);
  assert.equal(calls, 0);
});

test("field embedding batches reject redirects at the fetch boundary", async () => {
  const { calls, fetchImpl } = recordingFetch([okResponse([[1, 0], [0, 1]])]);
  const result = await embedTexts(["one", "two"], { apiKey: "sk-test", fetchImpl, dimensions: 2 });
  assert.equal(result.ok, true);
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].body.input, ["one", "two"]);
});

test("a missing API key fails LOUDLY and never as an empty result", async () => {
  // R6. This is the fabrication bug in miniature: a query embed that fails and
  // returns "no matches" is indistinguishable from a corpus that genuinely does
  // not cover the topic, and the agent answers from memory either way.
  const result = await embedQuery("anything", { apiKey: "", fetchImpl: async () => {
    throw new Error("must not be called");
  } });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /api_key/i);
  assert.ok(result.error.message.length > 0);
});

test("a non-200 embed response reports the status rather than swallowing it", async () => {
  const { fetchImpl } = recordingFetch([
    { ok: false, status: 429, json: async () => ({}) },
  ]);
  const result = await embedQuery("anything", { apiKey: "sk-test", fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /embed/i);
  assert.match(result.error.message, /429/);
});

test("a transport throw is reported, not propagated", async () => {
  // A hosted tool call must not die mid-turn on a network blip; it must return
  // a reason the caller can turn into a hedge.
  const result = await embedQuery("anything", {
    apiKey: "sk-test",
    fetchImpl: async () => {
      throw new TypeError("network down");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /unavailable|embed/i);
  assert.match(result.error.message, /network down/);
});

test("a response whose vector has the wrong width is refused", async () => {
  // If OpenAI ever ignores `dimensions`, the returned width silently disagrees
  // with the shipped index. Catch it at the boundary, not deep in ranking.
  const { fetchImpl } = recordingFetch([okResponse([[1, 0, 0]])]);
  const result = await embedQuery("anything", {
    apiKey: "sk-test",
    fetchImpl,
    dimensions: 2,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /dimension/i);
});

test("an empty query is refused before any network call", async () => {
  let called = false;
  const result = await embedQuery("   ", {
    apiKey: "sk-test",
    fetchImpl: async () => {
      called = true;
      return okResponse([[1, 0]]);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /query/i);
  assert.equal(called, false, "an empty query must not cost a request");
});

test("building an index embeds every document and pins the model in the artifact", async () => {
  const { calls, fetchImpl } = recordingFetch([okResponse([[1, 0], [0, 1]])]);
  const result = await buildCorpusIndex(
    [
      { id: "backup", text: "back up your catalog" },
      { id: "flip", text: "rotate or flip images" },
    ],
    { apiKey: "sk-test", fetchImpl, dimensions: 2 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.index.schema_version, 1);
  assert.equal(result.index.model, EMBEDDING_MODEL);
  assert.equal(result.index.dimensions, 2);
  assert.deepEqual(result.index.docs, [
    { id: "backup", vector: [1, 0] },
    { id: "flip", vector: [0, 1] },
  ]);
  assert.equal(calls.length, 1, "documents batch into one request");
  assert.deepEqual(calls[0].body.input, [
    "back up your catalog",
    "rotate or flip images",
  ]);
});

test("a partial batch failure fails the WHOLE build", async () => {
  // A half-built index is the worst artifact: it loads, it ranks, and it is
  // silently missing whatever the failed batch covered. Emitting nothing is
  // strictly better than emitting a table that lies about its coverage.
  // First batch succeeds fully (2 docs, 2 vectors) so the ONLY thing under test
  // is the second batch's 500 — not an incidental count mismatch in the first.
  const { fetchImpl } = recordingFetch([
    okResponse([[1, 0], [0, 1]]),
    { ok: false, status: 500, json: async () => ({}) },
  ]);
  const docs = Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, text: `t${i}` }));
  const result = await buildCorpusIndex(docs, {
    apiKey: "sk-test",
    fetchImpl,
    dimensions: 2,
    batchSize: 2,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /500/);
  assert.equal(result.index, undefined, "no partial artifact may escape");
});

test("a response with the wrong number of embeddings is refused", async () => {
  // Two documents in, one vector back. Zipping would silently drop a doc.
  const { fetchImpl } = recordingFetch([okResponse([[1, 0]])]);
  const result = await buildCorpusIndex(
    [
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ],
    { apiKey: "sk-test", fetchImpl, dimensions: 2 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.code, /count|mismatch/i);
});

test("duplicate document ids are refused", async () => {
  // Two rows with the same id make a ranking ambiguous and a rebuild
  // undiagnosable.
  const result = await buildCorpusIndex(
    [
      { id: "same", text: "one" },
      { id: "same", text: "two" },
    ],
    { apiKey: "sk-test", fetchImpl: async () => okResponse([[1, 0], [0, 1]]), dimensions: 2 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.code, /duplicate/i);
  assert.match(result.error.message, /same/);
});

test("an empty corpus is refused rather than producing an empty index", async () => {
  const result = await buildCorpusIndex([], {
    apiKey: "sk-test",
    fetchImpl: async () => okResponse([]),
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /empty/i);
});

test("a document with blank text is refused, naming it", async () => {
  const result = await buildCorpusIndex(
    [
      { id: "good", text: "content" },
      { id: "blank", text: "   " },
    ],
    { apiKey: "sk-test", fetchImpl: async () => okResponse([[1, 0], [0, 1]]), dimensions: 2 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /blank/);
});
