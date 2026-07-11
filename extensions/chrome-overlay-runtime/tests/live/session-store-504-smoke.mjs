// Self-driven LIVE smoke for the bridge-504 fix
// (investigations/bridge-504-timeouts.md).
//
// ROOT CAUSE: SessionStore.ready was a one-shot promise; under MV3 the background
// service worker is re-instantiated constantly, and if its chrome.storage.local.get
// init never settles, every session read (getSessionEntries/getSession) awaits it
// FOREVER. Every browser.claimed_tabs.* handler awaits it, so all tab-lifecycle
// calls 504 while non-store handlers keep working.
//
// This harness proves the fix in a REAL MV3 service worker (the seam node-ESM unit
// tests structurally cannot exercise — cf. the a11y-release-thrash lesson): it
// wedges chrome.storage.local.get INSIDE the live worker, then asserts a fresh
// SessionStore read AND the real listClaimedTabs() both DEGRADE (resolve) instead
// of hanging — with a race guard so a regression FAILS instead of hanging the run.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/session-store-504-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

// Run a SW-side async op with a hard ceiling: if it doesn't settle, the harness
// reports HANG (a regression) rather than blocking forever.
async function raced(sw, label, fnBody, arg, ms = 8000) {
  const started = Date.now();
  const result = await Promise.race([
    sw.evaluate(fnBody, arg).then((v) => ({ settled: true, value: v })),
    new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
  ]);
  return { ...result, label, ms_elapsed: Date.now() - started };
}

async function main() {
  // background.js statically imports the a11y bundle at load; without it the SW
  // fails to evaluate and NO hooks (including ours) get defined. Build it first,
  // exactly as the a11y-live smoke does.
  execFileSync('node', [path.join(EXT, 'esbuild.a11y.mjs')], { stdio: 'inherit' });

  const srv = http.createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end('<!doctype html><h1>session-store 504 smoke</h1><div id="x">ready</div>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss504-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  let pass = false;
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#x', { state: 'attached' });

    // Sanity: hook present. The SW may still be evaluating background.js just
    // after launch — poll briefly before giving up.
    let hooked = false;
    for (let i = 0; i < 40 && !hooked; i += 1) {
      hooked = await sw.evaluate(() => Boolean(self && self.__sessionStoreTest));
      if (!hooked) await page.waitForTimeout(250);
    }
    if (!hooked) {
      const probe = await sw.evaluate(() => ({
        inputTest: Boolean(self.__inputTest),
        a11yTest: Boolean(self.__a11yTest),
        ssTest: Boolean(self.__sessionStoreTest),
      }));
      throw new Error('self.__sessionStoreTest hook missing; probe=' + JSON.stringify(probe));
    }

    // Wedge chrome.storage.local.get INSIDE the live worker (the MV3 condition).
    await sw.evaluate(() => { self.__ss504restore = self.__sessionStoreTest.wedgeStorageGet(); });

    // (A) A fresh SessionStore whose first load hits the wedge must DEGRADE, not hang.
    const a = await raced(sw, 'freshStoreEntries (wedged)',
      () => self.__sessionStoreTest.freshStoreEntries());
    console.log('[A]', JSON.stringify(a));

    // (B) The REAL listClaimedTabs() (what browser.claimed_tabs.list calls) must
    //     also resolve while storage is wedged — this is the exact 504 path.
    const b = await raced(sw, 'listClaimedTabs (wedged)',
      () => self.__sessionStoreTest.listClaimedTabs());
    console.log('[B]', JSON.stringify(b));

    // Unwedge and confirm normal operation still works.
    await sw.evaluate(() => { if (self.__ss504restore) self.__ss504restore(); });
    const c = await raced(sw, 'listClaimedTabs (restored)',
      () => self.__sessionStoreTest.listClaimedTabs());
    console.log('[C]', JSON.stringify(c));

    const aOk = a.settled && Array.isArray(a.value);              // degraded, didn't hang
    const bOk = b.settled && b.value && b.value.ok === true
      && b.value.scope === 'extension_instance'
      && b.value.complete_within_scope === true;                  // real handler resolved and labeled its boundary
    const cOk = c.settled && c.value && c.value.ok === true
      && c.value.scope === 'extension_instance'
      && c.value.inventory_source === 'extension_session_store'; // normal path preserves the same scope contract
    pass = aOk && bOk && cOk;
    console.log('freshStore degraded:', aOk, '| listClaimedTabs(wedged) resolved:', bOk, '| restored:', cOk);
    console.log(pass ? 'SESSION-STORE 504 LIVE SMOKE PASS ✓' : 'SESSION-STORE 504 LIVE SMOKE FAIL ✗');
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
