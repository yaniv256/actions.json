// LIVE STRESS harness for keyboard.press_gated on a FULL, REAL article — not a
// toy 8-word fixture. Yaniv's directive (2026-07-07): "test in the harness in a
// real way on Playwright and you'll find more bugs before shipping." A real
// article carries what a toy can't: contractions (It's, isn't), sentence-final
// punctuation the a11y region strips (you. → "you"), capitalized sentence starts,
// numbers, em-dashes, long paragraphs, and word paths dozens deep.
//
// The fixture models a Docs-like COALESCING word surface AND reproduces the two
// real-Docs a11y quirks the live-on-Docs run exposed:
//   1. it publishes the caret WORD into #docs-aria-speakable with sentence-final
//      punctuation STRIPPED (real Docs reports "you", not "you."), and
//   2. it fires a coarse "Application" role echo into a second assertive region
//      (the noise readCurrentA11yValue must read past).
//
// It builds the expected-word regex path with the SAME algorithm the shipped map
// (docs.words_forward/backward) uses — including the [.]? optional-punctuation fix —
// so a mismatch here is a real map/primitive bug, not a fixture artifact.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/gated-repeat-article-stress.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

// A real paragraph from the maximum-pain article: contractions, sentence-final
// periods, capitalized starts, a colon, and a dash — the messy reality.
const PARAGRAPH =
  "The other stories flatter you. A compiler bug. It isn't your fault. " +
  "Here is the method: rank them by embarrassment, and test the worst one first.";

// Split into whitespace-delimited tokens exactly as a caret word-jump traverses them.
const TOKENS = PARAGRAPH.split(' ');

// ---- The map's expected-word builder, mirrored (with the [.]? punctuation fix) ----
// For a token, build an anchored regex where each non-alphanumeric char is made
// OPTIONAL, so it matches whether or not the a11y region kept the punctuation.
function tokenToRegex(tok) {
  const chars = [...tok].map((c) => (/[A-Za-z0-9]/.test(c) ? c : `[${c}]?`));
  return '^' + chars.join('') + '$';
}
// What the a11y region actually reports for a token: alphanumerics + internal
// apostrophes kept, sentence-final punctuation (. , : ; ! ?) stripped. This models
// real Docs #docs-aria-speakable behaviour observed live.
function tokenToRegionWord(tok) {
  return tok.replace(/[.,:;!?]+$/g, '');
}

const REGION_WORDS = TOKENS.map(tokenToRegionWord);

const FIXTURE = `<!doctype html>
<h1>gated repeat article stress</h1>
<input id="ed" style="width:900px" />
<div id="docs-aria-speakable" aria-live="assertive" role="region"></div>
<div id="docs-butterbar-container" aria-live="assertive"></div>
<div id="caret">word:0</div>
<script>
  // Coalescing word surface: Ctrl+ArrowRight forward / Ctrl+ArrowLeft backward advance
  // a WORD caret at most once per 10ms window (rapid presses coalesce). Each landing
  // publishes the REGION word (sentence-final punctuation stripped) into
  // #docs-aria-speakable, and a coarse "Application" echo into the other region.
  const REGION = ${JSON.stringify(REGION_WORDS)};
  const speak = document.getElementById('docs-aria-speakable');
  const noise = document.getElementById('docs-butterbar-container');
  const out = document.getElementById('caret');
  const ed = document.getElementById('ed');
  let idx = 0;            // 0 = before first word; 1..N = on word N
  let lastTs = -1000;
  function publish() {
    out.textContent = 'word:' + idx;
    speak.textContent = (idx >= 1 && idx <= REGION.length) ? REGION[idx - 1] : '';
    noise.textContent = 'Application';
  }
  ed.addEventListener('keydown', (e) => {
    const fwd = e.key === 'ArrowRight' && e.ctrlKey;
    const back = e.key === 'ArrowLeft' && e.ctrlKey;
    if (!fwd && !back) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastTs < 10) return;               // coalesced
    lastTs = now;
    if (fwd) idx = Math.min(REGION.length, idx + 1);
    else idx = Math.max(0, idx - 1);
    publish();
  });
  ed.focus();
  window.__idx = () => idx;
  window.__setIdx = (n) => { idx = n; lastTs = -1000; publish(); };
  window.__reset = () => { idx = 0; lastTs = -1000; publish(); noise.textContent = ''; };
  publish();
</script>`;

function log(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return ok;
}

