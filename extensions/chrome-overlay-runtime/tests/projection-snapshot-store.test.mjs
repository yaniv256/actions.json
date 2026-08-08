import assert from "node:assert/strict";
import test from "node:test";

import { graphifyProjection } from "../src/agent/projection-graph.mjs";
import {
  ProjectionSnapshotStoreError,
  createProjectionSnapshotStore,
  reconcileProjectionGraphRefs,
} from "../src/agent/projection-snapshot-store.mjs";

const authority = (overrides = {}) => ({
  runtime_id: "runtime-a",
  tab_id: 7,
  navigation_epoch: "nav-1",
  projection: "trello.board",
  catalog_revision: "catalog-1",
  ...overrides,
});

const errorCode = (code) => (error) => error instanceof ProjectionSnapshotStoreError && error.code === code;

function deterministicStore(overrides = {}) {
  let now = 1_000;
  let sequence = 0;
  const store = createProjectionSnapshotStore({
    now: () => now,
    randomId: () => `opaque-${++sequence}`,
    snapshotTtlMs: 1_000,
    cursorTtlMs: 100,
    ...overrides,
  });
  return { store, advance: (milliseconds) => { now += milliseconds; } };
}

test("activation is authority-bound and a failed build retains the old active snapshot", async () => {
  const { store } = deterministicStore();
  const first = store.activate({ authority: authority(), graph: graphifyProjection({ title: "first" }) });

  await assert.rejects(
    store.buildAndActivate({ authority: authority(), build: async () => { throw new Error("build failed"); } }),
    /build failed/,
  );
  assert.equal(store.getActive(authority()).snapshot_id, first.snapshot_id);
  assert.throws(() => store.getActive(authority({ tab_id: 8 })), errorCode("snapshot_not_found"));
});

test("successful replacement is atomic and makes old cursors stale", () => {
  const { store } = deterministicStore();
  const first = store.activate({ authority: authority(), graph: graphifyProjection({ title: "first" }) });
  const cursor = store.createCursor({
    authority: authority(), snapshot_id: first.snapshot_id, query: { text: "first" },
    scope: { roots: first.graph.roots }, order: { by: "score", direction: "desc" },
    page_size: 5, offset: 5, retrieval_revision: "lexical-1",
  });
  const second = store.activate({ authority: authority(), graph: graphifyProjection({ title: "second" }) });

  assert.notEqual(second.snapshot_id, first.snapshot_id);
  assert.equal(store.getActive(authority()).snapshot_id, second.snapshot_id);
  assert.throws(() => store.getSnapshot(authority(), first.snapshot_id), errorCode("snapshot_stale"));
  assert.throws(() => store.resolveCursor({ authority: authority(), handle: cursor.handle }), errorCode("cursor_stale"));
});

test("snapshots report expiry, eviction, malformed IDs, and cross-authority access", () => {
  const { store, advance } = deterministicStore({ maxSnapshots: 1 });
  const first = store.activate({ authority: authority({ tab_id: 1 }), graph: graphifyProjection({ tab: 1 }) });
  assert.throws(() => store.getSnapshot(authority({ tab_id: 2 }), first.snapshot_id), errorCode("snapshot_authority_mismatch"));
  assert.throws(() => store.getSnapshot(authority({ tab_id: 1 }), ""), errorCode("snapshot_id_malformed"));
  store.activate({ authority: authority({ tab_id: 2 }), graph: graphifyProjection({ tab: 2 }) });
  assert.throws(() => store.getSnapshot(authority({ tab_id: 1 }), first.snapshot_id), errorCode("snapshot_evicted"));
  const latest = store.getActive(authority({ tab_id: 2 }));
  advance(1_001);
  assert.throws(() => store.getSnapshot(authority({ tab_id: 2 }), latest.snapshot_id), errorCode("snapshot_expired"));
});

test("cursor handles are opaque, frozen, bounded, expiring, and authority scoped", () => {
  const { store, advance } = deterministicStore({ maxCursors: 2 });
  const snapshot = store.activate({ authority: authority(), graph: graphifyProjection({ values: [1, 2, 3] }) });
  const issue = (offset) => store.createCursor({
    authority: authority(), snapshot_id: snapshot.snapshot_id, query: { text: "value" }, scope: null,
    order: { by: "score" }, page_size: 5, offset, retrieval_revision: "lexical-1",
  });
  const first = issue(5);
  const second = issue(10);
  const resolved = store.resolveCursor({ authority: authority(), handle: second.handle });
  assert.match(second.handle, /^psc_opaque-/);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.query));
  assert.throws(() => { resolved.query.text = "changed"; }, TypeError);
  assert.throws(() => store.resolveCursor({ authority: authority({ runtime_id: "runtime-b" }), handle: second.handle }), errorCode("cursor_authority_mismatch"));
  issue(15);
  assert.throws(() => store.resolveCursor({ authority: authority(), handle: first.handle }), errorCode("cursor_evicted"));
  advance(101);
  assert.throws(() => store.resolveCursor({ authority: authority(), handle: second.handle }), errorCode("cursor_expired"));
  assert.throws(() => store.resolveCursor({ authority: authority(), handle: "not a cursor" }), errorCode("cursor_malformed"));
});

