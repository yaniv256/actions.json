import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-03 dismiss_dialog routing bug.
//
// Direct MCP-bridge tool calls arrive in background.js as type:"action_call"
// and are dispatched by routeBridgeItemToTab. Tab-lifecycle + dialog-dismiss
// tools are handled ONLY in the background service worker
// (executeBackgroundHostedToolCall) — content.js executeAction has no case for
// them and throws "No handler implemented". So routeBridgeItemToTab MUST
// intercept these names and run them in the background, exactly like it already
// does for browser.screenshot. If that interception is dropped,
// browser.dismiss_dialog (whose whole purpose is to rescue a tab whose content
// channel is frozen by a native modal) silently breaks again.

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

const REQUIRED_BACKGROUND_ACTIONS = [
  "browser.navigate",
  "browser.open_tab",
  "browser.close_tab",
  "browser.dismiss_dialog",
];

test("background.js declares the bridge background-action set with the lifecycle + dismiss tools", () => {
  const match = backgroundSource.match(
    /BRIDGE_BACKGROUND_ACTION_NAMES\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(match, "BRIDGE_BACKGROUND_ACTION_NAMES set must be declared in background.js");
  const declared = match[1];
  for (const name of REQUIRED_BACKGROUND_ACTIONS) {
    assert.ok(
      declared.includes(`"${name}"`),
      `${name} must be in BRIDGE_BACKGROUND_ACTION_NAMES so direct-bridge calls route to the background worker`,
    );
  }
});

test("routeBridgeItemToTab intercepts background actions before forwarding to the content script", () => {
  const routerStart = backgroundSource.indexOf("const routeBridgeItemToTab");
  assert.ok(routerStart >= 0, "routeBridgeItemToTab must exist");
  const routerBody = backgroundSource.slice(routerStart, routerStart + 6000);

  // The router decides the background path via bridgeItemNeedsBackground(item),
  // which consults BRIDGE_BACKGROUND_ACTION_NAMES (and the trusted keyboard.press
  // case). Keeping the decision in one predicate is the intended refactor.
  const interceptIdx = routerBody.indexOf("bridgeItemNeedsBackground(item)");
  const forwardIdx = routerBody.indexOf('type: "actions-json:bridge-message"');

  assert.ok(
    interceptIdx >= 0,
    "routeBridgeItemToTab must gate the background path on bridgeItemNeedsBackground(item)",
  );
  assert.ok(
    backgroundSource.includes("BRIDGE_BACKGROUND_ACTION_NAMES.has(item?.name)"),
    "bridgeItemNeedsBackground must still consult BRIDGE_BACKGROUND_ACTION_NAMES",
  );
  assert.ok(forwardIdx >= 0, "routeBridgeItemToTab must forward remaining items to the content script");
  assert.ok(
    interceptIdx < forwardIdx,
    "the background-action interception must come BEFORE the content-script forward, or lifecycle tools fall through to executeAction and throw",
  );
});

test("the background interception dispatches through executeBackgroundHostedToolCall", () => {
  const routerStart = backgroundSource.indexOf("const routeBridgeItemToTab");
  const routerBody = backgroundSource.slice(routerStart, routerStart + 6000);
  assert.ok(
    routerBody.includes("executeBackgroundHostedToolCall"),
    "the interception must run the tool via executeBackgroundHostedToolCall (the handler that owns navigate/open_tab/close_tab/dismiss_dialog)",
  );
});
