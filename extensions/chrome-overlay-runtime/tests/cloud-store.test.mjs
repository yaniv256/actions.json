import assert from "node:assert/strict";
import test from "node:test";
import { createCloudStore, SPOOL_CAP } from "../src/agent/cloud-store.mjs";

// In-memory implementation of the four-call spool seam the store consumes
// (the browser build defaults to an IndexedDB-backed implementation of the
// same seam).
function memorySpool() {
  const rows = new Map();
  let nextId = 1;
  return {
    async add(v) {
      rows.set(nextId, v);
      return nextId++;
    },
    async getAll(limit) {
      return [...rows.entries()].slice(0, limit).map(([id, v]) => ({ id, ...v }));
    },
    async delete(ids) {
      for (const id of ids) rows.delete(id);
    },
    async count() {
      return rows.size;
    },
  };
}

const config = {
  bucket: "b",
  region: "eu-west-1",
  prefix: "actions-json",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "sekrit",
};

test("appendLine spools; flush PUTs one part with all lines and clears spool", async () => {
  const puts = [];
  const store = createCloudStore({
    getConfig: async () => config,
    idbFactory: memorySpool,
    fetchImpl: async (url, init) => {
      puts.push({ url, init });
      return { ok: true, status: 200, text: async () => "" };
    },
    now: () => new Date("2026-07-04T12:00:00Z"),
  });
  await store.appendLine("expenditure/2026-07-04/sess1", '{"a":1}');
  await store.appendLine("expenditure/2026-07-04/sess1", '{"a":2}');
  assert.equal(await store.pendingCount(), 2);
  await store.flush();
  assert.equal(puts.length, 1);
  assert.match(
    puts[0].url,
    /^https:\/\/b\.s3\.eu-west-1\.amazonaws\.com\/actions-json\/expenditure\/2026-07-04\/sess1\/part-[0-9TZ]+-[a-z0-9]{4}\.jsonl$/,
  );
  assert.equal(new TextDecoder().decode(puts[0].init.body), '{"a":1}\n{"a":2}\n');
  assert.ok(puts[0].init.headers.authorization.startsWith("AWS4-HMAC-SHA256"));
  assert.equal(await store.pendingCount(), 0);
});

test("flush groups lines by stream into separate parts", async () => {
  const puts = [];
  const store = createCloudStore({
    getConfig: async () => config,
    idbFactory: memorySpool,
    fetchImpl: async (url, init) => {
      puts.push({ url, body: new TextDecoder().decode(init.body) });
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  await store.appendLine("stream-a", "a1");
  await store.appendLine("stream-b", "b1");
  await store.appendLine("stream-a", "a2");
  await store.flush();
  assert.equal(puts.length, 2);
  const a = puts.find((p) => p.url.includes("/stream-a/"));
  const b = puts.find((p) => p.url.includes("/stream-b/"));
  assert.equal(a.body, "a1\na2\n");
  assert.equal(b.body, "b1\n");
});

test("failed flush keeps lines spooled", async () => {
  const store = createCloudStore({
    getConfig: async () => config,
    idbFactory: memorySpool,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  await store.appendLine("s", "x");
  await store.flush().catch(() => {});
  assert.equal(await store.pendingCount(), 1);
});

test("unconfigured: appendLine spools, flush no-ops without error", async () => {
  const store = createCloudStore({ getConfig: async () => null, idbFactory: memorySpool });
  await store.appendLine("s", "x");
  await store.flush();
  assert.equal(await store.pendingCount(), 1);
});

test("testWrite round-trips a probe object and surfaces S3 errors", async () => {
  const okStore = createCloudStore({
    getConfig: async () => config,
    idbFactory: memorySpool,
    fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => "" }),
  });
  const ok = await okStore.testWrite();
  assert.equal(ok.ok, true);

  const badStore = createCloudStore({
    getConfig: async () => config,
    idbFactory: memorySpool,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => "<Error><Code>SignatureDoesNotMatch</Code></Error>",
    }),
  });
  const bad = await badStore.testWrite();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /SignatureDoesNotMatch/);
});

test("put writes a single object under the prefix", async () => {
  const puts = [];
  const store = createCloudStore({
    getConfig: async () => config,
    idbFactory: memorySpool,
    fetchImpl: async (url, init) => {
      puts.push({ url, init });
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  await store.put("reports/summary.json", new TextEncoder().encode("{}"), "application/json");
  assert.equal(puts[0].url, "https://b.s3.eu-west-1.amazonaws.com/actions-json/reports/summary.json");
  assert.equal(puts[0].init.headers["content-type"], "application/json");
});

test("spool cap evicts oldest and records a marker", async () => {
  const spool = memorySpool();
  const store = createCloudStore({ getConfig: async () => null, idbFactory: () => spool });
  for (let i = 0; i < SPOOL_CAP + 10; i++) await store.appendLine("s", `line-${i}`);
  const rows = await spool.getAll(SPOOL_CAP + 100);
  assert.ok(rows.length <= SPOOL_CAP + 1, `rows=${rows.length}`);
  assert.ok(rows.some((r) => r.line.includes('"kind":"spool_evicted"')));
  assert.ok(!rows.some((r) => r.line === "line-0"), "oldest line should be evicted");
});
