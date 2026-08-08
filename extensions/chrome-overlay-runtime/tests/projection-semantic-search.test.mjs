import assert from "node:assert/strict";
import test from "node:test";

import { createProjectionEmbeddingCache } from "../src/agent/projection-embedding-cache.mjs";
import { runProjectionSemanticSearch } from "../src/agent/projection-semantic-search.mjs";

const dimensions = 512;
const vector = (axis) => Array.from({ length: dimensions }, (_, index) => index === axis ? 1 : 0);

function memoryAdapter() {
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    async get(name, key) { return structuredClone(store(name).get(key)); },
    async put(name, key, value) { store(name).set(key, structuredClone(value)); },
    async delete(name, key) { store(name).delete(key); },
    async entries(name) { return [...store(name)].map(([key, value]) => [key, structuredClone(value)]); },
    async clear(name) { store(name).clear(); },
  };
}

const prepared = {
  snapshot_id: "snap-1",
  projection_name: "board",
  catalog_revision: "catalog-1",
  lexical_result: {
    ok: true,
    mode: "lexical",
    status: "matches",
    matches: [{ ref: "n1", type: "card", score: 10, fields: [{ field: "title", snippet: "Exact card" }] }],
    coverage: { complete: true },
  },
  candidates: [
    { id: "f1", node_ref: "n1", field: "title", path: "n1/title", node_type: "card", ancestry: ["root"], value: "Exact card" },
    { id: "f2", node_ref: "n2", field: "description", path: "n2/description", node_type: "card", ancestry: ["root"], value: "photographic color workflow" },
  ],
  coverage: { graph: { complete: true }, candidates: { complete: true } },
};

const scope = {
  host: "trello.com",
  semanticNamespace: "board",
  permissionRevision: "p1",
  catalogRevision: "catalog-1",
};

test("missing and untrusted policy cause zero credential reads and zero embedding calls", async () => {
  for (const [config, trustedCatalog] of [[null, true], [{ policy: { mode: "all" } }, false]]) {
    let credentials = 0;
    let network = 0;
    const result = await runProjectionSemanticSearch({
      prepared,
      config,
      trustedCatalog,
      query: "color",
      cache: createProjectionEmbeddingCache({ adapter: memoryAdapter() }),
      cacheScope: scope,
      loadApiKey: async () => { credentials += 1; return "sk-test"; },
      embedTexts: async () => { network += 1; return { ok: true, vectors: [] }; },
    });
    assert.equal(result.mode, "lexical");
    assert.equal(result.semantic.status, "degraded");
    assert.equal(credentials, 0);
    assert.equal(network, 0);
  }
});

test("trusted policy embeds only selected fields, preserves exact lexical first, and fills semantically", async () => {
  const calls = [];
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter() });
  const result = await runProjectionSemanticSearch({
    prepared,
    config: { policy: { mode: "include", fields: ["description"] } },
    trustedCatalog: true,
    query: "color",
    cache,
    cacheScope: scope,
    loadApiKey: async () => "sk-private",
    embedTexts: async (texts, options) => {
      calls.push({ texts, key: options.apiKey });
      return { ok: true, vectors: texts.map(() => vector(1)) };
    },
  });
  assert.equal(result.mode, "hybrid");
  assert.deepEqual(calls.map((call) => call.texts), [["photographic color workflow"], ["color"]]);
  assert.equal(calls.every((call) => call.key === "sk-private"), true);
  assert.deepEqual(result.matches.map((match) => match.ref), ["n2"]);
  assert.deepEqual(result.internal_ranked_matches.map((match) => match.ref), ["n2"]);
  assert.equal(result.semantic.progress.complete, true);
});

test("cached fields are reused and a partial provider failure reports resumable progress", async () => {
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter() });
  let fieldCalls = 0;
  const first = await runProjectionSemanticSearch({
    prepared,
    config: { policy: { mode: "all" } },
    trustedCatalog: true,
    query: "color",
    cache,
    cacheScope: scope,
    apiKey: "sk-test",
    batchSize: 1,
    embedTexts: async (texts) => {
      if (texts.length === 1 && texts[0] === "Exact card") { fieldCalls += 1; return { ok: true, vectors: [vector(0)] }; }
      if (texts.length === 1 && texts[0] === "photographic color workflow") return { ok: false, error: { code: "embedding_unavailable" } };
      return { ok: true, vectors: [vector(0)] };
    },
  });
  assert.equal(first.status, "incomplete");
  assert.equal(first.semantic.progress.completed_fields, 1);

  await runProjectionSemanticSearch({
    prepared,
    config: { policy: { mode: "all" } },
    trustedCatalog: true,
    query: "color",
    cache,
    cacheScope: scope,
    apiKey: "sk-test",
    batchSize: 1,
    embedTexts: async () => ({ ok: true, vectors: [vector(0)] }),
  });
  assert.equal(fieldCalls, 1, "the completed field remains cached across the resumed search");
});
