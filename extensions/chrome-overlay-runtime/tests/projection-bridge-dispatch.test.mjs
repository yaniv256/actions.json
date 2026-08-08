import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

const extractArrow = (name) => {
  const start = backgroundSource.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = backgroundSource.indexOf("\n};", start);
  assert.ok(end > start, `${name} must have a bounded arrow-function body`);
  return backgroundSource.slice(start, end + 3);
};

const makeExecutor = ({ bundle = { entries: [] } } = {}) => {
  const calls = [];
  const bridgeProjectionSnapshotBundles = new Map();
  const MAX_BRIDGE_PROJECTION_SNAPSHOT_BUNDLES = 64;
  const chrome = {
    storage: {
      local: {
        get: async () => ({ actionsJsonStorageBundle: bundle }),
      },
    },
  };
  const bridgeStateProjectionBundle = () => bundle;
  const executeStateProjectionModesInTab = async (...args) => {
    calls.push({ executor: "state", args });
    return { ok: true, output: { executor: "state" } };
  };
  const executeProjectionGraphModeInTab = async (...args) => {
    calls.push({ executor: "graph", args });
    return { ok: true, output: { executor: "graph" } };
  };
  const execute = new Function(
    "chrome",
    "EXTENSION_STORAGE_BUNDLE_KEY",
    "bridgeStateProjectionBundle",
    "bridgeProjectionSnapshotBundles",
    "MAX_BRIDGE_PROJECTION_SNAPSHOT_BUNDLES",
    "executeStateProjectionModesInTab",
    "executeProjectionGraphModeInTab",
    `${extractArrow("executeBridgeStateProjectionItem")}; return executeBridgeStateProjectionItem;`,
  )(
    chrome,
    "actionsJsonStorageBundle",
    bridgeStateProjectionBundle,
    bridgeProjectionSnapshotBundles,
    MAX_BRIDGE_PROJECTION_SNAPSHOT_BUNDLES,
    executeStateProjectionModesInTab,
    executeProjectionGraphModeInTab,
  );
  return { execute, calls };
};

for (const mode of ["navigate", "search"]) {
  test(`direct bridge ${mode} reaches the graph executor with the complete graph contract`, async () => {
    const { execute, calls } = makeExecutor();
    const item = {
      call_id: `call-${mode}`,
      mode,
      snapshot_id: "pss-1",
      node_ref: "psn-1",
      operation: "neighbors",
      direction: "outgoing",
      edge_types: ["contains"],
      max_depth: 2,
      measure_filter: { confidence: { gte: 0.5 } },
      measure_order: { rank: "asc" },
      query: "maximum pain",
      scope: { descendants_of: "psn-1" },
      cursor: "next-page",
      page_size: 5,
      search_mode: "semantic",
      max_bytes: 4096,
    };

    const result = await execute(item, { id: 7, url: "https://trello.com/b/test" });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executor, "graph");
    const [, dispatched] = calls[0].args;
    assert.equal(dispatched.mode, mode);
    assert.equal(dispatched.call.call_id, `call-${mode}`);
    for (const [key, value] of Object.entries(item)) {
      if (key === "call_id" || key === "mode") continue;
      assert.deepEqual(dispatched.args[key], value, `${mode} must preserve ${key}`);
    }
  });
}

test("direct bridge state_read remains on the legacy projection executor", async () => {
  const { execute, calls } = makeExecutor();
  const result = await execute(
    { call_id: "call-read", mode: "state_read", projection_name: "trello.board", max_bytes: 2048 },
    { id: 7, url: "https://trello.com/b/test" },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executor, "state");
  assert.equal(calls[0].args[1].args.projection_name, "trello.board");
});

test("bridge graph follow-up reuses the exact bundle that created its snapshot", async () => {
  const projectionBundle = { entries: [{ path: "trello/actions.json", content: "projection-only" }] };
  const fullBundle = { entries: [{ path: "other/actions.json", content: "full-catalog" }] };
  const { execute, calls } = makeExecutor({ bundle: fullBundle });

  const originalStateCall = {
    call_id: "call-read",
    mode: "state_read",
    projection_name: "trello.board",
    map_path: "trello/actions.json",
    projection: { name: "trello.board" },
  };
  const bridgeProjectionSnapshotBundles = new Map();
  const stateCalls = [];
  const graphCalls = [];
  const chrome = { storage: { local: { get: async () => ({ actionsJsonStorageBundle: fullBundle }) } } };
  const executeStateProjectionModesInTab = async (...args) => {
    stateCalls.push(args);
    return { ok: true, output: { graph_descriptor: { snapshot_id: "pss-retained" } } };
  };
  const executeProjectionGraphModeInTab = async (...args) => {
    graphCalls.push(args);
    return { ok: true, output: { ok: true } };
  };
  const executeBound = new Function(
    "chrome",
    "EXTENSION_STORAGE_BUNDLE_KEY",
    "bridgeStateProjectionBundle",
    "bridgeProjectionSnapshotBundles",
    "MAX_BRIDGE_PROJECTION_SNAPSHOT_BUNDLES",
    "executeStateProjectionModesInTab",
    "executeProjectionGraphModeInTab",
    `${extractArrow("executeBridgeStateProjectionItem")}; return executeBridgeStateProjectionItem;`,
  )(
    chrome,
    "actionsJsonStorageBundle",
    () => projectionBundle,
    bridgeProjectionSnapshotBundles,
    64,
    executeStateProjectionModesInTab,
    executeProjectionGraphModeInTab,
  );

  await executeBound(originalStateCall, { id: 7, url: "https://trello.com/b/test" });
  await executeBound(
    { call_id: "call-nav", mode: "navigate", snapshot_id: "pss-retained", operation: "roots" },
    { id: 7, url: "https://trello.com/b/test" },
  );

  assert.equal(stateCalls.length, 1);
  assert.equal(graphCalls.length, 1);
  assert.equal(graphCalls[0][1].bundle, projectionBundle);
  assert.notEqual(graphCalls[0][1].bundle, fullBundle);
});

test("direct bridge rejects modes outside the advertised projection contract", async () => {
  const { execute, calls } = makeExecutor();
  const result = await execute({ call_id: "call-bad", mode: "unknown" }, { id: 7 });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_input");
  assert.equal(calls.length, 0);
});
