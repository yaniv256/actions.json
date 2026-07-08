---
title: "SessionStore one-shot readiness promise wedges bridge tab-lifecycle calls into 504s"
date: 2026-07-07
category: runtime-errors
module: chrome-overlay-runtime
problem_type: runtime_error
component: background_job
symptoms:
  - "browser.claimed_tabs.list and browser.claimed_tabs.activate return HTTP 504 \"action timed out\""
  - "browser.screenshot, page.fetch, runtime.session.log, and the actions-json://bridge/runtimes resource all keep working normally"
  - "All tab-lifecycle bridge calls hang forever while non-SessionStore handlers stay responsive"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components: [tooling, development_workflow]
tags: [mv3, service-worker, chrome-storage, session-store, promise-wedge, timeout, bridge-504, self-healing]
---

# SessionStore one-shot readiness promise wedges bridge tab-lifecycle calls into 504s

> Component note: there is no Chrome-extension / MV3-service-worker enum for `component`; `background_job` is the least-wrong match (the defect lives in the MV3 background service worker's session-lifecycle code). `root_cause: async_timing` is the closest enum for a one-shot never-settling await (there is no dedicated "unsettled-promise" value).

## Problem

`browser.claimed_tabs.list` and `browser.claimed_tabs.activate` return 504 "action timed out" — permanently, within a single session — while `browser.screenshot`, `page.fetch`, and `runtime.session.log` on the same bridge in the same window keep succeeding. Tab-lifecycle control is dead; content and observation paths are fine.

## Symptoms

Every tab-lifecycle call comes back with the same shape:

```json
{ "ok": false, "status": 504, "error": "action timed out", "pending_cleanup": "scheduled" }
```

The discriminating fact is the *split*, not the 504 itself. At the exact same moment one call 504s, a sibling call succeeds:

| Call | Path | Result |
|---|---|---|
| `page.fetch` (73KB doc) | content | OK |
| `runtime.session.log`, `runtime.agent.user_message` | runtime | OK |
| `browser.screenshot` (`transport: background_capture`) | background capture | OK |
| `actions-json://bridge/runtimes` resource | Rust bridge, no extension store | OK instantly |
| `browser.claimed_tabs.list` | background, session-store | **504** |
| `browser.claimed_tabs.activate` | background, session-store | **504** |

So it is not a whole-bridge outage (content works), not a dead service worker (a `background_capture` screenshot works), and not a bridge-native enumeration problem (the Rust `bridge/runtimes` resource lists all four runtimes instantly). It is specifically the handlers that touch the extension's `SessionStore`, and only those, that hang. That precise split is the fingerprint of the root cause.

## What Didn't Work

This investigation is a worked example of the maximum-pain principle — that the most operationally embarrassing explanation is usually the true one, and the mind keeps reaching past it. Four dead ends, honestly:

**1. Blaming a `chrome.debugger` "Debugger is not attached" error — a red herring.** The 504 surfaced while I was already chasing a *separate* docs-edit failure, and I first pinned the tab problems on a `chrome.debugger` detach error I was seeing nearby. It was unrelated: the debugger error belonged to the other investigation entirely. What corrected it: forcing the *discriminating* experiment (X1 — does a content call succeed while a lifecycle call 504s?) instead of pattern-matching on whatever error text was scrolling by. Once `page.fetch` returned OK against a 504 list, the debugger error was visibly off the causal path.

**2. Declaring "root cause" on passive reasoning — twice — before running any experiment.** I read the logs and read the source and reached a satisfying "this must be it" conclusion two separate times without touching a live call. Both times the conviction was premature. What corrected it: the discipline that a conclusion reached by reading is a hypothesis, not a finding. X1/X2/X3 were prediction-first live experiments (predict both-fail vs one-fails, then run), and only the experiments moved a hypothesis to CONFIRMED. Reading told me where to look; only running told me what was true.

**3. A tidy code-story that a passing eval contradicted.** In the sibling docs-edit thread I had built a clean narrative — `text.type` selection lost across calls — that explained the failure beautifully. It was wrong: a docs eval that already *passed* exercised that exact path. What corrected it: checking the story against the case that already works. A theory that predicts failure for an operation you can watch succeed is falsified, however tidy it reads.

**4. Blaming "the environment / pre-existing" while building the live harness.** When my first Playwright live runs failed with every service-worker hook (`__a11yTest`, `__inputTest`, `__sessionStoreTest`) undefined, I called it a pre-existing SW-load failure, not my change. Then I ran `git stash` on my `background.js` edit and the a11y live smoke *passed* without my diff — so it WAS my change. The bug: I had declared `const withTimeout` at ~L166, but the module already declares `const withTimeout` at ~L1407. Two top-level `const` of the same name → `SyntaxError: Identifier 'withTimeout' has already been declared` at load → the entire service worker fails to evaluate → every hook vanishes. What corrected it: `git stash` to isolate my diff from the environment. This was itself a maximum-pain beat — I reached for "the environment is broken" before checking my own duplicate `const`, and stashing forced the embarrassing, correct answer.

The through-line: every dead end was a reach past the operational/embarrassing explanation toward a more comfortable one. Each was corrected by the same class of move — run the experiment, check the story against a case that works, stash to isolate — rather than by more reasoning.

## Solution

The fix makes `SessionStore` readiness self-healing and time-bounded, so a stalled storage access degrades to the in-memory default instead of hanging every reader forever.

**BEFORE** — a one-shot readiness promise, created once, awaited by every session read, with no timeout, retry, or re-init:

```js
class SessionStore {
  constructor() {
    this.state = { sessions: {} };
    this.ready = this.load();            // one-shot; captured once
  }
  async load() {
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);  // unbounded
    // ...hydrate this.state...
  }
  async getSessionEntries() {
    await this.ready;                    // hangs forever if load() never settles
    return Object.entries(this.state.sessions);
  }
  async getSession(sessionId = DEFAULT_SESSION_ID) {
    await this.ready;                    // same unbounded await
    // ...
  }
}
```

**AFTER** — `ensureReady()` bounds each storage access with the module `withTimeout` (3s) and re-initializes the load promise whenever a prior attempt stalled or rejected, degrading to the in-memory default; `save()` is timeout-guarded too. The critical detail: it **reuses the existing module `withTimeout`** rather than redeclaring it.

```js
const SESSION_STORE_IO_TIMEOUT_MS = 3000;

// NOTE: withTimeout(promise, ms, label) is declared once later in this module and
// reused here — Do NOT redeclare it: a second `const withTimeout` throws
// "Identifier already declared" at load and breaks the whole service worker.

class SessionStore {
  constructor() {
    this.state = { sessions: {} };
    this.readyPromise = null;
    this.loaded = false;
  }

  async load() {
    const stored = await withTimeout(
      chrome.storage.local.get(SESSION_STATE_KEY),
      SESSION_STORE_IO_TIMEOUT_MS,
      "SessionStore.load",
    );
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
      };
    }
    this.loaded = true;
  }

  async ensureReady() {
    if (this.loaded) return;
    if (!this.readyPromise) {
      this.readyPromise = this.load().catch((error) => {
        // Drop the failed promise so the NEXT ensureReady() re-attempts the load
        // instead of re-awaiting a rejected/stale one.
        this.readyPromise = null;
        throw error;
      });
    }
    try {
      await this.readyPromise;
    } catch (_error) {
      // Degrade to the in-memory default rather than propagating a hang/reject to
      // every tab-lifecycle handler. Storage may recover on a subsequent access.
    }
  }

  async save() {
    await withTimeout(
      chrome.storage.local.set({ [SESSION_STATE_KEY]: this.state }),
      SESSION_STORE_IO_TIMEOUT_MS,
      "SessionStore.save",
    ).catch(() => { /* best effort; in-memory state remains authoritative this run */ });
  }

  async getSession(sessionId = DEFAULT_SESSION_ID) {
    await this.ensureReady();
    // ...
  }

  async getSessionEntries() {
    await this.ensureReady();
    return Object.entries(this.state.sessions);
  }
}
```

Three behavioral changes carry the fix: (1) the readiness promise is no longer captured once — a rejected/timed-out load nulls `readyPromise` so the next `ensureReady()` re-attempts; (2) each storage access is bounded by `withTimeout(..., SESSION_STORE_IO_TIMEOUT_MS)` so a wedge surfaces in 3s, not never; (3) `ensureReady()` swallows the failure and returns on the in-memory default, so a stuck store degrades rather than propagating a hang to every `claimed_tabs.*` handler.

## Why This Works

**Root cause.** MV3 tears down and re-instantiates the background service worker constantly. On each re-instantiation the constructor ran `this.ready = this.load()`, and `load()` awaited a single `chrome.storage.local.get` with no timeout. If that one get never settled — a dead worker context, a zombie promise left by a torn-down worker mid-load — `this.ready` stayed pending forever. Every session read (`getSessionEntries`, `getSession`) began with `await this.ready`, and every `claimed_tabs.list` / `claimed_tabs.activate` handler calls one of those. So a single stuck init wedged the entire tab-lifecycle surface into permanent 504s, while every handler that never touches `SessionStore` — screenshot's `background_capture`, `page.fetch`, `runtime.session.log`, the bridge-native `runtimes` resource — kept working untouched. That is exactly the observed split. (A *rejected* `this.ready` would surface an error, not a hang; the hang means the promise was pending forever, which is why bounding it with a timeout is the correct lever.)

Bounding plus re-init converts a permanent hang into a fast, recoverable degradation: the get either settles within 3s or the timeout fires, the failed promise is dropped, and the handler proceeds on the in-memory default — returning in seconds instead of 504-ing forever, and self-healing on the next call once storage recovers.

**Three live experiments confirmed the mechanism** (prediction-first, run against the real bridge):

- **X1 — content vs lifecycle at the same moment.** If it were whole-bridge latency, both fail. `page.fetch` → OK, `claimed_tabs.list` → 504. Whole-bridge latency REFUTED; the failure is specific to the tab-lifecycle path.
- **X2 — `background_capture` vs `claimed_tabs` at the same moment.** If the whole service worker were dead, the screenshot (which also needs the SW) fails too. `browser.screenshot` (`transport: background_capture`) → OK, `claimed_tabs.list` → 504. Dead-SW REFUTED; the SW is alive but the store-backed handler specifically hangs.
- **X3 — bridge-native enumeration vs `claimed_tabs.list`.** The Rust `actions-json://bridge/runtimes` resource enumerates runtimes without calling the extension's `SessionStore`. It returned OK instantly (full list of four runtimes) while `claimed_tabs.list` still 504'd. Confirmed the wedge is on the `SessionStore` path — not on tab enumeration in general.

**Code proof (the red→green loop is itself the confirming experiment).** Writing the fix and reproducing red→green faithfully confirms the root cause: if bounding and re-initializing `SessionStore.ready` cures the hang, then `SessionStore.ready` *was* the hang. The node behavioral test degrades to `[]` in ~3s where the old one-shot store hung past a 4s ceiling; the Playwright live smoke, wedging `chrome.storage.local.get` inside a real MV3 service worker, settles the real `listClaimedTabs()` in 3.0s where the reverted old code hangs to the 8s ceiling. Both go RED on the old code and GREEN on the fix, so they catch the real bug rather than tautologically passing.

## Prevention

1. **Never leave an unbounded `await chrome.storage.*` — or any browser-singleton await — on a background-SW request hot path.** Wrap it in `withTimeout`. A background handler that can hang forever becomes a 504, because MV3 can restart the holder at any moment and leave a dead promise behind. (The anti-pattern search found one Medium sibling on the same class — `appendAgentMemoryEvent`'s fire-and-forget storage get/set — queued for the same treatment; it did not find a hidden field of the exact one-shot-init bug, which was unique to `SessionStore`.)

2. **A readiness promise must be self-healing, not one-shot.** `this.X = this.load()` captured once, awaited by every reader, with no re-init on failure, is fragile under any environment that can restart the holder. Re-initialize the load promise on stall/reject so a later caller retries the init instead of re-awaiting a dead promise.

3. **Every green test must have a proven negative control.** Both the node test and the live smoke were run against the *old* code and observed to hang — they provably go RED on the pre-fix body. A test that only ever went green would not prove it catches this bug.

4. **A duplicate top-level `const` silently kills the whole MV3 service worker at load.** A second `const withTimeout` throws `Identifier already declared` at module eval, so the entire SW fails to evaluate and every handler (`claimed_tabs.*`, a11y, input) breaks — invisible to a `node --check` of the fragment. The node test now asserts `withTimeout` is declared exactly once:

```js
test("background.js declares withTimeout exactly once (duplicate const kills the whole SW)", () => {
  const decls = backgroundSource.match(/^const withTimeout = /gm) || [];
  assert.equal(decls.length, 1, `expected exactly one 'const withTimeout' declaration, found ${decls.length}`);
});
```

5. **Reusable live-harness pattern: wedge a browser singleton inside the real SW via a guarded `self.__XTest` hook, then assert graceful degradation — with a negative control that provably hangs.** Node-ESM unit tests structurally cannot reach the MV3 integration seam; the live smoke loads the unpacked extension, wedges `chrome.storage.local.get` inside the live worker, and asserts the real handler still resolves. The `raced()` guard reports a HANG as a failure instead of blocking the run:

```js
async function raced(sw, label, fnBody, arg, ms = 8000) {
  const started = Date.now();
  const result = await Promise.race([
    sw.evaluate(fnBody, arg).then((v) => ({ settled: true, value: v })),
    new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
  ]);
  return { ...result, label, ms_elapsed: Date.now() - started };
}

// (B) The REAL listClaimedTabs() (what browser.claimed_tabs.list calls) must
//     resolve while storage is wedged — this is the exact 504 path.
const bOk = b.settled && b.value && b.value.ok === true;
```

The node behavioral assertion for the degradation itself:

```js
test("getSessionEntries resolves (does not hang) when storage.local.get never settles", async () => {
  // storage.local.get: () => new Promise(() => {})  — the wedge
  const entries = await Promise.race([
    store.getSessionEntries(),
    new Promise((_r, reject) => setTimeout(() => reject(new Error("HANG: getSessionEntries never resolved")), 8000)),
  ]);
  assert.deepEqual(entries, [], "should degrade to the empty in-memory default, not hang");
});
```

Negative control for the live smoke: with the hook kept but `SessionStore` reverted to the old one-shot `this.ready`, probe [A] returns `settled:false`, hung to the 8s ceiling — FAIL. That is what makes the harness trustworthy rather than decorative.

## Related Issues

- **Source investigation (same incident):** `investigations/bridge-504-timeouts.md` — the full hypothesis-driven investigation this doc distills (experiments X1–X6, red/green negative controls, three-level blame, and the Phase-9/10 remediation plan). This doc is its solutions-writeup, not a separate finding.
- **Blocked-by / co-occurring:** `investigations/hosted-agent-debugger-not-attached-new-tab.md` — a separate investigation (background-tab dropped trusted input) that was *paused* because this 504 wedge blocked its decisive foreground experiment. Resolving this unblocks it.
- **Methodology sibling:** `docs/solutions/architecture-patterns/live-harness-past-the-serializing-tool.md` — the "load the real bundled module under Playwright + negative-control every green live harness" discipline the session-store live smoke applies (sibling of `a11y-live-smoke.mjs`, `trusted-text-type-smoke.mjs`, `send-serialization-smoke.mjs`).
- **Anti-pattern family** (shared-state torn down + rebuilt / the holder can restart): runtime-route-registration-invariant (bridge socket churn), direct-bridge-lifecycle-routing, dual-browser-routing-hazard, cwd-resets-on-session-restart.
- **Remediation follow-up:** `appendAgentMemoryEvent` (`background.js:2140`) — the one Medium sibling of the unbounded-storage-await class, queued to receive the same `withTimeout` treatment.
- GitHub issues: checked (`gh issue list`, several searches) — the repo has no issue-tracker content; none to link.
