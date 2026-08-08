const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECTION_EMBEDDING_CACHE_BYTES = 50 * 1024 * 1024;

const STORES = Object.freeze({
  vectors: "vectors",
  progress: "progress",
  authority: "authority",
});

const encoder = new TextEncoder();

function degraded(reason, error) {
  return {
    ok: false,
    status: "degraded",
    reason,
    ...(error?.message ? { detail: error.message } : {}),
  };
}

function assertNonemptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function normalizeHost(host) {
  assertNonemptyString("host", host);
  let normalized = host.trim().toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (normalized.includes("://")) {
    const parsed = new URL(normalized);
    normalized = parsed.hostname.toLowerCase().replace(/\.$/, "");
  }
  if (normalized === "" || /[\s/?#]/u.test(normalized)) throw new TypeError("host must be a hostname");
  return normalized;
}

function normalizeText(text, normalization) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  if (normalization === "none") return text;
  if (normalization === "nfc-lf") return text.replace(/\r\n?/gu, "\n").normalize("NFC");
  throw new TypeError(`unsupported normalization: ${normalization}`);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

async function sha256(value) {
  const bytes = encoder.encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scopeParts(scope) {
  if (!scope || typeof scope !== "object") throw new TypeError("cache scope is required");
  const host = normalizeHost(scope.host);
  assertNonemptyString("semanticNamespace", scope.semanticNamespace);
  assertNonemptyString("permissionRevision", scope.permissionRevision);
  assertNonemptyString("catalogRevision", scope.catalogRevision);
  const semantic_namespace = scope.semanticNamespace.trim();
  const base = canonical({ host, semantic_namespace });
  return {
    host,
    semantic_namespace,
    permission_revision: scope.permissionRevision,
    catalog_revision: scope.catalogRevision,
    base,
  };
}

function identityParts(identity) {
  if (!identity || typeof identity !== "object") throw new TypeError("embedding identity is required");
  for (const name of ["provider", "model", "normalization"]) assertNonemptyString(name, identity[name]);
  if (!Number.isInteger(identity.dimensions) || identity.dimensions <= 0) throw new TypeError("dimensions must be a positive integer");
  if (!Number.isInteger(identity.schemaVersion) || identity.schemaVersion <= 0) throw new TypeError("schemaVersion must be a positive integer");
  return {
    text: normalizeText(identity.text, identity.normalization),
    provider: identity.provider,
    model: identity.model,
    dimensions: identity.dimensions,
    normalization: identity.normalization,
    schema_version: identity.schemaVersion,
  };
}

function serializedBytes(value) {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function withByteSize(record) {
  const sized = { ...record, byte_size: 0 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const measured = serializedBytes(sized);
    if (measured === sized.byte_size) break;
    sized.byte_size = measured;
  }
  return sized;
}

function validVectorRecord(record, key) {
  return record
    && record.cache_schema_version === CACHE_SCHEMA_VERSION
    && record.key === key
    && typeof record.scope_base === "string"
    && Array.isArray(record.vector)
    && record.vector.length === record.identity?.dimensions
    && record.vector.every(Number.isFinite)
    && Array.isArray(record.pinned_by)
    && Number.isInteger(record.byte_size)
    && record.byte_size === serializedBytes(record);
}

function validProgressRecord(record, key) {
  return record
    && record.cache_schema_version === CACHE_SCHEMA_VERSION
    && record.key === key
    && typeof record.scope_base === "string"
    && record.progress && typeof record.progress === "object"
    && Number.isInteger(record.byte_size)
    && record.byte_size === serializedBytes(record);
}

/**
 * Persistent field-vector cache over a minimal IndexedDB-like adapter.
 *
 * Adapter methods are async get/put/delete/entries/clear. Persistence errors
 * deliberately become degraded results so lexical graph operation never waits
 * on or fails with the cache.
 */
export function createProjectionEmbeddingCache({
  adapter,
  maxBytes = DEFAULT_PROJECTION_EMBEDDING_CACHE_BYTES,
  now = Date.now,
} = {}) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("adapter is required");
  for (const method of ["get", "put", "delete", "entries", "clear"]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`adapter.${method} is required`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");

  let tail = Promise.resolve();
  const serialize = (work) => {
    const result = tail.then(work, work);
    tail = result.catch(() => {});
    return result;
  };

  const contentKey = async (scope, identity) => {
    const parsedScope = scopeParts(scope);
    const parsedIdentity = identityParts(identity);
    const digest = await sha256(canonical(parsedIdentity));
    return { parsedScope, parsedIdentity, key: `${parsedScope.base}\u001f${digest}` };
  };

  const progressKey = (parsedScope, buildId) => {
    assertNonemptyString("buildId", buildId);
    return `${parsedScope.base}\u001f${buildId}`;
  };

  const purgeBase = async (parsedScope) => {
    let purged = 0;
    for (const store of [STORES.vectors, STORES.progress]) {
      const records = await adapter.entries(store);
      for (const [key, record] of records) {
        if (record?.scope_base === parsedScope.base || key.startsWith(`${parsedScope.base}\u001f`)) {
          await adapter.delete(store, key);
          purged += 1;
        }
      }
    }
    await adapter.delete(STORES.authority, parsedScope.base);
    return purged;
  };

  const reconcile = async (parsedScope) => {
    const existing = await adapter.get(STORES.authority, parsedScope.base);
    const revisionChanged = existing && (
      existing.permission_revision !== parsedScope.permission_revision
      || existing.catalog_revision !== parsedScope.catalog_revision
      || existing.cache_schema_version !== CACHE_SCHEMA_VERSION
    );
    const purged = revisionChanged ? await purgeBase(parsedScope) : 0;
    await adapter.put(STORES.authority, parsedScope.base, {
      cache_schema_version: CACHE_SCHEMA_VERSION,
      permission_revision: parsedScope.permission_revision,
      catalog_revision: parsedScope.catalog_revision,
      updated_at: now(),
    });
    return purged;
  };

  const evictOnAdmission = async () => {
    const rows = await adapter.entries(STORES.vectors);
    let total = rows.reduce((sum, [, record]) => sum + (Number.isInteger(record?.byte_size) ? record.byte_size : serializedBytes(record)), 0);
    const candidates = rows
      .filter(([, record]) => Array.isArray(record?.pinned_by) && record.pinned_by.length === 0)
      .sort((a, b) => (a[1].last_accessed_at ?? 0) - (b[1].last_accessed_at ?? 0) || a[0].localeCompare(b[0]));
    const evicted = [];
    for (const [key, record] of candidates) {
      if (total <= maxBytes) break;
      await adapter.delete(STORES.vectors, key);
      total -= Number.isInteger(record.byte_size) ? record.byte_size : serializedBytes(record);
      evicted.push(key);
    }
    return { total_bytes: Math.max(0, total), over_soft_limit: total > maxBytes, evicted };
  };

  return Object.freeze({
    async getVector(scope, identity) {
      return serialize(async () => {
        try {
          const { parsedScope, key } = await contentKey(scope, identity);
          const purged = await reconcile(parsedScope);
          const record = await adapter.get(STORES.vectors, key);
          if (!record) return { ok: true, status: "miss", purged };
          if (!validVectorRecord(record, key)) {
            try { await adapter.delete(STORES.vectors, key); } catch {}
            return degraded("cache_corrupt");
          }
          const updated = withByteSize({ ...record, last_accessed_at: now() });
          try { await adapter.put(STORES.vectors, key, updated); } catch {
            return { ok: true, status: "hit", vector: [...record.vector], cache_write_degraded: true };
          }
          return { ok: true, status: "hit", vector: [...record.vector] };
        } catch (error) {
          return degraded("cache_read_failed", error);
        }
      });
    },

    async getVectors(scope, identities) {
      return serialize(async () => {
        try {
          if (!Array.isArray(identities)) throw new TypeError("identities must be an array");
          const parsedScope = scopeParts(scope);
          const purged = await reconcile(parsedScope);
          const results = [];
          for (const identity of identities) {
            const { key } = await contentKey(scope, identity);
            const record = await adapter.get(STORES.vectors, key);
            if (!record) {
              results.push({ ok: true, status: "miss" });
              continue;
            }
            if (!validVectorRecord(record, key)) {
              try { await adapter.delete(STORES.vectors, key); } catch {}
              results.push(degraded("cache_corrupt"));
              continue;
            }
            const updated = withByteSize({ ...record, last_accessed_at: now() });
            try { await adapter.put(STORES.vectors, key, updated); } catch {}
            results.push({ ok: true, status: "hit", vector: [...record.vector] });
          }
          return { ok: true, status: "complete", purged, results };
        } catch (error) {
          return degraded("cache_read_failed", error);
        }
      });
    },

    async putVector(scope, identity, vector, { snapshotId = null } = {}) {
      return serialize(async () => {
        try {
          const { parsedScope, parsedIdentity, key } = await contentKey(scope, identity);
          if (!Array.isArray(vector) || vector.length !== parsedIdentity.dimensions || !vector.every(Number.isFinite)) {
            throw new TypeError("vector must contain exactly dimensions finite numbers");
          }
          if (snapshotId !== null) assertNonemptyString("snapshotId", snapshotId);
          const purged = await reconcile(parsedScope);
          const existing = await adapter.get(STORES.vectors, key);
          const pinnedBy = new Set(validVectorRecord(existing, key) ? existing.pinned_by : []);
          if (snapshotId) pinnedBy.add(snapshotId);
          const timestamp = now();
          const record = withByteSize({
            cache_schema_version: CACHE_SCHEMA_VERSION,
            key,
            scope_base: parsedScope.base,
            host: parsedScope.host,
            semantic_namespace: parsedScope.semantic_namespace,
            permission_revision: parsedScope.permission_revision,
            catalog_revision: parsedScope.catalog_revision,
            identity: parsedIdentity,
            vector: [...vector],
            pinned_by: [...pinnedBy].sort(),
            created_at: validVectorRecord(existing, key) ? existing.created_at : timestamp,
            last_accessed_at: timestamp,
          });
          await adapter.put(STORES.vectors, key, record);
          const eviction = await evictOnAdmission();
          const admitted = Boolean(await adapter.get(STORES.vectors, key));
          return { ok: true, status: admitted ? "stored" : "not_admitted", admitted, purged, ...eviction };
        } catch (error) {
          return degraded("cache_write_failed", error);
        }
      });
    },

    async putVectors(scope, entries, { snapshotId = null } = {}) {
      return serialize(async () => {
        try {
          if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("entries must be a non-empty array");
          if (snapshotId !== null) assertNonemptyString("snapshotId", snapshotId);
          const parsedScope = scopeParts(scope);
          const purged = await reconcile(parsedScope);
          const keys = [];
          for (const entry of entries) {
            const { parsedIdentity, key } = await contentKey(scope, entry.identity);
            const vector = entry.vector;
            if (!Array.isArray(vector) || vector.length !== parsedIdentity.dimensions || !vector.every(Number.isFinite)) {
              throw new TypeError("vector must contain exactly dimensions finite numbers");
            }
            const existing = await adapter.get(STORES.vectors, key);
            const pinnedBy = new Set(validVectorRecord(existing, key) ? existing.pinned_by : []);
            if (snapshotId) pinnedBy.add(snapshotId);
            const timestamp = now();
            await adapter.put(STORES.vectors, key, withByteSize({
              cache_schema_version: CACHE_SCHEMA_VERSION,
              key,
              scope_base: parsedScope.base,
              host: parsedScope.host,
              semantic_namespace: parsedScope.semantic_namespace,
              permission_revision: parsedScope.permission_revision,
              catalog_revision: parsedScope.catalog_revision,
              identity: parsedIdentity,
              vector: [...vector],
              pinned_by: [...pinnedBy].sort(),
              created_at: validVectorRecord(existing, key) ? existing.created_at : timestamp,
              last_accessed_at: timestamp,
            }));
            keys.push(key);
          }
          const eviction = await evictOnAdmission();
          let admitted = 0;
          for (const key of keys) if (await adapter.get(STORES.vectors, key)) admitted += 1;
          return { ok: true, status: admitted === keys.length ? "stored" : "partially_admitted", admitted, attempted: keys.length, purged, ...eviction };
        } catch (error) {
          return degraded("cache_write_failed", error);
        }
      });
    },

    async releaseSnapshotPins(scope, snapshotId) {
      return serialize(async () => {
        try {
          const parsedScope = scopeParts(scope);
          assertNonemptyString("snapshotId", snapshotId);
          let released = 0;
          for (const [key, record] of await adapter.entries(STORES.vectors)) {
            if (record?.scope_base !== parsedScope.base || !record.pinned_by?.includes(snapshotId)) continue;
            const updated = withByteSize({ ...record, pinned_by: record.pinned_by.filter((id) => id !== snapshotId) });
            await adapter.put(STORES.vectors, key, updated);
            released += 1;
          }
          return { ok: true, status: "released", released };
        } catch (error) {
          return degraded("cache_write_failed", error);
        }
      });
    },

    async pinSnapshotVectors(scope, snapshotId, identities) {
      return serialize(async () => {
        try {
          const parsedScope = scopeParts(scope);
          assertNonemptyString("snapshotId", snapshotId);
          if (!Array.isArray(identities)) throw new TypeError("identities must be an array");
          await reconcile(parsedScope);
          let pinned = 0;
          let missing = 0;
          for (const identity of identities) {
            const { key } = await contentKey(scope, identity);
            const record = await adapter.get(STORES.vectors, key);
            if (!record) {
              missing += 1;
              continue;
            }
            if (!validVectorRecord(record, key)) {
              try { await adapter.delete(STORES.vectors, key); } catch {}
              missing += 1;
              continue;
            }
            if (!record.pinned_by.includes(snapshotId)) {
              await adapter.put(STORES.vectors, key, withByteSize({
                ...record,
                pinned_by: [...record.pinned_by, snapshotId].sort(),
              }));
            }
            pinned += 1;
          }
          return { ok: true, status: "pinned", pinned, missing };
        } catch (error) {
          return degraded("cache_write_failed", error);
        }
      });
    },

    async reconcileAuthority(scope) {
      return serialize(async () => {
        try {
          const purged = await reconcile(scopeParts(scope));
          return { ok: true, status: "ready", purged };
        } catch (error) {
          return degraded("cache_reconcile_failed", error);
        }
      });
    },

    async putBuildProgress(scope, buildId, progress) {
      return serialize(async () => {
        try {
          if (!progress || typeof progress !== "object" || Array.isArray(progress)) throw new TypeError("progress must be an object");
          const parsedScope = scopeParts(scope);
          await reconcile(parsedScope);
          const key = progressKey(parsedScope, buildId);
          const record = withByteSize({
            cache_schema_version: CACHE_SCHEMA_VERSION,
            key,
            scope_base: parsedScope.base,
            permission_revision: parsedScope.permission_revision,
            catalog_revision: parsedScope.catalog_revision,
            progress: structuredClone(progress),
            updated_at: now(),
          });
          await adapter.put(STORES.progress, key, record);
          return { ok: true, status: "stored" };
        } catch (error) {
          return degraded("cache_write_failed", error);
        }
      });
    },

    async getBuildProgress(scope, buildId) {
      return serialize(async () => {
        try {
          const parsedScope = scopeParts(scope);
          await reconcile(parsedScope);
          const key = progressKey(parsedScope, buildId);
          const record = await adapter.get(STORES.progress, key);
          if (!record) return { ok: true, status: "miss" };
          if (!validProgressRecord(record, key)) {
            try { await adapter.delete(STORES.progress, key); } catch {}
            return degraded("cache_corrupt");
          }
          return { ok: true, status: "hit", progress: structuredClone(record.progress), updated_at: record.updated_at };
        } catch (error) {
          return degraded("cache_read_failed", error);
        }
      });
    },

    async purge(scope = null) {
      return serialize(async () => {
        try {
          if (scope === null) {
            let purged = 0;
            for (const store of [STORES.vectors, STORES.progress]) {
              purged += (await adapter.entries(store)).length;
              await adapter.clear(store);
            }
            await adapter.clear(STORES.authority);
            return { ok: true, status: "purged", purged };
          }
          const purged = await purgeBase(scopeParts({
            permissionRevision: scope.permissionRevision ?? "purge",
            catalogRevision: scope.catalogRevision ?? "purge",
            ...scope,
          }));
          return { ok: true, status: "purged", purged };
        } catch (error) {
          return degraded("cache_purge_failed", error);
        }
      });
    },

    async inspect(scope = null) {
      return serialize(async () => {
        try {
          const parsedScope = scope === null ? null : scopeParts(scope);
          const rows = (await adapter.entries(STORES.vectors))
            .filter(([, record]) => parsedScope === null || record?.scope_base === parsedScope.base);
          const totalBytes = rows.reduce((sum, [, record]) => sum + (record?.byte_size ?? serializedBytes(record)), 0);
          return {
            ok: true,
            status: "ready",
            entries: rows.length,
            pinned_entries: rows.filter(([, record]) => record?.pinned_by?.length > 0).length,
            total_bytes: totalBytes,
            soft_limit_bytes: maxBytes,
            over_soft_limit: totalBytes > maxBytes,
          };
        } catch (error) {
          return degraded("cache_inspect_failed", error);
        }
      });
    },
  });
}
