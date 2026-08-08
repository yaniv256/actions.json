import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"));

const extractArrow = (name) => {
  const start = background.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = background.indexOf("\n};", start);
  assert.ok(end > start, `${name} must have a bounded arrow-function body`);
  return background.slice(start, end + 3);
};

test("beforeUnloadRiskFromEvaluation reports only positive handler evidence", () => {
  const src = extractArrow("beforeUnloadRiskFromEvaluation");
  const fn = new Function(`${src}; return beforeUnloadRiskFromEvaluation;`)();
  assert.deepEqual(fn({ result: { value: { property_handler: false, listener_count: 0 } } }), {
    guarded: false,
    property_handler: false,
    listener_count: 0,
  });
  assert.deepEqual(fn({ result: { value: { property_handler: true, listener_count: 0 } } }), {
    guarded: true,
    property_handler: true,
    listener_count: 0,
  });
  assert.deepEqual(fn({ result: { value: { property_handler: false, listener_count: 2 } } }), {
    guarded: true,
    property_handler: false,
    listener_count: 2,
  });
});

test("close_tab declares force and documents fail-closed behavior on both catalog surfaces", () => {
  const tools = manifest.tools.filter((entry) => entry.name === "browser.close_tab");
  const primitives = manifest.primitive_dictionary.primitives.filter((entry) => entry.name === "browser.close_tab");
  assert.equal(tools.length, 1);
  assert.equal(primitives.length, 1);
  for (const entry of [...tools, ...primitives]) {
    assert.equal(entry.input_schema.properties.force.type, "boolean");
    assert.match(entry.description || entry.summary, /beforeunload/i);
    assert.match(entry.description || entry.summary, /force/i);
  }
});

test("closeClaimedTab checks the guard before mutating claims or closing the tab", () => {
  const start = background.indexOf("const closeClaimedTab = async (message = {}) =>");
  const end = background.indexOf("\n};", start);
  const body = background.slice(start, end);
  const detect = body.indexOf("detectBeforeUnloadGuard(tabId)");
  const removeClaim = body.indexOf("delete session.tabs");
  const close = body.indexOf("chrome.tabs.remove");
  assert.ok(detect >= 0, "close_tab must detect a beforeunload guard");
  assert.ok(detect < removeClaim, "guard detection must precede claim mutation");
  assert.ok(detect < close, "guard detection must precede tab removal");
  assert.match(body, /beforeunload_guard_detected/);
  assert.match(body, /beforeunload_guard_unknown/);
  assert.match(body, /message\.force/);
  assert.match(body, /close_failed/);
  assert.match(body, /remove_error/);
});

test("guard detection uses CDP's event-listener inventory rather than a command-line helper", () => {
  const src = extractArrow("detectBeforeUnloadGuard");
  assert.match(src, /DOMDebugger\.getEventListeners/);
  assert.match(src, /Runtime\.callFunctionOn/);
  assert.doesNotMatch(src, /getEventListeners\(window\)/);
});

test("dismiss_dialog refuses an unarmed native dialog with an honest recovery boundary", async () => {
  const calls = [];
  const deps = {
    ownedDialogRecoveryTabs: new Set(),
    acquireDebugger: async () => calls.push("acquire"),
    releaseDebugger: async () => calls.push("release"),
    debuggerSendCommand: async (_target, method, args) => {
      calls.push(["send", method, args?.accept]);
      return {};
    },
    withTimeout: async (promise) => promise,
  };
  const names = Object.keys(deps);
  const handle = new Function(
    ...names,
    `${extractArrow("handleJavaScriptDialogOnTabId")}; return handleJavaScriptDialogOnTabId;`,
  )(...names.map((name) => deps[name]));

  const result = await handle(41, { accept: false });

  assert.equal(result.dismissed, false);
  assert.equal(result.code, "dialog_recovery_not_armed");
  assert.deepEqual(calls, []);
});

test("dismiss_dialog handles a proactively armed session without re-enabling Page", async () => {
  const calls = [];
  const deps = {
    ownedDialogRecoveryTabs: new Set([41]),
    acquireDebugger: async () => calls.push("acquire"),
    releaseDebugger: async () => calls.push("release"),
    debuggerSendCommand: async (_target, method, args) => {
      calls.push(["send", method, args?.accept]);
      return {};
    },
    withTimeout: async (promise) => promise,
  };
  const names = Object.keys(deps);
  const handle = new Function(
    ...names,
    `${extractArrow("handleJavaScriptDialogOnTabId")}; return handleJavaScriptDialogOnTabId;`,
  )(...names.map((name) => deps[name]));

  const result = await handle(41, { accept: false });

  assert.equal(result.dismissed, true);
  assert.deepEqual(calls, [["send", "Page.handleJavaScriptDialog", false], "release"]);
  assert.equal(deps.ownedDialogRecoveryTabs.has(41), false);
});

