import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApprovalStore } from "../src/delegated-agent/approval-store.mjs";
import {
  DEFAULT_GROUP_ID,
  GROUPS_STORAGE_KEY,
  createGroupStore,
  makeWebsiteGroupId,
  validateGroupRecord,
  validateHomeLease,
  validateTabLease,
} from "../src/delegated-agent/group-store.mjs";

const clone = (value) => structuredClone(value);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function memoryStorage(initial = {}) {
  let value = clone(initial);
  return {
    async get(key) { return key === null ? clone(value) : { [key]: clone(value[key]) }; },
    async set(items) { value = { ...value, ...clone(items) }; },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete value[key]; },
    snapshot() { return clone(value); },
  };
}

function memoryBundleStorage() {
  const values = new Map();
  let unavailable = false;
  return {
    async get(key) {
      if (unavailable) throw new Error("bundle storage unavailable");
      return values.has(key) ? new Uint8Array(values.get(key)) : null;
    },
    async put(key, bytes) { values.set(key, new Uint8Array(bytes)); },
    async delete(key) { values.delete(key); },
    async getUsage() {
      return {
        usedBytes: [...values.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
        quotaBytes: 64 * 1024 * 1024,
      };
    },
    setUnavailable(value) { unavailable = value; },
  };
}

function persistedApproval(approvalId = "approval-a") {
  const bytes = new Uint8Array([1]);
  return {
    bytes,
    record: {
      schemaVersion: 1,
      approvalId,
      agent: { id: "agent-a", name: "Agent A" },
      sourceOrigin: "https://agent.example",
      githubOwner: "example",
      githubRepo: "agent-bundle",
      commitSha: "a".repeat(40),
      manifestPath: "agent.json",
      bundleDigest: digest(bytes),
      reviewedAt: "2026-07-15T12:00:00.000Z",
      revokedAt: null,
    },
  };
}

const liveApproval = (approvalId, sourceOrigin = "https://agent.example") => ({
  ...persistedApproval(approvalId).record,
  sourceOrigin,
});
const approvalLookup = async (approvalId) => liveApproval(approvalId);

function home(overrides = {}) {
  return {
    schemaVersion: 1,
    tabId: 10,
    frameId: 0,
    documentId: "document-one",
    origin: "https://agent.example",
    portNonce: "nonce-one",
    leasedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function lease(tabId, windowId = 1, overrides = {}) {
  return {
    schemaVersion: 1,
    tabId,
    windowId,
    currentDocumentId: null,
    currentRuntimeId: null,
    assignedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

test("lease and group validators reject incompatible versions", () => {
  assert.equal(validateHomeLease(home()).ok, true);
  assert.equal(validateTabLease(lease(20)).ok, true);
  assert.equal(validateHomeLease(home({ schemaVersion: 2 })).ok, false);
  assert.equal(validateTabLease(lease(20, 1, { schemaVersion: 2 })).ok, false);
  assert.equal(validateGroupRecord({ schemaVersion: 99 }).ok, false);
});

test("ordinary plus two website groups persist and reload without collisions", async () => {
  const storage = memoryStorage();
  let activation = 0;
  const first = createGroupStore({ storage, approvalLookup, activationIdFactory: () => `activation-${++activation}` });
  await first.initialize();
  const a = await first.createWebsiteGroup({ approvalId: "approval-a", title: "Agent A", home: home() });
  const b = await first.createWebsiteGroup({ approvalId: "approval-b", title: "Agent B", home: home({ tabId: 11, documentId: "document-two", portNonce: "nonce-two" }) });
  assert.equal(a.id, makeWebsiteGroupId("approval-a", "activation-1"));
  assert.equal(b.id, makeWebsiteGroupId("approval-b", "activation-2"));

  const second = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "unused" });
  await second.initialize();
  assert.equal((await second.getGroup(DEFAULT_GROUP_ID)).kind, "extension");
  assert.equal((await second.getGroup(a.id)).approvalId, "approval-a");
  assert.equal((await second.getGroup(b.id)).approvalId, "approval-b");
});

test("lookups require an explicit group ID and never return neighboring state", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  const created = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await assert.rejects(store.getGroup(), /explicit group id/i);
  await assert.rejects(store.getGroup("missing"), /group not found/i);
  const ordinary = await store.getGroup(DEFAULT_GROUP_ID);
  assert.equal(ordinary.approvalId, undefined);
  assert.equal((await store.getGroup(created.id)).approvalId, "approval-a");
});

test("duplicate tab ownership fails closed on mutation and reload", async () => {
  const storage = memoryStorage();
  let activation = 0;
  const store = createGroupStore({ storage, approvalLookup, activationIdFactory: () => `a${++activation}` });
  await store.initialize();
  const a = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  const b = await store.createWebsiteGroup({ approvalId: "approval-b", title: "B", home: home({ tabId: 11, documentId: "d2", portNonce: "n2" }) });
  await store.claimTab(a.id, lease(20));
  await assert.rejects(store.claimTab(b.id, lease(20)), /already owned/i);
  assert.equal(await store.ownerOfTab(20), a.id);

  const corrupt = storage.snapshot()[GROUPS_STORAGE_KEY];
  corrupt.groups[b.id].tabs["20"] = lease(20);
  const corruptStorage = memoryStorage({ [GROUPS_STORAGE_KEY]: corrupt });
  const reloaded = createGroupStore({ storage: corruptStorage, approvalLookup, activationIdFactory: () => "unused" });
  await reloaded.initialize();
  await assert.rejects(reloaded.getGroup(a.id), /persisted group state/i);
  assert.deepEqual(corruptStorage.snapshot()[GROUPS_STORAGE_KEY], corrupt);
});

test("website groups require a top-level live home and live approval", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  await assert.rejects(store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: null }), /home/i);
  await assert.rejects(store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home({ frameId: 1 }) }), /top-level/i);

  const missing = createGroupStore({ storage: memoryStorage(), approvalLookup: async () => null, activationIdFactory: () => "one" });
  await missing.initialize();
  await assert.rejects(missing.createWebsiteGroup({ approvalId: "missing", title: "A", home: home() }), /approval/i);

  const malformed = createGroupStore({
    storage: memoryStorage(),
    approvalLookup: async (approvalId) => ({ approvalId, sourceOrigin: "https://agent.example", revokedAt: null }),
    activationIdFactory: () => "one",
  });
  await malformed.initialize();
  await assert.rejects(malformed.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }), /approval/i);
});

