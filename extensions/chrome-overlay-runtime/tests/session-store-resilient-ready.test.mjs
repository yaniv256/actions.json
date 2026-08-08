import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  DEFAULT_GROUP_ID,
  createGroupStore,
  makeWebsiteGroupId,
} from "../src/delegated-agent/group-store.mjs";

// Behavioral regression guard for the internal investigation record.
//
// ROOT CAUSE: SessionStore.ready was a one-shot promise (`this.ready = this.load()`)
// created once in the constructor. load() awaits chrome.storage.local.get. Under
// MV3 the background service worker is re-instantiated constantly; if that single
// storage access never settles, `await this.ready` in getSessionEntries()/getSession()
// hangs FOREVER — and every claimed_tabs.* handler awaits it, so all tab-lifecycle
// calls return 504 while non-store handlers (screenshot, page.fetch) keep working.
//
// FIX: ensureReady() bounds each storage access with a timeout and re-initializes
// the load promise if a prior attempt stalled/rejected — degrading to the in-memory
// default instead of hanging every caller.
//
// background.js is a service-worker global-scope script with no exports, so we
// extract the SessionStore class source and evaluate it in a vm sandbox with a
// controllable `chrome` mock. This exercises the REAL class body (not a copy).

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);

// Pull the constants + class the fix touches, verbatim, out of the source.
// NOTE: `withTimeout` is declared ONCE in background.js (module-shared) and reused
// by SessionStore — we provide a matching stub here rather than extracting it, so
// this test never depends on which line the single declaration lives at, and never
// re-introduces a duplicate. (The duplicate-const-kills-the-SW bug is guarded by
// the live smoke; here we just exercise the SessionStore logic.)
function extractSessionStoreModule(src) {
  const grab = (re, label) => {
    const m = src.match(re);
    assert.ok(m, `could not locate ${label} in background.js`);
    return m[0];
  };
  const timeoutConst = grab(/const SESSION_STORE_IO_TIMEOUT_MS = \d+;/, "SESSION_STORE_IO_TIMEOUT_MS");
  const cls = grab(/class SessionStore \{[\s\S]*?\n\}/, "SessionStore class");
  // SessionStore now routes storage through the shared boundedStorage helpers
  // (the implementation plan) — extract them too, or the class's load()/save()
  // reference undefined names in the sandbox.
  const getFn = grab(/const boundedStorageGet = [\s\S]*?\n\};/, "boundedStorageGet");
  const setFn = grab(/const boundedStorageSet = [\s\S]*?\n\};/, "boundedStorageSet");
  // Behavior-equivalent stub of the module's withTimeout(promise, ms, label).
  const withTimeoutStub = `const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_res, rej) => setTimeout(() => rej(new Error(label + " timed out after " + ms + "ms")), ms)),
  ]);`;
  return `
    const SESSION_STATE_KEY = "sessionState";
    const LEGACY_SESSION_STATE_KEY = "legacySessionState";
    const DEFAULT_SESSION_ID = "extension:default";
    const LEGACY_DEFAULT_SESSION_ID = "actions-json-default";
    const DEFAULT_SESSION_GROUP_TITLE = "actions.json";
    ${withTimeoutStub}
    ${timeoutConst}
    ${getFn}
    ${setFn}
    ${cls}
    globalThis.__SessionStore = SessionStore;
  `;
}

function makeSandbox(chromeMock) {
  const ctx = { chrome: chromeMock, setTimeout, clearTimeout, Promise, Error, Object, structuredClone, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractSessionStoreModule(backgroundSource), ctx);
  return ctx.__SessionStore;
}

function sharedLocalStorage(initial = {}) {
  let value = structuredClone(initial);
  return {
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (key === null) return structuredClone(value);
            return { [key]: structuredClone(value[key]) };
          },
          async set(items) {
            value = { ...value, ...structuredClone(items) };
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete value[key];
          },
        },
      },
    },
    groupStorage: {
      async get(key) {
        if (key === null) return structuredClone(value);
        return { [key]: structuredClone(value[key]) };
      },
      async set(items) {
        value = { ...value, ...structuredClone(items) };
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete value[key];
      },
    },
  };
}