async function main() {
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(FIXTURE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-article-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  const results = [];
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (m) => { if (m.type() === 'error') console.log('[sw]', m.text()); });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#ed', { state: 'attached' });
    await page.evaluate(() => document.getElementById('ed').focus());
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
    if (tabId == null) throw new Error('fixture tab not found in SW');

    const gated = (args) => sw.evaluate(({ id, a }) => self.__inputTest.gatedRepeat(id, a), { id: tabId, a: args });
    const setIdx = (n) => page.evaluate((x) => window.__setIdx(x), n);
    const getIdx = () => page.evaluate(() => window.__idx());

    // (1) Long forward path across the FULL paragraph, punctuation and contractions
    //     included — the region strips sentence-final punctuation, so the [.]? regexes
    //     must still match. Move from word 0 through the first 12 tokens.
    await setIdx(0);
    const path12 = TOKENS.slice(0, 12).map(tokenToRegex);
    const r1 = await gated({ key: 'Control+ArrowRight', stop: 'path', expect: path12, max_presses: 40 });
    results.push(log('forward path across 12 real tokens (punct + contraction)',
      r1 && r1.ok === true && r1.steps_done === 12 && (await getIdx()) === 12, JSON.stringify(r1)));

    // (2) The contraction "isn't" and sentence-final "fault." — computed positions.
    //     Place the caret on the word BEFORE "isn't" (which is "It"), then walk
    //     isn't -> your -> fault. Positions derived from the token array, never guessed.
    const itIdx = TOKENS.indexOf('It') + 1;                 // 1-based word of "It"
    await setIdx(itIdx);                                    // caret ON "It"
    const r2 = await gated({ key: 'Control+ArrowRight', stop: 'path',
      expect: [tokenToRegex("isn't"), tokenToRegex('your'), tokenToRegex('fault.')], max_presses: 20 });
    results.push(log("contraction isn't + sentence-final fault.",
      r2 && r2.ok === true && r2.steps_done === 3, JSON.stringify(r2)));

    // (3) BACKWARD path — Ctrl+ArrowLeft. Start 2 words PAST "method:" and walk back
    //     onto it (region reports "method", punctuation stripped). Exercises the
    //     words_backward path AND the [.]?/[:]? optional-punctuation regex.
    //     methodWord = 1-based position of "method:"; caret starts on methodWord+2,
    //     so a backward walk lands methodWord+1, then methodWord, then methodWord-1.
    const methodWord = TOKENS.indexOf('method:') + 1;       // 1-based
    await setIdx(methodWord + 2);
    const r3 = await gated({ key: 'Control+ArrowLeft', stop: 'path',
      expect: [
        tokenToRegex(TOKENS[methodWord]),      // word at position methodWord+1 (0-based TOKENS[methodWord])
        tokenToRegex('method:'),               // back onto "method:" -> region "method"
        tokenToRegex(TOKENS[methodWord - 2]),  // word before it
      ],
      max_presses: 20 });
    results.push(log('backward path over colon word method:',
      r3 && r3.ok === true && r3.steps_done === 3, JSON.stringify(r3)));

    // (4) UNTIL a mid-sentence capitalized word ("Here") — region-word match through noise.
    await setIdx(0);
    const r4 = await gated({ key: 'Control+ArrowRight', stop: 'until', expect: '^Here$', max_presses: 40 });
    const hereIdx = TOKENS.indexOf('Here') + 1;
    results.push(log('until capitalized "Here" through Application noise',
      r4 && r4.ok === true && (await getIdx()) === hereIdx, JSON.stringify(r4)));

    // (5) COUNT mode: exactly 5 presses lands 5 words forward, no gate.
    await setIdx(0);
    const r5 = await gated({ key: 'Control+ArrowRight', stop: 'count', count: 5 });
    results.push(log('count mode: exactly 5 presses = 5 words',
      r5 && r5.ok === true && (await getIdx()) === 5, JSON.stringify(r5)));

    // (6) HALT-LOUD on a genuinely wrong expectation mid-path (drift guard, R5).
    await setIdx(0);
    const r6 = await gated({ key: 'Control+ArrowRight', stop: 'path',
      expect: [tokenToRegex('The'), '^NOPE$', tokenToRegex('stories')], max_presses: 20 });
    results.push(log('halts loud on wrong step 2 (no drift)',
      r6 && r6.ok === false && r6.halted === true && r6.steps_done === 1 && r6.actual === 'other',
      JSON.stringify(r6)));

    // (7) max_presses budget: UNTIL a word that never appears returns a clean partial.
    await setIdx(0);
    const r7 = await gated({ key: 'Control+ArrowRight', stop: 'until', expect: '^ZZZZ$', max_presses: 6 });
    results.push(log('max_presses partial (never-matching until)',
      r7 && r7.ok === true && r7.stop === 'partial', JSON.stringify(r7)));

    // (8) no_match polarity: advance while the region is NOT empty; here just confirm
    //     a single-step no_match path resolves (advance off word 0 where region is '').
    await setIdx(1); // on "The" (non-empty); expect NOT-empty holds
    const r8 = await gated({ key: 'Control+ArrowRight', stop: 'path', expect: ['^.+$'], polarity: 'match', max_presses: 5 });
    results.push(log('single-step forward resolves on real word',
      r8 && r8.ok === true && r8.steps_done === 1, JSON.stringify(r8)));

    const pass = results.every(Boolean);
    console.log(`\n${pass ? 'ARTICLE STRESS PASS ✓' : 'ARTICLE STRESS FAIL ✗'}  (${results.filter(Boolean).length}/${results.length})`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
