import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-03 shared-bridge-socket-churn incident.
//
// The bridge WebSocket is a single module-global shared by ALL claimed tabs.
// Rebuilding it on every content-script `bridge-connect` (open_tab/navigate/
// reconnect) churns the transport the other tabs depend on and can leave the
// connecting tab undrivable when the rebuild times out. Two invariants must hold:
//   1. bridge-connect reuses an already-open socket (attachRuntimeToOpenBridge)
//      before falling back to a full connectBackgroundBridge rebuild.
//   2. open_tab establishes the content-side bridge connection via connectClaimedTab
//      (which sends actions-json:connect), the same as the working re-claim path —
//      runtime-ready alone does NOT plug the content script into the transport.

const source = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

function bodyOf(marker, span = 2600) {
  const idx = source.indexOf(marker);
  assert.ok(idx >= 0, `expected to find ${marker}`);
  return source.slice(idx, idx + span);
}

test("connectBackgroundBridge reuses an open socket internally before closing it", () => {
  // The idempotency guard lives INSIDE connectBackgroundBridge (not only at the
  // bridge-connect call site) so no current or future caller can re-introduce the
  // per-tab socket churn. The attach attempt must precede closeBridgeSocket().
  const body = bodyOf("const connectBackgroundBridge = async (state, options = {}) =>", 1400);
  const attachIdx = body.indexOf("await attachRuntimeToOpenBridge(");
  const closeIdx = body.indexOf("closeBridgeSocket()");
  assert.ok(attachIdx >= 0, "connectBackgroundBridge must AWAIT attachRuntimeToOpenBridge — it is async, and an un-awaited Promise is always truthy");
  assert.ok(closeIdx >= 0, "connectBackgroundBridge must still close the socket on a real rebuild");
  assert.ok(
    attachIdx < closeIdx,
    "the reuse attempt must come BEFORE closeBridgeSocket(), or the healthy socket is torn down first",
  );
});

test("connectBackgroundBridge does NOT reuse on a genuine reconnect attempt", () => {
  const body = bodyOf("const connectBackgroundBridge = async (state, options = {}) =>", 1400);
  assert.ok(
    /!options\.reconnectAttempt/.test(body),
    "reuse must be gated on !options.reconnectAttempt so real socket loss still rebuilds",
  );
});

test("attachRuntimeToOpenBridge only reuses a socket that is OPEN for the same bridge URL", () => {
  const body = bodyOf("const attachRuntimeToOpenBridge = async (", 1400);
  assert.ok(
    /bridgeSocket\?\.readyState !== WebSocket\.OPEN/.test(body),
    "must bail unless the shared socket is OPEN",
  );
  assert.ok(
    /bridgeState\.bridgeUrl !== bridgeUrl/.test(body),
    "must bail if the open socket is for a different bridge URL",
  );
  assert.ok(
    /return false/.test(body),
    "must return false (fall through to rebuild) when it cannot reuse",
  );
});

test("attachRuntimeToOpenBridge registers the runtime on the existing socket (no teardown)", () => {
  const body = bodyOf("const attachRuntimeToOpenBridge = async (", 1400);
  assert.ok(/sendBridgeItem\(/.test(body), "must register the tab on the open socket");
  assert.ok(/rememberRuntimeRoute\(/.test(body), "must record the local route");
  assert.ok(
    !/closeBridgeSocket\(/.test(body),
    "must NOT close/rebuild the shared socket in the reuse path",
  );
});

test("openClaimedTab establishes the content bridge connection via connectClaimedTab", () => {
  const body = bodyOf("const openClaimedTab = async (message = {}) =>", 2600);
  assert.ok(
    /connectClaimedTab\(/.test(body),
    "open_tab must call connectClaimedTab (sends actions-json:connect) so the content script plugs into the transport — runtime-ready alone does not",
  );
});
