import assert from "node:assert/strict";
import test from "node:test";

import { createDurableStateCommitLog } from "../src/delegated-agent/durable-state-commit-log.mjs";

const clone = (value) => structuredClone(value);

function memoryStorage(initial = {}) {
  let value = clone(initial);
  return {
    async get(key) { return key === null ? clone(value) : { [key]: clone(value[key]) }; },
    async set(items) { value = { ...value, ...clone(items) }; },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete value[key]; },
    snapshot() { return clone(value); },
  };
}

const makeLog = (storage, clock = () => 1) => createDurableStateCommitLog({
  storage,
  mainKey: "state",
  keyPrefix: "state.commits",
  validateState: (value) => Number.isInteger(value?.value),
  ioTimeoutMs: 20,
  clock,
});

test("a late acknowledgement cannot revive a transaction that was durably cancelled", async () => {
  const storage = memoryStorage();
  const log = makeLog(storage);
  await log.commit({ value: 1 }, { transactionId: "baseline", startedAtMs: 1 });

  const immediateSet = storage.set.bind(storage);
  let lateAcknowledgement = null;
  storage.set = async (items) => {
    const key = Object.keys(items)[0];
    if (key === "state.commits.ack.failed") {
      lateAcknowledgement = () => immediateSet(items);
      throw new Error("acknowledgement unavailable");
    }
    return immediateSet(items);
  };

  await assert.rejects(
    log.commit({ value: 2 }, { transactionId: "failed", startedAtMs: 2 }),
    /acknowledgement unavailable/i,
  );
  await lateAcknowledgement();

  const replacement = makeLog(storage);
  assert.deepEqual(await replacement.readLatest(), { value: 1 });
  assert.equal(storage.snapshot()["state.commits.cancel.failed"].transactionId, "failed");
});

test("a failed cancellation removes prepared data before a late acknowledgement can land", async () => {
  const storage = memoryStorage();
  const log = makeLog(storage);
  await log.commit({ value: 1 }, { transactionId: "baseline", startedAtMs: 1 });

  const immediateSet = storage.set.bind(storage);
  let lateAcknowledgement = null;
  storage.set = async (items) => {
    const key = Object.keys(items)[0];
    if (key === "state.commits.ack.failed") {
      lateAcknowledgement = () => immediateSet(items);
      throw new Error("acknowledgement unavailable");
    }
    if (key === "state.commits.cancel.failed") {
      throw new Error("cancellation unavailable");
    }
    return immediateSet(items);
  };

  await assert.rejects(
    log.commit({ value: 2 }, { transactionId: "failed", startedAtMs: 2 }),
    /acknowledgement unavailable/i,
  );
  await lateAcknowledgement();

  const replacement = makeLog(storage);
  assert.deepEqual(await replacement.readLatest(), { value: 1 });
  assert.equal(storage.snapshot()["state.commits.data.failed"], undefined);
});

test("an unacknowledged prepared record still advances the recovery revision fence", async () => {
  const storage = memoryStorage();
  const baseline = makeLog(storage);
  await baseline.commit({ value: 1 }, { transactionId: "baseline", startedAtMs: 1 });
  await storage.set({
    "state.commits.data.abandoned": {
      schemaVersion: 1,
      transactionId: "abandoned",
      revision: 2,
      startedAtMs: 2,
      resourceKeys: [],
      state: { value: 2 },
    },
  });

  const replacement = makeLog(storage);
  assert.deepEqual(await replacement.readLatest(), { value: 1 });
  assert.equal(replacement.nextRevision(), 3);
});

test("a final mirror that applies before rejecting is reconciled as committed", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let rejectAppliedMirror = true;
  storage.set = async (items) => {
    if (rejectAppliedMirror && Object.keys(items)[0] === "state") {
      rejectAppliedMirror = false;
      await immediateSet(items);
      throw new Error("mirror reported failure after commit");
    }
    return immediateSet(items);
  };

  const log = makeLog(storage);
  await log.commit({ value: 1 }, { transactionId: "applied-mirror", startedAtMs: 1 });

  assert.deepEqual(storage.snapshot().state, { value: 1 });
  assert.deepEqual(await makeLog(storage).readLatest(), { value: 1 });
});

test("the final mirror is not timer-abandoned and cannot land after a reported failure", async () => {
  const storage = memoryStorage();
  const immediateSet = storage.set.bind(storage);
  let delayedMirror = true;
  storage.set = async (items) => {
    if (delayedMirror && Object.keys(items)[0] === "state") {
      delayedMirror = false;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return immediateSet(items);
  };

  const log = makeLog(storage);
  await log.commit({ value: 1 }, { transactionId: "slow-mirror", startedAtMs: 1 });
  assert.deepEqual(storage.snapshot().state, { value: 1 });
});

test("reading the ledger does not erase an unreconciled compatibility-mirror marker", async () => {
  const storage = memoryStorage();
  const log = makeLog(storage);
  await log.commit({ value: 1 }, { transactionId: "baseline", startedAtMs: 1 });
  const marker = { value: 999, recovery: { transactionId: "repair" } };
  await storage.set({ state: marker });

  assert.deepEqual((await log.readLatestRecord()).state, { value: 1 });
  assert.deepEqual(storage.snapshot().state, marker);
});

test("a stale compactor cannot delete a newer peer worker commit", async () => {
  const storage = memoryStorage();
  const baseline = makeLog(storage);
  await baseline.commit({ value: 1 }, { transactionId: "baseline", startedAtMs: 1 });

  const first = makeLog(storage);
  const second = makeLog(storage);
  await first.readLatest();
  await second.readLatest();

  const immediateGet = storage.get.bind(storage);
  let releaseScan;
  let scanStarted;
  const scanReached = new Promise((resolve) => { scanStarted = resolve; });
  const scanRelease = new Promise((resolve) => { releaseScan = resolve; });
  let pauseNextScan = true;
  storage.get = async (key) => {
    if (key === null && pauseNextScan) {
      pauseNextScan = false;
      scanStarted();
      await scanRelease;
    }
    return immediateGet(key);
  };

  const staleCommit = first.commit({ value: 2 }, { transactionId: "first", startedAtMs: 2 });
  await scanReached;
  await second.commit({ value: 3 }, { transactionId: "second", startedAtMs: 3 });
  releaseScan();
  await staleCommit;

  const replacement = makeLog(storage);
  const latest = await replacement.readLatestRecord();
  assert.equal(latest.transactionId, "second");
  assert.deepEqual(latest.state, { value: 3 });
});