const delegatedApproval = (approvalId) => ({
  schemaVersion: 1,
  approvalId,
  agent: { id: "agent-a", name: "Agent A" },
  sourceOrigin: "https://agent.example",
  githubOwner: "example",
  githubRepo: "agent-bundle",
  commitSha: "a".repeat(40),
  manifestPath: "agent.json",
  bundleDigest: "b".repeat(64),
  reviewedAt: "2026-07-19T00:00:00.000Z",
  revokedAt: null,
});

const delegatedHome = () => ({
  schemaVersion: 1,
  tabId: 10,
  frameId: 0,
  documentId: "home-document",
  origin: "https://agent.example",
  portNonce: "home-nonce",
  leasedAt: "2026-07-19T00:00:00.000Z",
});

const tabLease = (tabId) => ({
  schemaVersion: 1,
  tabId,
  windowId: 1,
  currentDocumentId: null,
  currentRuntimeId: null,
  assignedAt: "2026-07-19T00:00:00.000Z",
});

test("getSessionEntries resolves (does not hang) when storage.local.get never settles", async () => {
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => new Promise(() => {}), // never resolves — the wedge
        set: () => Promise.resolve(),
      },
    },
  });
  const store = new SessionStore();
  // Without the fix this awaits forever. With it, it degrades to the in-memory
  // default within the io timeout. Guard with our own race so a regression FAILS
  // the test instead of hanging the whole run.
  const entries = await Promise.race([
    store.getSessionEntries(),
    new Promise((_r, reject) => setTimeout(() => reject(new Error("HANG: getSessionEntries never resolved")), 8000)),
  ]);
  assert.deepEqual(entries, [], "should degrade to the empty in-memory default, not hang");
});

test("recovers on a later call after an initial storage stall", async () => {
  let attempt = 0;
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => {
          attempt += 1;
          // First load stalls forever; a later load succeeds with real state.
          if (attempt === 1) return new Promise(() => {});
          return Promise.resolve({ sessionState: { sessions: { "actions-json-default": { tabs: { 42: {} }, activeTabId: 42 } } } });
        },
        set: () => Promise.resolve(),
      },
    },
  });
  const store = new SessionStore();
  const first = await Promise.race([
    store.getSessionEntries(),
    new Promise((_r, reject) => setTimeout(() => reject(new Error("HANG on first call")), 8000)),
  ]);
  assert.deepEqual(first, [], "first call degrades to default while storage is stalled");

  const second = await store.getSessionEntries();
  assert.equal(second.length, 1, "second call re-attempts load and picks up real state");
  assert.equal(second[0][0], "extension:default");
});

test("background.js declares withTimeout exactly once (duplicate const kills the whole SW)", () => {
  // A second top-level `const withTimeout` throws "Identifier already declared" at
  // module load, so the ENTIRE service worker fails to evaluate and every handler
  // (claimed_tabs.*, a11y, input) breaks. The SessionStore fix reuses the existing
  // helper; this guards against a future re-introduction of the duplicate.
  const decls = backgroundSource.match(/^const withTimeout = /gm) || [];
  assert.equal(decls.length, 1, `expected exactly one 'const withTimeout' declaration, found ${decls.length}`);
});

test("normal path still loads persisted state", async () => {
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({ sessionState: { sessions: { "actions-json-default": { tabs: {}, activeTabId: 7 } } } }),
        set: () => Promise.resolve(),
      },
    },
  });
  const store = new SessionStore();
  const entries = await store.getSessionEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].activeTabId, 7);
});

test("save never rejects even if storage.local.set hangs", async () => {
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => new Promise(() => {}), // hangs
      },
    },
  });
  const store = new SessionStore();
  // getSession() calls save() for a freshly-created session; must not hang.
  const session = await Promise.race([
    store.getSession(),
    new Promise((_r, reject) => setTimeout(() => reject(new Error("HANG: getSession/save never resolved")), 8000)),
  ]);
  assert.ok(session && typeof session === "object", "getSession resolves despite a hanging save");
});

