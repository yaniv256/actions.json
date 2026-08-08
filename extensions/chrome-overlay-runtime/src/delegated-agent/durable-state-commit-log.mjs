const LOG_SCHEMA_VERSION = 1;

const clone = (value) => value == null ? value : structuredClone(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const compareRecords = (left, right) => (
  left.revision - right.revision
  || left.startedAtMs - right.startedAtMs
  || left.transactionId.localeCompare(right.transactionId)
);

const bounded = (operation, timeoutMs, label) => {
  let timer = null;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Append-only authority ledger for MV3 state.
 *
 * The ordinary storage key remains a readable mirror, but it is not the
 * authority once a committed ledger entry exists. A late write owned by a
 * destroyed service worker can therefore overwrite the mirror without erasing
 * a newer worker's commit. A data record is usable only when its separate ack
 * exists and no cancellation tombstone exists; late data writes from calls that
 * already failed remain inert.
 */
export function createDurableStateCommitLog({
  storage,
  mainKey,
  keyPrefix,
  validateState,
  ioTimeoutMs,
  clock = Date.now,
} = {}) {
  if (!storage?.get || !storage?.set) throw new Error("durable commit storage with get/set is required");
  if (typeof validateState !== "function") throw new Error("validateState is required");
  let revision = 0;

  const dataKey = (id) => `${keyPrefix}.data.${id}`;
  const ackKey = (id) => `${keyPrefix}.ack.${id}`;
  const cancelKey = (id) => `${keyPrefix}.cancel.${id}`;

  const readExact = async (key) => {
    const stored = await bounded(() => storage.get(key), ioTimeoutMs, `durable state read ${key}`);
    return stored?.[key];
  };

  const writeExact = async (key, value, label) => {
    try {
      await bounded(() => storage.set({ [key]: clone(value) }), ioTimeoutMs, label);
      return;
    } catch (error) {
      const observed = await readExact(key).catch(() => undefined);
      if (sameValue(observed, value)) return;
      throw error;
    }
  };

  // The compatibility mirror is the final, visible confirmation of a commit.
  // Do not abandon this write on a local timer: a timed-out write can still
  // land later and erase a recovery marker after the caller was told that the
  // transaction failed. The browser may suspend the worker while this Promise
  // is pending; replacement-worker recovery is designed for that case.
  const writeFinalMirror = async (value) => {
    try {
      await storage.set({ [mainKey]: clone(value) });
    } catch (error) {
      const observed = await readExact(mainKey).catch(() => undefined);
      if (sameValue(observed, value)) return;
      throw error;
    }
  };

  const cancel = async (id, reason) => {
    const tombstone = {
      schemaVersion: LOG_SCHEMA_VERSION,
      transactionId: id,
      cancelledAtMs: clock(),
      reason: String(reason?.message || reason || "cancelled"),
    };
    await writeExact(cancelKey(id), tombstone, "durable state cancellation write");
  };

  const readLatestRecord = async () => {
    const all = await bounded(() => storage.get(null), ioTimeoutMs, "durable state ledger scan");
    const candidates = [];
    let highestObservedRevision = revision;
    for (const [key, record] of Object.entries(isRecord(all) ? all : {})) {
      if (!key.startsWith(`${keyPrefix}.data.`) || !isRecord(record)) continue;
      const id = record.transactionId;
      if (
        record.schemaVersion !== LOG_SCHEMA_VERSION
        || typeof id !== "string"
        || id.length === 0
        || !Number.isInteger(record.revision)
        || record.revision < 1
        || !Number.isInteger(record.startedAtMs)
        || !validateState(record.state)
      ) continue;
      highestObservedRevision = Math.max(highestObservedRevision, record.revision);
      const ack = all[ackKey(id)];
      const cancelled = all[cancelKey(id)];
      if (
        cancelled !== undefined
        || !isRecord(ack)
        || ack.schemaVersion !== LOG_SCHEMA_VERSION
        || ack.transactionId !== id
        || ack.revision !== record.revision
      ) continue;
      candidates.push(record);
    }
    // Recovery must advance beyond every prepared record, not only records
    // whose acknowledgement is already visible. Otherwise a late ack from an
    // abandoned transaction can tie or outrank the compensating commit.
    revision = highestObservedRevision;
    candidates.sort((left, right) => compareRecords(right, left));
    const latest = candidates[0] || null;
    if (!latest) return null;
    const authoritative = clone(latest.state);
    return {
      state: authoritative,
      transactionId: latest.transactionId,
      revision: latest.revision,
      startedAtMs: latest.startedAtMs,
      resourceKeys: Array.isArray(latest.resourceKeys) ? [...latest.resourceKeys] : [],
    };
  };

  const readLatest = async () => clone((await readLatestRecord())?.state || null);

  const commit = async (nextState, {
    transactionId,
    startedAtMs = clock(),
    resourceKeys = [],
  } = {}) => {
    if (!validateState(nextState)) throw new Error("Invalid durable commit state");
    if (!Array.isArray(resourceKeys) || !resourceKeys.every((key) => typeof key === "string" && key.length > 0)) {
      throw new Error("Durable commit resourceKeys must be non-empty strings");
    }
    const id = transactionId || `${startedAtMs.toString(36)}-${crypto.randomUUID()}`;
    const nextRevision = revision + 1;
    const record = {
      schemaVersion: LOG_SCHEMA_VERSION,
      transactionId: id,
      revision: nextRevision,
      startedAtMs,
      resourceKeys: [...new Set(resourceKeys)],
      state: clone(nextState),
    };
    try {
      await writeExact(dataKey(id), record, "durable state data write");
      // Once prepared data exists, every compensation must use a strictly
      // newer revision even if the acknowledgement step fails.
      revision = Math.max(revision, nextRevision);
      await writeExact(
        ackKey(id),
        {
          schemaVersion: LOG_SCHEMA_VERSION,
          transactionId: id,
          revision: nextRevision,
        },
        "durable state acknowledgement write",
      );
    } catch (error) {
      // Do not reject a live call until its transaction is durably cancelled.
      // If cancellation cannot be proven, surface that stronger integrity loss.
      try {
        await cancel(id, error);
      } catch (cancelError) {
        try {
          if (typeof storage.remove !== "function") throw new Error("storage.remove is unavailable");
          await bounded(
            () => storage.remove([dataKey(id), ackKey(id)]),
            ioTimeoutMs,
            "durable state failed transaction cleanup",
          );
          const remainingData = await readExact(dataKey(id));
          if (remainingData !== undefined) throw new Error("prepared data is still present");
        } catch (cleanupError) {
          throw new Error(
            `Durable state cancellation could not be proven and prepared data cleanup failed: ${cancelError.message}; ${cleanupError.message}`,
          );
        }
      }
      throw error;
    }
    revision = Math.max(revision, nextRevision);
    await writeFinalMirror(nextState);
    if (typeof storage.remove === "function") {
      const all = await bounded(() => storage.get(null), ioTimeoutMs, "durable state compaction scan")
        .catch(() => null);
      if (isRecord(all)) {
        const obsolete = [];
        for (const [key, candidate] of Object.entries(all)) {
          if (key === dataKey(id) || key === ackKey(id) || key.startsWith(`${keyPrefix}.cancel.`)) continue;
          if (!key.startsWith(`${keyPrefix}.data.`) || !isRecord(candidate)) continue;
          if (
            candidate.schemaVersion === LOG_SCHEMA_VERSION
            && typeof candidate.transactionId === "string"
            && Number.isInteger(candidate.revision)
            && Number.isInteger(candidate.startedAtMs)
            && compareRecords(candidate, record) < 0
          ) {
            obsolete.push(key, ackKey(candidate.transactionId));
          }
        }
        if (obsolete.length > 0) {
          await bounded(
            () => storage.remove(obsolete),
            ioTimeoutMs,
            "durable state compaction remove",
          ).catch(() => {});
        }
      }
    }
    return clone(nextState);
  };

  return {
    readLatest,
    readLatestRecord,
    commit,
    nextRevision: () => revision + 1,
  };
}
