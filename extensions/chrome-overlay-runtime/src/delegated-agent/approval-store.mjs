export const APPROVALS_STORAGE_KEY = "actionsJsonAgentApprovals.v1";
export const BUNDLE_STORE_NAME = "delegatedBundles/v1";
const APPROVAL_COMMIT_PREFIX = "actionsJsonAgentApprovals.v1.commits";

const APPROVAL_SCHEMA_VERSION = 1;
const DEFAULT_IO_TIMEOUT_MS = 3000;
const RECOVERY_TIMEOUT_MULTIPLIER = 3;

export class ApprovalAuthorityUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "ApprovalAuthorityUnavailableError";
    this.code = "approval_authority_unavailable";
    if (cause !== undefined) this.cause = cause;
  }
}

export class ApprovalIntegrityError extends Error {
  constructor(message, { cause, storedByteLength } = {}) {
    super(message);
    this.name = "ApprovalIntegrityError";
    this.code = "approval_integrity_failure";
    if (cause !== undefined) this.cause = cause;
    if (Number.isInteger(storedByteLength) && storedByteLength >= 0) {
      this.storedByteLength = storedByteLength;
    }
  }
}

const clone = (value) => value == null ? value : structuredClone(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

const bounded = (operation, timeoutMs, label) => {
  let timer = null;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

const canonicalOrigin = (value) => {
  try {
    return canonicalizeDelegatedOrigin(value, { allowLocalhost: true });
  } catch (_error) {
    return null;
  }
};

export function validateApprovalRecord(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["approval must be an object"] };
  if (value.schemaVersion !== APPROVAL_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  if (!isNonEmptyString(value.approvalId)) errors.push("approvalId is required");
  if (!isRecord(value.agent) || !isNonEmptyString(value.agent.id)) errors.push("agent.id is required");
  if (!canonicalOrigin(value.sourceOrigin)) errors.push("sourceOrigin must be an exact HTTP(S) origin");
  if (!/^[A-Za-z0-9_.-]+$/.test(value.githubOwner || "")) errors.push("githubOwner is invalid");
  if (!/^[A-Za-z0-9_.-]+$/.test(value.githubRepo || "")) errors.push("githubRepo is invalid");
  if (!/^[0-9a-f]{40}$/.test(value.commitSha || "")) errors.push("commitSha must be a full lowercase SHA");
  if (!isNonEmptyString(value.manifestPath) || value.manifestPath.startsWith("/") || value.manifestPath.includes("..") || value.manifestPath.includes("\\")) {
    errors.push("manifestPath must be a safe repository-relative path");
  }
  if (!/^[0-9a-f]{64}$/.test(value.bundleDigest || "")) errors.push("bundleDigest is invalid");
  if (!isNonEmptyString(value.reviewedAt) || !Number.isFinite(Date.parse(value.reviewedAt))) errors.push("reviewedAt is invalid");
  if (value.revokedAt !== null && (!isNonEmptyString(value.revokedAt) || !Number.isFinite(Date.parse(value.revokedAt)))) {
    errors.push("revokedAt must be null or an ISO timestamp");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function approvalIdentityKey(value) {
  const checked = validateApprovalRecord(value);
  if (!checked.ok) throw new Error(`Invalid approval identity: ${checked.errors.join("; ")}`);
  const fields = [
    value.schemaVersion,
    value.agent.id,
    value.sourceOrigin,
    value.githubOwner,
    value.githubRepo,
    value.commitSha,
    value.manifestPath,
    value.bundleDigest,
  ];
  return fields.map((field) => `${String(field).length}:${String(field)}`).join("|");
}

const validatePersistedState = (value) => {
  if (!isRecord(value) || value.schemaVersion !== APPROVAL_SCHEMA_VERSION || !isRecord(value.approvals)) return false;
  if (
    value.orphanBundleKeys !== undefined
    && (
      !Array.isArray(value.orphanBundleKeys)
      || value.orphanBundleKeys.some((key) => !isNonEmptyString(key))
      || new Set(value.orphanBundleKeys).size !== value.orphanBundleKeys.length
    )
  ) return false;
  if (
    value.bundleOwners !== undefined
    && (
      !isRecord(value.bundleOwners)
      || Object.entries(value.bundleOwners).some(([key, owner]) => (
        !isNonEmptyString(key)
        || !isRecord(owner)
        || !isNonEmptyString(owner.transactionId)
        || !Number.isInteger(owner.startedAtMs)
        || !Number.isInteger(owner.expectedRevision)
        || owner.expectedRevision < 1
        || (owner.storageKey !== undefined && !isNonEmptyString(owner.storageKey))
      ))
    )
  ) return false;
  const approvalsValid = Object.entries(value.approvals).every(([approvalId, approval]) => {
    const checked = validateApprovalRecord(approval);
    return checked.ok && approval.approvalId === approvalId;
  });
  if (!approvalsValid) return false;
  if (value.recovery === undefined || value.recovery === null) return true;
  const recovery = value.recovery;
  if (!isRecord(recovery)
    || (recovery.kind !== "approval-put" && recovery.kind !== "approval-metadata")
  ) return false;
  if (!isNonEmptyString(recovery.id)
    || !Number.isInteger(recovery.startedAtMs)
    || !Number.isInteger(recovery.expectedRevision)
    || recovery.expectedRevision < 1
    || !isRecord(recovery.previousState)
    || (recovery.previousState.recovery !== undefined && recovery.previousState.recovery !== null)
    || !validatePersistedState(recovery.previousState)
  ) return false;
  if (recovery.kind === "approval-put") {
    return isNonEmptyString(recovery.bundleKey)
      && isNonEmptyString(recovery.approvalId)
      && (recovery.logicalBundleKey === undefined || isNonEmptyString(recovery.logicalBundleKey));
  }
  return recovery.bundleKey === undefined && recovery.approvalId === undefined;
};

const bundleKey = (approval) => `${approval.approvalId}:${approval.bundleDigest}`;
const bundleStorageKey = (persistedState, approval) => {
  const logicalKey = bundleKey(approval);
  return persistedState.bundleOwners?.[logicalKey]?.storageKey || logicalKey;
};

export function approvalRecordFromValidatedBundle(bundle, { reviewedAt = new Date().toISOString() } = {}) {
  const bundleBytes = serializeValidatedDelegatedBundle(bundle);
  const approval = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: bundle.approvalId,
    agent: clone(bundle.manifest.agent),
    sourceOrigin: bundle.sourceOrigin,
    githubOwner: bundle.repository.owner,
    githubRepo: bundle.repository.repo,
    commitSha: bundle.commitSha,
    manifestPath: bundle.manifestPath,
    bundleDigest: bundle.bundleDigest,
    reviewedAt,
    revokedAt: null,
  };
  const checked = validateApprovalRecord(approval);
  if (!checked.ok) throw new Error(`Validated bundle cannot form an approval: ${checked.errors.join("; ")}`);
  return { approval, bundleBytes };
}

export function createApprovalStore({
  metadataStorage,
  bundleStorage,
  now = Date.now,
  ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS,
} = {}) {
  if (!metadataStorage?.get || !metadataStorage?.set) throw new Error("metadataStorage with get/set is required");
  if (!bundleStorage?.get || !bundleStorage?.put || !bundleStorage?.delete || !bundleStorage?.getUsage) {
    throw new Error("bundleStorage with get/put/delete/getUsage is required");
  }

  let state = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvals: {},
    orphanBundleKeys: [],
    bundleOwners: {},
  };
  let initialized = false;
  let invalidPersistedState = false;
  let loadPromise = null;
  let mutationLane = Promise.resolve();
  let recoveryPromise = null;
  let lastInitializationError = null;
  const commitLog = createDurableStateCommitLog({
    storage: metadataStorage,
    mainKey: APPROVALS_STORAGE_KEY,
    keyPrefix: APPROVAL_COMMIT_PREFIX,
    validateState: (candidate) => validatePersistedState(candidate) && !candidate.recovery,
    ioTimeoutMs,
  });

  const cleanupOrphanBundles = async () => {
    const keys = [...(state.orphanBundleKeys || [])];
    if (keys.length === 0) return true;
    try {
      for (const key of keys) {
        await bounded(() => bundleStorage.delete(key), ioTimeoutMs, "approval orphan bundle delete");
      }
      const cleaned = clone(state);
      cleaned.orphanBundleKeys = [];
      cleaned.bundleOwners = { ...(cleaned.bundleOwners || {}) };
      for (const [logicalKey, owner] of Object.entries(cleaned.bundleOwners)) {
        if (keys.includes(owner.storageKey || logicalKey)) delete cleaned.bundleOwners[logicalKey];
      }
      await commitLog.commit(cleaned);
      state = cleaned;
      return true;
    } catch (_error) {
      return false;
    }
  };

  const load = async () => {
    const stored = await bounded(() => metadataStorage.get(APPROVALS_STORAGE_KEY), ioTimeoutMs, "approval metadata read");
    const storedRaw = stored?.[APPROVALS_STORAGE_KEY];
    const committedRecord = await commitLog.readLatestRecord();
    const committed = committedRecord?.state || null;
    if (storedRaw?.recovery && validatePersistedState(storedRaw)) {
      const recovery = storedRaw.recovery;
      const exactCommitLanded = committedRecord?.transactionId === recovery.id;
      // A surviving recovery marker means the originating call never proved
      // completion. Even if its acknowledgement landed late, roll back that
      // exact transaction. Preserve only a genuinely later committed state.
      const reconciled = clone(exactCommitLanded ? recovery.previousState : (committed || recovery.previousState));
      let bundleNeedsCleanup = false;
      if (recovery.kind === "approval-put") {
        const current = reconciled.approvals[recovery.approvalId];
        const recoveryLogicalKey = recovery.logicalBundleKey || recovery.bundleKey;
        const sameBundleIsLive = current?.revokedAt === null && bundleKey(current) === recoveryLogicalKey;
        if (recovery.logicalBundleKey === undefined) {
          // Pre-0.1.234 repairs reused the logical content key. A failed
          // repair could therefore replace corrupt bytes in place. Retain the
          // old provenance fence: only a demonstrably later committed owner
          // may keep those bytes.
          const owner = reconciled.bundleOwners?.[recovery.bundleKey];
          const aLaterCommitOwnsTheBundle = Boolean(
            sameBundleIsLive
            && owner
            && (owner.storageKey || recovery.bundleKey) === recovery.bundleKey
            && owner.expectedRevision >= recovery.expectedRevision
            && (
              owner.expectedRevision > recovery.expectedRevision
              || owner.startedAtMs > recovery.startedAtMs
              || (
                owner.startedAtMs === recovery.startedAtMs
                && owner.transactionId.localeCompare(recovery.id) > 0
              )
            )
          );
          bundleNeedsCleanup = !aLaterCommitOwnsTheBundle;
        } else {
          const liveStorageKey = sameBundleIsLive ? bundleStorageKey(reconciled, current) : null;
          bundleNeedsCleanup = liveStorageKey !== recovery.bundleKey;
        }
      }
      if (bundleNeedsCleanup) {
        try {
          await bounded(
            () => bundleStorage.delete(recovery.bundleKey),
            ioTimeoutMs,
            "approval restart orphan bundle delete",
          );
          if (reconciled.bundleOwners) {
            for (const [logicalKey, owner] of Object.entries(reconciled.bundleOwners)) {
              if ((owner.storageKey || logicalKey) === recovery.bundleKey) {
                delete reconciled.bundleOwners[logicalKey];
              }
            }
          }
        } catch (_error) {
          return false;
        }
      }
      // Keep the recovery marker durable until a later successful mutation
      // writes both a newer ledger commit and its marker-free mirror. The
      // in-memory state is safe to expose after required orphan cleanup.
      state = reconciled;
      if (!await cleanupOrphanBundles()) return false;
      initialized = true;
      lastInitializationError = null;
      return true;
    }
    const raw = committed || storedRaw;
    if (raw === undefined) {
      state = {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        approvals: {},
        orphanBundleKeys: [],
        bundleOwners: {},
      };
      initialized = true;
      lastInitializationError = null;
      return true;
    }
    if (!validatePersistedState(raw)) {
      invalidPersistedState = true;
      return false;
    }
    state = clone(raw);
    if (!await cleanupOrphanBundles()) return false;
    initialized = true;
    lastInitializationError = null;
    return true;
  };

  const initialize = async () => {
    if (recoveryPromise) return false;
    if (invalidPersistedState) return false;
    if (initialized) return true;
    if (!loadPromise) {
      loadPromise = load().finally(() => { loadPromise = null; });
    }
    try {
      return await loadPromise;
    } catch (error) {
      lastInitializationError = error;
      return false;
    }
  };

  const requireReadable = async () => {
    if (recoveryPromise) {
      throw new ApprovalAuthorityUnavailableError("Approval store recovery is still in progress");
    }
    if (await initialize()) return;
    if (invalidPersistedState) {
      throw new ApprovalIntegrityError("Invalid persisted approval state");
    }
    throw new ApprovalAuthorityUnavailableError("Approval store unavailable", { cause: lastInitializationError });
  };

  const requireWritable = async () => {
    if (recoveryPromise) {
      throw new Error("Approval store recovery is still in progress");
    }
    if (!await initialize()) {
      throw new Error(invalidPersistedState ? "Invalid persisted approval state" : "Approval store unavailable");
    }
  };

  const persist = async (nextState) => {
    const previousState = clone(state);
    const startedAtMs = Date.now();
    const recovery = {
      kind: "approval-metadata",
      id: `${startedAtMs.toString(36)}-${crypto.randomUUID()}`,
      startedAtMs,
      expectedRevision: commitLog.nextRevision(),
      previousState,
    };
    const preparedState = clone({ ...previousState, recovery });
    const appliedState = clone({ ...nextState, recovery });
    if (!validatePersistedState(preparedState) || !validatePersistedState(appliedState)) {
      throw new Error("Approval metadata recovery invariant violation");
    }

    let activeWrite = Promise.resolve();
    const rollbackWhenSettled = () => {
      const recoveryTask = bounded(
        async () => {
          await activeWrite.catch(() => {});
          // Preserve any newer mutation that committed after the bounded local
          // barrier expired but before this abandoned write finally settled.
          await metadataStorage.set({ [APPROVALS_STORAGE_KEY]: clone(preparedState) });
        },
        ioTimeoutMs * RECOVERY_TIMEOUT_MULTIPLIER,
        "approval metadata local recovery",
      ).catch(() => {
        initialized = false;
      });
      const barrier = recoveryTask.finally(() => {
        if (recoveryPromise === barrier) recoveryPromise = null;
      });
      recoveryPromise = barrier;
    };

    try {
      activeWrite = Promise.resolve().then(
        () => metadataStorage.set({ [APPROVALS_STORAGE_KEY]: preparedState }),
      );
      await bounded(() => activeWrite, ioTimeoutMs, "approval metadata recovery marker write");
      activeWrite = Promise.resolve().then(
        () => metadataStorage.set({ [APPROVALS_STORAGE_KEY]: appliedState }),
      );
      await bounded(() => activeWrite, ioTimeoutMs, "approval metadata applied write");
      await commitLog.commit(nextState, {
        transactionId: recovery.id,
        startedAtMs: recovery.startedAtMs,
      });
    } catch (error) {
      rollbackWhenSettled();
      initialized = false;
      throw error;
    }
    state = nextState;
  };

  const persistBundle = async (approval, bytes, key) => {
    const activeWrite = Promise.resolve().then(() => bundleStorage.put(key, bytes));
    let writeSettled = false;
    activeWrite.then(
      () => { writeSettled = true; },
      () => { writeSettled = true; },
    );
    try {
      await bounded(() => activeWrite, ioTimeoutMs, "approval bundle write");
    } catch (error) {
      if (writeSettled) {
        await bounded(() => bundleStorage.delete(key), ioTimeoutMs, "approval bundle rollback")
          .catch(() => {
            invalidPersistedState = true;
            initialized = false;
          });
        throw error;
      }
      const recovery = bounded(
        async () => {
          await activeWrite.catch(() => {});
          const current = state.approvals[approval.approvalId];
          const keyIsStillLive = current?.revokedAt === null && bundleStorageKey(state, current) === key;
          if (!keyIsStillLive) await bundleStorage.delete(key);
        },
        ioTimeoutMs * RECOVERY_TIMEOUT_MULTIPLIER,
        "approval bundle local recovery",
      ).catch(() => {
        // The durable marker owns cleanup after an abandoned local Promise.
        initialized = false;
      });
      const barrier = recovery.finally(() => {
        if (recoveryPromise === barrier) recoveryPromise = null;
      });
      recoveryPromise = barrier;
      initialized = false;
      throw error;
    }
  };

  const persistApprovalWithBundle = async ({ approval, bytes, nextState }) => {
    const previousState = clone(state);
    const logicalKey = bundleKey(approval);
    const startedAtMs = Date.now();
    const recovery = {
      kind: "approval-put",
      id: `${startedAtMs.toString(36)}-${crypto.randomUUID()}`,
      startedAtMs,
      expectedRevision: commitLog.nextRevision(),
      approvalId: approval.approvalId,
      bundleKey: `${logicalKey}:${startedAtMs.toString(36)}-${crypto.randomUUID()}`,
      logicalBundleKey: logicalKey,
      previousState,
    };
    const committedState = clone({
      ...nextState,
      bundleOwners: {
        ...(previousState.bundleOwners || {}),
        [logicalKey]: {
          transactionId: recovery.id,
          startedAtMs: recovery.startedAtMs,
          expectedRevision: recovery.expectedRevision,
          storageKey: recovery.bundleKey,
        },
      },
    });
    const preparedState = clone({ ...previousState, recovery });
    const appliedState = clone({ ...committedState, recovery });
    if (!validatePersistedState(preparedState) || !validatePersistedState(appliedState)) {
      throw new Error("Approval recovery invariant violation");
    }

    const installRecoveryBarrier = (activeWrite, { cleanBundle = false } = {}) => {
      const recoveryTask = bounded(
        async () => {
          await activeWrite.catch(() => {});
          const current = state.approvals[approval.approvalId];
          const keyIsStillLive = current?.revokedAt === null
            && bundleStorageKey(state, current) === recovery.bundleKey;
          if (cleanBundle && !keyIsStillLive) await bundleStorage.delete(recovery.bundleKey);
          await metadataStorage.set({ [APPROVALS_STORAGE_KEY]: clone(preparedState) });
        },
        ioTimeoutMs * RECOVERY_TIMEOUT_MULTIPLIER,
        "approval metadata local recovery",
      )
        .catch(() => {
          // A durable marker still permits initialization-time rollback.
          initialized = false;
        });
      const barrier = recoveryTask.finally(() => {
        if (recoveryPromise === barrier) recoveryPromise = null;
      });
      recoveryPromise = barrier;
    };

    let prepared = false;
    try {
      const markerWrite = Promise.resolve().then(
        () => metadataStorage.set({ [APPROVALS_STORAGE_KEY]: preparedState }),
      );
      try {
        await bounded(() => markerWrite, ioTimeoutMs, "approval recovery marker write");
        prepared = true;
      } catch (error) {
        if (/timed out/i.test(error.message)) installRecoveryBarrier(markerWrite);
        // A rejected write is not proof of corrupt persisted state. Clear
        // readiness and let the next load classify what actually committed.
        else initialized = false;
        throw error;
      }
      await persistBundle(approval, bytes, recovery.bundleKey);
      const appliedWrite = Promise.resolve().then(
        () => metadataStorage.set({ [APPROVALS_STORAGE_KEY]: appliedState }),
      );
      try {
        await bounded(() => appliedWrite, ioTimeoutMs, "approval metadata applied write");
      } catch (error) {
        installRecoveryBarrier(appliedWrite, { cleanBundle: true });
        throw error;
      }
      // Do not report a timeout after the committed authority record becomes
      // durable. If the worker disappears here, replacement initialization sees
      // either the recoverable applied marker or the final committed state.
      await commitLog.commit(committedState, {
        transactionId: recovery.id,
        startedAtMs: recovery.startedAtMs,
        resourceKeys: [recovery.bundleKey],
      });
    } catch (error) {
      initialized = false;
      if (!prepared && invalidPersistedState) recoveryPromise = null;
      throw error;
    }
    state = committedState;
  };

  const mutate = (operation) => {
    const task = mutationLane.then(operation);
    mutationLane = task.catch(() => {});
    return task;
  };

  const readBundleClone = async (approvalId) => {
    if (!isNonEmptyString(approvalId)) return null;
    await requireReadable();
    const approval = state.approvals[approvalId];
    if (!approval || approval.revokedAt !== null) return null;
    const storageKey = bundleStorageKey(state, approval);
    if ((state.orphanBundleKeys || []).includes(storageKey)) {
      throw new ApprovalIntegrityError(`Approval bundle is pending orphan cleanup: ${approvalId}`);
    }
    try {
      const bytes = await bounded(
        () => bundleStorage.get(storageKey),
        ioTimeoutMs,
        "approval bundle read",
      );
      if (!(bytes instanceof Uint8Array)) {
        const storedByteLength = Number.isInteger(bytes?.byteLength) ? bytes.byteLength : 0;
        throw new ApprovalIntegrityError(`Approval bundle is missing: ${approvalId}`, { storedByteLength });
      }
      const copy = new Uint8Array(bytes);
      if (await sha256Hex(copy) !== approval.bundleDigest) {
        throw new ApprovalIntegrityError(`Approval bundle digest mismatch: ${approvalId}`, {
          storedByteLength: copy.byteLength,
        });
      }
      return copy;
    } catch (error) {
      if (error instanceof ApprovalIntegrityError) throw error;
      throw new ApprovalAuthorityUnavailableError(`Approval bundle read unavailable: ${approvalId}`, { cause: error });
    }
  };

  return {
    initialize,

    async getApproval(approvalId) {
      if (!isNonEmptyString(approvalId)) return null;
      await requireReadable();
      const approval = state.approvals[approvalId];
      if (!approval || approval.revokedAt !== null) return clone(approval || null);
      const bytes = await readBundleClone(approvalId);
      return bytes ? clone(approval) : null;
    },

    putApproval({ approval, bundleBytes } = {}) {
      return mutate(async () => {
        await requireWritable();
        const checked = validateApprovalRecord(approval);
        if (!checked.ok) throw new Error(`Invalid approval: ${checked.errors.join("; ")}`);
        if (!(bundleBytes instanceof Uint8Array)) throw new Error("bundleBytes must be a Uint8Array");

        const existing = state.approvals[approval.approvalId];
        if (existing && approvalIdentityKey(existing) !== approvalIdentityKey(approval)) {
          throw new Error("Approval identity cannot change under an existing approval ID");
        }
        const immutableBytes = new Uint8Array(bundleBytes);
        const actualDigest = await sha256Hex(immutableBytes);
        if (actualDigest !== approval.bundleDigest) throw new Error("Bundle bytes digest does not match approval.bundleDigest");
        if (immutableBytes.byteLength > DELEGATED_POLICY_LIMITS.maxBundleBytes) {
          throw new Error("Bundle exceeds the per-bundle storage ceiling");
        }
        let supersededBundleKey = null;
        if (existing && existing.revokedAt === null) {
          try {
            const existingBytes = await readBundleClone(approval.approvalId);
            if (existingBytes) return clone(existing);
          } catch (error) {
            if (!(error instanceof ApprovalIntegrityError)) throw error;
            supersededBundleKey = bundleStorageKey(state, existing);
          }
        }
        if (!await cleanupOrphanBundles()) {
          throw new ApprovalAuthorityUnavailableError("Approval orphan cleanup is unavailable");
        }
        if (supersededBundleKey) {
          try {
            await bounded(
              () => bundleStorage.delete(supersededBundleKey),
              ioTimeoutMs,
              "approval superseded bundle delete",
            );
            const remaining = await bounded(
              () => bundleStorage.get(supersededBundleKey),
              ioTimeoutMs,
              "approval superseded bundle verification",
            );
            if (remaining instanceof Uint8Array) {
              throw new Error("superseded bundle is still present");
            }
          } catch (error) {
            throw new ApprovalAuthorityUnavailableError("Approval superseded bundle cleanup is unavailable", {
              cause: error,
            });
          }
        }
        const usage = await bounded(() => bundleStorage.getUsage(), ioTimeoutMs, "approval bundle quota read");
        if (!Number.isFinite(usage?.usedBytes) || !Number.isFinite(usage?.quotaBytes)) {
          throw new Error("Bundle storage quota preflight is unavailable");
        }
        const projectedUsage = usage.usedBytes + immutableBytes.byteLength;
        if (projectedUsage > DELEGATED_POLICY_LIMITS.maxStoredBundlesBytes) {
          throw new Error("Bundle storage global ceiling exceeded");
        }
        if (projectedUsage > usage.quotaBytes) {
          throw new Error("Browser bundle storage quota exceeded");
        }

        const nextApproval = clone({ ...approval, revokedAt: null });
        const nextState = clone(state);
        nextState.approvals[approval.approvalId] = nextApproval;
        try {
          await persistApprovalWithBundle({ approval, bytes: immutableBytes, nextState });
        } catch (error) {
          throw new Error(`Approval metadata outcome is indeterminate: ${error.message}`);
        }
        return clone(nextApproval);
      });
    },

    getBundleClone: readBundleClone,

    revokeApproval(approvalId) {
      return mutate(async () => {
        await requireWritable();
        const existing = state.approvals[approvalId];
        if (!existing) throw new Error(`Approval not found: ${approvalId}`);
        if (existing.revokedAt !== null) return clone(existing);
        const nextState = clone(state);
        nextState.approvals[approvalId].revokedAt = new Date(now()).toISOString();
        nextState.orphanBundleKeys = [...new Set([
          ...(nextState.orphanBundleKeys || []),
          bundleStorageKey(nextState, existing),
        ])];
        await persist(nextState);
        await cleanupOrphanBundles();
        return clone(nextState.approvals[approvalId]);
      });
    },
  };
}
import {
  serializeValidatedDelegatedBundle,
  sha256Hex,
} from "./bundle-schema.mjs";
import {
  DELEGATED_POLICY_LIMITS,
  canonicalizeDelegatedOrigin,
} from "./delegated-policy.mjs";
import { createDurableStateCommitLog } from "./durable-state-commit-log.mjs";
