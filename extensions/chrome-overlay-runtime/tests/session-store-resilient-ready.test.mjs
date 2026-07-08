import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Behavioral regression guard for investigations/bridge-504-timeouts.md.
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
  // (docs/plans/2026-07-07-001) — extract them too, or the class's load()/save()
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
    const DEFAULT_SESSION_ID = "default";
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
  const ctx = { chrome: chromeMock, setTimeout, clearTimeout, Promise, Error, Object, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(extractSessionStoreModule(backgroundSource), ctx);
  return ctx.__SessionStore;
}

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
          return Promise.resolve({ sessionState: { sessions: { default: { tabs: { 42: {} }, activeTabId: 42 } } } });
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
  assert.equal(second[0][0], "default");
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
        get: () => Promise.resolve({ sessionState: { sessions: { default: { tabs: {}, activeTabId: 7 } } } }),
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

// ── U1: boundedStorage access helper (docs/plans/2026-07-07-001) ──────────────
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
