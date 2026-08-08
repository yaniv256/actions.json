import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ApprovalAuthorityUnavailableError,
  ApprovalIntegrityError,
  APPROVALS_STORAGE_KEY,
  BUNDLE_STORE_NAME,
  approvalIdentityKey,
  approvalRecordFromValidatedBundle,
  createApprovalStore,
  validateApprovalRecord,
} from "../src/delegated-agent/approval-store.mjs";
import { validateDelegatedBundleSnapshot } from "../src/delegated-agent/bundle-schema.mjs";
import { DELEGATED_POLICY_LIMITS } from "../src/delegated-agent/delegated-policy.mjs";

const clone = (value) => structuredClone(value);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oneByteDigest = digest(new Uint8Array([1]));

function approval(overrides = {}) {
  return {
    schemaVersion: 1,
    approvalId: "approval-one",
    agent: { id: "agent-one", name: "Example agent" },
    sourceOrigin: "https://agent.example",
    githubOwner: "example",
    githubRepo: "agent-bundle",
    commitSha: "a".repeat(40),
    manifestPath: "agent.json",
    bundleDigest: oneByteDigest,
    reviewedAt: "2026-07-15T12:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function memoryMetadata(initial = {}) {
  let value = clone(initial);
  return {
    async get(key) { return key === null ? clone(value) : { [key]: clone(value[key]) }; },
    async set(items) { value = { ...value, ...clone(items) }; },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete value[key]; },
    snapshot() { return clone(value); },
  };
}

function memoryBundles({ initialUsedBytes = 0, quotaBytes = 64 * 1024 * 1024 } = {}) {
  const values = new Map();
  return {
    name: BUNDLE_STORE_NAME,
    async get(key) { return values.has(key) ? new Uint8Array(values.get(key)) : null; },
    async put(key, bytes) { values.set(key, new Uint8Array(bytes)); },
    async delete(key) { values.delete(key); },
    async getUsage() {
      const storedBytes = [...values.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
      return { usedBytes: initialUsedBytes + storedBytes, quotaBytes };
    },
    seed(key, bytes) { values.set(key, new Uint8Array(bytes)); },
    snapshot() { return new Map([...values].map(([key, bytes]) => [key, new Uint8Array(bytes)])); },
  };
}

const persistedBundleKey = (metadataStorage, record = approval()) => {
  const logicalKey = `${record.approvalId}:${record.bundleDigest}`;
  return metadataStorage.snapshot()[APPROVALS_STORAGE_KEY]?.bundleOwners?.[logicalKey]?.storageKey || logicalKey;
};

test("approval record validation and identity cover every immutable authority field", () => {
  const original = approval();
  assert.deepEqual(validateApprovalRecord(original), { ok: true, value: original });
  for (const changed of [
    { sourceOrigin: "https://other.example" },
    { githubRepo: "other" },
    { commitSha: "c".repeat(40) },
    { manifestPath: "nested/agent.json" },
    { bundleDigest: "d".repeat(64) },
    { agent: { id: "other-agent", name: "Example agent" } },
  ]) {
    assert.notEqual(approvalIdentityKey(original), approvalIdentityKey(approval(changed)));
  }
});

test("approval metadata and immutable bytes persist and reload", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const bytes = new Uint8Array([1, 2, 3]);
  const first = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1 });
  await first.putApproval({ approval: approval({ bundleDigest: digest(bytes) }), bundleBytes: bytes });

  bytes[0] = 99;
  const second = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2 });
  assert.equal((await second.getApproval("approval-one")).approvalId, "approval-one");
  assert.deepEqual([...await second.getBundleClone("approval-one")], [1, 2, 3]);
});

test("returned records and bytes are mutation-isolated clones", async () => {
  const store = createApprovalStore({ metadataStorage: memoryMetadata(), bundleStorage: memoryBundles(), now: () => 1 });
  await store.putApproval({ approval: approval({ bundleDigest: digest(new Uint8Array([4, 5])) }), bundleBytes: new Uint8Array([4, 5]) });
  const record = await store.getApproval("approval-one");
  record.agent.id = "mutated";
  const bytes = await store.getBundleClone("approval-one");
  bytes[0] = 0;
  assert.equal((await store.getApproval("approval-one")).agent.id, "agent-one");
  assert.deepEqual([...await store.getBundleClone("approval-one")], [4, 5]);
});

test("an existing approval ID cannot change its exact approval identity", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1 });
  await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  for (const changed of [
    { sourceOrigin: "https://other.example" },
    { githubOwner: "attacker" },
    { commitSha: "c".repeat(40) },
    { manifestPath: "other.json" },
    { bundleDigest: "d".repeat(64) },
    { agent: { id: "other", name: "Other" } },
  ]) {
    await assert.rejects(
      store.putApproval({ approval: approval(changed), bundleBytes: new Uint8Array([1]) }),
      /identity/i,
    );
  }
  assert.equal((await store.getApproval("approval-one")).sourceOrigin, "https://agent.example");
  assert.deepEqual([...await store.getBundleClone("approval-one")], [1]);
});

