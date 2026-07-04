import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-03 fresh-tab routing incident.
//
// bridgeRuntimeRoutes maps runtime_id/runtime_key -> tabId; resolveBridgeItemTabId
// uses it to deliver bridge->content messages (heartbeat pings AND primitive
// action_calls). Every path that (re)connects a claimed tab MUST populate this
// map (rememberRuntimeRoute), and every path that closes/removes a tab MUST
// clear it (forgetRuntimeRoutesForTab) — else fresh tabs go deaf to content
// primitives (create/reconnect miss) or /runtimes leaks stale entries (close miss).

const source = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

function bodyOf(fnDecl, span = 1200) {
  const idx = source.indexOf(fnDecl);
  assert.ok(idx >= 0, `expected to find ${fnDecl}`);
  return source.slice(idx, idx + span);
}

test("connectClaimedTab records the local route (covers claim/navigate/activate/reconnect)", () => {
  const body = bodyOf("const connectClaimedTab = async (tabId, claim) =>");
  assert.ok(
    /rememberRuntimeRoute\(/.test(body),
    "connectClaimedTab must call rememberRuntimeRoute so every connect path populates bridgeRuntimeRoutes",
  );
});

test("openClaimedTab records the local route (does not funnel through connectClaimedTab)", () => {
  const body = bodyOf("const openClaimedTab = async (message = {}) =>", 2600);
  assert.ok(
    /rememberRuntimeRoute\(/.test(body),
    "openClaimedTab must call rememberRuntimeRoute after registering with the bridge",
  );
});

test("closeClaimedTab clears the local routes for the closed tab", () => {
  const body = bodyOf("const closeClaimedTab = async (message = {}) =>", 1400);
  assert.ok(
    /forgetRuntimeRoutesForTab\(/.test(body),
    "closeClaimedTab must call forgetRuntimeRoutesForTab so closed tabs don't leak stale routes",
  );
});

test("onRemoved handler clears the local routes for the removed tab", () => {
  const idx = source.indexOf("chrome.tabs.onRemoved.addListener");
  assert.ok(idx >= 0, "onRemoved listener must exist");
  const body = source.slice(idx, idx + 900);
  assert.ok(
    /forgetRuntimeRoutesForTab\(/.test(body),
    "onRemoved must call forgetRuntimeRoutesForTab for externally-closed tabs",
  );
});

test("forgetRuntimeRoutesForTab exists and deletes by mapped tabId", () => {
  const body = bodyOf("const forgetRuntimeRoutesForTab = (tabId) =>", 400);
  assert.ok(
    /bridgeRuntimeRoutes\.delete\(/.test(body),
    "forgetRuntimeRoutesForTab must delete matching bridgeRuntimeRoutes entries",
  );
});

test("the relayed-ready loop also records routes (not just bridge registration)", () => {
  const idx = source.indexOf("for (const item of bridgeState.relayedReadyItems");
  assert.ok(idx >= 0, "relayed-ready loop must exist");
  const body = source.slice(idx, idx + 300);
  assert.ok(
    /rememberRuntimeRoute\(/.test(body),
    "relayed runtimes must also get a local route, matching the single-readyItem path",
  );
});