// ── U1: boundedStorage access helper (the implementation plan) ──────────────
// The shared, timeout-guarded chrome.storage.local get/set both background stores
// call instead of raw chrome.storage.local. Extracted from the real source and
// exercised in the same vm sandbox as SessionStore.

function extractBoundedStorageModule(src) {
  const grab = (re, label) => {
    const m = src.match(re);
    assert.ok(m, `could not locate ${label} in background.js`);
    return m[0];
  };
  const timeoutConst = grab(/const SESSION_STORE_IO_TIMEOUT_MS = \d+;/, "SESSION_STORE_IO_TIMEOUT_MS");
  const getFn = grab(/const boundedStorageGet = [\s\S]*?\n\};/, "boundedStorageGet");
  const setFn = grab(/const boundedStorageSet = [\s\S]*?\n\};/, "boundedStorageSet");
  const withTimeoutStub = `const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_res, rej) => setTimeout(() => rej(new Error(label + " timed out after " + ms + "ms")), ms)),
  ]);`;
  return `
    const SESSION_STATE_KEY = "sessionState";
    ${withTimeoutStub}
    ${timeoutConst}
    ${getFn}
    ${setFn}
    globalThis.__boundedStorageGet = boundedStorageGet;
    globalThis.__boundedStorageSet = boundedStorageSet;
  `;
}

function makeBoundedSandbox(chromeMock) {
  const ctx = { chrome: chromeMock, setTimeout, clearTimeout, Promise, Error, Object, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractBoundedStorageModule(backgroundSource), ctx);
  return { get: ctx.__boundedStorageGet, set: ctx.__boundedStorageSet };
}

test("boundedStorageGet resolves with the stored value when storage.local.get is healthy", async () => {
  const { get } = makeBoundedSandbox({
    storage: { local: { get: (k) => Promise.resolve({ [k]: "ok" }), set: () => Promise.resolve() } },
  });
  const value = await get("sessionState");
  assert.deepEqual(value, { sessionState: "ok" });
});

test("boundedStorageGet rejects within the budget when storage.local.get never settles", async () => {
  const { get } = makeBoundedSandbox({
    storage: { local: { get: () => new Promise(() => {}), set: () => Promise.resolve() } },
  });
  // Race against a HANG ceiling so a regression (unbounded await) FAILS the test
  // instead of hanging the run. The bounded helper must reject via its timeout.
  const outcome = await Promise.race([
    get("k").then(() => "resolved").catch(() => "rejected"),
    new Promise((_r, resolve) => setTimeout(() => resolve("HANG"), 8000)),
  ]);
  assert.equal(outcome, "rejected", "bounded get should reject on timeout, not hang");
});

test("boundedStorageSet rejects within the budget when storage.local.set never settles", async () => {
  const { set } = makeBoundedSandbox({
    storage: { local: { get: () => Promise.resolve({}), set: () => new Promise(() => {}) } },
  });
  const outcome = await Promise.race([
    set({ k: 1 }).then(() => "resolved").catch(() => "rejected"),
    new Promise((_r, resolve) => setTimeout(() => resolve("HANG"), 8000)),
  ]);
  assert.equal(outcome, "rejected", "bounded set should reject on timeout, not hang");
});

// ── U3: appendAgentMemoryEvent routed through boundedStorage (closes F1) ──────
// The hosted-agent event-logging hot path must degrade, not hang or throw, when
// chrome.storage is wedged. Extract the real function body and run it in a sandbox.

