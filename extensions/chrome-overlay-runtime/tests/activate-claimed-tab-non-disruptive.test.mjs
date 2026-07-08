import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-05 "activation churns the transport" fix.
//
// browser.claimed_tabs.activate brings a tab to the Chrome foreground. Previously
// activateClaimedTab ALWAYS scheduled connectClaimedTab (which re-injects
// content.js + re-runs the connect handshake). Re-injecting into an
// already-connected tab tears down its live runtime and, via the resulting
// bridge-connect, churns the single shared bridge socket every other tab depends
// on. Foregrounding a healthy tab is a pure UI op that never touches the socket
// or the content script, so the reconnect is gratuitous.
//
// Fix: claimedTabHasLiveRuntime(tabId) gates the reconnect. When the tab already
// has a live runtime on the OPEN shared socket, activation foregrounds it and
// returns WITHOUT reconnecting. If this guard is dropped, activation goes back to
// disrupting every live tab.

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

test("claimedTabHasLiveRuntime checks the open socket, the connected set, and the remembered route", () => {
  const match = backgroundSource.match(
    /const claimedTabHasLiveRuntime = \(tabId\) => \{([\s\S]*?)\n\};/,
  );
  assert.ok(match, "claimedTabHasLiveRuntime helper must be declared");
  const body = match[1];
  assert.ok(
    body.includes("bridgeSocket?.readyState !== WebSocket.OPEN"),
    "liveness must require the shared bridge socket to be OPEN",
  );
  assert.ok(
    body.includes("activeRuntimeTabIds") && body.includes(".has(tabId)"),
    "liveness must require the tab to be in the connected runtime set",
  );
  assert.ok(
    body.includes("bridgeRuntimeRoutes.get(`runtime_key:${runtimeKeyForTab(tabId)}`) === tabId"),
    "liveness must require the tab's runtime route to be remembered",
  );
});

test("activateClaimedTab foregrounds a live tab without reconnecting", () => {
  const fnMatch = backgroundSource.match(
    /const activateClaimedTab = async \(message\) => \{([\s\S]*?)\n\};/,
  );
  assert.ok(fnMatch, "activateClaimedTab must be declared");
  const body = fnMatch[1];

  // The reconnect must be guarded by the liveness check with an early return.
  assert.ok(
    body.includes("if (claimedTabHasLiveRuntime(tabId)) {"),
    "activateClaimedTab must gate the reconnect on claimedTabHasLiveRuntime",
  );

  // The live-tab branch must return before scheduling connectClaimedTab.
  const guardIdx = body.indexOf("if (claimedTabHasLiveRuntime(tabId)) {");
  const reconnectIdx = body.indexOf("connectClaimedTab(tabId, claim)");
  assert.ok(guardIdx !== -1 && reconnectIdx !== -1);
  assert.ok(
    guardIdx < reconnectIdx,
    "the liveness guard must appear before the connectClaimedTab reconnect",
  );

  // The live branch reports reconnected:false so callers can see it was reused.
  const liveBranch = body.slice(guardIdx, reconnectIdx);
  assert.ok(
    liveBranch.includes("reconnected: false") && liveBranch.includes("return"),
    "the live-tab branch must return early with reconnected:false",
  );
});
