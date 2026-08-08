import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Investigation:
// the internal investigation record
//
// A user with nothing claimed opened the extension's options page and saw:
//
//   Cannot access contents of url "chrome-extension://<id>/src/options.html".
//   Extension manifest must request permission to access this host.
//
// Root cause, confirmed by experiment X4 with a PASSING CONTROL on an ordinary
// page in the same session: `getHostedToolDefaultTab` falls back to
// `chrome.tabs.query({active:true})` when no claimed tab resolves, and hands
// that tab — UNCLAIMED, unfiltered by scheme — to a hosted tool call, which
// reaches injectContent -> chrome.scripting.executeScript.
//
// The scheme refusal is the LOUD version. The same fallback would hand over a
// banking tab or a password manager, and on https:// Chrome does NOT refuse —
// it would inject silently into a tab the user never authorized. Per-tab
// authorization is this product's security model; a convenience default that
// bypasses it is the defect, not the scheme it happened to trip over.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXECUTES THE FUNCTION INSTEAD OF GREPPING background.js
//
// My first version of this test asserted on the SOURCE TEXT — that the fallback
// "contains isOperableTabUrl(tab.url)". I then ran the known-answer check by
// changing the guard to `if (false && !isOperableTabUrl(tab.url))`.
//
// All seven tests stayed GREEN. The regex still matched: the call was textually
// present while being unreachable.
//
// A test that greps source cannot detect a disabled code path. Only executing
// the function can. So this file lifts the shipped `getHostedToolDefaultTab`
// out of background.js and RUNS it against a fake `chrome.tabs` — and the
// known-answer check now turns it red.
// ---------------------------------------------------------------------------

const BACKGROUND = readFileSync(
  fileURLToPath(new URL("../src/background.js", import.meta.url)),
  "utf8",
);

// background.js is an MV3 service-worker module full of chrome.* references and
// cannot be imported. Lift the SHIPPED definitions and execute them, so the
// test binds to the real code rather than to a copy that could drift.
function loadShipped({ claimedTab = null } = {}) {
  const grab = (re, what) => {
    const m = BACKGROUND.match(re);
    assert.ok(m, `${what} must exist in background.js`);
    return m[0];
  };
  const schemes = grab(
    /const UNOPERABLE_TAB_SCHEMES = Object\.freeze\(\[[\s\S]*?\]\);/,
    "UNOPERABLE_TAB_SCHEMES",
  );
  const predicate = grab(
    /const isOperableTabUrl = \(url\) =>\n[\s\S]*?;\n/,
    "isOperableTabUrl",
  );
  const fn = grab(
    /const getHostedToolDefaultTab = async \(\) => \{[\s\S]*?\n\};/,
    "getHostedToolDefaultTab",
  );

  return (activeTab) => {
    const chrome = {
      tabs: { query: async () => (activeTab ? [activeTab] : []) },
    };
    const getClaimedActiveTab = async () => claimedTab;
    return new Function(
      "chrome",
      "getClaimedActiveTab",
      `${schemes}\n${predicate}\n${fn}\nreturn getHostedToolDefaultTab();`,
    )(chrome, getClaimedActiveTab);
  };
}

const OPTIONS_TAB = {
  id: 7,
  url: "chrome-extension://hpfhjegmjhbagbabohjemenfnnjdmhdl/src/options.html",
};
const ORDINARY_TAB = { id: 8, url: "https://example.com/" };

test("the reported tab is refused, and the refusal is NAMED — the exact defect", async () => {
  const run = loadShipped();
  const result = await run(OPTIONS_TAB);

  // The tab must NOT be handed onward: that is what reached executeScript.
  assert.equal(result.tab, null, "an unoperable frontmost tab must not be returned");
  assert.equal(result.refused?.code, "active_tab_not_operable");
  assert.equal(result.refused?.url, OPTIONS_TAB.url);
  // The original failure reached the user as an opaque Chrome string with no
  // remedy. The refusal must say what to do instead.
  assert.match(result.refused.message, /Take control of this tab/);
});

