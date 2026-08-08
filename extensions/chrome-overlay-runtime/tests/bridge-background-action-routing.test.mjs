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

test("close_tab and dismiss_dialog preserve the exact bridge-routed tab id", () => {
  const handlerStart = backgroundSource.indexOf("const executeBackgroundHostedToolCall");
  const handlerBody = backgroundSource.slice(handlerStart, handlerStart + 15000);
  for (const name of ["browser.close_tab", "browser.dismiss_dialog"]) {
    const branchStart = handlerBody.indexOf(`call.name === "${name}"`);
    assert.ok(branchStart >= 0, `${name} background branch must exist`);
    const branch = handlerBody.slice(branchStart, branchStart + 700);
    assert.match(
      branch,
      /tab_id:\s*Number\.isInteger\(routedTabId\)\s*\?\s*routedTabId/,
      `${name} must inject routedTabId instead of falling back to the active tab`,
    );
  }
});

// ---------------------------------------------------------------------------
// Regression guards for the 2026-07-20/2026-07-24 cross-runtime misroute
// (route-or-refuse contract).
//
// routeBridgeItemToTab resolves the bridge item's runtime to a tab and passes
// it as the second argument (routedTabId) to executeBackgroundHostedToolCall.
// The a11y/trusted-input branches always honored it, but the tab-targeted
// browser.* lifecycle branches DROPPED it, so navigate/close/dismiss fell back
// to resolveClaimedTarget's ACTIVE-claimed-tab default: a call routed to
// runtime X (by target_runtime_id OR target_url_contains — both resolve to the
// same routedTabId) navigated whatever tab was active. Live impact 2026-07-24:
// five misrouted navigates, two clobbered human tabs (Trello, Calendar), plus
// an operator independent two-runtime repro the same night. Discriminating control:
// actions.site calls (content-script path) routed correctly all session — only
// this background family misroutes, which is exactly the dropped parameter.

const backgroundHandlerBlock = (name) => {
  const start = backgroundSource.indexOf(`if (call.name === "${name}")`);
  assert.ok(start >= 0, `${name} handler must exist in executeBackgroundHostedToolCall`);
  const nextHandler = backgroundSource.indexOf('if (call.name === "', start + 10);
  return backgroundSource.slice(start, nextHandler > start ? nextHandler : start + 1200);
};

test("browser.navigate honors routedTabId (route-or-refuse, never active-tab fallback)", () => {
  const block = backgroundHandlerBlock("browser.navigate");
  assert.ok(
    block.includes("Number.isInteger(routedTabId)") && block.includes("tab_id: routedTabId"),
    "browser.navigate must forward routedTabId as tab_id into navigateClaimedTab; dropping it re-opens the active-tab misroute",
  );
});

test("browser.close_tab honors routedTabId", () => {
  const block = backgroundHandlerBlock("browser.close_tab");
  assert.match(
    block,
    /tab_id:\s*(?:routedTabId\b|Number\.isInteger\(routedTabId\)\s*\?\s*routedTabId)/,
    "browser.close_tab must forward routedTabId as tab_id into closeClaimedTab",
  );
});

test("browser.dismiss_dialog honors routedTabId", () => {
  const block = backgroundHandlerBlock("browser.dismiss_dialog");
  assert.match(
    block,
    /tab_id:\s*(?:routedTabId\b|Number\.isInteger\(routedTabId\)\s*\?\s*routedTabId)/,
    "browser.dismiss_dialog must forward routedTabId as tab_id into dismissDialogOnTab",
  );
});

test("browser.claimed_tabs.activate honors routedTabId", () => {
  const block = backgroundHandlerBlock("browser.claimed_tabs.activate");
  assert.ok(
    block.includes("Number.isInteger(routedTabId) ? routedTabId :"),
    "browser.claimed_tabs.activate must prefer routedTabId over caller-supplied tab ids",
  );
});

test("routeBridgeItemToTab passes the resolved tabId into the background dispatch", () => {
  const routerStart = backgroundSource.indexOf("const routeBridgeItemToTab");
  const routerBody = backgroundSource.slice(routerStart, routerStart + 8000);
  assert.ok(
    /executeBackgroundHostedToolCall\(\{[\s\S]*?\}, tabId\)/.test(routerBody),
    "the bridge interception must call executeBackgroundHostedToolCall(call, tabId) — the routed tab is the second argument",
  );
});

test("resolveClaimedTarget refuses an unclaimed explicit tab instead of falling back", () => {
  assert.ok(
    backgroundSource.includes("is not claimed by actions.json."),
    "resolveClaimedTarget must throw for an integer tab id that is not claimed — route-or-refuse depends on this refusal, so a routed id can never silently retarget",
  );
});
