import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROJECTION_EMBEDDING_CACHE_BYTES,
  createProjectionEmbeddingCache,
} from "../src/agent/projection-embedding-cache.mjs";

function memoryAdapter({ fail = null } = {}) {
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const check = (operation) => {
    if (fail?.(operation)) throw new Error(`adapter ${operation} failed`);
  };
  return {
    async get(name, key) { check("get"); return structuredClone(store(name).get(key)); },
    async put(name, key, value) { check("put"); store(name).set(key, structuredClone(value)); },
    async delete(name, key) { check("delete"); store(name).delete(key); },
    async entries(name) { check("entries"); return [...store(name).entries()].map(([key, value]) => [key, structuredClone(value)]); },
    async clear(name) { check("clear"); store(name).clear(); },
    stores,
  };
}

const scope = (overrides = {}) => ({
  host: "EXAMPLE.com.",
  semanticNamespace: "trello.board",
  permissionRevision: "permission-1",
  catalogRevision: "catalog-1",
  ...overrides,
});

const identity = (text, overrides = {}) => ({
  text,
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  normalization: "nfc-lf",
  schemaVersion: 1,
  ...overrides,
});

test("uses a 50 MiB configurable soft default and content-addresses every vector input", async () => {
  assert.equal(DEFAULT_PROJECTION_EMBEDDING_CACHE_BYTES, 50 * 1024 * 1024);
  const adapter = memoryAdapter();
  const cache = createProjectionEmbeddingCache({ adapter, maxBytes: 1024 });
  const first = await cache.putVector(scope(), identity("Cafe\u0301\r\ncard"), [1, 0, 0]);
  const equivalent = await cache.getVector(scope(), identity("Café\ncard"));
  assert.equal(first.ok, true);
  assert.deepEqual(equivalent.vector, [1, 0, 0]);

  for (const changed of [
    { provider: "other" }, { model: "other" }, { dimensions: 4 },
    { normalization: "none" }, { schemaVersion: 2 },
  ]) {
    assert.equal((await cache.getVector(scope(), identity("Café\ncard", changed))).status, "miss");
  }
});

test("isolates normalized host and semantic namespace", async () => {
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter() });
  await cache.putVector(scope(), identity("card"), [1, 2, 3]);
  assert.equal((await cache.getVector(scope({ host: "example.com" }), identity("card"))).status, "hit");
  assert.equal((await cache.getVector(scope({ host: "other.example" }), identity("card"))).status, "miss");
  assert.equal((await cache.getVector(scope({ semanticNamespace: "other" }), identity("card"))).status, "miss");
});

test("evicts least-recently-used unpinned vectors only on admission", async () => {
  let now = 10;
  const adapter = memoryAdapter();
  const cache = createProjectionEmbeddingCache({ adapter, maxBytes: 1_500, now: () => ++now });
  const vectorIdentity = (text) => identity(text, { dimensions: 30 });
  await cache.putVector(scope(), vectorIdentity("old"), Array(30).fill(0.1));
  await cache.putVector(scope(), vectorIdentity("recent"), Array(30).fill(0.2));
  await cache.getVector(scope(), vectorIdentity("old"));
  const before = await cache.inspect(scope());
  await cache.putVector(scope(), vectorIdentity("new"), Array(30).fill(0.3));
  const after = await cache.inspect(scope());

  assert.ok(before.total_bytes <= 1_500);
  assert.ok(after.total_bytes <= 1_500);
  assert.equal((await cache.getVector(scope(), vectorIdentity("old"))).status, "hit");
  assert.equal((await cache.getVector(scope(), vectorIdentity("recent"))).status, "miss");
  assert.equal((await cache.getVector(scope(), vectorIdentity("new"))).status, "hit");
});

test("active snapshot pins survive the soft limit and are released explicitly", async () => {
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter(), maxBytes: 500 });
  const vectorIdentity = (text, dimensions) => identity(text, { dimensions });
  const pinned = await cache.putVector(scope(), vectorIdentity("pinned", 80), Array(80).fill(0.1), { snapshotId: "snapshot-a" });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.over_soft_limit, true);
  await cache.putVector(scope(), vectorIdentity("disposable", 40), Array(40).fill(0.2));
  assert.equal((await cache.getVector(scope(), vectorIdentity("pinned", 80))).status, "hit");
  assert.equal((await cache.getVector(scope(), vectorIdentity("disposable", 40))).status, "miss");

  await cache.releaseSnapshotPins(scope(), "snapshot-a");
  await cache.putVector(scope(), vectorIdentity("replacement", 40), Array(40).fill(0.3));
  assert.equal((await cache.getVector(scope(), vectorIdentity("pinned", 80))).status, "miss");
});