test("navigation and tab cleanup invalidate the exact authority without crossing tabs", () => {
  const { store } = deterministicStore();
  const tab7 = store.activate({ authority: authority(), graph: graphifyProjection({ tab: 7 }) });
  const tab8 = store.activate({ authority: authority({ tab_id: 8 }), graph: graphifyProjection({ tab: 8 }) });
  store.cleanupNavigation({ runtime_id: "runtime-a", tab_id: 7, retain_navigation_epoch: "nav-2" });
  assert.throws(() => store.getSnapshot(authority(), tab7.snapshot_id), errorCode("snapshot_stale"));
  assert.equal(store.getSnapshot(authority({ tab_id: 8 }), tab8.snapshot_id).snapshot_id, tab8.snapshot_id);
  store.cleanupTab({ runtime_id: "runtime-a", tab_id: 8 });
  assert.throws(() => store.getActive(authority({ tab_id: 8 })), errorCode("snapshot_not_found"));
});

test("reconciliation preserves only unambiguous cheap evidence and rewrites edges", () => {
  let sequence = 0;
  const randomRef = () => `ref-${++sequence}`;
  const first = reconcileProjectionGraphRefs(graphifyProjection({ cards: [
    { id: "a", url: "https://example.test/a", title: "Alpha" },
    { id: "b", url: "https://example.test/b", title: "Beta" },
  ] }), { declaredKeys: ["id"], randomRef });
  const alphaRef = first.graph.nodes.find((node) => node.attributes.id === "a").ref;
  const second = reconcileProjectionGraphRefs(graphifyProjection({ cards: [
    { id: "b", url: "https://example.test/b", title: "Beta changed" },
    { id: "a", url: "https://example.test/a", title: "Alpha" },
    { id: "c", title: "Gamma" },
  ] }), { previousGraph: first.graph, declaredKeys: ["id"], randomRef });

  assert.equal(second.graph.nodes.find((node) => node.attributes.id === "a").ref, alphaRef);
  assert.deepEqual(second.transitions, { preserved: 4, new: 1, removed: 0, ambiguous: 0 });
  const refs = new Set(second.graph.nodes.map((node) => node.ref));
  assert.ok(second.graph.edges.every((edge) => refs.has(edge.from) && refs.has(edge.to)));
  assert.ok(second.graph.roots.every((ref) => refs.has(ref)));
});

test("snapshot retention remains bounded even when many authorities are active", () => {
  const { store } = deterministicStore({ maxSnapshots: 2 });
  const oldest = store.activate({ authority: authority({ tab_id: 1 }), graph: graphifyProjection({ tab: 1 }) });
  store.activate({ authority: authority({ tab_id: 2 }), graph: graphifyProjection({ tab: 2 }) });
  store.activate({ authority: authority({ tab_id: 3 }), graph: graphifyProjection({ tab: 3 }) });
  assert.deepEqual(store.inspectCounts(), { snapshots: 2, active: 2, cursors: 0 });
  assert.throws(() => store.getSnapshot(authority({ tab_id: 1 }), oldest.snapshot_id), errorCode("snapshot_evicted"));
});

test("ambiguous identity evidence always receives new refs and is reported", () => {
  let sequence = 0;
  const randomRef = () => `ref-${++sequence}`;
  const first = reconcileProjectionGraphRefs(graphifyProjection({ cards: [
    { title: "Duplicate" }, { title: "Duplicate" },
  ] }), { declaredKeys: ["title"], randomRef });
  const oldRefs = new Set(first.graph.nodes.filter((node) => node.attributes.title === "Duplicate").map((node) => node.ref));
  const second = reconcileProjectionGraphRefs(graphifyProjection({ cards: [
    { title: "Duplicate" }, { title: "Duplicate" },
  ] }), { previousGraph: first.graph, declaredKeys: ["title"], randomRef });
  const newRefs = second.graph.nodes.filter((node) => node.attributes.title === "Duplicate").map((node) => node.ref);

  assert.ok(newRefs.every((ref) => !oldRefs.has(ref)));
  assert.equal(second.transitions.ambiguous, 2);
});