test("bundle persistence happens before metadata and either failure grants no approval", async () => {
  const bundleFailure = memoryBundles();
  bundleFailure.put = async () => { throw new Error("bundle full"); };
  const metadataOne = memoryMetadata();
  const first = createApprovalStore({ metadataStorage: metadataOne, bundleStorage: bundleFailure, now: () => 1 });
  await assert.rejects(first.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }), /bundle full/);
  assert.equal(await first.getApproval("approval-one"), null);

  const metadataFailure = memoryMetadata();
  metadataFailure.set = async () => { throw new Error("metadata unavailable"); };
  const bundlesTwo = memoryBundles();
  const second = createApprovalStore({ metadataStorage: metadataFailure, bundleStorage: bundlesTwo, now: () => 1 });
  await assert.rejects(second.putApproval({ approval: approval({ bundleDigest: digest(new Uint8Array([2])) }), bundleBytes: new Uint8Array([2]) }), /metadata unavailable/);
  assert.equal(await second.getApproval("approval-one"), null);
  assert.equal(metadataFailure.snapshot()[APPROVALS_STORAGE_KEY], undefined);
});

test("a committed bundle write with failed rollback latches approval integrity", async () => {
  const bundleStorage = memoryBundles();
  const commitBundle = bundleStorage.put.bind(bundleStorage);
  bundleStorage.put = async (key, bytes) => {
    await commitBundle(key, bytes);
    throw new Error("bundle outcome reported failed after commit");
  };
  bundleStorage.delete = async () => {
    throw new Error("bundle rollback unavailable");
  };
  const store = createApprovalStore({
    metadataStorage: memoryMetadata(),
    bundleStorage,
    now: () => 1,
  });

  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /reported failed after commit/i,
  );
  await assert.rejects(
    store.getApproval("approval-one"),
    (error) => error instanceof ApprovalIntegrityError
      && error.code === "approval_integrity_failure",
  );
});

test("revocation affects only the selected approval", async () => {
  const store = createApprovalStore({ metadataStorage: memoryMetadata(), bundleStorage: memoryBundles(), now: () => 42 });
  await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  await store.putApproval({
    approval: approval({ approvalId: "approval-two", agent: { id: "agent-two", name: "Two" }, bundleDigest: digest(new Uint8Array([2])) }),
    bundleBytes: new Uint8Array([2]),
  });
  await store.revokeApproval("approval-one");
  assert.equal((await store.getApproval("approval-one")).revokedAt, new Date(42).toISOString());
  assert.equal(await store.getBundleClone("approval-one"), null);
  assert.equal((await store.getApproval("approval-two")).revokedAt, null);
  assert.deepEqual([...await store.getBundleClone("approval-two")], [2]);
});

test("malformed and newer persisted states fail closed and are never overwritten", async () => {
  for (const persisted of [
    { schemaVersion: 99, approvals: { "approval-one": approval() } },
    { schemaVersion: 1, approvals: { "approval-one": { ...approval(), commitSha: "main" } } },
  ]) {
    const metadataStorage = memoryMetadata({ [APPROVALS_STORAGE_KEY]: persisted });
    const store = createApprovalStore({ metadataStorage, bundleStorage: memoryBundles(), now: () => 1 });
    await assert.rejects(
      store.getApproval("approval-one"),
      (error) => error instanceof ApprovalIntegrityError && error.code === "approval_integrity_failure",
    );
    await assert.rejects(
      store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
      /persisted approval state/i,
    );
    assert.deepEqual(metadataStorage.snapshot()[APPROVALS_STORAGE_KEY], persisted);
  }
});

test("a timed-out initialization fails closed and retries successfully on the next call", async () => {
  let calls = 0;
  const metadataStorage = memoryMetadata({
    [APPROVALS_STORAGE_KEY]: { schemaVersion: 1, approvals: { "approval-one": approval() } },
  });
  const healthyGet = metadataStorage.get.bind(metadataStorage);
  metadataStorage.get = (key) => {
    calls += 1;
    return calls === 1 ? new Promise(() => {}) : healthyGet(key);
  };
  const bundleStorage = memoryBundles();
  bundleStorage.seed(`approval-one:${oneByteDigest}`, new Uint8Array([1]));
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });
  await assert.rejects(
    store.getApproval("approval-one"),
    (error) => error instanceof ApprovalAuthorityUnavailableError && error.code === "approval_authority_unavailable",
  );
  assert.equal((await store.getApproval("approval-one")).approvalId, "approval-one");
});

