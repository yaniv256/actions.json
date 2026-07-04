// CloudStore: the extension's configurable persistence facility (spec 037).
// Consumers append JSONL lines to named streams; lines spool locally
// (IndexedDB in the browser; injectable seam in tests) and a flusher batches
// them into timestamped part objects on the configured backend. v1 backend:
// S3, signed with sigv4.mjs directly from the service worker — no SDK, no
// bridge dependency. Unconfigured stores still spool so no record is lost
// before setup; flush simply waits for configuration.

import { signS3Request } from "./sigv4.mjs";

export const SPOOL_CAP = 5000;

const IDB_NAME = "actions-json-cloud-spool";
const IDB_STORE = "lines";

// Default spool seam backed by IndexedDB. The seam is four async calls so
// tests can substitute a trivial in-memory map instead of faking full IDB.
function indexedDbSpool() {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE, { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(IDB_STORE, mode);
        const store = t.objectStore(IDB_STORE);
        const out = fn(store);
        t.oncomplete = () => resolve(out.result ?? out.value);
        t.onerror = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    add: (value) => tx("readwrite", (s) => s.add(value)),
    getAll: (limit) =>
      tx("readonly", (s) => {
        const out = { value: [] };
        const cursorReq = s.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && out.value.length < limit) {
            out.value.push({ id: cursor.key, ...cursor.value });
            cursor.continue();
          }
        };
        return out;
      }),
    delete: (ids) =>
      tx("readwrite", (s) => {
        for (const id of ids) s.delete(id);
        return { value: undefined };
      }),
    count: () => tx("readonly", (s) => s.count()),
  };
}

export function createCloudStore({
  getConfig,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  idbFactory = indexedDbSpool,
  now = () => new Date(),
} = {}) {
  const spool = idbFactory();

  const objectUrl = (config, key) =>
    `https://${config.bucket}.s3.${config.region}.amazonaws.com/` +
    `${config.prefix.replace(/\/$/, "")}/${key}`;

  async function signedPut(config, key, bytes, contentType) {
    const url = objectUrl(config, key);
    const headers = await signS3Request({
      method: "PUT",
      url,
      headers: contentType ? { "content-type": contentType } : {},
      bodyBytes: bytes,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      date: now(),
    });
    const res = await fetchImpl(url, { method: "PUT", headers, body: bytes });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`s3_put_failed status=${res.status} ${detail.slice(0, 300)}`);
    }
    return res;
  }

  async function enforceCap() {
    const count = await spool.count();
    if (count <= SPOOL_CAP) return;
    const excess = count - SPOOL_CAP;
    const oldest = await spool.getAll(excess);
    await spool.delete(oldest.map((r) => r.id));
    await spool.add({
      streamKey: oldest[0]?.streamKey ?? "unknown",
      line: JSON.stringify({
        kind: "spool_evicted",
        count: excess,
        ts: now().toISOString(),
      }),
      ts: Date.now(),
    });
  }

  return {
    async appendLine(streamKey, line) {
      await spool.add({ streamKey, line, ts: Date.now() });
      await enforceCap();
    },

    async pendingCount() {
      return spool.count();
    },

    async put(key, bytes, contentType) {
      const config = await getConfig();
      if (!config) throw new Error("cloud_store_unconfigured");
      await signedPut(config, key, bytes, contentType);
    },

    async flush() {
      const config = await getConfig();
      if (!config) return { flushed: 0, reason: "unconfigured" };
      const rows = await spool.getAll(SPOOL_CAP + 1);
      if (rows.length === 0) return { flushed: 0 };

      const byStream = new Map();
      for (const row of rows) {
        if (!byStream.has(row.streamKey)) byStream.set(row.streamKey, []);
        byStream.get(row.streamKey).push(row);
      }

      let flushed = 0;
      for (const [streamKey, streamRows] of byStream) {
        const stamp = now().toISOString().replace(/[-:.]/g, "").replace(/\d{3}Z$/, "Z");
        const rand = Math.random().toString(36).slice(2, 6);
        const key = `${streamKey}/part-${stamp}-${rand}.jsonl`;
        const body = new TextEncoder().encode(
          streamRows.map((r) => r.line).join("\n") + "\n",
        );
        await signedPut(config, key, body, "application/jsonl");
        await spool.delete(streamRows.map((r) => r.id));
        flushed += streamRows.length;
      }
      return { flushed };
    },

    async list(prefix) {
      const config = await getConfig();
      if (!config) throw new Error("cloud_store_unconfigured");
      const fullPrefix = `${config.prefix.replace(/\/$/, "")}/${prefix}`;
      const url =
        `https://${config.bucket}.s3.${config.region}.amazonaws.com/` +
        `?list-type=2&prefix=${encodeURIComponent(fullPrefix)}`;
      const headers = await signS3Request({
        method: "GET",
        url,
        bodyBytes: new Uint8Array(0),
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        date: now(),
      });
      const res = await fetchImpl(url, { method: "GET", headers });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`s3_list_failed status=${res.status} ${detail.slice(0, 300)}`);
      }
      const xml = await res.text();
      return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    },

    async testWrite() {
      try {
        const config = await getConfig();
        if (!config) return { ok: false, error: "cloud_store_unconfigured" };
        const stamp = now().toISOString().replace(/[:.]/g, "-");
        await signedPut(
          config,
          `probe/test-write-${stamp}.json`,
          new TextEncoder().encode(JSON.stringify({ probe: true, ts: stamp })),
          "application/json",
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
  };
}