test("reconciliation rejects a live group after approval is missing or revoked", async () => {
  const storage = memoryStorage();
  let revoked = false;
  const lookup = async (approvalId) => revoked
    ? { ...liveApproval(approvalId), revokedAt: "2026-07-15T13:00:00.000Z" }
    : liveApproval(approvalId);
  const store = createGroupStore({ storage, approvalLookup: lookup, activationIdFactory: () => "one" });
  await store.initialize();
  const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  revoked = true;
  const result = await store.reconcile();
  assert.deepEqual(result.invalidGroups, [group.id]);
  await assert.rejects(store.getGroup(group.id), /group not found/i);
});

test("reconciliation suspends during an authority outage and restores the group after recovery", async () => {
  const storage = memoryStorage();
  let unavailable = false;
  const lookup = async (approvalId) => {
    if (unavailable) throw new Error("approval storage unavailable");
    return liveApproval(approvalId);
  };
  const store = createGroupStore({ storage, approvalLookup: lookup, activationIdFactory: () => "one" });
  await store.initialize();
  const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await store.claimTab(group.id, lease(20));

  unavailable = true;
  assert.deepEqual((await store.reconcile()).invalidGroups, [group.id]);
  const suspended = storage.snapshot()[GROUPS_STORAGE_KEY];
  assert.equal(suspended.groups[group.id].status, "suspended");
  assert.equal(suspended.tabOwners["20"], group.id);
  assert.equal(suspended.homeTabOwners["10"], group.id);

  unavailable = false;
  assert.deepEqual((await store.reconcile()).invalidGroups, []);
  assert.equal(storage.snapshot()[GROUPS_STORAGE_KEY].groups[group.id].status, "live");
  assert.equal((await store.getGroup(group.id)).status, "live");
  assert.equal(await store.ownerOfTab(20), group.id);
});