function extractAppendMemoryModule(src) {
  const grab = (re, label) => {
    const m = src.match(re);
    assert.ok(m, `could not locate ${label} in background.js`);
    return m[0];
  };
  const timeoutConst = grab(/const SESSION_STORE_IO_TIMEOUT_MS = \d+;/, "SESSION_STORE_IO_TIMEOUT_MS");
  const getFn = grab(/const boundedStorageGet = [\s\S]*?\n\};/, "boundedStorageGet");
  const setFn = grab(/const boundedStorageSet = [\s\S]*?\n\};/, "boundedStorageSet");
  const appendFn = grab(/const appendAgentMemoryEvent = async \(event\) => \{[\s\S]*?\n\};/, "appendAgentMemoryEvent");
  const withTimeoutStub = `const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_res, rej) => setTimeout(() => rej(new Error(label + " timed out after " + ms + "ms")), ms)),
  ]);`;
  return `
    const AGENT_MEMORY_STORAGE_KEY = "agentMemory";
    const MAX_AGENT_LOG_EVENTS = 200;
    ${withTimeoutStub}
    ${timeoutConst}
    ${getFn}
    ${setFn}
    ${appendFn}
    globalThis.__appendAgentMemoryEvent = appendAgentMemoryEvent;
  `;
}

function makeAppendSandbox(chromeMock) {
  const ctx = {
    chrome: chromeMock, setTimeout, clearTimeout, Promise, Error, Object, Array,
    Date, Math, console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractAppendMemoryModule(backgroundSource), ctx);
  return ctx.__appendAgentMemoryEvent;
}

test("appendAgentMemoryEvent persists an event when storage is healthy", async () => {
  let written = null;
  const append = makeAppendSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({ agentMemory: { visitorId: "v", events: [] } }),
        set: (obj) => { written = obj; return Promise.resolve(); },
      },
    },
  });
  await append({ type: "test-event" });
  assert.ok(written, "set was called");
  assert.equal(written.agentMemory.events.length, 1);
  assert.equal(written.agentMemory.events[0].type, "test-event");
  assert.equal(written.agentMemory.visitorId, "v");
});

test("appendAgentMemoryEvent does not hang or throw when storage.local.get is wedged", async () => {
  const append = makeAppendSandbox({
    storage: {
      local: {
        get: () => new Promise(() => {}), // wedged
        set: () => Promise.resolve(),
      },
    },
  });
  const outcome = await Promise.race([
    append({ type: "e" }).then(() => "settled").catch(() => "threw"),
    new Promise((_r, resolve) => setTimeout(() => resolve("HANG"), 8000)),
  ]);
  assert.equal(outcome, "settled", "append should degrade (start from empty) and settle without throwing");
});

test("appendAgentMemoryEvent does not hang or throw when storage.local.set is wedged", async () => {
  const append = makeAppendSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => new Promise(() => {}), // wedged
      },
    },
  });
  const outcome = await Promise.race([
    append({ type: "e" }).then(() => "settled").catch(() => "threw"),
    new Promise((_r, resolve) => setTimeout(() => resolve("HANG"), 8000)),
  ]);
  assert.equal(outcome, "settled", "append should drop the event and settle without throwing");
});