test("a cache hit can be attached to a later active snapshot pin set", async () => {
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter(), maxBytes: 750 });
  await cache.putVector(scope(), identity("reused"), [1, 2, 3]);
  assert.equal((await cache.pinSnapshotVectors(scope(), "snapshot-b", [identity("reused")])).pinned, 1);
  await cache.putVector(scope(), identity("pressure", { dimensions: 50 }), Array(50).fill(0.4));
  assert.equal((await cache.getVector(scope(), identity("reused"))).status, "hit");
  await cache.releaseSnapshotPins(scope(), "snapshot-b");
});

test("permission and catalog revision changes purge the isolated namespace", async () => {
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter() });
  await cache.putVector(scope(), identity("card"), [1, 2, 3]);
  await cache.putBuildProgress(scope(), "build-a", { completed: 2, total: 5, pending_ids: ["c"] });
  assert.equal((await cache.reconcileAuthority(scope())).purged, 0);
  const changed = scope({ permissionRevision: "permission-2" });
  assert.equal((await cache.reconcileAuthority(changed)).purged, 2);
  assert.equal((await cache.getVector(changed, identity("card"))).status, "miss");

  await cache.putVector(changed, identity("again"), [3, 2, 1]);
  const catalogChanged = scope({ permissionRevision: "permission-2", catalogRevision: "catalog-2" });
  assert.equal((await cache.reconcileAuthority(catalogChanged)).purged, 1);
  await cache.putVector(catalogChanged, identity("again"), [3, 2, 1]);
  assert.equal((await cache.purge({ host: "example.com", semanticNamespace: "trello.board" })).purged, 1);
});

test("persists resumable build progress without TTL expiry", async () => {
  let now = 1;
  const adapter = memoryAdapter();
  const first = createProjectionEmbeddingCache({ adapter, now: () => now });
  await first.putBuildProgress(scope(), "build-a", { completed: 2, total: 5, pending_ids: ["c", "d", "e"] });
  now = Number.MAX_SAFE_INTEGER;
  const restarted = createProjectionEmbeddingCache({ adapter, now: () => now });
  const result = await restarted.getBuildProgress(scope(), "build-a");
  assert.equal(result.status, "hit");
  assert.deepEqual(result.progress, { completed: 2, total: 5, pending_ids: ["c", "d", "e"] });
});

test("serializes concurrent admissions so byte limits and records remain coherent", async () => {
  const cache = createProjectionEmbeddingCache({ adapter: memoryAdapter(), maxBytes: 1_500 });
  const writes = Array.from({ length: 12 }, (_, index) => cache.putVector(
    scope(),
    identity(`field-${index}`, { dimensions: 30 }),
    Array(30).fill(index / 100),
  ));
  const results = await Promise.all(writes);
  assert.ok(results.every((result) => result.ok));
  const state = await cache.inspect();
  assert.ok(state.total_bytes <= 1_500);
  assert.ok(state.entries > 0);
});

test("batch admission stores all vectors and applies the soft limit once", async () => {
  const adapter = memoryAdapter();
  const cache = createProjectionEmbeddingCache({ adapter, maxBytes: 10_000 });
  const result = await cache.putVectors(scope(), [
    { identity: identity("one"), vector: [1, 0, 0] },
    { identity: identity("two"), vector: [0, 1, 0] },
    { identity: identity("three"), vector: [0, 0, 1] },
  ], { snapshotId: "snapshot-batch" });
  assert.equal(result.ok, true);
  assert.equal(result.admitted, 3);
  assert.equal((await cache.getVector(scope(), identity("one"))).status, "hit");
  assert.equal((await cache.getVector(scope(), identity("two"))).status, "hit");
  assert.equal((await cache.getVector(scope(), identity("three"))).status, "hit");
  const batch = await cache.getVectors(scope(), [identity("one"), identity("missing"), identity("three")]);
  assert.deepEqual(batch.results.map((entry) => entry.status), ["hit", "miss", "hit"]);
});

test("corruption and adapter read/write/quota failures degrade without throwing", async () => {
  const adapter = memoryAdapter();
  const cache = createProjectionEmbeddingCache({ adapter });
  const saved = await cache.putVector(scope(), identity("bad"), [1, 2, 3]);
  const vectorStore = adapter.stores.get("vectors");
  const [storedKey] = [...vectorStore.keys()];
  vectorStore.set(storedKey, { malformed: true });
  const corrupt = await cache.getVector(scope(), identity("bad"));
  assert.equal(corrupt.status, "degraded");
  assert.equal(corrupt.reason, "cache_corrupt");
  assert.equal(saved.ok, true);

  for (const operation of ["get", "put", "entries", "delete"]) {
    const broken = createProjectionEmbeddingCache({ adapter: memoryAdapter({ fail: (name) => name === operation }) });
    const result = operation === "get"
      ? await broken.getVector(scope(), identity("x"))
      : operation === "put"
        ? await broken.putVector(scope(), identity("x"), [1, 2, 3])
        : operation === "entries"
          ? await broken.inspect(scope())
          : await broken.purge(scope());
    assert.equal(result.ok, false);
    assert.equal(result.status, "degraded");
    assert.match(result.reason, /^cache_/);
  }
});