test("reconciliation preserves and suspends authority identity or integrity mismatches", async () => {
  for (const mismatch of [
    undefined,
    {},
    { approvalId: "approval-a", sourceOrigin: "https://agent.example" },
    { approvalId: "approval-a", sourceOrigin: "https://agent.example", revokedAt: null },
    { approvalId: "different-approval", sourceOrigin: "https://agent.example", revokedAt: null },
    { approvalId: "approval-a", sourceOrigin: "https://different.example", revokedAt: null },
    { ...liveApproval("approval-a", "https://different.example"), revokedAt: "2026-07-15T13:00:00.000Z" },
  ]) {
    const storage = memoryStorage();
    let current = liveApproval("approval-a");
    const store = createGroupStore({
      storage,
      approvalLookup: async () => current,
      activationIdFactory: () => "mismatch",
    });
    await store.initialize();
    const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
    current = mismatch;

    assert.deepEqual((await store.reconcile()).invalidGroups, [group.id]);
    const persisted = storage.snapshot()[GROUPS_STORAGE_KEY];
    assert.equal(persisted.groups[group.id].status, "suspended");
    assert.equal(persisted.homeTabOwners["10"], group.id);
  }
});

test("approval and group stores compose across outage, recovery, revocation, and missing authority", async () => {
  const bundleStorage = memoryBundleStorage();
  const approvalStorage = memoryStorage();
  const approvals = createApprovalStore({ metadataStorage: approvalStorage, bundleStorage, now: () => 42 });
  const granted = persistedApproval();
  await approvals.putApproval({ approval: granted.record, bundleBytes: granted.bytes });

  let authority = approvals;
  const groupStorage = memoryStorage();
  const groups = createGroupStore({
    storage: groupStorage,
    approvalLookup: (approvalId) => authority.getApproval(approvalId),
    activationIdFactory: () => "one",
  });
  await groups.initialize();
  const group = await groups.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await groups.claimTab(group.id, lease(20));

  bundleStorage.setUnavailable(true);
  await groups.reconcile();
  assert.equal(groupStorage.snapshot()[GROUPS_STORAGE_KEY].groups[group.id].status, "suspended");
  assert.equal(groupStorage.snapshot()[GROUPS_STORAGE_KEY].tabOwners["20"], group.id);

  bundleStorage.setUnavailable(false);
  await groups.reconcile();
  assert.equal((await groups.getGroup(group.id)).status, "live");

  await approvals.revokeApproval("approval-a");
  await groups.reconcile();
  await assert.rejects(groups.getGroup(group.id), /group not found/i);

  const secondBundleStorage = memoryBundleStorage();
  const secondApprovals = createApprovalStore({ metadataStorage: memoryStorage(), bundleStorage: secondBundleStorage, now: () => 1 });
  const secondGranted = persistedApproval("approval-b");
  await secondApprovals.putApproval({ approval: secondGranted.record, bundleBytes: secondGranted.bytes });
  authority = secondApprovals;
  const second = await groups.createWebsiteGroup({
    approvalId: "approval-b",
    title: "B",
    home: home({ tabId: 11, documentId: "document-two", portNonce: "nonce-two" }),
  });
  authority = createApprovalStore({ metadataStorage: memoryStorage(), bundleStorage: memoryBundleStorage(), now: () => 1 });
  await groups.reconcile();
  await assert.rejects(groups.getGroup(second.id), /group not found/i);
});

test("visual Chrome group IDs are partitioned per window", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  await store.setChromeGroupId(DEFAULT_GROUP_ID, 1, 101);
  await store.setChromeGroupId(DEFAULT_GROUP_ID, 2, 202);
  const ordinary = await store.getGroup(DEFAULT_GROUP_ID);
  assert.deepEqual(ordinary.chromeGroupIdsByWindow, { "1": 101, "2": 202 });
});