test("missing and revoked approvals remain authoritative while bundle read failures are typed", async () => {
  const missing = createApprovalStore({
    metadataStorage: memoryMetadata(),
    bundleStorage: memoryBundles(),
    now: () => 1,
  });
  assert.equal(await missing.getApproval("approval-one"), null);

  const revoked = createApprovalStore({
    metadataStorage: memoryMetadata(),
    bundleStorage: memoryBundles(),
    now: () => 42,
  });
  await revoked.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  await revoked.revokeApproval("approval-one");
  assert.notEqual((await revoked.getApproval("approval-one")).revokedAt, null);

  const metadata = memoryMetadata({
    [APPROVALS_STORAGE_KEY]: { schemaVersion: 1, approvals: { "approval-one": approval() } },
  });
  const unavailableBundles = memoryBundles();
  unavailableBundles.get = async () => { throw new Error("IndexedDB unavailable"); };
  const unavailable = createApprovalStore({ metadataStorage: metadata, bundleStorage: unavailableBundles, now: () => 1 });
  await assert.rejects(
    unavailable.getApproval("approval-one"),
    (error) => error instanceof ApprovalAuthorityUnavailableError
      && error.code === "approval_authority_unavailable"
      && /bundle read/i.test(error.message),
  );

  const absentBundle = createApprovalStore({
    metadataStorage: metadata,
    bundleStorage: memoryBundles(),
    now: () => 1,
  });
  await assert.rejects(
    absentBundle.getApproval("approval-one"),
    (error) => error instanceof ApprovalIntegrityError
      && error.code === "approval_integrity_failure"
      && /missing/i.test(error.message),
  );

  const corruptBundles = memoryBundles();
  corruptBundles.seed(`approval-one:${oneByteDigest}`, new Uint8Array([2]));
  const corruptBundle = createApprovalStore({ metadataStorage: metadata, bundleStorage: corruptBundles, now: () => 1 });
  await assert.rejects(
    corruptBundle.getApproval("approval-one"),
    (error) => error instanceof ApprovalIntegrityError
      && error.code === "approval_integrity_failure"
      && /digest/i.test(error.message),
  );
});

test("a validated same-identity grant repairs corrupt bytes but not an unavailable bundle store", async () => {
  const record = approval();
  const corruptBundles = memoryBundles({ quotaBytes: 1 });
  corruptBundles.seed(`approval-one:${oneByteDigest}`, new Uint8Array([2]));
  for (const bundleStorage of [memoryBundles(), corruptBundles]) {
    const metadata = memoryMetadata({
      [APPROVALS_STORAGE_KEY]: { schemaVersion: 1, approvals: { [record.approvalId]: record } },
    });
    const repairable = createApprovalStore({ metadataStorage: metadata, bundleStorage, now: () => 1 });
    await assert.rejects(repairable.getApproval(record.approvalId), ApprovalIntegrityError);
    await repairable.putApproval({ approval: record, bundleBytes: new Uint8Array([1]) });
    assert.equal((await repairable.getApproval(record.approvalId)).approvalId, record.approvalId);
    assert.equal(bundleStorage.snapshot().size, 1);
    assert.equal((await bundleStorage.getUsage()).usedBytes, 1);
    const replacement = createApprovalStore({ metadataStorage: metadata, bundleStorage, now: () => 2 });
    assert.equal((await replacement.getApproval(record.approvalId)).approvalId, record.approvalId);
    await replacement.revokeApproval(record.approvalId);
    assert.equal(bundleStorage.snapshot().size, 0);
  }

  const unavailableBundles = memoryBundles();
  unavailableBundles.get = async () => { throw new Error("IndexedDB unavailable"); };
  const metadata = memoryMetadata({
    [APPROVALS_STORAGE_KEY]: { schemaVersion: 1, approvals: { [record.approvalId]: record } },
  });
  const unavailable = createApprovalStore({ metadataStorage: metadata, bundleStorage: unavailableBundles, now: () => 1 });
  await assert.rejects(
    unavailable.putApproval({ approval: record, bundleBytes: new Uint8Array([1]) }),
    ApprovalAuthorityUnavailableError,
  );
});

test("a timed-out repair stays unavailable until its late bundle write is removed", async () => {
  const record = approval();
  const metadata = memoryMetadata({
    [APPROVALS_STORAGE_KEY]: { schemaVersion: 1, approvals: { [record.approvalId]: record } },
  });
  const bundles = memoryBundles();
  bundles.seed(`approval-one:${oneByteDigest}`, new Uint8Array([2]));
  const immediatePut = bundles.put.bind(bundles);
  bundles.put = (key, bytes) => new Promise((resolve) => {
    setTimeout(() => { immediatePut(key, bytes).then(resolve); }, 40);
  });
  const store = createApprovalStore({ metadataStorage: metadata, bundleStorage: bundles, now: () => 1, ioTimeoutMs: 10 });

  await assert.rejects(
    store.putApproval({ approval: record, bundleBytes: new Uint8Array([1]) }),
    /bundle write timed out/i,
  );
  await assert.rejects(store.getApproval(record.approvalId), ApprovalAuthorityUnavailableError);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(store.getApproval(record.approvalId), ApprovalIntegrityError);
});