test("the two routed background stores go through boundedStorage, not raw chrome.storage.local", () => {
  // Regression guard SCOPED to the routed sites — NOT a whole-file assertion.
  // Same-key read/clear handlers (respondWithAgentSessionLog, respondWithAgentMemoryClear)
  // and UI-page calls are intentionally unrouted (Deferred to Follow-Up Work) and
  // must not trip this guard, so we assert only inside the two routed function bodies.
  const grabBody = (re, label) => {
    const m = backgroundSource.match(re);
    assert.ok(m, `could not locate ${label} in background.js`);
    return m[0];
  };
  // SessionStore.load()/save() bodies live inside the class.
  const sessionStore = grabBody(/class SessionStore \{[\s\S]*?\n\}/, "SessionStore class");
  assert.ok(
    !/chrome\.storage\.local\.(get|set)\s*\(/.test(sessionStore),
    "SessionStore must not call raw chrome.storage.local.get/set — route through boundedStorage",
  );
  // appendAgentMemoryEvent body.
  const appendMemory = grabBody(/const appendAgentMemoryEvent = async \(event\) => \{[\s\S]*?\n\};/, "appendAgentMemoryEvent");
  assert.ok(
    !/chrome\.storage\.local\.(get|set)\s*\(/.test(appendMemory),
    "appendAgentMemoryEvent must not call raw chrome.storage.local.get/set — route through boundedStorage",
  );
});

test("SessionStore migrates only the legacy ordinary session into an explicit default group and owner index", async () => {
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: (key) => Promise.resolve({
          [key]: {
            sessions: {
              "actions-json-default": {
                title: "actions.json",
                activeTabId: 42,
                chromeGroupId: 7,
                tabs: { "42": { authorizationId: "auth-42", windowId: 3 } },
              },
              "legacy-website-looking": { tabs: { "99": { authorizationId: "must-not-migrate" } } },
            },
          },
        }),
        set: () => Promise.resolve(),
      },
    },
  });
  const store = new SessionStore();
  const entries = await store.getSessionEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "extension:default");
  assert.equal(entries[0][1].tabs["42"].authorizationId, "auth-42");
  assert.equal(entries[0][1].tabs["99"], undefined);
  assert.equal(store.state.tabOwners["42"], "extension:default");
  assert.deepEqual(entries[0][1].chromeGroupIdsByWindow, {});
});

test("SessionStore persists versioned group-qualified state and rebuilds central ownership on save", async () => {
  let persisted = null;
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: (items) => { persisted = structuredClone(items.sessionState); return Promise.resolve(); },
      },
    },
  });
  const store = new SessionStore();
  const session = await store.getSession("extension:default");
  session.tabs["8"] = { authorizationId: "a", windowId: 2 };
  await store.save();
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.groups["extension:default"].id, "extension:default");
  assert.equal(persisted.groups["extension:default"].tabs["8"].schemaVersion, 1);
  assert.equal(persisted.tabOwners["8"], "extension:default");
});

test("SessionStore keeps returned ordinary-group references live across successful saves", async () => {
  let persisted = null;
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: (items) => { persisted = structuredClone(items.sessionState); return Promise.resolve(); },
      },
    },
  });
  const store = new SessionStore();
  const session = await store.getSession("extension:default");
  session.tabs["8"] = { authorizationId: "a", windowId: 2 };
  await store.save();
  session.activeTabId = 8;
  session.tabs["8"].url = "https://after-save.example/";
  await store.save();
  assert.equal(persisted.groups["extension:default"].activeTabId, 8);
  assert.equal(persisted.groups["extension:default"].tabs["8"].url, "https://after-save.example/");
});

test("SessionStore snapshots restore failed in-memory claim mutations", async () => {
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.reject(new Error("disk unavailable")),
      },
    },
  });
  const store = new SessionStore();
  const session = await store.getSession(DEFAULT_GROUP_ID);
  const snapshot = store.snapshotState();
  session.tabs["42"] = tabLease(42);

  assert.equal(await store.save(), false);
  assert.equal(await store.ownerOfTab(42), DEFAULT_GROUP_ID);
  store.restoreState(snapshot);
  assert.equal(await store.ownerOfTab(42), null);
  assert.equal(session.tabs["42"], undefined);
});

test("SessionStore claim rollback preserves a superseding claim and unrelated metadata", async () => {
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
      },
    },
  });
  const store = new SessionStore();
  const session = await store.getSession(DEFAULT_GROUP_ID);
  session.activeTabId = 7;
  session.tabs["7"] = { ...tabLease(7), ownershipRevision: "old" };
  await store.save();
  const snapshot = store.snapshotState();

  session.activeTabId = 42;
  session.tabs["42"] = { ...tabLease(42), ownershipRevision: "attempt" };
  session.tabs["99"] = { ...tabLease(99), ownershipRevision: "unrelated" };

  assert.equal(store.rollbackClaimMetadata({
    groupId: DEFAULT_GROUP_ID,
    tabId: 42,
    expectedRevision: "attempt",
    snapshot,
  }), true);
  assert.equal(session.tabs["42"], undefined);
  assert.equal(session.tabs["99"].ownershipRevision, "unrelated");
  assert.equal(session.activeTabId, 7);

  session.tabs["42"] = { ...tabLease(42), ownershipRevision: "successor" };
  assert.equal(store.rollbackClaimMetadata({
    groupId: DEFAULT_GROUP_ID,
    tabId: 42,
    expectedRevision: "attempt",
    snapshot,
  }), false);
  assert.equal(session.tabs["42"].ownershipRevision, "successor");
});