test("storage timeout fails closed and initialization recovers on a later call", async () => {
  let calls = 0;
  const storage = memoryStorage();
  const healthyGet = storage.get.bind(storage);
  storage.get = (key) => ++calls === 1 ? new Promise(() => {}) : healthyGet(key);
  const store = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "one", ioTimeoutMs: 20 });
  await assert.rejects(store.getGroup(DEFAULT_GROUP_ID), /group store unavailable/i);
  assert.equal((await store.getGroup(DEFAULT_GROUP_ID)).id, DEFAULT_GROUP_ID);
});

test("concurrent claims serialize and produce exactly one winner", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: (() => { let i = 0; return () => `a${++i}`; })() });
  await store.initialize();
  const a = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  const b = await store.createWebsiteGroup({ approvalId: "approval-b", title: "B", home: home({ tabId: 11, documentId: "d2", portNonce: "n2" }) });
  const results = await Promise.allSettled([store.claimTab(a.id, lease(30)), store.claimTab(b.id, lease(30))]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.ok([a.id, b.id].includes(await store.ownerOfTab(30)));
});

test("claim receipts make rollback and release compare-and-swap", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  const first = await store.claimTabWithReceipt(DEFAULT_GROUP_ID, { ...lease(30), authorizationId: "first" });
  const second = await store.claimTabWithReceipt(DEFAULT_GROUP_ID, { ...lease(30), authorizationId: "second" });

  assert.equal(await store.rollbackTabClaim(first), false);
  assert.equal(await store.releaseTabIfRevision(DEFAULT_GROUP_ID, 30, first.claimedRevision), false);
  assert.equal((await store.authoritativeClaimOfTab(30)).lease.authorizationId, "second");

  assert.equal(await store.rollbackTabClaim(second), true);
  const restored = await store.authoritativeClaimOfTab(30);
  assert.equal(restored.lease.authorizationId, "first");
  assert.equal(restored.lease.ownershipRevision, first.claimedRevision);
});

test("claim rollback rejects a malformed receipt before changing authority", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  const receipt = await store.claimTabWithReceipt(DEFAULT_GROUP_ID, lease(31));

  await assert.rejects(
    store.rollbackTabClaim({ ...receipt, claimedRevision: "" }),
    /valid tab claim receipt/i,
  );
  const current = await store.authoritativeClaimOfTab(31);
  assert.equal(current.state, "owned");
  assert.equal(current.lease.ownershipRevision, receipt.claimedRevision);
});

test("legacy migration recognizes only actions-json-default", async () => {
  const storage = memoryStorage();
  const store = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "unused" });
  await store.initialize({
    legacyState: {
      sessions: {
        "actions-json-default": { title: "actions.json", activeTabId: 42, tabs: { "42": { authorizationId: "auth" } }, chromeGroupId: 7 },
        "website-looking-legacy": { tabs: { "99": {} } },
      },
    },
  });
  const ordinary = await store.getGroup(DEFAULT_GROUP_ID);
  assert.equal(ordinary.activeTabId, 42);
  assert.equal(ordinary.tabs["42"].tabId, 42);
  assert.equal(await store.ownerOfTab(42), DEFAULT_GROUP_ID);
  assert.equal(await store.ownerOfTab(99), null);
  assert.deepEqual(ordinary.chromeGroupIdsByWindow, {});
});

test("website home origin must exactly match its live approval on create, update, reload, and reconcile", async () => {
  const storage = memoryStorage();
  const store = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home({ origin: "https://other.example" }) }),
    /source origin/i,
  );
  const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await assert.rejects(store.updateGroup(group.id, { home: home({ origin: "https://other.example" }) }), /source origin/i);

  const raw = storage.snapshot()[GROUPS_STORAGE_KEY];
  raw.groups[group.id].home.origin = "https://other.example";
  const reloaded = createGroupStore({ storage: memoryStorage({ [GROUPS_STORAGE_KEY]: raw }), approvalLookup, activationIdFactory: () => "unused" });
  await reloaded.initialize();
  await assert.rejects(reloaded.getGroup(group.id), /source origin|authority/i);
});

test("website group approval, activation, and derived ID are immutable", async () => {
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => "one" });
  await store.initialize();
  const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await assert.rejects(store.updateGroup(group.id, { approvalId: "approval-b" }), /identity/i);
  await assert.rejects(store.updateGroup(group.id, { activationId: "two" }), /identity/i);
  const malformed = { ...group, id: "website:approval-a:wrong" };
  assert.equal(validateGroupRecord(malformed).ok, false);
});