test("concurrent approval writes serialize without losing either durable grant", async () => {
  const store = createApprovalStore({ metadataStorage: memoryMetadata(), bundleStorage: memoryBundles(), now: () => 1 });
  await Promise.all([
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    store.putApproval({
      approval: approval({ approvalId: "approval-two", agent: { id: "agent-two", name: "Two" }, bundleDigest: digest(new Uint8Array([2])) }),
      bundleBytes: new Uint8Array([2]),
    }),
  ]);
  assert.equal((await store.getApproval("approval-one")).agent.id, "agent-one");
  assert.equal((await store.getApproval("approval-two")).agent.id, "agent-two");
});

test("approval origins require HTTPS except canonical localhost HTTP", () => {
  assert.equal(validateApprovalRecord(approval({ sourceOrigin: "http://agent.example" })).ok, false);
  assert.equal(validateApprovalRecord(approval({ sourceOrigin: "http://localhost:3000" })).ok, true);
  assert.equal(validateApprovalRecord(approval({ sourceOrigin: "https://AGENT.example" })).ok, false);
  assert.equal(validateApprovalRecord(approval({ sourceOrigin: "https://agent.example/" })).ok, false);
});

test("bundle bytes must match the canonical bare SHA-256 digest", async () => {
  const store = createApprovalStore({ metadataStorage: memoryMetadata(), bundleStorage: memoryBundles(), now: () => 1 });
  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([9]) }),
    /digest/i,
  );
  assert.equal(await store.getApproval("approval-one"), null);
});

test("per-bundle, global, and browser quota preflights deny without usable metadata", async () => {
  const tooLarge = new Uint8Array(DELEGATED_POLICY_LIMITS.maxBundleBytes + 1);
  const metadataOne = memoryMetadata();
  const first = createApprovalStore({ metadataStorage: metadataOne, bundleStorage: memoryBundles(), now: () => 1 });
  await assert.rejects(
    first.putApproval({ approval: approval({ bundleDigest: digest(tooLarge) }), bundleBytes: tooLarge }),
    /per-bundle/i,
  );
  assert.equal(metadataOne.snapshot()[APPROVALS_STORAGE_KEY], undefined);

  const one = new Uint8Array([1]);
  for (const bundleStorage of [
    memoryBundles({ initialUsedBytes: DELEGATED_POLICY_LIMITS.maxStoredBundlesBytes }),
    memoryBundles({ quotaBytes: 0 }),
  ]) {
    const metadata = memoryMetadata();
    const store = createApprovalStore({ metadataStorage: metadata, bundleStorage, now: () => 1 });
    await assert.rejects(store.putApproval({ approval: approval(), bundleBytes: one }), /quota|global/i);
    assert.equal(metadata.snapshot()[APPROVALS_STORAGE_KEY], undefined);
  }
});

test("a delayed metadata write is reconciled and cannot become a grant after a failed call or restart", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  metadataStorage.set = (items) => new Promise((resolve) => {
    setTimeout(() => { immediateSet(items).then(resolve); }, 40);
  });
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });
  await assert.rejects(store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }), /indeterminate|timed out/i);
  const immediateRestart = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 10 });
  assert.equal(await immediateRestart.getApproval("approval-one"), null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const settledRestart = createApprovalStore({ metadataStorage, bundleStorage, now: () => 3, ioTimeoutMs: 20 });
  assert.equal(await settledRestart.getApproval("approval-one"), null);
});

test("a final approval commit that reports rejection is reconciled as success", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  let writes = 0;
  metadataStorage.set = async (items) => {
    writes += 1;
    await immediateSet(items);
    if (writes === 3) throw new Error("final commit reported rejected");
  };
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });

  const result = await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });

  assert.equal(result.approvalId, "approval-one");
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal((await replacement.getApproval("approval-one")).approvalId, "approval-one");
});

test("a transient approval marker rejection does not permanently poison authority", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  let rejectMarker = true;
  metadataStorage.set = async (items) => {
    if (rejectMarker && items[APPROVALS_STORAGE_KEY]?.recovery?.kind === "approval-put") {
      rejectMarker = false;
      throw new Error("transient marker rejection");
    }
    await immediateSet(items);
  };
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });

  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /transient marker rejection/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  const result = await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  assert.equal(result.approvalId, "approval-one");
});

test("a timed-out approval write cannot erase a later successful grant in the same store", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  let delayNextWrite = false;
  metadataStorage.set = (items) => {
    if (!delayNextWrite) return immediateSet(items);
    delayNextWrite = false;
    return new Promise((resolve) => setTimeout(() => { immediateSet(items).then(resolve); }, 40));
  };
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });
  delayNextWrite = true;
  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );
  const second = approval({
    approvalId: "approval-two",
    agent: { id: "agent-two", name: "Two" },
    bundleDigest: digest(new Uint8Array([2])),
  });
  const putSecond = () => store.putApproval({ approval: second, bundleBytes: new Uint8Array([2]) });
  await assert.rejects(putSecond(), /recovery.*progress/i);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await putSecond();
  const restarted = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal((await restarted.getApproval("approval-two")).agent.id, "agent-two");
});

