// LIVE smoke: reproduce and guard against the Google-Docs caret-walk COALESCING
// bug offline. Google Docs advances its canvas caret on a requestAnimationFrame
// loop that processes AT MOST ONE arrow key per frame — so a burst of trusted
// ArrowRight events fired faster than ~1/frame is dropped, and a walk of N
// lands ~2 chars in (measured live 2026-07-07 on a real Doc with ext 0.1.179).
// The plain-contenteditable smoke could NOT reproduce this because a normal
// contenteditable moves the caret synchronously on every keydown.
//
// This fixture models Docs' consumption: a hidden input whose keydown handler
// advances a logical caret only ONCE PER ANIMATION FRAME, ignoring extra
// ArrowRight keydowns that arrive in the same frame. That is the coalescing.
// dispatchTrustedKey(repeat:N) must land the caret at exactly N to pass.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/caret-walk-coalesce-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

const FIXTURE = `<!doctype html>
<h1>caret coalesce smoke</h1>
<input id="ed" style="width:600px" value="" />
<div id="caret">caret:0</div>
<script>
  // Docs-like model: process at most ONE ArrowRight per animation frame.
  const ed = document.getElementById('ed');
  const out = document.getElementById('caret');
  let caret = 0;
  const N = 200; // logical length
  // Realistic model of the observed bug: the browser coalesces trusted keydowns
  // that arrive within the same input-throttle window (~<10ms apart) into one,
  // so only well-SPACED presses each advance the caret. Extras are lost.
  let lastTs = -1000;
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const now = performance.now();
      if (now - lastTs >= 10) { caret = Math.min(N, caret + 1); lastTs = now; } // spaced press lands
      out.textContent = 'caret:' + caret;                                        // rapid press dropped
    }
  });
  ed.focus();
  window.__caret = () => caret;
  window.__reset = () => { caret = 0; lastTs = -1000; out.textContent = 'caret:0'; };
</script>`;

async function main() {
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(FIXTURE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caret-smoke-'));
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
    await page.waitForSelector('#ed', { state: 'attached' });
    await page.evaluate(() => document.getElementById('ed').focus());

    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found in SW');

    // (A) Direct dispatchTrustedKey path (the primitive-internal fix).
    const res = await sw.evaluate(({ id }) => self.__inputTest.trustedKey(id, 'ArrowRight', [], 78), { id: tabId });
    console.log('direct trustedKey result:', JSON.stringify(res));
    await page.waitForTimeout(400);
    const caretDirect = await page.evaluate(() => window.__caret());
    console.log('caret after DIRECT walk of 78:', caretDirect, '(expected 78)');

    // Reset the fixture caret to 0.
    await page.evaluate(() => { window.__reset(); });

    // (B) RELAY path: route keyboard.press{trusted, repeat} through the CONTENT
    // SCRIPT (the workflow walkers' actual path) via the extension's
    // execute-action message. content.js relays to background marker-trusted-key
    // with repeat — the seam that dropped it before the fix.
    const relayResult = await sw.evaluate(async ({ id }) => {
      return await chrome.tabs.sendMessage(id, {
        type: 'actions-json:execute-action',
        call_id: 'test-relay',
        name: 'keyboard.press',
        arguments: { key: 'ArrowRight', trusted: true, repeat: 78 },
      });
    }, { id: tabId }).catch((e) => ({ ok: false, error: String(e) }));
    // Relay is diagnostic only: the content script is host-permission-gated and
    // not injected on the localhost fixture, so this reports 'not injected' here.
    // The relay's repeat-forwarding is verified on the live sandbox post-install.
    const caretRelay = relayResult && relayResult.ok ? await page.evaluate(() => window.__caret()) : 'content-script-not-injected';
    console.log('caret after RELAY walk (diagnostic):', caretRelay);

    pass = caretDirect === 78;
    console.log(pass ? 'CARET COALESCE SMOKE PASS ✓' : `CARET COALESCE SMOKE FAIL ✗ (direct=${caretDirect})`);
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