test("revoked, missing, and lookup-error approvals deny reads, ownership, and claims immediately", async () => {
  for (const mode of ["revoked", "missing", "error"]) {
    let blocked = false;
    const lookup = async (approvalId) => {
      if (!blocked) return liveApproval(approvalId);
      if (mode === "error") throw new Error("approval backend unavailable");
      if (mode === "missing") return null;
      return { ...liveApproval(approvalId), revokedAt: "2026-07-15T13:00:00.000Z" };
    };
    const store = createGroupStore({ storage: memoryStorage(), approvalLookup: lookup, activationIdFactory: () => "one" });
    await store.initialize();
    const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
    await store.claimTab(group.id, lease(20));
    blocked = true;
    await assert.rejects(store.getGroup(group.id), /approval|authority|suspended/i);
    assert.equal(await store.ownerOfTab(20), null);
    await assert.rejects(store.claimTab(group.id, lease(21)), /approval|authority|suspended/i);
    await assert.rejects(store.releaseTab(group.id, 20), /approval|authority|suspended/i);
  }
});

test("ownership lookup distinguishes owned, unowned, and unavailable authority", async () => {
  let authorityAvailable = true;
  const lookup = async (approvalId) => {
    if (!authorityAvailable) throw new Error("approval backend unavailable");
    return liveApproval(approvalId);
  };
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup: lookup, activationIdFactory: () => "one" });
  await store.initialize();
  const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await store.claimTab(group.id, lease(20));

  assert.deepEqual(await store.ownershipOfTab(20), { state: "owned", groupId: group.id });
  assert.deepEqual(await store.ownershipOfTab(21), { state: "unowned", groupId: null });

  authorityAvailable = false;
  const unavailable = await store.ownershipOfTab(20);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.groupId, group.id);
  assert.match(unavailable.reason, /authority|unavailable/i);
  await assert.rejects(store.isTabReserved(20), /authority unavailable/i);
});

test("home tabs are reserved but never returned as target ownership", async () => {
  let activation = 0;
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => `a${++activation}` });
  await store.initialize();
  const group = await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home({ tabId: 10 }) });
  assert.equal(await store.ownerOfTab(10), null, "home is identity, not an action target");
  await assert.rejects(store.claimTab(DEFAULT_GROUP_ID, lease(10)), /home|reserved/i);
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-b", title: "B", home: home({ tabId: 10, documentId: "d2", portNonce: "n2" }) }),
    /home|reserved/i,
  );
  await store.claimTab(group.id, lease(20));
  assert.equal(await store.ownerOfTab(20), group.id);
});

test("suspended and ended groups cannot be read as live destinations or claim targets", async () => {
  for (const status of ["suspended", "ended"]) {
    const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => status });
    await store.initialize();
    const group = await store.createWebsiteGroup({ approvalId: `approval-${status}`, title: status, home: home() });
    await store.updateGroup(group.id, { status });
    await assert.rejects(store.getGroup(group.id), /not live|suspended|ended/i);
    await assert.rejects(store.claimTab(group.id, lease(20)), /not live|suspended|ended/i);
  }
});

test("an approval can have at most one live or suspended activation", async () => {
  let activation = 0;
  const store = createGroupStore({ storage: memoryStorage(), approvalLookup, activationIdFactory: () => `a${++activation}` });
  await store.initialize();
  await store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-a", title: "A2", home: home({ tabId: 11, documentId: "d2", portNonce: "n2" }) }),
    /live group|activation/i,
  );
});

test("delayed group metadata writes are reconciled and cannot appear after a failed mutation", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let delay = false;
  storage.set = (items) => delay
    ? new Promise((resolve) => setTimeout(() => { immediateSet(items).then(resolve); }, 40))
    : immediateSet(items);
  const store = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "one", ioTimeoutMs: 10 });
  await store.initialize();
  delay = true;
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );
  const immediateRestart = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "two", ioTimeoutMs: 10 });
  await immediateRestart.initialize();
  await assert.rejects(immediateRestart.getGroup(makeWebsiteGroupId("approval-a", "one")), /not found/i);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const settledRestart = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "three", ioTimeoutMs: 20 });
  await settledRestart.initialize();
  await assert.rejects(settledRestart.getGroup(makeWebsiteGroupId("approval-a", "one")), /not found/i);
});