test("a replacement worker never exposes approval metadata from a failed write", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  let abandonWrite = true;
  metadataStorage.set = (items) => {
    immediateSet(items);
    if (abandonWrite) return new Promise(() => {});
    return Promise.resolve();
  };
  const bundleStorage = memoryBundles();
  const immediateDelete = bundleStorage.delete.bind(bundleStorage);
  bundleStorage.delete = (key) => abandonWrite ? new Promise(() => {}) : immediateDelete(key);
  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });

  await assert.rejects(
    original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );
  abandonWrite = false;

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal(await replacement.getApproval("approval-one"), null);
});

test("a late write from a destroyed worker cannot erase a replacement worker commit", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  let strandedWrite = null;
  let strandNextMarker = true;
  metadataStorage.set = (items) => {
    const next = items[APPROVALS_STORAGE_KEY];
    if (strandNextMarker && next?.recovery?.kind === "approval-put") {
      strandNextMarker = false;
      strandedWrite = () => immediateSet(items);
      // Simulate a storage operation owned by a worker that is destroyed:
      // the browser may commit it later, but its JavaScript continuation never runs.
      return new Promise(() => {});
    }
    return immediateSet(items);
  };
  const bundleStorage = memoryBundles();
  const first = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });
  await assert.rejects(
    first.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );

  const secondApproval = approval({
    approvalId: "approval-two",
    agent: { id: "agent-two", name: "Two" },
    bundleDigest: digest(new Uint8Array([2])),
  });
  const second = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  await second.putApproval({ approval: secondApproval, bundleBytes: new Uint8Array([2]) });

  await strandedWrite();
  const third = createApprovalStore({ metadataStorage, bundleStorage, now: () => 3, ioTimeoutMs: 20 });
  assert.equal((await third.getApproval("approval-two")).agent.id, "agent-two");
  assert.equal(await third.getApproval("approval-one"), null);
});

test("an older ledger commit cannot hide a failed approval repair marker", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });
  await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  await bundleStorage.delete(persistedBundleKey(metadataStorage));

  const immediatePut = bundleStorage.put.bind(bundleStorage);
  let strandRepair = true;
  bundleStorage.put = (key, bytes) => {
    immediatePut(key, bytes);
    if (strandRepair) return new Promise(() => {});
    return Promise.resolve();
  };
  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );

  strandRepair = false;
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  await assert.rejects(replacement.getApproval("approval-one"), ApprovalIntegrityError);
  assert.equal(bundleStorage.snapshot().size, 0);
});

test("failed orphan cleanup never exposes the orphaned bundle as live authority", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const first = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });
  await first.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  await bundleStorage.delete(persistedBundleKey(metadataStorage));
  const immediatePut = bundleStorage.put.bind(bundleStorage);
  bundleStorage.put = (key, bytes) => {
    immediatePut(key, bytes);
    return new Promise(() => {});
  };
  await assert.rejects(
    first.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );
  bundleStorage.delete = async () => { throw new Error("orphan delete unavailable"); };

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  await assert.rejects(
    replacement.getApproval("approval-one"),
    (error) => error instanceof ApprovalAuthorityUnavailableError,
  );
});

test("an unrelated later metadata commit cannot adopt failed repair bytes", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const first = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });
  await first.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  const approvalTwo = approval({
    approvalId: "approval-two",
    agent: { id: "agent-two", name: "Two" },
    bundleDigest: digest(new Uint8Array([2])),
  });
  await first.putApproval({ approval: approvalTwo, bundleBytes: new Uint8Array([2]) });
  const repairBaseline = clone(metadataStorage.snapshot()[APPROVALS_STORAGE_KEY]);
  await bundleStorage.delete(persistedBundleKey(metadataStorage));

  await first.revokeApproval("approval-two");
  const latest = clone(metadataStorage.snapshot()[APPROVALS_STORAGE_KEY]);
  const failedRepairKey = `approval-one:${oneByteDigest}:failed-repair`;
  await bundleStorage.put(failedRepairKey, new Uint8Array([1]));
  await metadataStorage.set({
    [APPROVALS_STORAGE_KEY]: {
      ...repairBaseline,
      recovery: {
        kind: "approval-put",
        id: "failed-repair",
        startedAtMs: 1,
        expectedRevision: 3,
        approvalId: "approval-one",
        bundleKey: failedRepairKey,
        logicalBundleKey: `approval-one:${oneByteDigest}`,
        previousState: repairBaseline,
      },
    },
  });

  assert.equal(latest.approvals["approval-one"].revokedAt, null);
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  await assert.rejects(replacement.getApproval("approval-one"), ApprovalIntegrityError);
  assert.equal(bundleStorage.snapshot().has(failedRepairKey), false);
});