test("ordinary pages still pass through — the control that keeps this non-vacuous", async () => {
  // X4's control injected successfully on https://example.com. A guard that
  // refused everything would "fix" the symptom by breaking the product, and
  // every refusal assertion above would pass for the wrong reason.
  const run = loadShipped();
  for (const url of [
    "https://example.com/",
    "https://trello.com/b/abc/board",
    "http://localhost:3000/",
    "https://docs.google.com/document/d/x/edit",
    "https://example.com/?next=chrome://settings", // merely CONTAINS a scheme
  ]) {
    const result = await run({ id: 9, url });
    assert.equal(result.tab?.url, url, `${url} must stay operable`);
    assert.equal(result.refused, undefined);
    assert.equal(result.source, "browser_active_tab");
  }
});

test("every scheme that grants no host access is refused", async () => {
  const run = loadShipped();
  for (const url of [
    "chrome://extensions",
    "chrome-extension://abc/agent-surface.html",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
  ]) {
    const result = await run({ id: 10, url });
    assert.equal(result.tab, null, `${url} must be refused`);
    assert.equal(result.refused?.code, "active_tab_not_operable");
  }
});

test("a tab with no url is refused rather than passed on", async () => {
  // chrome.tabs.get can return a tab with no url when the permission is absent.
  // Refusing is the safe direction.
  const run = loadShipped();
  for (const tab of [{ id: 11 }, { id: 12, url: "" }, { id: 13, url: null }]) {
    const result = await run(tab);
    assert.equal(result.tab, null);
    assert.equal(result.refused?.code, "active_tab_not_operable");
  }
});

test("no active tab at all yields null without a refusal code", async () => {
  // Distinct from "there is a tab and we will not touch it".
  const run = loadShipped();
  const result = await run(null);
  assert.equal(result.tab, null);
  assert.equal(result.refused, undefined);
});

test("a CLAIMED tab still wins, and is never scheme-filtered", async () => {
  // The fix must not narrow what already worked. An explicitly claimed tab is
  // the user's own authorization and is returned before the fallback runs — so
  // it is returned even for a URL the fallback would refuse.
  const claimed = { id: 42, url: "chrome-extension://whatever/page.html" };
  const run = loadShipped({ claimedTab: claimed });
  const result = await run(OPTIONS_TAB);
  assert.equal(result.source, "claimed_active_tab");
  assert.equal(result.tab.id, 42);
  assert.equal(result.refused, undefined);
});

test("the claimed path short-circuits the query entirely", async () => {
  // Proves ordering by observation, not by reading: if the fallback ran, the
  // fake query would have been called.
  let queried = false;
  const schemes = BACKGROUND.match(
    /const UNOPERABLE_TAB_SCHEMES = Object\.freeze\(\[[\s\S]*?\]\);/,
  )[0];
  const predicate = BACKGROUND.match(
    /const isOperableTabUrl = \(url\) =>\n[\s\S]*?;\n/,
  )[0];
  const fn = BACKGROUND.match(
    /const getHostedToolDefaultTab = async \(\) => \{[\s\S]*?\n\};/,
  )[0];
  const chrome = {
    tabs: {
      query: async () => {
        queried = true;
        return [ORDINARY_TAB];
      },
    },
  };
  const result = await new Function(
    "chrome",
    "getClaimedActiveTab",
    `${schemes}\n${predicate}\n${fn}\nreturn getHostedToolDefaultTab();`,
  )(chrome, async () => ({ id: 5, url: "https://claimed.example/" }));

  assert.equal(result.source, "claimed_active_tab");
  assert.equal(queried, false, "the browser-active fallback must not run when a tab is claimed");
});

// ---------------------------------------------------------------------------
// Phase 10 remediation (C1/C2 from the audit): the guard that closes the SILENT
// failure, not just the loud one.
//
// The Phase 8 fix above made the fallback refuse unoperable SCHEMES. The audit
// then found that the fallback itself is the defect: when it yields, four sinks
// — runA11yTreeOp, runA11yWatch, dispatchTrustedKey, dispatchTrustedText —
// attach a debugger and read the whole accessibility tree, inject into all
// frames, and dispatch up to 1000 real isTrusted keystrokes. Each guards only
// with `Number.isInteger(tabId)` while its error text claims to require "an
// authorized browser tab".
//
// On https:// Chrome does not refuse, so against a bank or a password manager
// it succeeds SILENTLY. The reported incident was the loud version.
// ---------------------------------------------------------------------------