test("SessionStore denies reads and mutations when persisted ordinary-group state is malformed", async () => {
  let writes = 0;
  const SessionStore = makeSandbox({
    storage: {
      local: {
        get: () => Promise.resolve({
          sessionState: {
            schemaVersion: 2,
            groups: {
              "extension:default": {
                id: "extension:default",
                kind: "extension",
                tabs: { "8": { tabId: 8 } },
              },
              "other": {
                id: "other",
                kind: "extension",
                tabs: { "8": { tabId: 8 } },
              },
            },
          },
        }),
        set: () => { writes += 1; return Promise.resolve(); },
      },
    },
  });
  const store = new SessionStore();
  await assert.rejects(store.getSession(), /invalid persisted ordinary-session state/i);
  await assert.rejects(store.getSessionEntries(), /invalid persisted ordinary-session state/i);
  await assert.rejects(store.ownerOfTab(8), /invalid persisted ordinary-session state/i);
  assert.equal(await store.save(), false);
  assert.equal(writes, 0);
});

test("background ordinary-session constants reserve extension:default without sharing the delegated group writer key", () => {
  assert.match(backgroundSource, /const SESSION_STATE_KEY = "actionsJsonOrdinarySessions\.v2";/);
  assert.match(backgroundSource, /const LEGACY_SESSION_STATE_KEY = "ACTIONS_JSON_OVERLAY_SESSION_STATE";/);
  assert.match(backgroundSource, /const DEFAULT_SESSION_ID = "extension:default";/);
  assert.match(backgroundSource, /createGroupStore/);
  assert.match(backgroundSource, /const delegatedGroupStore = createGroupStore/);
  assert.match(backgroundSource, /claimTabWithDurableAuthority/);
  assert.match(backgroundSource, /ensureOrdinaryAuthorityReady/);
  assert.match(backgroundSource, /agentGroupId: DEFAULT_SESSION_ID/);
  assert.match(backgroundSource, /chromeTabGroupId/);
  assert.match(backgroundSource, /agent_group_id: DEFAULT_SESSION_ID/);
  assert.match(backgroundSource, /chrome_tab_group_id/);
  assert.doesNotMatch(backgroundSource, /groupId: chromeTabGroupId/);
  assert.match(backgroundSource, /requireOrdinaryTabOwnership\(tabId, claim\.ownershipRevision \|\| null\)/);
  assert.doesNotMatch(backgroundSource, /const SESSION_STATE_KEY = "actionsJsonAgentGroups\.v2";/);
});

test("ordinary tab claim paths defer visual grouping until durable authority and metadata", () => {
  for (const [declaration, span] of [
    ["const claimAuthorizedTab = async (message) =>", 3600],
    ["const openClaimedTab = async (message = {}) =>", 4400],
  ]) {
    const start = backgroundSource.indexOf(declaration);
    assert.ok(start >= 0, `expected ${declaration}`);
    const body = backgroundSource.slice(start, start + span);
    const authority = body.indexOf("claimTabWithDurableAuthority({");
    const metadata = body.indexOf("persistMetadata:");
    const connect = body.indexOf("connect: async");
    const visualGroup = body.indexOf("ensureSessionGroup(");
    assert.ok(authority >= 0 && metadata >= 0 && connect >= 0 && visualGroup >= 0);
    assert.ok(
      authority < metadata && metadata < connect && connect < visualGroup,
      `${declaration} must place Chrome visual grouping inside the post-authority connect phase`,
    );
  }
});