test("later metadata commits preserve provenance from a successful same-bundle repair", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });
  await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  const approvalTwo = approval({
    approvalId: "approval-two",
    agent: { id: "agent-two", name: "Two" },
    bundleDigest: digest(new Uint8Array([2])),
  });
  await store.putApproval({ approval: approvalTwo, bundleBytes: new Uint8Array([2]) });
  await bundleStorage.delete(persistedBundleKey(metadataStorage));
  const failedRepairBaseline = clone(metadataStorage.snapshot()[APPROVALS_STORAGE_KEY]);

  await store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  await store.revokeApproval("approval-two");
  await metadataStorage.set({
    [APPROVALS_STORAGE_KEY]: {
      ...failedRepairBaseline,
      recovery: {
        kind: "approval-put",
        id: "older-failed-repair",
        startedAtMs: 1,
        expectedRevision: 3,
        approvalId: "approval-one",
        bundleKey: `approval-one:${oneByteDigest}`,
        previousState: failedRepairBaseline,
      },
    },
  });

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal((await replacement.getApproval("approval-one")).approvalId, "approval-one");
  assert.deepEqual([...await replacement.getBundleClone("approval-one")], [1]);
});

test("a replacement worker rolls back a persisted applied approval transaction", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  const bundleStorage = memoryBundles();
  let strandApplied = true;
  metadataStorage.set = (items) => {
    const next = items[APPROVALS_STORAGE_KEY];
    if (
      strandApplied
      && next?.recovery?.kind === "approval-put"
      && next.approvals?.["approval-one"]
    ) {
      immediateSet(items);
      return new Promise(() => {});
    }
    return immediateSet(items);
  };
  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });
  await assert.rejects(
    original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );
  assert.equal(metadataStorage.snapshot()[APPROVALS_STORAGE_KEY].recovery.kind, "approval-put");

  strandApplied = false;
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal(await replacement.getApproval("approval-one"), null);
  assert.equal(bundleStorage.snapshot().size, 0);
});

test("a recovery marker fences a late acknowledgement when cancellation and cleanup both fail", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  const immediateRemove = metadataStorage.remove.bind(metadataStorage);
  const bundleStorage = memoryBundles();
  let failFence = true;
  let lateAcknowledgement = null;
  metadataStorage.set = async (items) => {
    const key = Object.keys(items)[0];
    if (failFence && key.startsWith("actionsJsonAgentApprovals.v1.commits.ack.")) {
      lateAcknowledgement = () => immediateSet(items);
      throw new Error("acknowledgement unavailable");
    }
    if (failFence && key.startsWith("actionsJsonAgentApprovals.v1.commits.cancel.")) {
      throw new Error("cancellation unavailable");
    }
    return immediateSet(items);
  };
  metadataStorage.remove = async (keys) => {
    if (failFence) throw new Error("prepared data cleanup unavailable");
    return immediateRemove(keys);
  };

  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });
  await assert.rejects(
    original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /cancellation could not be proven.*cleanup failed/i,
  );
  assert.equal(metadataStorage.snapshot()[APPROVALS_STORAGE_KEY].recovery.kind, "approval-put");
  assert.ok(lateAcknowledgement);

  failFence = false;
  await lateAcknowledgement();
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal(await replacement.getApproval("approval-one"), null);
  assert.equal(bundleStorage.snapshot().size, 0);
});

test("a stale recovery worker cannot delete a later approval's same-digest bundle", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  const immediateRemove = metadataStorage.remove.bind(metadataStorage);
  const bundleStorage = memoryBundles();
  const immediateDelete = bundleStorage.delete.bind(bundleStorage);
  let failFence = true;
  let lateAcknowledgement = null;
  metadataStorage.set = async (items) => {
    const key = Object.keys(items)[0];
    if (failFence && key.startsWith("actionsJsonAgentApprovals.v1.commits.ack.")) {
      lateAcknowledgement = () => immediateSet(items);
      throw new Error("acknowledgement unavailable");
    }
    if (failFence && key.startsWith("actionsJsonAgentApprovals.v1.commits.cancel.")) {
      throw new Error("cancellation unavailable");
    }
    return immediateSet(items);
  };
  metadataStorage.remove = async (keys) => {
    if (failFence) throw new Error("prepared data cleanup unavailable");
    return immediateRemove(keys);
  };

  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 20 });
  await assert.rejects(
    original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /cancellation could not be proven.*cleanup failed/i,
  );
  failFence = false;
  await lateAcknowledgement();

  let releaseStaleDelete;
  let staleDeleteStarted;
  const staleDeleteReached = new Promise((resolve) => { staleDeleteStarted = resolve; });
  const staleDeleteRelease = new Promise((resolve) => { releaseStaleDelete = resolve; });
  let pauseFirstDelete = true;
  bundleStorage.delete = async (key) => {
    if (pauseFirstDelete) {
      pauseFirstDelete = false;
      staleDeleteStarted();
      await staleDeleteRelease;
    }
    return immediateDelete(key);
  };

  const staleWorker = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 100 });
  const staleInitialization = staleWorker.initialize();
  await staleDeleteReached;

  const laterWorker = createApprovalStore({ metadataStorage, bundleStorage, now: () => 3, ioTimeoutMs: 100 });
  assert.equal(await laterWorker.initialize(), true);
  await laterWorker.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });
  releaseStaleDelete();
  assert.equal(await staleInitialization, true);

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 4, ioTimeoutMs: 100 });
  assert.equal((await replacement.getApproval("approval-one")).approvalId, "approval-one");
  assert.deepEqual([...await replacement.getBundleClone("approval-one")], [1]);
});

