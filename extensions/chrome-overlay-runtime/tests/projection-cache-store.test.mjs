import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECTION_CACHE_STORAGE_KEY,
  createProjectionCacheStore,
  readDeclaredProjectionCache,
} from "../src/agent/projection-cache-store.mjs";

const memoryStorage = (initial = {}) => {
  const values = structuredClone(initial);
  return {
    async get(key) { return { [key]: structuredClone(values[key]) }; },
    async set(items) { Object.assign(values, structuredClone(items)); },
    snapshot() { return structuredClone(values); },
  };
};

const entry = (entity_id, observed_at, value = { last_touched_at: observed_at }) => ({
  entity_id,
  value,
  content_hash: `sha256:${entity_id}`,
  observed_at,
  expires_at: "2026-08-01T00:00:00.000Z",
  provenance: "trello-visible-activity",
});

test("projection cache persists and rehydrates known entries", async () => {
  const storage = memoryStorage();
  const now = () => Date.parse("2026-07-20T00:00:00.000Z");
  const store = createProjectionCacheStore({ storage, now });
  await store.upsert({
    siteHost: "trello.com",
    groupId: "ordinary-extension",
    namespace: "trello.card-digest",
    entries: [entry("card-1", "2026-07-19T12:00:00.000Z")],
  });

  const restarted = createProjectionCacheStore({ storage, now });
  const cache = await restarted.read({
    siteHost: "www.trello.com",
    groupId: "ordinary-extension",
    namespaces: ["trello.card-digest"],
  });
  assert.equal(cache["trello.card-digest"]["card-1"].freshness, "known");
  assert.equal(cache["trello.card-digest"]["card-1"].value.last_touched_at, "2026-07-19T12:00:00.000Z");
  assert.equal(storage.snapshot()[PROJECTION_CACHE_STORAGE_KEY].version, 1);
});

test("projection cache ignores malformed persisted entries instead of failing reads", async () => {
  const valid = {
    siteHost: "trello.com",
    groupId: "group-a",
    namespace: "cards",
    entityId: "valid",
    value: { last_touched_at: "2026-07-19T00:00:00.000Z" },
    contentHash: "sha256:valid",
    observedAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    provenance: "trello-visible-activity",
  };
  const storage = memoryStorage({
    [PROJECTION_CACHE_STORAGE_KEY]: {
      version: 1,
      entries: [null, { siteHost: "trello.com" }, { ...valid, expiresAt: "not-a-date" }, valid],
    },
  });
  const store = createProjectionCacheStore({ storage, now: () => Date.parse("2026-07-20T00:00:00.000Z") });
  const cache = await store.read({ siteHost: "trello.com", groupId: "group-a", namespaces: ["cards"] });
  assert.deepEqual(Object.keys(cache.cards), ["valid"]);
});

test("projection cache isolates site, group, and namespace", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({ storage, now: () => Date.parse("2026-07-20T00:00:00.000Z") });
  for (const [siteHost, groupId, namespace, entityId] of [
    ["trello.com", "group-a", "cards", "a"],
    ["trello.com", "group-b", "cards", "b"],
    ["example.com", "group-a", "cards", "c"],
    ["trello.com", "group-a", "other", "d"],
  ]) {
    await store.upsert({ siteHost, groupId, namespace, entries: [entry(entityId, "2026-07-19T00:00:00.000Z")] });
  }
  assert.deepEqual(Object.keys((await store.read({ siteHost: "trello.com", groupId: "group-a", namespaces: ["cards"] })).cards), ["a"]);
});

test("declared projection reads never turn an empty namespace list into ambient access", async () => {
  let reads = 0;
  const store = {
    async read() {
      reads += 1;
      return { secret_namespace: { hidden: true } };
    },
  };
  assert.deepEqual(await readDeclaredProjectionCache({ store, scope: {}, namespaces: [] }), {});
  assert.equal(reads, 0);
  assert.deepEqual(
    await readDeclaredProjectionCache({ store, scope: {}, namespaces: ["cards"] }),
    { secret_namespace: { hidden: true } },
  );
  assert.equal(reads, 1);
});

test("projection cache marks expired entries stale", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({ storage, now: () => Date.parse("2026-08-02T00:00:00.000Z") });
  await store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("a", "2026-07-19T00:00:00.000Z")] });
  const cache = await store.read({ siteHost: "trello.com", groupId: "group-a", namespaces: ["cards"] });
  assert.equal(cache.cards.a.freshness, "stale");
});

test("projection cache evicts deterministically oldest-first at every bound", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({
    storage,
    now: () => Date.parse("2026-07-20T00:00:00.000Z"),
    limits: { maxEntriesPerNamespace: 2, maxEntriesPerSiteGroup: 3, maxEntriesGlobal: 4 },
  });
  await store.upsert({
    siteHost: "trello.com",
    groupId: "group-a",
    namespace: "cards",
    entries: [
      entry("old", "2026-07-10T00:00:00.000Z"),
      entry("middle", "2026-07-11T00:00:00.000Z"),
      entry("new", "2026-07-12T00:00:00.000Z"),
    ],
  });
  assert.deepEqual(Object.keys((await store.read({ siteHost: "trello.com", groupId: "group-a", namespaces: ["cards"] })).cards), ["middle", "new"]);
});

test("projection cache rejects oversized and secret-bearing values", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({ storage, limits: { maxValueBytes: 40 } });
  await assert.rejects(
    store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("a", "2026-07-19T00:00:00.000Z", { token: "hidden" })] }),
    /secret-bearing/,
  );
  await assert.rejects(
    store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("b", "2026-07-19T00:00:00.000Z", { text: "x".repeat(200) })] }),
    /byte limit/,
  );
});

test("projection cache invalidates exact entities and can clear a group", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({ storage });
  await store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("a", "2026-07-19T00:00:00.000Z"), entry("b", "2026-07-19T01:00:00.000Z")] });
  assert.deepEqual(await store.invalidate({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entityIds: ["a"] }), { invalidated: 1 });
  assert.deepEqual(Object.keys((await store.read({ siteHost: "trello.com", groupId: "group-a", namespaces: ["cards"] })).cards), ["b"]);
  assert.deepEqual(await store.clearGroup({ groupId: "group-a" }), { removed: 1 });
});

test("projection cache can invalidate one namespace without crossing scope", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({ storage });
  await store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("a", "2026-07-19T00:00:00.000Z")] });
  await store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "other", entries: [entry("b", "2026-07-19T00:00:00.000Z")] });
  assert.deepEqual(await store.invalidateNamespace({ siteHost: "trello.com", groupId: "group-a", namespace: "cards" }), { invalidated: 1 });
  const cache = await store.read({ siteHost: "trello.com", groupId: "group-a" });
  assert.equal(cache.cards, undefined);
  assert.deepEqual(Object.keys(cache.other), ["b"]);
});

test("projection cache serializes concurrent writers without losing entries", async () => {
  const storage = memoryStorage();
  const store = createProjectionCacheStore({ storage });
  await Promise.all([
    store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("a", "2026-07-19T00:00:00.000Z")] }),
    store.upsert({ siteHost: "trello.com", groupId: "group-a", namespace: "cards", entries: [entry("b", "2026-07-19T01:00:00.000Z")] }),
  ]);
  const cache = await store.read({ siteHost: "trello.com", groupId: "group-a", namespaces: ["cards"] });
  assert.deepEqual(Object.keys(cache.cards), ["a", "b"]);
});
