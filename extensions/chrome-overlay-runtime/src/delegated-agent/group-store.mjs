export const GROUPS_STORAGE_KEY = "actionsJsonAgentGroups.v2";
export const DEFAULT_GROUP_ID = "extension:default";
const GROUP_COMMIT_PREFIX = "actionsJsonAgentGroups.v2.commits";

const GROUP_SCHEMA_VERSION = 2;
const LEASE_SCHEMA_VERSION = 1;
const DEFAULT_IO_TIMEOUT_MS = 3000;
const RECOVERY_TIMEOUT_MULTIPLIER = 3;
const ORDINARY_AUTHORITY_VERSION = 1;
const OWNERSHIP_REVISION_FIELD = "ownershipRevision";

const clone = (value) => value == null ? value : structuredClone(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isInteger = (value) => Number.isInteger(value) && value >= 0;
const validTimestamp = (value) => isNonEmptyString(value) && Number.isFinite(Date.parse(value));

const bounded = (operation, timeoutMs, label) => {
  let timer = null;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

const exactOrigin = (value) => {
  try {
    return canonicalizeDelegatedOrigin(value, { allowLocalhost: true }) === value;
  } catch (_error) {
    return false;
  }
};

export function validateHomeLease(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["home lease must be an object"] };
  if (value.schemaVersion !== LEASE_SCHEMA_VERSION) errors.push("home lease schemaVersion must be 1");
  if (!isInteger(value.tabId)) errors.push("home tabId is invalid");
  if (value.frameId !== 0) errors.push("home must be top-level frame 0");
  if (!isNonEmptyString(value.documentId)) errors.push("home documentId is required");
  if (!exactOrigin(value.origin)) errors.push("home origin must be exact");
  if (!isNonEmptyString(value.portNonce)) errors.push("home portNonce is required");
  if (!validTimestamp(value.leasedAt)) errors.push("home leasedAt is invalid");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateTabLease(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["tab lease must be an object"] };
  if (value.schemaVersion !== LEASE_SCHEMA_VERSION) errors.push("tab lease schemaVersion must be 1");
  if (!isInteger(value.tabId)) errors.push("tabId is invalid");
  if (!isInteger(value.windowId)) errors.push("windowId is invalid");
  if (value.currentDocumentId !== null && !isNonEmptyString(value.currentDocumentId)) errors.push("currentDocumentId is invalid");
  if (value.currentRuntimeId !== null && !isNonEmptyString(value.currentRuntimeId)) errors.push("currentRuntimeId is invalid");
  if (!validTimestamp(value.assignedAt)) errors.push("assignedAt is invalid");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateGroupRecord(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["group must be an object"] };
  if (value.schemaVersion !== GROUP_SCHEMA_VERSION) errors.push("group schemaVersion must be 2");
  if (!isNonEmptyString(value.id)) errors.push("group id is required");
  if (value.kind !== "extension" && value.kind !== "website") errors.push("group kind is invalid");
  if (!isNonEmptyString(value.title)) errors.push("group title is required");
  if (!isRecord(value.tabs)) errors.push("group tabs must be an object");
  if (!isRecord(value.chromeGroupIdsByWindow)) errors.push("chromeGroupIdsByWindow must be an object");
  if (isRecord(value.tabs)) {
    for (const [tabId, tabLease] of Object.entries(value.tabs)) {
      const checked = validateTabLease(tabLease);
      if (!checked.ok || String(tabLease?.tabId) !== tabId) errors.push(`invalid tab lease ${tabId}`);
    }
  }
  if (isRecord(value.chromeGroupIdsByWindow)) {
    for (const [windowId, chromeGroupId] of Object.entries(value.chromeGroupIdsByWindow)) {
      if (!/^\d+$/.test(windowId) || !isInteger(chromeGroupId)) errors.push(`invalid Chrome group for window ${windowId}`);
    }
  }
  if (value.kind === "extension") {
    if (value.id !== DEFAULT_GROUP_ID) errors.push("ordinary extension group must use reserved ID");
    if (value.home != null || value.approvalId != null) errors.push("ordinary extension group cannot have delegated authority");
  } else {
    if (!isNonEmptyString(value.approvalId)) errors.push("website approvalId is required");
    if (!isNonEmptyString(value.activationId)) errors.push("website activationId is required");
    if (isNonEmptyString(value.approvalId) && isNonEmptyString(value.activationId)) {
      try {
        if (value.id !== makeWebsiteGroupId(value.approvalId, value.activationId)) errors.push("website group id does not match its immutable identity");
      } catch (_error) {
        errors.push("website group identity is invalid");
      }
    }
    const home = validateHomeLease(value.home);
    if (!home.ok) errors.push(...home.errors);
    if (value.status !== "live" && value.status !== "suspended" && value.status !== "ended") errors.push("website status is invalid");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

const makeOrdinaryGroup = () => ({
  schemaVersion: GROUP_SCHEMA_VERSION,
  id: DEFAULT_GROUP_ID,
  kind: "extension",
  title: "actions.json",
  status: "live",
  activeTabId: null,
  tabs: {},
  chromeGroupIdsByWindow: {},
});

export function makeWebsiteGroupId(approvalId, activationId) {
  if (!/^[A-Za-z0-9_-]+$/.test(approvalId || "") || !/^[A-Za-z0-9_-]+$/.test(activationId || "")) {
    throw new Error("Approval and activation IDs must be opaque URL-safe tokens");
  }
  return `website:${approvalId}:${activationId}`;
}

const validatePersistedState = (value, { allowPending = false } = {}) => {
  if (
    !isRecord(value)
    || value.schemaVersion !== GROUP_SCHEMA_VERSION
    || (value.ordinaryAuthorityVersion !== undefined && value.ordinaryAuthorityVersion !== ORDINARY_AUTHORITY_VERSION)
    || !isRecord(value.groups)
    || !isRecord(value.tabOwners)
    || !isRecord(value.homeTabOwners)
    || !isRecord(value.transaction)
    || !isNonEmptyString(value.transaction.id)
    || (
      value.transaction.state !== "committed"
      && !(allowPending && (value.transaction.state === "pending" || value.transaction.state === "applied"))
    )
  ) return false;
  if (value.transaction.state !== "committed") {
    const rollback = value.transaction.rollback;
    if (!isRecord(rollback) || rollback.transaction?.state !== "committed" || !validatePersistedState(rollback)) {
      return false;
    }
  }
  const observedOwners = {};
  const observedHomes = {};
  const liveApprovals = new Set();
  for (const [groupId, group] of Object.entries(value.groups)) {
    const checked = validateGroupRecord(group);
    if (!checked.ok || group.id !== groupId) return false;
    for (const tabId of Object.keys(group.tabs)) {
      if (observedOwners[tabId] || observedHomes[tabId]) return false;
      observedOwners[tabId] = groupId;
    }
    if (group.kind === "website") {
      const homeTabId = String(group.home.tabId);
      if (observedHomes[homeTabId] || observedOwners[homeTabId]) return false;
      observedHomes[homeTabId] = groupId;
      if (group.status === "live" || group.status === "suspended") {
        if (liveApprovals.has(group.approvalId)) return false;
        liveApprovals.add(group.approvalId);
      }
    }
  }
  if (!value.groups[DEFAULT_GROUP_ID]) return false;
  const ownerEntries = Object.entries(value.tabOwners);
  if (ownerEntries.length !== Object.keys(observedOwners).length) return false;
  if (!ownerEntries.every(([tabId, groupId]) => observedOwners[tabId] === groupId)) return false;
  const homeEntries = Object.entries(value.homeTabOwners);
  return homeEntries.length === Object.keys(observedHomes).length
    && homeEntries.every(([tabId, groupId]) => observedHomes[tabId] === groupId);
};

const migrateLegacy = (legacyState) => {
  const state = {
    schemaVersion: GROUP_SCHEMA_VERSION,
    ordinaryAuthorityVersion: ORDINARY_AUTHORITY_VERSION,
    groups: { [DEFAULT_GROUP_ID]: makeOrdinaryGroup() },
    tabOwners: {},
    homeTabOwners: {},
    transaction: { state: "committed", id: "migration" },
  };
  const legacy = legacyState?.sessions?.["actions-json-default"];
  if (!isRecord(legacy)) return state;
  const ordinary = state.groups[DEFAULT_GROUP_ID];
  ordinary.title = isNonEmptyString(legacy.title) ? legacy.title : ordinary.title;
  ordinary.activeTabId = isInteger(legacy.activeTabId) ? legacy.activeTabId : null;
  for (const [tabIdText, claim] of Object.entries(isRecord(legacy.tabs) ? legacy.tabs : {})) {
    const tabId = Number(tabIdText);
    if (!isInteger(tabId)) continue;
    ordinary.tabs[tabIdText] = {
      ...(isRecord(claim) ? clone(claim) : {}),
      schemaVersion: LEASE_SCHEMA_VERSION,
      tabId,
      windowId: isInteger(claim?.windowId) ? claim.windowId : 0,
      currentDocumentId: isNonEmptyString(claim?.documentId) ? claim.documentId : null,
      currentRuntimeId: isNonEmptyString(claim?.runtimeId) ? claim.runtimeId : null,
      assignedAt: validTimestamp(claim?.assignedAt) ? claim.assignedAt : new Date(0).toISOString(),
    };
    state.tabOwners[tabIdText] = DEFAULT_GROUP_ID;
  }
  return state;
};

export function createGroupStore({
  storage,
  approvalLookup,
  activationIdFactory,
  externalTabOwnerLookup = async () => null,
  ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS,
} = {}) {
  if (!storage?.get || !storage?.set) throw new Error("storage with get/set is required");
  if (typeof approvalLookup !== "function") throw new Error("approvalLookup is required");
  if (typeof activationIdFactory !== "function") throw new Error("activationIdFactory is required");
  if (typeof externalTabOwnerLookup !== "function") throw new Error("externalTabOwnerLookup must be a function");

  let state = { schemaVersion: GROUP_SCHEMA_VERSION, groups: {}, tabOwners: {}, homeTabOwners: {}, transaction: { state: "committed", id: "empty" } };
  let initialized = false;
  let invalidPersistedState = false;
  let loadPromise = null;
  let mutationLane = Promise.resolve();
  let recoveryPromise = null;

  let transactionSequence = 0;
  const commitLog = createDurableStateCommitLog({
    storage,
    mainKey: GROUPS_STORAGE_KEY,
    keyPrefix: GROUP_COMMIT_PREFIX,
    validateState: (candidate) => validatePersistedState(candidate),
    ioTimeoutMs,
  });

  const persist = async (nextState) => {
    const transactionId = `${Date.now().toString(36)}-${++transactionSequence}-${crypto.randomUUID()}`;
    const previousState = clone(state);
    if (!validatePersistedState(previousState)) {
      throw new Error("Group rollback baseline is invalid");
    }
    const rollback = clone(previousState);
    const pendingState = clone({
      ...nextState,
      transaction: { state: "pending", id: transactionId, rollback },
    });
    const appliedState = clone({
      ...nextState,
      transaction: { state: "applied", id: transactionId, rollback },
    });
    const committedState = clone({ ...nextState, transaction: { state: "committed", id: transactionId } });
    if (
      !validatePersistedState(pendingState, { allowPending: true })
      || !validatePersistedState(appliedState, { allowPending: true })
      || !validatePersistedState(committedState)
    ) {
      throw new Error("Group invariant violation");
    }

    let activeWrite = Promise.resolve();
    const rollbackWhenSettled = () => {
      const recovery = bounded(
        async () => {
          await activeWrite.catch(() => {});
          // A newer mutation may commit after this bounded barrier expires but
          // before the abandoned write finally settles. Re-persist the current
          // in-memory committed state so the late write cannot erase it.
          await storage.set({ [GROUPS_STORAGE_KEY]: clone(pendingState) });
        },
        ioTimeoutMs * RECOVERY_TIMEOUT_MULTIPLIER,
        "group metadata local recovery",
      ).catch(() => {
        // The durable pending/applied snapshot remains enough for a later
        // initialize() call or replacement worker to recover.
        initialized = false;
      });
      const barrier = recovery.finally(() => {
        if (recoveryPromise === barrier) recoveryPromise = null;
      });
      recoveryPromise = barrier;
    };
    try {
      activeWrite = Promise.resolve().then(() => storage.set({ [GROUPS_STORAGE_KEY]: pendingState }));
      await bounded(() => activeWrite, ioTimeoutMs, "group metadata pending write");
      activeWrite = Promise.resolve().then(() => storage.set({ [GROUPS_STORAGE_KEY]: appliedState }));
      await bounded(() => activeWrite, ioTimeoutMs, "group metadata applied write");
      // The final confirmation is intentionally not raced against a local timer.
      // If the worker disappears, replacement initialization sees either the
      // recoverable applied record or the committed record. A live caller is
      // never told the mutation failed after a committed record became durable.
      activeWrite = commitLog.commit(committedState, { transactionId });
      await activeWrite;
    } catch (error) {
      rollbackWhenSettled();
      initialized = false;
      throw new Error(`Group metadata outcome is indeterminate: ${error.message}`);
    }
    state = committedState;
  };

  const load = async (legacyState) => {
    const stored = await bounded(() => storage.get(GROUPS_STORAGE_KEY), ioTimeoutMs, "group metadata read");
    const storedRaw = stored?.[GROUPS_STORAGE_KEY];
    const committedRecord = await commitLog.readLatestRecord();
    const committed = committedRecord?.state || null;
    // Pending/applied mirror state is unresolved recovery evidence and takes
    // precedence over an acknowledgement that may have landed after failure.
    if (
      validatePersistedState(storedRaw, { allowPending: true })
      && (storedRaw.transaction.state === "pending" || storedRaw.transaction.state === "applied")
    ) {
      const exactCommitLanded = committedRecord?.transactionId === storedRaw.transaction.id;
      state = clone(exactCommitLanded
        ? storedRaw.transaction.rollback
        : (committed || storedRaw.transaction.rollback));
      initialized = true;
      return true;
    }
    const raw = committed || storedRaw;
    if (raw === undefined) {
      const migrated = migrateLegacy(legacyState);
      // A first-install transaction must roll back to a valid ordinary group,
      // never to the intentionally empty construction placeholder.
      state = clone(migrated);
      await persist(migrated);
      initialized = true;
      return true;
    }
    if (!validatePersistedState(raw, { allowPending: true })) {
      invalidPersistedState = true;
      return false;
    }
    state = clone(raw);
    initialized = true;
    return true;
  };

  const initialize = async ({ legacyState } = {}) => {
    if (initialized) return true;
    if (invalidPersistedState) return false;
    if (!loadPromise) loadPromise = load(legacyState).finally(() => { loadPromise = null; });
    try {
      return await loadPromise;
    } catch (_error) {
      return false;
    }
  };

  const requireReady = async () => {
    if (recoveryPromise) {
      throw new Error("Group store recovery is still in progress");
    }
    if (await initialize()) return;
    throw new Error(invalidPersistedState ? "Invalid persisted group state" : "Group store unavailable");
  };

  const mutate = (operation) => {
    const task = mutationLane.then(async () => {
      await requireReady();
      return operation();
    });
    mutationLane = task.catch(() => {});
    return task;
  };

  const requireGroup = (groupId) => {
    if (!isNonEmptyString(groupId)) throw new Error("An explicit group ID is required");
    const group = state.groups[groupId];
    if (!group) throw new Error(`Group not found: ${groupId}`);
    return group;
  };

  const requireLiveApproval = async (approvalId) => {
    let approval;
    try {
      approval = await approvalLookup(approvalId);
    } catch (error) {
      throw new Error(`Approval authority is suspended: ${error.message}`);
    }
    const checked = validateApprovalRecord(approval);
    if (!checked.ok || approval.approvalId !== approvalId || approval.revokedAt !== null) {
      throw new Error(`A live approval is required: ${approvalId}`);
    }
    return approval;
  };

  const requireLiveWebsiteGroup = async (group) => {
    if (group.status !== "live") throw new Error(`Website group is not live: ${group.status}`);
    const approval = await requireLiveApproval(group.approvalId);
    if (approval.sourceOrigin !== group.home.origin) {
      throw new Error("Website home origin does not match approval source origin");
    }
    return approval;
  };

  const claimTabWithReceipt = (groupId, tabLease) => {
    return mutate(async () => {
      const group = requireGroup(groupId);
      if (group.kind === "website") await requireLiveWebsiteGroup(group);
      const checked = validateTabLease(tabLease);
      if (!checked.ok) throw new Error(`Invalid tab lease: ${checked.errors.join("; ")}`);
      const tabKey = String(tabLease.tabId);
      if (state.homeTabOwners[tabKey]) throw new Error(`Tab ${tabKey} is reserved as a website home`);
      const externalOwner = await externalTabOwnerLookup(tabLease.tabId);
      if (externalOwner && externalOwner !== groupId) throw new Error(`Tab ${tabKey} is already externally owned`);
      const owner = state.tabOwners[tabKey];
      if (owner && owner !== groupId) throw new Error(`Tab ${tabKey} is already owned by ${owner}`);
      const previousLease = clone(state.groups[groupId].tabs[tabKey] || null);
      const claimedLease = {
        ...clone(tabLease),
        [OWNERSHIP_REVISION_FIELD]: crypto.randomUUID(),
      };
      const nextState = clone(state);
      nextState.groups[groupId].tabs[tabKey] = claimedLease;
      nextState.tabOwners[tabKey] = groupId;
      await persist(nextState);
      return {
        groupId,
        tabId: tabLease.tabId,
        claimedRevision: claimedLease[OWNERSHIP_REVISION_FIELD],
        claimedLease: clone(claimedLease),
        previousLease,
      };
    });
  };

  const releaseTabIfRevision = (groupId, tabId, expectedRevision = null) => {
    return mutate(async () => {
      const group = requireGroup(groupId);
      if (group.kind === "website") await requireLiveWebsiteGroup(group);
      const tabKey = String(tabId);
      if (state.tabOwners[tabKey] !== groupId) return false;
      const current = state.groups[groupId].tabs[tabKey];
      if (
        expectedRevision !== null
        && current?.[OWNERSHIP_REVISION_FIELD] !== expectedRevision
      ) return false;
      const nextState = clone(state);
      delete nextState.groups[groupId].tabs[tabKey];
      delete nextState.tabOwners[tabKey];
      if (nextState.groups[groupId].activeTabId === tabId) nextState.groups[groupId].activeTabId = null;
      await persist(nextState);
      return true;
    });
  };

  return {
    initialize,

    adoptOrdinaryGroup(ordinaryGroup) {
      return mutate(async () => {
        if (state.ordinaryAuthorityVersion === ORDINARY_AUTHORITY_VERSION) {
          return { group: clone(requireGroup(DEFAULT_GROUP_ID)), conflicts: [] };
        }

        const source = isRecord(ordinaryGroup) ? ordinaryGroup : makeOrdinaryGroup();
        const nextState = clone(state);
        const ordinary = nextState.groups[DEFAULT_GROUP_ID];
        const conflicts = [];
        ordinary.title = isNonEmptyString(source.title) ? source.title : ordinary.title;
        ordinary.activeTabId = isInteger(source.activeTabId) ? source.activeTabId : ordinary.activeTabId;
        ordinary.chromeGroupIdsByWindow = isRecord(source.chromeGroupIdsByWindow)
          ? clone(source.chromeGroupIdsByWindow)
          : ordinary.chromeGroupIdsByWindow;

        for (const [tabKey, rawLease] of Object.entries(isRecord(source.tabs) ? source.tabs : {})) {
          const tabId = Number(tabKey);
          const lease = {
            ...(isRecord(rawLease) ? clone(rawLease) : {}),
            schemaVersion: LEASE_SCHEMA_VERSION,
            tabId,
            windowId: isInteger(rawLease?.windowId) ? rawLease.windowId : 0,
            currentDocumentId: isNonEmptyString(rawLease?.currentDocumentId)
              ? rawLease.currentDocumentId
              : null,
            currentRuntimeId: isNonEmptyString(rawLease?.currentRuntimeId)
              ? rawLease.currentRuntimeId
              : null,
            assignedAt: validTimestamp(rawLease?.assignedAt)
              ? rawLease.assignedAt
              : new Date(0).toISOString(),
          };
          if (!validateTabLease(lease).ok) continue;
          const owner = nextState.tabOwners[tabKey] || nextState.homeTabOwners[tabKey] || null;
          if (owner && owner !== DEFAULT_GROUP_ID) {
            conflicts.push({ tabId, retainedOwner: owner });
            continue;
          }
          ordinary.tabs[tabKey] = lease;
          nextState.tabOwners[tabKey] = DEFAULT_GROUP_ID;
        }

        nextState.ordinaryAuthorityVersion = ORDINARY_AUTHORITY_VERSION;
        await persist(nextState);
        return { group: clone(nextState.groups[DEFAULT_GROUP_ID]), conflicts };
      });
    },

    async getGroup(groupId) {
      await requireReady();
      const group = requireGroup(groupId);
      if (group.kind === "website") await requireLiveWebsiteGroup(group);
      return clone(group);
    },

    createWebsiteGroup({ approvalId, activationId = activationIdFactory(), title, home } = {}) {
      return mutate(async () => {
        const approval = await requireLiveApproval(approvalId);
        const homeCheck = validateHomeLease(home);
        if (!homeCheck.ok) throw new Error(`Invalid top-level home lease: ${homeCheck.errors.join("; ")}`);
        if (approval.sourceOrigin !== home.origin) throw new Error("Website home origin does not match approval source origin");
        const id = makeWebsiteGroupId(approvalId, activationId);
        if (state.groups[id]) throw new Error(`Group already exists: ${id}`);
        if (Object.values(state.groups).some((candidate) => (
          candidate.kind === "website"
          && candidate.approvalId === approvalId
          && (candidate.status === "live" || candidate.status === "suspended")
        ))) throw new Error(`Approval already has a live group activation: ${approvalId}`);
        const homeKey = String(home.tabId);
        if (state.homeTabOwners[homeKey] || state.tabOwners[homeKey] || await externalTabOwnerLookup(home.tabId)) {
          throw new Error(`Home tab ${homeKey} is already reserved or owned`);
        }
        const group = {
          schemaVersion: GROUP_SCHEMA_VERSION,
          id,
          kind: "website",
          title: isNonEmptyString(title) ? title : approvalId,
          status: "live",
          approvalId,
          activationId,
          home: clone(home),
          activeTabId: null,
          tabs: {},
          chromeGroupIdsByWindow: {},
        };
        const checked = validateGroupRecord(group);
        if (!checked.ok) throw new Error(`Invalid website group: ${checked.errors.join("; ")}`);
        const nextState = clone(state);
        nextState.groups[id] = group;
        nextState.homeTabOwners[homeKey] = id;
        await persist(nextState);
        return clone(group);
      });
    },

    updateGroup(groupId, update) {
      return mutate(async () => {
        const current = clone(requireGroup(groupId));
        const candidate = typeof update === "function" ? await update(current) : { ...current, ...clone(update) };
        if (!candidate || candidate.id !== groupId || candidate.kind !== current.kind) throw new Error("Group identity cannot change");
        if (candidate.kind === "website") {
          if (candidate.approvalId !== current.approvalId || candidate.activationId !== current.activationId) {
            throw new Error("Website group identity cannot change");
          }
          const approval = await requireLiveApproval(candidate.approvalId);
          if (approval.sourceOrigin !== candidate.home?.origin) throw new Error("Website home origin does not match approval source origin");
        }
        const checked = validateGroupRecord(candidate);
        if (!checked.ok) throw new Error(`Invalid group update: ${checked.errors.join("; ")}`);
        const nextState = clone(state);
        if (candidate.kind === "website" && candidate.home.tabId !== current.home.tabId) {
          const nextHomeKey = String(candidate.home.tabId);
          if (nextState.homeTabOwners[nextHomeKey] || nextState.tabOwners[nextHomeKey] || await externalTabOwnerLookup(candidate.home.tabId)) {
            throw new Error(`Home tab ${nextHomeKey} is already reserved or owned`);
          }
          delete nextState.homeTabOwners[String(current.home.tabId)];
          nextState.homeTabOwners[nextHomeKey] = groupId;
        }
        nextState.groups[groupId] = clone(candidate);
        await persist(nextState);
        return clone(candidate);
      });
    },

    async claimTab(groupId, tabLease) {
      return (await claimTabWithReceipt(groupId, tabLease)).claimedLease;
    },

    claimTabWithReceipt,

    rollbackTabClaim(receipt) {
      return mutate(async () => {
        if (
          !isRecord(receipt)
          || !isNonEmptyString(receipt.groupId)
          || !isInteger(receipt.tabId)
          || !isNonEmptyString(receipt.claimedRevision)
          || !isRecord(receipt.claimedLease)
          || receipt.claimedLease.tabId !== receipt.tabId
          || receipt.claimedLease[OWNERSHIP_REVISION_FIELD] !== receipt.claimedRevision
          || (
            receipt.previousLease !== null
            && (
              !validateTabLease(receipt.previousLease).ok
              || receipt.previousLease.tabId !== receipt.tabId
            )
          )
        ) {
          throw new Error("A valid tab claim receipt is required");
        }
        const group = requireGroup(receipt.groupId);
        if (group.kind === "website") await requireLiveWebsiteGroup(group);
        const tabKey = String(receipt.tabId);
        const current = state.groups[receipt.groupId].tabs[tabKey];
        if (
          state.tabOwners[tabKey] !== receipt.groupId
          || current?.[OWNERSHIP_REVISION_FIELD] !== receipt.claimedRevision
        ) return false;
        const nextState = clone(state);
        if (receipt.previousLease) {
          nextState.groups[receipt.groupId].tabs[tabKey] = clone(receipt.previousLease);
          nextState.tabOwners[tabKey] = receipt.groupId;
        } else {
          delete nextState.groups[receipt.groupId].tabs[tabKey];
          delete nextState.tabOwners[tabKey];
          if (nextState.groups[receipt.groupId].activeTabId === receipt.tabId) {
            nextState.groups[receipt.groupId].activeTabId = null;
          }
        }
        await persist(nextState);
        return true;
      });
    },

    releaseTab(groupId, tabId) {
      return releaseTabIfRevision(groupId, tabId);
    },

    releaseTabIfRevision,

    async ownershipOfTab(tabId) {
      try {
        await requireReady();
      } catch (error) {
        return { state: "unavailable", groupId: null, reason: error.message || String(error) };
      }
      const groupId = state.tabOwners[String(tabId)] || null;
      if (!groupId) return { state: "unowned", groupId: null };
      const group = state.groups[groupId];
      if (group?.kind === "website") {
        try {
          await requireLiveWebsiteGroup(group);
        } catch (error) {
          return { state: "unavailable", groupId, reason: error.message || String(error) };
        }
      }
      return { state: "owned", groupId };
    },

    async authoritativeClaimOfTab(tabId) {
      const ownership = await this.ownershipOfTab(tabId);
      if (ownership.state !== "owned") return { ...ownership, lease: null };
      return {
        ...ownership,
        lease: clone(state.groups[ownership.groupId]?.tabs?.[String(tabId)] || null),
      };
    },

    async ownerOfTab(tabId) {
      const ownership = await this.ownershipOfTab(tabId);
      return ownership.state === "owned" ? ownership.groupId : null;
    },

    async isTabReserved(tabId) {
      const ownership = await this.ownershipOfTab(tabId);
      if (ownership.state === "unavailable") {
        throw new Error(`Tab ownership authority unavailable: ${ownership.reason}`);
      }
      await requireReady();
      return Boolean(ownership.groupId || state.homeTabOwners[String(tabId)] || await externalTabOwnerLookup(tabId));
    },

    setChromeGroupId(groupId, windowId, chromeGroupId) {
      return mutate(async () => {
        const group = requireGroup(groupId);
        if (group.kind === "website") await requireLiveWebsiteGroup(group);
        if (!isInteger(windowId) || !isInteger(chromeGroupId)) throw new Error("windowId and chromeGroupId must be non-negative integers");
        const nextState = clone(state);
        nextState.groups[groupId].chromeGroupIdsByWindow[String(windowId)] = chromeGroupId;
        await persist(nextState);
        return clone(nextState.groups[groupId]);
      });
    },

    reconcile() {
      return mutate(async () => {
        const invalidGroups = [];
        const nextState = clone(state);
        let changed = false;
        for (const [groupId, group] of Object.entries(state.groups)) {
          if (group.kind !== "website") continue;
          let approval;
          try {
            approval = await approvalLookup(group.approvalId);
          } catch (_error) {
            if (nextState.groups[groupId].status !== "suspended") {
              nextState.groups[groupId].status = "suspended";
              changed = true;
            }
            invalidGroups.push(groupId);
            continue;
          }
          const missing = approval === null;
          const checkedApproval = validateApprovalRecord(approval);
          const matchesAuthority = checkedApproval.ok
            && approval.approvalId === group.approvalId
            && approval.sourceOrigin === group.home.origin;
          const revoked = matchesAuthority
            && validTimestamp(approval.revokedAt);
          if (missing || revoked) {
            invalidGroups.push(groupId);
            for (const tabId of Object.keys(group.tabs)) delete nextState.tabOwners[tabId];
            delete nextState.homeTabOwners[String(group.home.tabId)];
            delete nextState.groups[groupId];
            changed = true;
            continue;
          }
          const authorityValid = matchesAuthority
            && approval.revokedAt === null
            && validateHomeLease(group.home).ok;
          if (authorityValid) {
            if (group.status === "suspended") {
              nextState.groups[groupId].status = "live";
              changed = true;
            }
            continue;
          }
          if (group.status !== "ended" && nextState.groups[groupId].status !== "suspended") {
            nextState.groups[groupId].status = "suspended";
            changed = true;
          }
          invalidGroups.push(groupId);
        }
        if (changed) await persist(nextState);
        return { invalidGroups };
      });
    },
  };
}
import { validateApprovalRecord } from "./approval-store.mjs";
import { canonicalizeDelegatedOrigin } from "./delegated-policy.mjs";
import { createDurableStateCommitLog } from "./durable-state-commit-log.mjs";