test("dialog recovery preparation attaches and enables Page before a dialog opens", async () => {
  const calls = [];
  const ownedDialogRecoveryTabs = new Set();
  const deps = {
    ownedDialogRecoveryTabs,
    acquireDebugger: async () => calls.push("acquire"),
    debuggerSendCommand: async (_target, method) => calls.push(["send", method]),
    releaseDebugger: async () => calls.push("release"),
    withTimeout: async (promise) => promise,
  };
  const names = Object.keys(deps);
  const prepare = new Function(
    ...names,
    `${extractArrow("prepareJavaScriptDialogHandlingOnTabId")}; return prepareJavaScriptDialogHandlingOnTabId;`,
  )(...names.map((name) => deps[name]));

  const result = await prepare(41);

  assert.equal(result.armed, true);
  assert.equal(result.owned_session, true);
  assert.equal(ownedDialogRecoveryTabs.has(41), true);
  assert.deepEqual(calls, ["acquire", ["send", "Page.enable"]]);
});

const makeCloseHarness = ({ guardResult, guardError } = {}) => {
  const session = { tabs: { "41": { url: "https://example.test" }, "42": {} }, activeTabId: 41 };
  const calls = [];
  const deps = {
    ownedDialogRecoveryTabs: new Set(),
    sessionStore: {
      getSessionEntries: async () => [["session", session]],
      save: async () => { calls.push("save"); return true; },
      snapshotState: () => ({}),
      restoreState: () => {},
    },
    resolveClaimedTarget: async () => ({ session, tabId: 41, claim: { ownershipRevision: "rev-1" } }),
    DEFAULT_SESSION_ID: "session",
    delegatedGroupStore: {
      // main's ownership-revision guard (PR #276): the close path checks that the
      // tab's ownership has not changed before closing. These tests exercise the
      // beforeunload behavior with ownership intact, so the guard passes (true).
      releaseTabIfRevision: async () => true,
    },
    detectBeforeUnloadGuard: async () => {
      calls.push("detect");
      if (guardError) throw guardError;
      return guardResult || { guarded: false, property_handler: false, listener_count: 0 };
    },
    runtimeIdsForTab: () => ["runtime-41"],
    sendBridgeItem: () => calls.push("runtime_removed"),
    forgetRuntimeRoutesForTab: () => calls.push("forget"),
    chrome: {
      tabs: {
        remove: async () => calls.push("remove"),
        get: async () => { throw new Error("No tab with id: 41"); },
      },
    },
    waitForTabToClose: async () => true,
    prepareJavaScriptDialogHandlingOnTabId: async () => {
      calls.push("prepare");
      return { armed: true, owned_session: true };
    },
    handleJavaScriptDialogOnTabId: async () => calls.push("dismiss"),
  };
  const names = Object.keys(deps);
  const closeClaimedTab = new Function(
    ...names,
    `${extractArrow("closeClaimedTab")}; return closeClaimedTab;`,
  )(...names.map((name) => deps[name]));
  return { closeClaimedTab, session, calls };
};

test("close_tab refuses a detected guard without mutating the claim", async () => {
  const harness = makeCloseHarness({
    guardResult: { guarded: true, property_handler: false, listener_count: 1 },
  });
  const result = await harness.closeClaimedTab({ tab_id: 41 });
  assert.equal(result.code, "beforeunload_guard_detected");
  assert.equal(result.closed, false);
  assert.equal(result.dialog_recovery_armed, true);
  assert.deepEqual(Object.keys(harness.session.tabs), ["41", "42"]);
  assert.deepEqual(harness.calls, ["detect", "prepare"]);
});

test("close_tab fails closed when guard detection is indeterminate", async () => {
  const harness = makeCloseHarness({ guardError: new Error("debugger unavailable") });
  const result = await harness.closeClaimedTab({ tab_id: 41 });
  assert.equal(result.code, "beforeunload_guard_unknown");
  assert.equal(result.force_required, true);
  assert.deepEqual(Object.keys(harness.session.tabs), ["41", "42"]);
  assert.deepEqual(harness.calls, ["detect"]);
});

