import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProjectionCacheInvalidations,
  validateProjectionCachePolicy,
} from "../src/agent/projection-cache-policy.mjs";

test("projection cache policy validates bounded exact invalidations", () => {
  assert.deepEqual(validateProjectionCachePolicy({
    invalidations: [{ namespace: "trello.cards", entity_id_argument: "card_id" }],
  }), { ok: true });
  assert.equal(validateProjectionCachePolicy({ invalidations: [{ namespace: "../other" }] }).ok, false);
  assert.equal(validateProjectionCachePolicy({ invalidations: [], arbitrary: true }).ok, false);
});

test("projection cache policy invalidates an exact entity when its stable argument exists", async () => {
  const calls = [];
  const result = await applyProjectionCacheInvalidations({
    store: {
      async invalidate(args) { calls.push(["exact", args]); return { invalidated: 1 }; },
      async invalidateNamespace(args) { calls.push(["namespace", args]); return { invalidated: 9 }; },
    },
    scope: { siteHost: "trello.com", groupId: "group-a" },
    policy: { invalidations: [{ namespace: "trello.cards", entity_id_argument: "card_id" }] },
    input: { card_id: "card-1" },
  });
  assert.deepEqual(result, { invalidated: 1 });
  assert.deepEqual(calls, [["exact", {
    siteHost: "trello.com",
    groupId: "group-a",
    namespace: "trello.cards",
    entityIds: ["card-1"],
  }]]);
});

test("projection cache policy conservatively invalidates a namespace without stable identity", async () => {
  const calls = [];
  const result = await applyProjectionCacheInvalidations({
    store: {
      async invalidate() { throw new Error("exact invalidation must not run"); },
      async invalidateNamespace(args) { calls.push(args); return { invalidated: 3 }; },
    },
    scope: { siteHost: "trello.com", groupId: "group-a" },
    policy: { invalidations: [{ namespace: "trello.cards", entity_id_argument: "card_id" }] },
    input: {},
  });
  assert.deepEqual(result, { invalidated: 3 });
  assert.deepEqual(calls[0], { siteHost: "trello.com", groupId: "group-a", namespace: "trello.cards" });
});
