import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-03 fresh-tab routing incident.
//
// bridgeRuntimeRoutes maps runtime_id/runtime_key -> tabId; resolveBridgeItemTabId
// uses it to deliver bridge->content messages (heartbeat pings AND primitive
// action_calls). Every path that (re)connects a claimed tab MUST populate this
// map (directly through rememberRuntimeRoute or through the stronger
// rememberRuntimeRegistration wrapper), and every path that closes/removes a tab MUST
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
    /rememberRuntimeRegistration\(/.test(body),
    "openClaimedTab must remember the complete runtime registration after sending it to the bridge",
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
  // Window widened for the U2 runtime_removed emit that now precedes the
  // forget call inside the handler; the assertion (onRemoved forgets the
  // routes) is unchanged.
  const body = source.slice(idx, idx + 1600);
  assert.ok(
    /forgetRuntimeRoutesForTab\(/.test(body),
    "onRemoved must call forgetRuntimeRoutesForTab for externally-closed tabs",
  );
});

// LIVE-CAUGHT REGRESSION (2026-07-09, ext 0.1.187 on Yaniv's browser):
// browser.close_tab did NOT reap the runtime instantly — the bridge only aged it
// out via the 30s TTL sweep. Root cause: closeClaimedTab called
// forgetRuntimeRoutesForTab(tabId) and THEN chrome.tabs.remove(tabId), so by the
// time chrome fires onRemoved, runtimeIdsForTab(tabId) resolves to [] and the
// `runtime_removed` emit loop never runs. The routes are the ONLY map from tabId
// -> runtime_id, so wiping them before the close destroys the reap's input.
// Neither the unit test (called remove_single_runtime directly) nor the live
// harness (Playwright page.close tore down the whole WS => connection-teardown
// reap) exercised this ordering. Guard it here.
test("closeClaimedTab emits runtime_removed BEFORE forgetting the routes", () => {
  const body = bodyOf("const closeClaimedTab = async (message = {}) =>", 1400);
  const emitIdx = body.indexOf("runtime_removed");
  const forgetIdx = body.indexOf("forgetRuntimeRoutesForTab(");
  assert.ok(
    emitIdx >= 0,
    "closeClaimedTab must emit runtime_removed so the bridge reaps the runtime instantly (not after the TTL sweep)",
  );
  assert.ok(forgetIdx >= 0, "closeClaimedTab must still forget the routes");
  assert.ok(
    emitIdx < forgetIdx,
    "runtime_removed must be emitted BEFORE forgetRuntimeRoutesForTab — the route map is the only tabId->runtime_id lookup, so wiping it first makes the reap a no-op",
  );
});

// LIVE-CAUGHT REGRESSION (2026-07-13, ext 0.1.206): browser.navigate
// reconnected three tabs but returned each tab's pre-navigation runtime_id.
// The very next bridge inventory had already removed those ids and registered
// replacements. A successful navigate must retire the invalid document runtime
// and attest the replacement identity before serializing its result.
test("navigateClaimedTab retires the old runtime and attests its replacement before success", () => {
  const body = bodyOf("const navigateClaimedTab = async (message = {}) =>", 4200);
  const snapshotIdx = body.indexOf("previousRuntimeIds");
  const removedIdx = body.indexOf("runtime_removed");
  const forgetIdx = body.indexOf("forgetRuntimeRoutesForTab(");
  const connectIdx = body.indexOf("await connectClaimedTab(");
  const replacementIdx = body.indexOf("replacementRuntimeIds");
  const serializeIdx = body.lastIndexOf("serializeClaimedTab(");

  assert.ok(snapshotIdx >= 0, "navigate must snapshot the pre-navigation runtime ids");
  assert.ok(removedIdx >= 0, "navigate must reap the invalidated document runtime on the bridge");
  assert.ok(forgetIdx >= 0, "navigate must remove stale local runtime routes");
  assert.ok(connectIdx >= 0, "navigate must reconnect the new document runtime");
  assert.ok(replacementIdx >= 0, "navigate must identify the replacement runtime id");
  assert.ok(
    removedIdx < forgetIdx && forgetIdx < connectIdx && connectIdx < replacementIdx,
    "old runtime retirement must precede reconnect, and replacement attestation must follow reconnect",
  );
  assert.ok(
    body.includes("runtime_identity_unattested"),
    "navigate must fail explicitly instead of returning success with an old or missing runtime id",
  );
  assert.ok(
    replacementIdx < serializeIdx,
    "replacement identity must be attested before the success payload is serialized",
  );
  assert.ok(
    body.includes("const sameDocument") && body.includes("withoutHash("),
    "navigate must distinguish hash-only same-document navigation from a replaced document",
  );
  assert.ok(
    /if \(!sameDocument\)[\s\S]*runtime_removed/.test(body),
    "only a replaced document should reap its prior runtime identity",
  );
});

// U8 (R6-for-real): the bridge's `host` is the SITE host, so two browsers on the
// same page are indistinguishable. The extension must report a machine/browser
// label on runtime_ready. Live-caught 2026-07-09 (ext on Windows AND Mac).
test("runtime_ready carries a device label (machine/browser, not the site host)", () => {
  const body = bodyOf("const decorateReadyItemForReplay = async (", 900);
  assert.ok(
    /device:\s*readyItem\.device \|\| \(await getDeviceLabel\(\)\)/.test(body),
    "decorateReadyItemForReplay must include a `device` label so the agent can tell two browsers apart",
  );
});

test("initial bridge registration decorates runtime_ready with complete tab identity", () => {
  const body = bodyOf("const connectBackgroundBridge = async (state, options = {}) =>", 7000);
  const fallback = body.slice(body.indexOf("registered_count === 0"));
  assert.ok(
    fallback.includes("decorateReadyItemForReplay("),
    "the zero-replay fallback must decorate initial runtime_ready instead of sending an ownerless row",
  );
  assert.ok(
    fallback.includes("sendBridgeItem(decorated)"),
    "the bridge must receive the decorated runtime_ready item",
  );
});

test("getDeviceLabel combines platform OS with a stable per-install id", () => {
  const body = bodyOf("const getDeviceLabel = () =>", 1200);
  assert.ok(
    /getPlatformInfo\(\)/.test(body),
    "device label must include the platform OS (mac/win/linux)",
  );
  assert.ok(
    /DEVICE_ID_STORAGE_KEY/.test(body) && /chrome\.storage\.local\.set/.test(body),
    "device label must persist a stable per-install id so two Chromes on the SAME OS still differ",
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
    /rememberRuntimeRegistration\(/.test(body),
    "relayed runtimes must remember the complete registration, matching the single-readyItem path",
  );
});