test("close_tab force bypasses detection and preserves close ordering", async () => {
  const harness = makeCloseHarness({ guardError: new Error("must not run") });
  const result = await harness.closeClaimedTab({ tab_id: 41, force: true });
  assert.equal(result.closed, true);
  assert.equal(result.forced, true);
  assert.deepEqual(Object.keys(harness.session.tabs), ["42"]);
  assert.deepEqual(harness.calls, ["prepare", "remove", "save", "runtime_removed", "forget"]);
});

test("close_tab preserves the claim when Chrome does not confirm closure", async () => {
  const harness = makeCloseHarness();
  // Override the closure probe through a fresh harness whose tab remains live.
  const session = harness.session;
  const calls = [];
  const deps = {
    ownedDialogRecoveryTabs: new Set(),
    sessionStore: {
      getSessionEntries: async () => [["session", session]],
      save: async () => { calls.push("save"); return true; },
      snapshotState: () => ({}),
      restoreState: () => {},
    },
    resolveClaimedTarget: async () => ({ session, tabId: 41, claim: { ownershipRevision: "rev-1" } }),
    DEFAULT_SESSION_ID: "session",
    delegatedGroupStore: {
      // main's ownership-revision guard (PR #276): the close path checks that the
      // tab's ownership has not changed before closing. These tests exercise the
      // beforeunload behavior with ownership intact, so the guard passes (true).
      releaseTabIfRevision: async () => true,
    },
    detectBeforeUnloadGuard: async () => ({ guarded: false }),
    runtimeIdsForTab: () => ["runtime-41"],
    sendBridgeItem: () => calls.push("runtime_removed"),
    forgetRuntimeRoutesForTab: () => calls.push("forget"),
    chrome: { tabs: { remove: async () => calls.push("remove") } },
    waitForTabToClose: async () => false,
    prepareJavaScriptDialogHandlingOnTabId: async () => ({ armed: true }),
    handleJavaScriptDialogOnTabId: async () => calls.push("dismiss"),
  };
  const names = Object.keys(deps);
  const close = new Function(...names, `${extractArrow("closeClaimedTab")}; return closeClaimedTab;`)(
    ...names.map((name) => deps[name]),
  );
  const result = await close({ tab_id: 41 });
  assert.equal(result.code, "close_blocked_by_unarmed_dialog");
  assert.equal(result.manual_interaction_required, true);
  assert.equal(result.dialog_recovery_armed, false);
  assert.match(result.message, /browser UI/);
  assert.doesNotMatch(result.message, /dismiss_dialog|force=true/);
  assert.deepEqual(Object.keys(session.tabs), ["41", "42"]);
  assert.deepEqual(calls, ["remove"]);
});

test("close_tab force recovers when chrome.tabs.remove waits on beforeunload", async () => {
  const session = { tabs: { "41": { url: "https://example.test" }, "42": {} }, activeTabId: 41 };
  const calls = [];
  let closeChecks = 0;
  const deps = {
    ownedDialogRecoveryTabs: new Set(),
    sessionStore: {
      getSessionEntries: async () => [["session", session]],
      save: async () => { calls.push("save"); return true; },
      snapshotState: () => ({}),
      restoreState: () => {},
    },
    resolveClaimedTarget: async () => ({ session, tabId: 41, claim: { ownershipRevision: "rev-1" } }),
    DEFAULT_SESSION_ID: "session",
    delegatedGroupStore: {
      // main's ownership-revision guard (PR #276): the close path checks that the
      // tab's ownership has not changed before closing. These tests exercise the
      // beforeunload behavior with ownership intact, so the guard passes (true).
      releaseTabIfRevision: async () => true,
    },
    detectBeforeUnloadGuard: async () => ({ guarded: true }),
    runtimeIdsForTab: () => ["runtime-41"],
    sendBridgeItem: () => calls.push("runtime_removed"),
    forgetRuntimeRoutesForTab: () => calls.push("forget"),
    chrome: { tabs: { remove: () => new Promise(() => {}) } },
    waitForTabToClose: async () => ++closeChecks > 1,
    prepareJavaScriptDialogHandlingOnTabId: async () => {
      calls.push("prepare");
      return { armed: true };
    },
    handleJavaScriptDialogOnTabId: async () => {
      calls.push("dismiss");
      return { dismissed: true, accept: true };
    },
  };
  const names = Object.keys(deps);
  const close = new Function(...names, `${extractArrow("closeClaimedTab")}; return closeClaimedTab;`)(
    ...names.map((name) => deps[name]),
  );

  const result = await Promise.race([
    close({ tab_id: 41, force: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("force close remained absorbed")), 500)),
  ]);

  assert.equal(result.closed, true);
  assert.equal(result.forced, true);
  assert.deepEqual(calls, ["prepare", "dismiss", "save", "runtime_removed", "forget"]);
});