function loadDispatcherGuard() {
  // Execute the real branch, not a copy: extract the guard from
  // executeHostedToolCallInner and run it with a stubbed resolver.
  const inner = BACKGROUND.slice(
    BACKGROUND.indexOf("const executeHostedToolCallInner"),
    BACKGROUND.indexOf("const backgroundResult = await executeBackgroundHostedToolCall"),
  );
  assert.ok(inner.includes("getHostedToolDefaultTab"), "the dispatcher must resolve a default tab");

  return ({ source, tabId = 99 }) =>
    new Function(
      "getHostedToolDefaultTab",
      "call",
      `${inner}\nreturn (async () => {
         const r = await (async () => { ${inner.slice(inner.indexOf("{") + 1)} })();
         return r;
       })();`,
    );
}

test("C1/C2: an unclaimed frontmost tab is REFUSED for the privileged tools", async () => {
  // Executed, not grepped. Build the real branch condition and run it.
  const innerSrc = BACKGROUND.slice(
    BACKGROUND.indexOf("const executeHostedToolCallInner = async (call = {}) => {"),
    BACKGROUND.indexOf("  const backgroundResult = await executeBackgroundHostedToolCall"),
  );
  const body = innerSrc.slice(innerSrc.indexOf("=> {") + 4);

  const runGuard = (call, source) =>
    new Function(
      "call",
      "HOSTED_DEFAULT_TAB_TOOLS",
      "getHostedToolDefaultTab",
      `return (async () => {${body}\nreturn { passed: true, backgroundRoutedTabId }; })();`,
    )(
      call,
      new Set(["a11y.tree", "a11y.query", "a11y.watch"]),
      async () => ({ tab: { id: 99, url: "https://bank.example/" }, source }),
    );

  for (const call of [
    { name: "a11y.tree", call_id: "c1", arguments: {} },
    { name: "a11y.query", call_id: "c2", arguments: {} },
    { name: "keyboard.press", call_id: "c3", arguments: { trusted: true, key: "a" } },
    { name: "text.type", call_id: "c4", arguments: { trusted: true, text: "x" } },
  ]) {
    const result = await runGuard(call, "browser_active_tab");
    assert.equal(result.ok, false, `${call.name} must be refused on an unclaimed tab`);
    assert.equal(result.error?.code, "no_claimed_tab");
    assert.match(result.error.message, /Take control of this tab/);
  }
});

test("C1/C2 control: a CLAIMED tab still routes — the guard does not break the product", async () => {
  const innerSrc = BACKGROUND.slice(
    BACKGROUND.indexOf("const executeHostedToolCallInner = async (call = {}) => {"),
    BACKGROUND.indexOf("  const backgroundResult = await executeBackgroundHostedToolCall"),
  );
  const body = innerSrc.slice(innerSrc.indexOf("=> {") + 4);

  const result = await new Function(
    "call",
    "HOSTED_DEFAULT_TAB_TOOLS",
    "getHostedToolDefaultTab",
    `return (async () => {${body}\nreturn { passed: true, backgroundRoutedTabId }; })();`,
  )(
    { name: "a11y.tree", call_id: "ok", arguments: {} },
    new Set(["a11y.tree", "a11y.query", "a11y.watch"]),
    async () => ({ tab: { id: 42, url: "https://trello.com/" }, source: "claimed_active_tab" }),
  );

  assert.equal(result.passed, true, "a claimed tab must reach the sinks");
  assert.equal(result.backgroundRoutedTabId, 42);
});

test("C1/C2: an EXPLICIT tab_id bypasses the fallback entirely", async () => {
  // The refusal is about the absence of a target, not about the tools.
  const innerSrc = BACKGROUND.slice(
    BACKGROUND.indexOf("const executeHostedToolCallInner = async (call = {}) => {"),
    BACKGROUND.indexOf("  const backgroundResult = await executeBackgroundHostedToolCall"),
  );
  const body = innerSrc.slice(innerSrc.indexOf("=> {") + 4);

  let resolverCalled = false;
  const result = await new Function(
    "call",
    "HOSTED_DEFAULT_TAB_TOOLS",
    "getHostedToolDefaultTab",
    `return (async () => {${body}\nreturn { passed: true, backgroundRoutedTabId }; })();`,
  )(
    { name: "a11y.tree", call_id: "explicit", arguments: { tab_id: 7 } },
    new Set(["a11y.tree", "a11y.query", "a11y.watch"]),
    async () => {
      resolverCalled = true;
      return { tab: { id: 99 }, source: "browser_active_tab" };
    },
  );

  assert.equal(result.passed, true);
  assert.equal(resolverCalled, false, "an explicit tab_id must not consult the fallback");
});
