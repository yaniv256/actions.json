// LIVE smoke: prove the accessibility-gated key-repeat primitive
// (keyboard.press_gated / dispatchGatedRepeat) navigates RELIABLY where an
// open-loop burst coalesces. Loads the real UNPACKED extension into Chromium and
// drives dispatchGatedRepeat via the self.__inputTest hook — no human install.
//
// The fixture models a COALESCING word surface, like Google Docs' canvas caret:
//  - it advances a logical "word caret" at most once per input-throttle window
//    (rapid presses within 10ms are dropped — the coalescing bug), and
//  - it publishes the CURRENT word into `#docs-aria-speakable` (the a11y region
//    readCurrentA11yValue falls back to), so the gate can confirm each landing.
//
// PATH mode with the correct expected-word regex list must land on the target
// word reliably (each gated press waits its dwell, so none coalesce); a forced
// wrong-expectation must HALT LOUD. This is the red->green the plan's U6 needs.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/gated-repeat-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

const WORDS = ['The', 'other', 'stories', 'flatter', 'you.', 'A', 'compiler', 'bug.'];

const FIXTURE = `<!doctype html>
<h1>gated repeat smoke</h1>
<input id="ed" style="width:600px" />
<div id="docs-aria-speakable" aria-live="assertive" role="region"></div>
<!-- Real Docs also fires COARSE role echoes ("Application") into OTHER assertive
     live-regions at the same time it updates the caret-word region. This node
     reproduces that interleaving so the smoke exercises the read-SOURCE bug: a
     buffer-first reader grabs "Application"; a region-first reader grabs the word. -->
<div id="docs-butterbar-container" aria-live="assertive"></div>
<div id="caret">word:0</div>
<script>
  // A coalescing word surface: Ctrl+ArrowRight advances a WORD caret at most once
  // per 10ms window (rapid presses dropped — the Docs coalescing bug). Each landing
  // publishes the current word into #docs-aria-speakable (the a11y region the gate reads),
  // AND emits a coarse "Application" role echo into another assertive region (the noise
  // the read-source fix must see through).
  const WORDS = ${JSON.stringify(WORDS)};
  const speak = document.getElementById('docs-aria-speakable');
  const noise = document.getElementById('docs-butterbar-container');
  const out = document.getElementById('caret');
  const ed = document.getElementById('ed');
  let idx = 0;         // word caret index (0 = before first word)
  let lastTs = -1000;
  function publish() {
    out.textContent = 'word:' + idx;
    speak.textContent = idx >= 1 && idx <= WORDS.length ? WORDS[idx - 1] : '';
    // Coarse role echo lands in the OTHER assertive region — after the word, so a
    // buffer-first reader that takes the last announcement would pick THIS up.
    noise.textContent = 'Application';
  }
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && e.ctrlKey) {
      e.preventDefault();
      const now = performance.now();
      if (now - lastTs >= 10) { idx = Math.min(WORDS.length, idx + 1); lastTs = now; publish(); } // spaced press lands
      // rapid press within the window: dropped (coalesced)
    }
  });
  ed.focus();
  window.__idx = () => idx;
  window.__reset = () => { idx = 0; lastTs = -1000; publish(); noise.textContent = ''; };
  publish();
</script>`;

async function main() {
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(FIXTURE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  let pass = false;
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (m) => { if (m.type() === 'error') console.log('[sw]', m.type(), m.text()); });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#ed', { state: 'attached' });
    await page.evaluate(() => document.getElementById('ed').focus());

    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found in SW');

    // (1) GREEN: move to word 3 ("stories") via PATH mode. Each gated press dwells,
    //     so all land — the gate confirms each word from #docs-aria-speakable.
    await page.evaluate(() => window.__reset());
    const green = await sw.evaluate(({ id, expect }) => self.__inputTest.gatedRepeat(id, {
      key: 'Control+ArrowRight', stop: 'path', expect, polarity: 'match', max_presses: 20,
    }), { id: tabId, expect: ['^The$', '^other$', '^stories$'] });
    await page.waitForTimeout(200);
    const idxGreen = await page.evaluate(() => window.__idx());
    console.log('PATH move 3 words:', JSON.stringify(green), '-> word caret at', idxGreen, '(expected 3)');
    const okGreen = green && green.ok === true && green.steps_done === 3 && idxGreen === 3;

    // (2) HALT: a wrong expectation at step 2 must halt loud (R5), not drift.
    await page.evaluate(() => window.__reset());
    const halt = await sw.evaluate(({ id }) => self.__inputTest.gatedRepeat(id, {
      key: 'Control+ArrowRight', stop: 'path', expect: ['^The$', '^WRONG$', '^stories$'], max_presses: 20,
    }), { id: tabId });
    console.log('PATH with wrong step 2:', JSON.stringify(halt));
    const okHalt = halt && halt.ok === false && halt.halted === true && halt.steps_done === 1 && halt.actual === 'other';

    // (3) UNTIL: press until the a11y word matches "flatter" (word 4).
    await page.evaluate(() => window.__reset());
    const until = await sw.evaluate(({ id }) => self.__inputTest.gatedRepeat(id, {
      key: 'Control+ArrowRight', stop: 'until', expect: '^flatter$', max_presses: 20,
    }), { id: tabId });
    await page.waitForTimeout(200);
    const idxUntil = await page.evaluate(() => window.__idx());
    console.log('UNTIL flatter:', JSON.stringify(until), '-> word caret at', idxUntil, '(expected 4)');
    const okUntil = until && until.ok === true && idxUntil === 4;

    pass = okGreen && okHalt && okUntil;
    console.log(pass ? 'GATED REPEAT SMOKE PASS ✓' : `GATED REPEAT SMOKE FAIL ✗ (green=${okGreen} halt=${okHalt} until=${okUntil})`);
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
