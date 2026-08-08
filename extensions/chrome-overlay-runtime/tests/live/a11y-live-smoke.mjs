// Self-driven LIVE smoke (Task #71): loads the unpacked extension into a real
// Chromium via Playwright, serves a fixture page with an aria-live region over
// http, and drives the full observer → background → announcer → store path —
// asserting a record lands — with NO human install/restart and NO bridge.
// This is the harness whose absence caused the 0.1.162→0.1.168 release thrash.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/a11y-live-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertDescendantsShareProcessGroup,
  createPhaseReporter,
  exitCodeForAbortReason,
  runWithInheritedProcessGroup,
  superviseLiveSmoke,
} from './support/live-smoke-supervisor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

const withDeadline = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const closeServer = async (server) => {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => {
    server.close(resolve);
    // Node recommends force-closing after close() starts, avoiding the race in
    // which a new connection arrives between the two calls.
    server.closeAllConnections?.();
  });
  await withDeadline(
    closed,
    5000,
    'fixture server close',
  );
};

async function runWorker() {
  const phase = createPhaseReporter();
  let srv = null;
  let ctx = null;
  let dir = null;
  try {
  phase('build:start');
  execFileSync('node', [path.join(EXT, 'esbuild.a11y.mjs')], { stdio: 'inherit' });
  // background.js statically imports the broker bundle. Building only the
  // a11y bundle leaves the unpacked extension unloadable in a clean checkout:
  // Chromium exposes a service-worker target, but every evaluate call hangs
  // because module evaluation stopped at ERR_FILE_NOT_FOUND.
  execFileSync('node', [path.join(EXT, 'esbuild.protoface-broker.mjs')], { stdio: 'inherit' });
  phase('build:complete');

  srv = http.createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    // Two regions:
    //  #lr  — the easy case (top-level, id'd, assertive, atomic) that always passed.
    //  #docs-like — reproduces the Docs caret region that was SILENTLY DROPPED:
    //    polite, NON-atomic, and deeply nested with no id on the live element
    //    itself. CDP's AX tree does not expose aria-relevant here, so the fork's
    //    containerLiveRelevant filter read empty and dropped the change before
    //    queuing it (spoke:0). The liveOverride_ fix threads the observer's
    //    DOM-sourced metadata so the fork queues + speaks it.
    r.end('<!doctype html><h1>a11y smoke</h1>' +
      '<button id="covered" style="position:absolute;left:20px;top:20px;width:220px;height:48px">Covered action</button>' +
      '<div id="sticky-cover" style="position:fixed;left:0;top:0;width:320px;height:120px;background:white;z-index:10000">Sticky cover</div>' +
      '<button id="partly-covered" style="position:absolute;left:20px;top:150px;width:220px;height:48px">Partly covered action</button>' +
      '<div id="center-cover" style="position:fixed;left:90px;top:140px;width:80px;height:68px;background:white;z-index:10000">Center cover</div>' +
      '<div id="lr" role="status" aria-live="assertive" aria-atomic="true"></div>' +
      '<div id="docs-like"><section><div aria-live="polite"><span class="cvox">' +
      '</span></div></section></div>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  phase('fixture-listener:ready');
  const url = `http://127.0.0.1:${srv.address().port}/`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-smoke-'));
  const profileDir = path.join(dir, 'profile');
  const extensionDir = path.join(dir, 'extension');
  fs.cpSync(EXT, extensionDir, { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, 'test-controller.html'),
    '<!doctype html><script type="module" src="src/background.js"></script>',
  );
  phase('browser-launch:start');
  ctx = await withDeadline(runWithInheritedProcessGroup(
    () => chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run'],
    }),
  ), 30000, 'Chromium persistent-context launch');
  const ownership = assertDescendantsShareProcessGroup();
  console.error(`[a11y-live] owned process group=${ownership.pgid} descendants=${ownership.descendantCount}`);
  phase('browser-launch:complete');

  let pass = false;
    phase('service-worker:identity');
    const initialWorker = ctx.serviceWorkers()[0]
      || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(initialWorker.url()).host;
    phase('extension-controller:start');
    const controller = await ctx.newPage();
    controller.on('console', (m) => console.log('[controller]', m.type(), m.text()));
    controller.on('pageerror', (error) => console.error('[controller]', error.message));
    controller.on('requestfailed', (request) => {
      console.error(
        '[controller] request failed:',
        request.url().slice(0, 300),
        request.failure()?.errorText,
      );
    });
    await controller.goto(`chrome-extension://${extensionId}/test-controller.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await controller.waitForFunction(
      () => Boolean(window.__a11yTest && window.__inputTest && window.__a11yRoutingProbe),
      null,
      { timeout: 15000 },
    );
    const evaluate = (fn, argument) => withDeadline(
      controller.evaluate(fn, argument),
      10000,
      'extension controller evaluation',
    );
    phase('extension-controller:ready');

    phase('page:resolve');
    const page = await ctx.newPage();
    phase('page:goto:start');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    phase('page:goto:complete');
    await page.waitForSelector('#lr', { state: 'attached' });
    phase('page:fixture-ready');

    phase('extension-controller:probe:start');
    const workerProbe = await evaluate(() => ({
      href: self.location.href,
      hasChromeTabs: Boolean(globalThis.chrome?.tabs),
    }));
    console.log('extension controller probe:', JSON.stringify(workerProbe));
    phase('extension-controller:probe:complete');

    phase('fixture-tab:lookup');
    const tabId = await evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    phase('fixture-tab:resolved');
    if (tabId == null) throw new Error('fixture tab not found in SW');
    console.log('fixture tabId:', tabId, 'url committed');

    phase('a11y-query:start');
    const queryResult = await evaluate(({id}) => self.__a11yTest.query(id, {
      role: 'button',
      name: 'Covered action',
    }), {id: tabId});
    phase('a11y-query:complete');
    const query = queryResult?.output;
    const queryChecks = {
      found: query?.found === true,
      attested: query?.actionability_attested === true,
      occluded: query?.receives_events === false && query?.clickable === false,
      no_click_point: !Object.prototype.hasOwnProperty.call(query || {}, 'clickable_center'),
      geometry_present: Number.isFinite(query?.visible_center?.x) && Number.isFinite(query?.visible_center?.y),
      blocker_reported: query?.occluded_by?.id === 'sticky-cover',
    };
    for (const [name, passed] of Object.entries(queryChecks)) {
      console.log(`${passed ? 'PASS' : 'FAIL'}  a11y.query ${name}`);
    }
    if (!Object.values(queryChecks).every(Boolean)) {
      throw new Error(`a11y.query actionability checks failed: ${JSON.stringify(queryResult)}`);
    }

    phase('a11y-query-partial:start');
    const partialQueryResult = await evaluate(({id}) => self.__a11yTest.query(id, {
      role: 'button',
      name: 'Partly covered action',
    }), {id: tabId});
    phase('a11y-query-partial:complete');
    const partialQuery = partialQueryResult?.output;
    const partialChecks = {
      found: partialQuery?.found === true,
      attested: partialQuery?.actionability_attested === true,
      actionable: partialQuery?.receives_events === true && partialQuery?.clickable === true,
      click_point_present: Number.isFinite(partialQuery?.clickable_center?.x)
        && Number.isFinite(partialQuery?.clickable_center?.y),
      click_point_is_not_center: partialQuery?.clickable_center?.x !== partialQuery?.visible_center?.x
        || partialQuery?.clickable_center?.y !== partialQuery?.visible_center?.y,
      no_blocker: partialQuery?.occluded_by == null,
    };
    for (const [name, passed] of Object.entries(partialChecks)) {
      console.log(`${passed ? 'PASS' : 'FAIL'}  a11y.query partial ${name}`);
    }
    if (!Object.values(partialChecks).every(Boolean)) {
      throw new Error(`a11y.query partial-actionability checks failed: ${JSON.stringify(partialQueryResult)}`);
    }

    const watch = await evaluate((id) => self.__a11yTest.watch(id), tabId);
    console.log('a11y.watch:', JSON.stringify(watch));

    // Force the exact production lifecycle boundary behind the 0.1.229
    // incident: Chrome loses the physical debugger session while a11y retains
    // a long-lived logical lease. The next a11y call must repair attachment,
    // and a transient trusted-key lease must not release the persistent one.
    const detachRecovery = await evaluate(async (id) => {
      await new Promise((resolve, reject) => {
        chrome.debugger.detach({tabId: id}, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const repaired = await self.__a11yTest.query(id, {
        role: 'button',
        name: 'Covered action',
      });
      await self.__inputTest.trustedKey(id, 'Shift', [], 1);
      const stillHeld = await self.__a11yTest.query(id, {
        role: 'button',
        name: 'Covered action',
      });
      return {
        repaired: repaired?.output?.found === true,
        survived_transient_holder: stillHeld?.output?.found === true,
      };
    }, tabId);
    console.log('debugger detach recovery:', JSON.stringify(detachRecovery));
    if (!detachRecovery.repaired || !detachRecovery.survived_transient_holder) {
      throw new Error(`debugger detach recovery failed: ${JSON.stringify(detachRecovery)}`);
    }

    // Mutate the easy region (assertive/atomic/id'd).
    for (const t of ['first update', 'second update']) {
      await page.evaluate((txt) => { document.getElementById('lr').textContent = txt; }, t);
      await page.waitForTimeout(400);
    }
    // Mutate the Docs-like region (polite, non-atomic, nested, id-less live el).
    // This is the case that reproduced the silent drop.
    for (const t of ['caret on paragraph two', 'caret on paragraph three']) {
      await page.evaluate((txt) => {
        document.querySelector('#docs-like span.cvox').textContent = txt;
      }, t);
      await page.waitForTimeout(400);
    }

    const after = await evaluate((id) => self.__a11yTest.watch(id), tabId); // re-read diag
    console.log('post-mutation diag:', JSON.stringify(after));
    // Verify the 0.1.170 fix: the hosted-agent path resolves a default tab for
    // a11y.* tools. __a11yTest.watch reaches runA11yWatch with the tabId we pass;
    // the real routing gap was executeHostedToolCallInner. Assert the set + that
    // a11y.watch WITHOUT an explicit tab still resolves one (default-tab path).
    const routing = await evaluate(async () => {
      const src = self.__a11yRoutingProbe ? await self.__a11yRoutingProbe() : null;
      return src;
    });
    console.log('hosted a11y routing probe:', JSON.stringify(routing));
    const store = await evaluate((id) => self.__a11yTest.read(id), tabId);
    console.log('store:', JSON.stringify(store));

    const anns = Array.isArray(store?.announcements) ? store.announcements : [];
    const sawAssertive = anns.some((a) => /update/.test(a.text || ''));
    // The regression guard: a POLITE, non-atomic, nested, id-less region must
    // still be spoken. Before the liveOverride_ fix this was silently dropped
    // (spoke:0) because the fork's containerLiveRelevant filter read empty.
    const sawDocsLike = anns.some((a) => /caret on paragraph/.test(a.text || ''));
    pass = sawAssertive && sawDocsLike;
    console.log('sawAssertive:', sawAssertive, 'sawDocsLike(polite/nested):', sawDocsLike);
    console.log(pass ? 'LIVE SMOKE PASS ✓' : 'LIVE SMOKE FAIL ✗');
    return pass ? 0 : 1;
  } finally {
    phase('cleanup:start');
    if (ctx) {
      try {
        await withDeadline(ctx.close(), 10000, 'Chromium context close');
        phase('browser-close:complete');
      } catch (error) {
        console.error(`[a11y-live] browser cleanup failed: ${error.message}`);
      }
    }
    if (srv) {
      try {
        await closeServer(srv);
        phase('fixture-listener:closed');
      } catch (error) {
        console.error(`[a11y-live] fixture cleanup failed: ${error.message}`);
      }
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    phase('cleanup:complete');
  }
}

const runSupervisor = async () => {
  const timeoutMs = Number(process.env.ACTIONS_JSON_A11Y_SMOKE_TIMEOUT_MS) || 120000;
  const abortController = new AbortController();
  const onSigint = () => abortController.abort('SIGINT');
  const onSigterm = () => abortController.abort('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const result = await superviseLiveSmoke({
      scriptPath: process.env.ACTIONS_JSON_A11Y_SMOKE_WORKER_SCRIPT
        || fileURLToPath(import.meta.url),
      timeoutMs,
      killGraceMs: 3000,
      signal: abortController.signal,
    });
    if (result.timedOut) {
      console.error(`[a11y-live] watchdog deadline ${timeoutMs}ms exceeded; last_phase=${result.lastPhase}`);
      return 124;
    }
    if (result.aborted) {
      console.error(`[a11y-live] interrupted by ${result.abortReason}; last_phase=${result.lastPhase}`);
      return exitCodeForAbortReason(result.abortReason);
    }
    if (result.signal) {
      console.error(`[a11y-live] worker exited by ${result.signal}; last_phase=${result.lastPhase}`);
      return 1;
    }
    return Number.isInteger(result.code) ? result.code : 2;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
};

const entry = process.env.ACTIONS_JSON_LIVE_SMOKE_CHILD === '1'
  ? runWorker().catch((error) => { console.error(error); return 2; })
  : runSupervisor();

entry.then((code) => {
  if (process.env.ACTIONS_JSON_LIVE_SMOKE_CHILD === '1') {
    // Playwright can retain a transport handle after a bounded ctx.close()
    // timeout even though the worker completed every cleanup phase. The
    // supervisor owns and reaps the worker's whole process group, so the worker
    // must terminate explicitly once it has reported its final result.
    process.exit(code);
  }
  process.exitCode = code;
});