test("a timed-out delayed write cannot roll back a later successful mutation in the same store", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let delayNextWrite = false;
  storage.set = (items) => {
    if (!delayNextWrite) return immediateSet(items);
    delayNextWrite = false;
    return new Promise((resolve) => setTimeout(() => { immediateSet(items).then(resolve); }, 40));
  };
  let activation = 0;
  const store = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => `a${++activation}`,
    ioTimeoutMs: 10,
  });
  await store.initialize();
  delayNextWrite = true;
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );
  const createSecond = () => store.createWebsiteGroup({
    approvalId: "approval-b",
    title: "B",
    home: home({ tabId: 11, documentId: "d2", portNonce: "n2" }),
  });
  await assert.rejects(createSecond(), /recovery.*progress/i);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const second = await createSecond();
  assert.equal((await store.getGroup(second.id)).approvalId, "approval-b");
  const restarted = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "restart",
    ioTimeoutMs: 20,
  });
  await restarted.initialize();
  assert.equal((await restarted.getGroup(second.id)).approvalId, "approval-b");
});

test("a final group commit that reports rejection is reconciled as success", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let rejectFinalCommit = false;
  storage.set = async (items) => {
    await immediateSet(items);
    const key = Object.keys(items)[0];
    if (rejectFinalCommit && key.startsWith(`${GROUPS_STORAGE_KEY}.commits.ack.`)) {
      rejectFinalCommit = false;
      throw new Error("final group commit reported rejected");
    }
  };
  const store = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "commit-rejected",
    ioTimeoutMs: 20,
  });
  await store.initialize();
  rejectFinalCommit = true;

  const created = await store.createWebsiteGroup({
    approvalId: "approval-a",
    title: "A",
    home: home(),
  });

  assert.equal(created.approvalId, "approval-a");
  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal((await replacement.getGroup(created.id)).approvalId, "approval-a");
});

test("a replacement worker rolls back a persisted pending group transaction", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let abandonCommit = false;
  storage.set = (items) => {
    const transaction = items[GROUPS_STORAGE_KEY]?.transaction;
    if (abandonCommit && transaction?.state === "applied") {
      return new Promise(() => {});
    }
    return immediateSet(items);
  };

  const original = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "crashed",
    ioTimeoutMs: 10,
  });
  await original.initialize();
  abandonCommit = true;
  await assert.rejects(
    original.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );
  assert.equal(storage.snapshot()[GROUPS_STORAGE_KEY].transaction.state, "pending");

  // Simulate replacement of the original worker. Its process-local recovery
  // continuation is gone; the durable pending record is the only evidence left.
  abandonCommit = false;
  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal(await replacement.initialize(), true);
  assert.equal((await replacement.getGroup(DEFAULT_GROUP_ID)).id, DEFAULT_GROUP_ID);
  await assert.rejects(
    replacement.getGroup(makeWebsiteGroupId("approval-a", "crashed")),
    /not found/i,
  );
});

test("a late group write from a destroyed worker cannot erase a replacement worker commit", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let strandedWrite = null;
  let strandNextPending = false;
  storage.set = (items) => {
    const next = items[GROUPS_STORAGE_KEY];
    if (strandNextPending && next?.transaction?.state === "pending") {
      strandNextPending = false;
      strandedWrite = () => immediateSet(items);
      // The write may reach storage after W1 is gone, but W1's Promise and
      // process-local compensation never resume.
      return new Promise(() => {});
    }
    return immediateSet(items);
  };
  const first = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "first",
    ioTimeoutMs: 10,
  });
  await first.initialize();
  strandNextPending = true;
  await assert.rejects(
    first.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );

  const second = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "second",
    ioTimeoutMs: 20,
  });
  const committed = await second.createWebsiteGroup({
    approvalId: "approval-b",
    title: "B",
    home: home({ tabId: 11, documentId: "d2", portNonce: "n2" }),
  });

  await strandedWrite();
  const third = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "third",
    ioTimeoutMs: 20,
  });
  assert.equal((await third.getGroup(committed.id)).approvalId, "approval-b");
  await assert.rejects(third.getGroup(makeWebsiteGroupId("approval-a", "first")), /not found/i);
});

