import assert from "node:assert/strict";
import test from "node:test";

import { claimTabWithDurableAuthority } from "../src/agent/tab-ownership-authority.mjs";

const lease = { tabId: 42 };

test("durable authority commits before metadata and connect", async () => {
  const order = [];
  const authority = {
    async claimTabWithReceipt(groupId, claimedLease) {
      order.push("authority");
      return { groupId, tabId: claimedLease.tabId, claimedLease, claimedRevision: "revision", previousLease: null };
    },
    async rollbackTabClaim() { order.push("rollback"); return true; },
  };

  await claimTabWithDurableAuthority({
    authority,
    groupId: "extension:default",
    lease,
    persistMetadata: async () => { order.push("metadata"); return true; },
    connect: async () => { order.push("connect"); },
  });

  assert.deepEqual(order, ["authority", "metadata", "connect"]);
});

test("an unproven authority commit never persists metadata or connects", async () => {
  let metadataCalls = 0;
  let connectCalls = 0;
  const authority = {
    async claimTabWithReceipt() { throw new Error("outcome is indeterminate"); },
    async rollbackTabClaim() {},
  };

  await assert.rejects(claimTabWithDurableAuthority({
    authority,
    groupId: "extension:default",
    lease,
    persistMetadata: async () => { metadataCalls += 1; return true; },
    connect: async () => { connectCalls += 1; },
  }), /indeterminate/);
  assert.equal(metadataCalls, 0);
  assert.equal(connectCalls, 0);
});

test("secondary metadata failure compensates the durable claim before connect", async () => {
  const order = [];
  const authority = {
    async claimTabWithReceipt(groupId, claimedLease) {
      order.push("authority");
      return { groupId, tabId: claimedLease.tabId, claimedLease, claimedRevision: "revision", previousLease: null };
    },
    async rollbackTabClaim() { order.push("rollback-authority"); return true; },
  };

  await assert.rejects(claimTabWithDurableAuthority({
    authority,
    groupId: "extension:default",
    lease,
    persistMetadata: async () => { order.push("metadata"); return false; },
    rollbackMetadata: async () => { order.push("rollback-metadata"); return true; },
    connect: async () => { order.push("connect"); },
  }), /metadata did not persist/);
  assert.deepEqual(order, ["authority", "metadata", "rollback-authority", "rollback-metadata"]);
});

test("failed re-claim rolls back only the exact durable receipt", async () => {
  const oldLease = { tabId: 42, authorizationId: "old" };
  const newLease = { tabId: 42, authorizationId: "new", ownershipRevision: "new-revision" };
  const order = [];
  let currentLease = oldLease;
  const authority = {
    async claimTabWithReceipt(groupId) {
      currentLease = newLease;
      order.push("claim:new");
      return {
        groupId,
        tabId: 42,
        claimedRevision: "new-revision",
        claimedLease: newLease,
        previousLease: oldLease,
      };
    },
    async rollbackTabClaim(receipt) {
      order.push(`rollback:${receipt.claimedRevision}`);
      if (currentLease.ownershipRevision !== receipt.claimedRevision) return false;
      currentLease = receipt.previousLease;
      return true;
    },
  };

  await assert.rejects(claimTabWithDurableAuthority({
    authority,
    groupId: "extension:default",
    lease: newLease,
    persistMetadata: async () => { order.push("metadata"); return false; },
    connect: async () => { order.push("connect"); },
  }), /metadata did not persist/);

  assert.equal(currentLease.authorizationId, "old");
  assert.deepEqual(order, ["claim:new", "metadata", "rollback:new-revision"]);
});

test("superseded claim compensation fails loudly without overwriting its successor", async () => {
  const order = [];
  const authority = {
    async claimTabWithReceipt(groupId) {
      return {
        groupId,
        tabId: 42,
        claimedRevision: "older",
        claimedLease: { tabId: 42, ownershipRevision: "older" },
        previousLease: null,
      };
    },
    async rollbackTabClaim() { order.push("rollback-rejected"); return false; },
  };

  await assert.rejects(claimTabWithDurableAuthority({
    authority,
    groupId: "extension:default",
    lease,
    persistMetadata: async () => false,
    rollbackMetadata: async () => { order.push("metadata-rollback"); return true; },
    connect: async () => {},
  }), /outcome is unavailable/);
  assert.deepEqual(order, ["rollback-rejected"]);
});
