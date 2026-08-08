export const PROJECTION_CACHE_STORAGE_KEY = "ACTIONS_JSON_PROJECTION_CACHE_V1";

export const DEFAULT_PROJECTION_CACHE_LIMITS = Object.freeze({
  maxValueBytes: 8_000,
  maxEntriesPerNamespace: 500,
  maxEntriesPerSiteGroup: 2_000,
  maxEntriesGlobal: 10_000,
  maxTtlMs: 30 * 24 * 60 * 60 * 1_000,
});

export async function readDeclaredProjectionCache({ store, scope, namespaces = [] } = {}) {
  if (!store?.read) throw new Error("Projection cache reader is unavailable.");
  if (!Array.isArray(namespaces)) throw new Error("Projection cache namespaces must be an array.");
  if (namespaces.length === 0) return {};
  return store.read({ ...scope, namespaces });
}

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SECRET_PATTERN = /(?:api[_-]?key|authorization|bearer|password|secret|token|private[_-]?key)/i;

const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const normalizeSegment = (value, name) => {
  const normalized = String(value || "").trim();
  if (!SEGMENT_PATTERN.test(normalized)) {
    throw new Error(`Invalid projection-cache ${name}.`);
  }
  return normalized;
};

const normalizeSiteHost = (value) => {
  const normalized = String(value || "").trim().toLowerCase().replace(/^www\./, "");
  if (!normalized || normalized.length > 253 || !/^[a-z0-9.-]+$/.test(normalized)) {
    throw new Error("Invalid projection-cache site host.");
  }
  return normalized;
};

const containsSecretMaterial = (value, depth = 0) => {
  if (depth > 8 || value == null) return false;
  if (typeof value === "string") return /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/.test(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretMaterial(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => (
      SECRET_PATTERN.test(key) || containsSecretMaterial(nested, depth + 1)
    ));
  }
  return false;
};

const normalizeIso = (value, fallback) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};

const stableEntryKey = (entry) => [entry.siteHost, entry.groupId, entry.namespace, entry.entityId].join("\u0000");

const sortOldestFirst = (left, right) => (
  Date.parse(left.observedAt) - Date.parse(right.observedAt)
  || stableEntryKey(left).localeCompare(stableEntryKey(right))
);

const storedEntryIsValid = (entry) => (
  entry
  && typeof entry === "object"
  && !Array.isArray(entry)
  && typeof entry.siteHost === "string"
  && typeof entry.groupId === "string"
  && typeof entry.namespace === "string"
  && typeof entry.entityId === "string"
  && entry.value !== undefined
  && typeof entry.contentHash === "string"
  && Number.isFinite(Date.parse(entry.observedAt))
  && Number.isFinite(Date.parse(entry.expiresAt))
  && typeof entry.provenance === "string"
);

const normalizeState = (value) => ({
  version: 1,
  entries: Array.isArray(value?.entries) ? value.entries.filter(storedEntryIsValid) : [],
});

const publicEntry = (entry, nowMs) => ({
  entity_id: entry.entityId,
  value: structuredClone(entry.value),
  content_hash: entry.contentHash,
  observed_at: entry.observedAt,
  expires_at: entry.expiresAt,
  provenance: entry.provenance,
  freshness: Date.parse(entry.expiresAt) > nowMs ? "known" : "stale",
});