test("replacement workers cannot reuse a cancelled group transaction ID", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  const originalNow = Date.now;
  Date.now = () => 1234;
  let rejectFirstAcknowledgement = true;
  storage.set = async (items) => {
    const key = Object.keys(items)[0];
    if (rejectFirstAcknowledgement && key.includes(".commits.ack.")) {
      rejectFirstAcknowledgement = false;
      throw new Error("acknowledgement unavailable");
    }
    return immediateSet(items);
  };
  try {
    const first = createGroupStore({
      storage,
      approvalLookup,
      activationIdFactory: () => "first",
      ioTimeoutMs: 20,
    });
    assert.equal(await first.initialize(), false);

    const second = createGroupStore({
      storage,
      approvalLookup,
      activationIdFactory: () => "second",
      ioTimeoutMs: 20,
    });
    const staleMirror = storage.snapshot()[GROUPS_STORAGE_KEY];
    await second.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
    await immediateSet({ [GROUPS_STORAGE_KEY]: staleMirror });

    const third = createGroupStore({
      storage,
      approvalLookup,
      activationIdFactory: () => "third",
      ioTimeoutMs: 20,
    });
    assert.equal((await third.getGroup(makeWebsiteGroupId("approval-a", "second"))).approvalId, "approval-a");
  } finally {
    Date.now = originalNow;
  }
});

test("a replacement worker rolls back a persisted applied group transaction", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let abandonApplied = false;
  storage.set = (items) => {
    const transaction = items[GROUPS_STORAGE_KEY]?.transaction;
    if (abandonApplied && transaction?.state === "applied") {
      immediateSet(items);
      return new Promise(() => {});
    }
    return immediateSet(items);
  };
  const original = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "applied",
    ioTimeoutMs: 10,
  });
  await original.initialize();
  abandonApplied = true;
  await assert.rejects(
    original.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );
  assert.equal(storage.snapshot()[GROUPS_STORAGE_KEY].transaction.state, "applied");

  abandonApplied = false;
  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal(await replacement.initialize(), true);
  assert.equal((await replacement.getGroup(DEFAULT_GROUP_ID)).id, DEFAULT_GROUP_ID);
  await assert.rejects(
    replacement.getGroup(makeWebsiteGroupId("approval-a", "applied")),
    /not found/i,
  );
});

test("a persisted group recovery marker fences an unfenceable late acknowledgement", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  const immediateRemove = storage.remove.bind(storage);
  let failFence = false;
  let lateAcknowledgement = null;
  storage.set = async (items) => {
    const key = Object.keys(items)[0];
    if (failFence && key.startsWith("actionsJsonAgentGroups.v2.commits.ack.")) {
      lateAcknowledgement = () => immediateSet(items);
      throw new Error("acknowledgement unavailable");
    }
    if (failFence && key.startsWith("actionsJsonAgentGroups.v2.commits.cancel.")) {
      throw new Error("cancellation unavailable");
    }
    return immediateSet(items);
  };
  storage.remove = async (keys) => {
    if (failFence) throw new Error("prepared data cleanup unavailable");
    return immediateRemove(keys);
  };
  const original = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "unfenced",
    ioTimeoutMs: 20,
  });
  await original.initialize();
  failFence = true;
  await assert.rejects(
    original.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /cancellation could not be proven.*cleanup failed/i,
  );
  assert.ok(lateAcknowledgement);

  failFence = false;
  await lateAcknowledgement();
  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal(await replacement.initialize(), true);
  await assert.rejects(
    replacement.getGroup(makeWebsiteGroupId("approval-a", "unfenced")),
    /not found/i,
  );
});