test("a pre-upgrade failed same-bundle repair cannot authorize replacement bytes", async () => {
  const record = approval();
  const logicalKey = `${record.approvalId}:${record.bundleDigest}`;
  const previousState = {
    schemaVersion: 1,
    approvals: { [record.approvalId]: record },
    orphanBundleKeys: [],
    bundleOwners: {},
  };
  const metadataStorage = memoryMetadata({
    [APPROVALS_STORAGE_KEY]: {
      ...previousState,
      recovery: {
        kind: "approval-put",
        id: "legacy-failed-repair",
        startedAtMs: 2,
        expectedRevision: 2,
        approvalId: record.approvalId,
        bundleKey: logicalKey,
        previousState,
      },
    },
    "actionsJsonAgentApprovals.v1.commits.data.baseline": {
      schemaVersion: 1,
      transactionId: "baseline",
      revision: 1,
      startedAtMs: 1,
      resourceKeys: [logicalKey],
      state: previousState,
    },
    "actionsJsonAgentApprovals.v1.commits.ack.baseline": {
      schemaVersion: 1,
      transactionId: "baseline",
      revision: 1,
    },
  });
  const bundleStorage = memoryBundles();
  bundleStorage.seed(logicalKey, new Uint8Array([1]));

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 3, ioTimeoutMs: 20 });
  await assert.rejects(replacement.getApproval(record.approvalId), ApprovalIntegrityError);
  assert.equal(bundleStorage.snapshot().has(logicalKey), false);
});

test("a delayed pre-upgrade repair marker cleans only its legacy key after a later physical-key repair", async () => {
  const record = approval();
  const logicalKey = `${record.approvalId}:${record.bundleDigest}`;
  const laterStorageKey = `${logicalKey}:later-transaction`;
  const previousState = {
    schemaVersion: 1,
    approvals: { [record.approvalId]: record },
    orphanBundleKeys: [],
    bundleOwners: {},
  };
  const laterState = {
    ...previousState,
    bundleOwners: {
      [logicalKey]: {
        transactionId: "later-repair",
        startedAtMs: 3,
        expectedRevision: 3,
        storageKey: laterStorageKey,
      },
    },
  };
  const metadataStorage = memoryMetadata({
    [APPROVALS_STORAGE_KEY]: {
      ...previousState,
      recovery: {
        kind: "approval-put",
        id: "legacy-failed-repair",
        startedAtMs: 2,
        expectedRevision: 2,
        approvalId: record.approvalId,
        bundleKey: logicalKey,
        previousState,
      },
    },
    "actionsJsonAgentApprovals.v1.commits.data.later-repair": {
      schemaVersion: 1,
      transactionId: "later-repair",
      revision: 3,
      startedAtMs: 3,
      resourceKeys: [laterStorageKey],
      state: laterState,
    },
    "actionsJsonAgentApprovals.v1.commits.ack.later-repair": {
      schemaVersion: 1,
      transactionId: "later-repair",
      revision: 3,
    },
  });
  const bundleStorage = memoryBundles();
  bundleStorage.seed(logicalKey, new Uint8Array([1]));
  bundleStorage.seed(laterStorageKey, new Uint8Array([1]));

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 4, ioTimeoutMs: 20 });
  assert.equal((await replacement.getApproval(record.approvalId)).approvalId, record.approvalId);
  assert.equal(bundleStorage.snapshot().has(logicalKey), false);
  assert.equal(bundleStorage.snapshot().has(laterStorageKey), true);
});

test("a replacement worker removes an orphan left by an abandoned bundle write", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const immediatePut = bundleStorage.put.bind(bundleStorage);
  let abandonWrite = true;
  bundleStorage.put = (key, bytes) => {
    immediatePut(key, bytes);
    if (abandonWrite) return new Promise(() => {});
    return Promise.resolve();
  };
  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });

  await assert.rejects(
    original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /bundle write timed out/i,
  );
  assert.equal(bundleStorage.snapshot().size, 1);
  abandonWrite = false;

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal(await replacement.initialize(), true);
  assert.equal(bundleStorage.snapshot().size, 0);
});

