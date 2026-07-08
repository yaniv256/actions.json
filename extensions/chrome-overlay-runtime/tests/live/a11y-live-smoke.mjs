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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

async function main() {
  execFileSync('node', [path.join(EXT, 'esbuild.a11y.mjs')], { stdio: 'inherit' });

  const srv = http.createServer((_q, r) => {
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
      '<div id="lr" role="status" aria-live="assertive" aria-atomic="true"></div>' +
      '<div id="docs-like"><section><div aria-live="polite"><span class="cvox">' +
      '</span></div></section></div>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  let pass = false;
  try {
    let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#lr', { state: 'attached' });

    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found in SW');
    console.log('fixture tabId:', tabId, 'url committed');

    const watch = await sw.evaluate((id) => self.__a11yTest.watch(id), tabId);
    console.log('a11y.watch:', JSON.stringify(watch));

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

    const after = await sw.evaluate((id) => self.__a11yTest.watch(id), tabId); // re-read diag
    console.log('post-mutation diag:', JSON.stringify(after));
    // Verify the 0.1.170 fix: the hosted-agent path resolves a default tab for
    // a11y.* tools. __a11yTest.watch reaches runA11yWatch with the tabId we pass;
    // the real routing gap was executeHostedToolCallInner. Assert the set + that
    // a11y.watch WITHOUT an explicit tab still resolves one (default-tab path).
    const routing = await sw.evaluate(async () => {
      const src = self.__a11yRoutingProbe ? await self.__a11yRoutingProbe() : null;
      return src;
    });
    console.log('hosted a11y routing probe:', JSON.stringify(routing));
    const store = await sw.evaluate((id) => self.__a11yTest.read(id), tabId);
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
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