export function createProjectionCacheStore({ storage, now = () => Date.now(), limits = {} } = {}) {
  if (!storage?.get || !storage?.set) throw new Error("Projection cache requires get/set storage.");
  const bounds = { ...DEFAULT_PROJECTION_CACHE_LIMITS, ...limits };
  let writeLane = Promise.resolve();

  const serializeWrite = (operation) => {
    const task = writeLane.then(operation, operation);
    writeLane = task.catch(() => {});
    return task;
  };

  const load = async () => {
    const stored = await storage.get(PROJECTION_CACHE_STORAGE_KEY);
    return normalizeState(stored?.[PROJECTION_CACHE_STORAGE_KEY]);
  };

  const save = async (state) => {
    await storage.set({ [PROJECTION_CACHE_STORAGE_KEY]: normalizeState(state) });
  };

  const normalizeEntry = ({ siteHost, groupId, namespace, entry }) => {
    const nowMs = now();
    const observedAt = normalizeIso(entry?.observed_at, new Date(nowMs).toISOString());
    const requestedExpiry = Date.parse(entry?.expires_at);
    const expiresAtMs = Number.isFinite(requestedExpiry)
      ? Math.min(Math.max(requestedExpiry, Date.parse(observedAt)), nowMs + bounds.maxTtlMs)
      : nowMs + bounds.maxTtlMs;
    const value = structuredClone(entry?.value);
    if (value === undefined || containsSecretMaterial(value)) {
      throw new Error("Projection-cache values must be JSON data without secret-bearing fields or tokens.");
    }
    if (byteLength(value) > bounds.maxValueBytes) {
      throw new Error("Projection-cache value exceeds the configured byte limit.");
    }
    return {
      siteHost: normalizeSiteHost(siteHost),
      groupId: normalizeSegment(groupId, "group id"),
      namespace: normalizeSegment(namespace, "namespace"),
      entityId: normalizeSegment(entry?.entity_id, "entity id"),
      value,
      contentHash: normalizeSegment(entry?.content_hash, "content hash"),
      observedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      provenance: normalizeSegment(entry?.provenance || "projection", "provenance"),
    };
  };

  const enforceBounds = (entries) => {
    const keep = new Map(entries.map((entry) => [stableEntryKey(entry), entry]));
    const evictOldest = (candidates, excess) => {
      for (const entry of candidates.sort(sortOldestFirst).slice(0, Math.max(0, excess))) {
        keep.delete(stableEntryKey(entry));
      }
    };

    const byNamespace = new Map();
    const bySiteGroup = new Map();
    for (const entry of keep.values()) {
      const namespaceKey = [entry.siteHost, entry.groupId, entry.namespace].join("\u0000");
      const siteGroupKey = [entry.siteHost, entry.groupId].join("\u0000");
      if (!byNamespace.has(namespaceKey)) byNamespace.set(namespaceKey, []);
      if (!bySiteGroup.has(siteGroupKey)) bySiteGroup.set(siteGroupKey, []);
      byNamespace.get(namespaceKey).push(entry);
      bySiteGroup.get(siteGroupKey).push(entry);
    }
    for (const entriesInNamespace of byNamespace.values()) {
      evictOldest(entriesInNamespace, entriesInNamespace.length - bounds.maxEntriesPerNamespace);
    }
    for (const entriesInSiteGroup of bySiteGroup.values()) {
      const retained = entriesInSiteGroup.filter((entry) => keep.has(stableEntryKey(entry)));
      evictOldest(retained, retained.length - bounds.maxEntriesPerSiteGroup);
    }
    const retained = [...keep.values()];
    evictOldest(retained, retained.length - bounds.maxEntriesGlobal);
    return [...keep.values()].sort((left, right) => stableEntryKey(left).localeCompare(stableEntryKey(right)));
  };

  return {
    async read({ siteHost, groupId, namespaces = [] } = {}) {
      const normalizedSite = normalizeSiteHost(siteHost);
      const normalizedGroup = normalizeSegment(groupId, "group id");
      const requested = new Set(namespaces.map((namespace) => normalizeSegment(namespace, "namespace")));
      const state = await load();
      const nowMs = now();
      const result = {};
      for (const entry of state.entries) {
        if (entry.siteHost !== normalizedSite || entry.groupId !== normalizedGroup) continue;
        if (requested.size > 0 && !requested.has(entry.namespace)) continue;
        result[entry.namespace] ||= {};
        result[entry.namespace][entry.entityId] = publicEntry(entry, nowMs);
      }
      return result;
    },

    async upsert({ siteHost, groupId, namespace, entries = [] } = {}) {
      if (!Array.isArray(entries)) throw new Error("Projection-cache entries must be an array.");
      return serializeWrite(async () => {
        const state = await load();
        const merged = new Map(state.entries.map((entry) => [stableEntryKey(entry), entry]));
        for (const candidate of entries) {
          const normalized = normalizeEntry({ siteHost, groupId, namespace, entry: candidate });
          merged.set(stableEntryKey(normalized), normalized);
        }
        state.entries = enforceBounds([...merged.values()]);
        await save(state);
        return { upserted: entries.length, retained: state.entries.length };
      });
    },

    async invalidate({ siteHost, groupId, namespace, entityIds = [] } = {}) {
      const normalizedSite = normalizeSiteHost(siteHost);
      const normalizedGroup = normalizeSegment(groupId, "group id");
      const normalizedNamespace = normalizeSegment(namespace, "namespace");
      const ids = new Set(entityIds.map((entityId) => normalizeSegment(entityId, "entity id")));
      return serializeWrite(async () => {
        const state = await load();
        const before = state.entries.length;
        state.entries = state.entries.filter((entry) => !(
          entry.siteHost === normalizedSite
          && entry.groupId === normalizedGroup
          && entry.namespace === normalizedNamespace
          && ids.has(entry.entityId)
        ));
        await save(state);
        return { invalidated: before - state.entries.length };
      });
    },

    async invalidateNamespace({ siteHost, groupId, namespace } = {}) {
      const normalizedSite = normalizeSiteHost(siteHost);
      const normalizedGroup = normalizeSegment(groupId, "group id");
      const normalizedNamespace = normalizeSegment(namespace, "namespace");
      return serializeWrite(async () => {
        const state = await load();
        const before = state.entries.length;
        state.entries = state.entries.filter((entry) => !(
          entry.siteHost === normalizedSite
          && entry.groupId === normalizedGroup
          && entry.namespace === normalizedNamespace
        ));
        await save(state);
        return { invalidated: before - state.entries.length };
      });
    },

    async clearGroup({ groupId } = {}) {
      const normalizedGroup = normalizeSegment(groupId, "group id");
      return serializeWrite(async () => {
        const state = await load();
        const before = state.entries.length;
        state.entries = state.entries.filter((entry) => entry.groupId !== normalizedGroup);
        await save(state);
        return { removed: before - state.entries.length };
      });
    },
  };
}