test("a replacement worker rolls back a timed-out approval revocation", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  const bundleStorage = memoryBundles();
  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });
  await original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });

  let abandonRevocation = true;
  metadataStorage.set = (items) => {
    const next = items[APPROVALS_STORAGE_KEY];
    if (abandonRevocation && next?.approvals?.["approval-one"]?.revokedAt !== null) {
      immediateSet(items);
      return new Promise(() => {});
    }
    return immediateSet(items);
  };

  await assert.rejects(original.revokeApproval("approval-one"), /timed out/i);
  abandonRevocation = false;

  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal((await replacement.getApproval("approval-one")).revokedAt, null);
});

test("a failed revocation bundle delete is durably retried after restart", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const immediateDelete = bundleStorage.delete.bind(bundleStorage);
  const original = createApprovalStore({ metadataStorage, bundleStorage, now: () => 42, ioTimeoutMs: 10 });
  await original.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) });

  let rejectDelete = true;
  bundleStorage.delete = async (key) => {
    if (rejectDelete) throw new Error("temporary bundle delete failure");
    return immediateDelete(key);
  };
  const revoked = await original.revokeApproval("approval-one");
  assert.notEqual(revoked.revokedAt, null);
  assert.equal(bundleStorage.snapshot().size, 1);

  rejectDelete = false;
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 43, ioTimeoutMs: 20 });
  assert.equal((await replacement.getApproval("approval-one")).revokedAt, revoked.revokedAt);
  assert.equal(bundleStorage.snapshot().size, 0);
});

test("an abandoned bundle write cannot leave the same worker recovery barrier stuck forever", async () => {
  const metadataStorage = memoryMetadata();
  const bundleStorage = memoryBundles();
  const immediatePut = bundleStorage.put.bind(bundleStorage);
  let abandonWrite = true;
  bundleStorage.put = (key, bytes) => {
    immediatePut(key, bytes);
    if (abandonWrite) return new Promise(() => {});
    return Promise.resolve();
  };
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });

  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /bundle write timed out/i,
  );
  abandonWrite = false;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await store.getApproval("approval-one"), null);
  assert.equal(bundleStorage.snapshot().size, 0);
});

test("a very-late approval marker cannot erase a newer grant after the recovery barrier expires", async () => {
  const metadataStorage = memoryMetadata();
  const immediateSet = metadataStorage.set.bind(metadataStorage);
  let delayNextMarker = true;
  metadataStorage.set = (items) => {
    if (delayNextMarker && items[APPROVALS_STORAGE_KEY]?.recovery?.kind === "approval-put") {
      delayNextMarker = false;
      return new Promise((resolve) => {
        setTimeout(() => { immediateSet(items).then(resolve); }, 120);
      });
    }
    return immediateSet(items);
  };
  const bundleStorage = memoryBundles();
  const store = createApprovalStore({ metadataStorage, bundleStorage, now: () => 1, ioTimeoutMs: 10 });

  await assert.rejects(
    store.putApproval({ approval: approval(), bundleBytes: new Uint8Array([1]) }),
    /indeterminate|timed out/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const newer = approval({
    approvalId: "approval-two",
    agent: { id: "agent-two", name: "Two" },
    bundleDigest: digest(new Uint8Array([2])),
  });
  await store.putApproval({ approval: newer, bundleBytes: new Uint8Array([2]) });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const replacement = createApprovalStore({ metadataStorage, bundleStorage, now: () => 2, ioTimeoutMs: 20 });
  assert.equal((await replacement.getApproval("approval-two")).agent.id, "agent-two");
});

test("ValidatedDelegatedBundle serializes end-to-end into a matching approval record and bytes", async () => {
  const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/delegated-agent-bundles/valid");
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const paths = ["agent.json", "sites/tasks.example/actions.json", "sites/tasks.example/SKILL.md"];
  const files = await Promise.all(paths.map(async (filePath) => {
    const bytes = new Uint8Array(await readFile(path.join(fixtureRoot, filePath)));
    return {
      path: filePath,
      mode: "100644",
      type: "blob",
      bytes,
      size: bytes.byteLength,
      blobSha: createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"),
    };
  }));
  const validation = await validateDelegatedBundleSnapshot({
    proposal: { owner: "example", repo: "agent-bundle", commitSha, manifestPath: "agent.json" },
    sourceOrigin: "https://course.example",
    resolvedCommitSha: commitSha,
    treeSha: "89abcdef0123456789abcdef0123456789abcdef",
    files,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.problems));
  const serialized = approvalRecordFromValidatedBundle(validation.bundle, { reviewedAt: "2026-07-15T12:00:00.000Z" });
  assert.equal(serialized.approval.bundleDigest, digest(serialized.bundleBytes));
  assert.equal(serialized.approval.sourceOrigin, validation.bundle.sourceOrigin);
  assert.equal(serialized.approval.agent.id, validation.bundle.manifest.agent.id);
  const store = createApprovalStore({ metadataStorage: memoryMetadata(), bundleStorage: memoryBundles(), now: () => 1 });
  await store.putApproval(serialized);
  assert.equal((await store.getApproval(serialized.approval.approvalId)).commitSha, commitSha);
});