test("actionable tab paths revalidate the exact lease before connect or bridge registration", () => {
  const openStart = backgroundSource.indexOf("const openClaimedTab = async (message = {}) =>");
  const openBody = backgroundSource.slice(openStart, openStart + 6200);
  const preRegisterCheck = openBody.indexOf(
    "await requireOrdinaryTabOwnership(tabId, claimedLease.ownershipRevision);",
  );
  const register = openBody.indexOf("registered = sendBridgeItem(decorated);");
  assert.ok(preRegisterCheck >= 0 && preRegisterCheck < register);

  for (const [declaration, span] of [
    ["const navigateClaimedTab = async (message = {}) =>", 4200],
    ["const reconnectClaimedTab = async (tabId, tab) =>", 1800],
  ]) {
    const start = backgroundSource.indexOf(declaration);
    assert.ok(start >= 0, `expected ${declaration}`);
    const body = backgroundSource.slice(start, start + span);
    const finalCheck = body.lastIndexOf("requireOrdinaryTabOwnership(");
    const connect = body.indexOf("connectClaimedTab(", finalCheck);
    assert.ok(finalCheck >= 0 && connect > finalCheck, `${declaration} must revalidate immediately before connect`);
  }
});

test("claimed-tab projection and activation revalidate after their last awaited lookup", () => {
  const listStart = backgroundSource.indexOf("const listClaimedTabs = async () =>");
  const listBody = backgroundSource.slice(listStart, listStart + 2600);
  const tabLookup = listBody.indexOf("const tab = await chrome.tabs.get(tabId);");
  const projectionCheck = listBody.indexOf(
    "await requireOrdinaryTabOwnership(tabId, claim.ownershipRevision || null);",
    tabLookup,
  );
  const projection = listBody.indexOf("tabs.push(serializeClaimedTab(session, tab, claim));");
  assert.ok(tabLookup >= 0 && projectionCheck > tabLookup && projection > projectionCheck);

  const activateStart = backgroundSource.indexOf("const activateClaimedTab = async (message) =>");
  const activateBody = backgroundSource.slice(activateStart, activateStart + 2400);
  const focus = activateBody.indexOf("await chrome.windows.update(");
  const activationCheck = activateBody.indexOf(
    "await requireOrdinaryTabOwnership(tabId, claim.ownershipRevision || null);",
    focus,
  );
  const activate = activateBody.indexOf("await chrome.tabs.update(tabId, { active: true });");
  assert.ok(focus >= 0 && activationCheck > focus && activate > activationCheck);
});

test("ordinary-session migration and later ordinary/delegated claims use one exclusive authority", async () => {
  const shared = sharedLocalStorage();
  const SessionStore = makeSandbox(shared.chrome);
  const ordinaryStore = new SessionStore();
  const ordinary = await ordinaryStore.getSession(DEFAULT_GROUP_ID);
  ordinary.tabs["29"] = tabLease(29);
  assert.equal(await ordinaryStore.save(), true);

  const groups = createGroupStore({
    storage: shared.groupStorage,
    approvalLookup: async (approvalId) => delegatedApproval(approvalId),
    activationIdFactory: () => "activation-a",
  });
  await groups.initialize({
    legacyState: { sessions: { "actions-json-default": structuredClone(ordinary) } },
  });
  await groups.adoptOrdinaryGroup(ordinary);
  assert.equal(await groups.ownerOfTab(29), DEFAULT_GROUP_ID);

  const website = await groups.createWebsiteGroup({
    approvalId: "approval-a",
    title: "Agent A",
    home: delegatedHome(),
  });
  assert.equal(website.id, makeWebsiteGroupId("approval-a", "activation-a"));

  const results = await Promise.allSettled([
    groups.claimTab(DEFAULT_GROUP_ID, tabLease(30)),
    groups.claimTab(website.id, tabLease(30)),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
    "one shared authority must reject one of two concurrent cross-store claims",
  );
  assert.ok([DEFAULT_GROUP_ID, website.id].includes(await groups.ownerOfTab(30)));
});