test("a slow final group mirror cannot time out and later resurrect a rejected group", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let delayCommittedMirror = true;
  storage.set = async (items) => {
    const transaction = items[GROUPS_STORAGE_KEY]?.transaction;
    if (delayCommittedMirror && transaction?.state === "committed" && transaction.id !== "empty") {
      delayCommittedMirror = false;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return immediateSet(items);
  };
  const original = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "slow-final",
    ioTimeoutMs: 10,
  });
  await original.initialize();
  const created = await original.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  assert.equal(created.id, makeWebsiteGroupId("approval-a", "slow-final"));

  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal((await replacement.getGroup(created.id)).id, created.id);
});

test("first-install recovery always restores a valid extension default group", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let abandonCommit = true;
  storage.set = (items) => {
    const transaction = items[GROUPS_STORAGE_KEY]?.transaction;
    if (abandonCommit && transaction?.state === "applied") {
      return new Promise(() => {});
    }
    return immediateSet(items);
  };

  const original = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "original",
    ioTimeoutMs: 10,
  });
  assert.equal(await original.initialize(), false);
  assert.equal(storage.snapshot()[GROUPS_STORAGE_KEY].transaction.state, "pending");

  abandonCommit = false;
  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal(await replacement.initialize(), true);
  assert.equal((await replacement.getGroup(DEFAULT_GROUP_ID)).id, DEFAULT_GROUP_ID);
});

test("an abandoned group write cannot leave the same worker recovery barrier stuck forever", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let abandonApplied = false;
  storage.set = (items) => {
    if (abandonApplied && items[GROUPS_STORAGE_KEY]?.transaction?.state === "applied") {
      return new Promise(() => {});
    }
    return immediateSet(items);
  };
  const store = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "abandoned",
    ioTimeoutMs: 10,
  });
  await store.initialize();
  abandonApplied = true;
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );
  abandonApplied = false;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await store.getGroup(DEFAULT_GROUP_ID)).id, DEFAULT_GROUP_ID);
});

test("a very-late group write cannot erase a newer committed mutation after the recovery barrier expires", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let delayNextPending = false;
  storage.set = (items) => {
    if (delayNextPending && items[GROUPS_STORAGE_KEY]?.transaction?.state === "pending") {
      delayNextPending = false;
      return new Promise((resolve) => {
        setTimeout(() => { immediateSet(items).then(resolve); }, 120);
      });
    }
    return immediateSet(items);
  };
  let activation = 0;
  const store = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => `late-${++activation}`,
    ioTimeoutMs: 10,
  });
  await store.initialize();

  delayNextPending = true;
  await assert.rejects(
    store.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() }),
    /indeterminate|timed out/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const newer = await store.createWebsiteGroup({
    approvalId: "approval-b",
    title: "B",
    home: home({ tabId: 11, documentId: "d2", portNonce: "n2" }),
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const replacement = createGroupStore({
    storage,
    approvalLookup,
    activationIdFactory: () => "replacement",
    ioTimeoutMs: 20,
  });
  assert.equal((await replacement.getGroup(newer.id)).approvalId, "approval-b");
});

test("HTTP origins are allowed only for canonical localhost", () => {
  assert.equal(validateHomeLease(home({ origin: "http://agent.example" })).ok, false);
  assert.equal(validateHomeLease(home({ origin: "http://localhost:3000" })).ok, true);
});

test("interleaved ordinary-session and delegated-group writes preserve both isolated records", async () => {
  const ordinaryKey = "actionsJsonOrdinarySessions.v2";
  const ordinary = { schemaVersion: 2, groups: { [DEFAULT_GROUP_ID]: { tabs: { "40": {} } } } };
  const storage = memoryStorage({ [ordinaryKey]: ordinary });
  const groups = createGroupStore({ storage, approvalLookup, activationIdFactory: () => "one" });
  await groups.initialize();
  await groups.createWebsiteGroup({ approvalId: "approval-a", title: "A", home: home() });
  assert.deepEqual(storage.snapshot()[ordinaryKey], ordinary);
  const updatedOrdinary = { ...ordinary, marker: "later ordinary write" };
  await storage.set({ [ordinaryKey]: updatedOrdinary });
  assert.equal(storage.snapshot()[GROUPS_STORAGE_KEY].groups[makeWebsiteGroupId("approval-a", "one")].approvalId, "approval-a");
});
