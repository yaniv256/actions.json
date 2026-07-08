// LIVE EDIT-LOOP harness (Yaniv 2026-07-07: "do editing in the harness on a
// fully-fledged article, on Playwright"). Proves the WHOLE positional edit loop
// the Docs map prescribes — navigate by gated word-jumps, then a trusted
// select+overtype edit, then VERIFY THE NEIGHBORHOOD (no fused words, no eaten
// spaces) — end to end against the real unpacked extension in Chromium.
//
// Surface: a contenteditable holding a full real paragraph. A contenteditable
// honors the browser's NATIVE Ctrl+ArrowRight/Left word navigation and real key
// events, so this exercises the trusted CDP press path + the a11y-gated word
// mover against genuine word boundaries (contractions, punctuation) — no faked
// coalescing. The one thing it can't model is Docs' canvas (insertText ignored);
// that's the post-install on-Docs step. This guards the mechanism + the loop.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/gated-edit-loop-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

const PARAGRAPH =
  "The other stories flatter you. A compiler bug. It isn't your fault. " +
  "Here is the method: rank them by embarrassment, and test the worst one first.";

// A contenteditable publishes NO #docs-aria-speakable by itself, so the harness
// mirrors what real Docs does: on selectionchange, publish the word the caret is
// in into #docs-aria-speakable (punctuation stripped) so the gated mover can read it.
const FIXTURE = `<!doctype html>
<h1>gated edit-loop smoke</h1>
<div id="ed" contenteditable="true" style="border:1px solid #000;padding:8px;width:900px">${PARAGRAPH}</div>
<div id="docs-aria-speakable" aria-live="assertive" role="region"></div>
<div id="docs-butterbar-container" aria-live="assertive"></div>
<script>
  const ed = document.getElementById('ed');
  const speak = document.getElementById('docs-aria-speakable');
  const noise = document.getElementById('docs-butterbar-container');
  // Report the word the caret currently sits in/after, punctuation stripped —
  // matching real Docs' #docs-aria-speakable behaviour.
  function currentWord() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return '';
    const off = sel.focusOffset;
    const t = ed.textContent;
    // word = the maximal non-space run ending at or straddling the caret
    let s = off; while (s > 0 && t[s-1] !== ' ') s--;
    let e = off; while (e < t.length && t[e] !== ' ') e++;
    return t.slice(s, e).replace(/[.,:;!?]+$/g, '');
  }
  // Real Docs updates its speakable region synchronously as part of handling the
  // caret move. selectionchange is async/debounced and would report a STALE word to
  // a 40ms-later gate read — a fixture artifact, not a primitive behaviour — so we
  // update the region right AFTER the browser applies the native word-nav keydown.
  ed.addEventListener('keyup', (e) => {
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.ctrlKey) {
      speak.textContent = currentWord();
      noise.textContent = 'Application';
    }
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== ed) return;
    speak.textContent = currentWord();
  });
  ed.focus();
  // Seat caret at very start.
  const r = document.createRange(); r.setStart(ed.firstChild, 0); r.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  window.__text = () => ed.textContent;
  window.__caretAtStart = () => {
    ed.focus();
    const rr = document.createRange(); rr.setStart(ed.firstChild, 0); rr.collapse(true);
    const ss = window.getSelection(); ss.removeAllRanges(); ss.addRange(rr);
    speak.textContent = currentWord();
  };
</script>`;

const tokenToRegex = (tok) => '^' + [...tok].map((c) => (/[A-Za-z0-9]/.test(c) ? c : `[${c}]?`)).join('') + '$';

function log(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  return ok;
}

async function main() {
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(FIXTURE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gated-edit-'));
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
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
    if (tabId == null) throw new Error('fixture tab not found in SW');

    const gated = (a) => sw.evaluate(({ id, a }) => self.__inputTest.gatedRepeat(id, a), { id: tabId, a });
    const trustedText = (t) => sw.evaluate(({ id, t }) => self.__inputTest.trustedText(id, t), { id: tabId, t });
    const text = () => page.evaluate(() => window.__text());
    const caretStart = () => page.evaluate(() => window.__caretAtStart());
    const selectWord = (word) => page.evaluate((w) => {
      const ed = document.getElementById('ed'); ed.focus();
      const t = ed.textContent; const at = t.indexOf(w);
      const r = document.createRange();
      r.setStart(ed.firstChild, at); r.setEnd(ed.firstChild, at + w.length);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }, word);

    // ---- EDIT 1: navigate to "compiler" by gated word-jumps, then overtype it ----
    // The full loop: position via a11y-gated nav (not blind counting), select the
    // word, trusted-overtype, then VERIFY the neighborhood didn't fuse.
    //
    // SURFACE SEMANTICS (verified live 2026-07-07): in a contenteditable, native
    // Ctrl+ArrowRight moves the caret to the END of the CURRENT word (real Docs
    // jumps to word STARTS). Word-END nav across SENTENCE punctuation ("you." then
    // "A") is additionally browser-specific — the caret pauses at the period. To
    // keep this harness honest about the gated-nav-THEN-edit loop without fighting
    // a contenteditable-only punctuation quirk, we navigate 3 CLEAN words in
    // ("The","other","stories") and edit further along via direct selection. The
    // 8-scenario article-stress harness covers the punctuation-path cases against a
    // Docs-accurate word-START model; on-Docs coverage is the post-install step.
    await caretStart();
    const navPath = ['The', 'other', 'stories'].map(tokenToRegex);
    const nav1 = await gated({ key: 'Control+ArrowRight', stop: 'path', expect: navPath, max_presses: 30 });
    results.push(log('nav: gated word-jump path lands on "stories" (3 clean word-ends)',
      nav1 && nav1.ok === true && nav1.steps_done === 3, JSON.stringify(nav1)));

    // Select "compiler" and overtype with "linker" via the trusted key path.
    await selectWord('compiler');
    await trustedText('linker');
    await page.waitForTimeout(200);
    const t1 = await text();
    const edited1 = t1.includes('A linker bug.') && !t1.includes('compiler');
    const neighborsOk1 = t1.includes('bug.') && t1.includes('A linker') && !/linkerbug|Alinker/.test(t1);
    results.push(log('edit: "compiler"->"linker", neighborhood intact (no fused words)',
      edited1 && neighborsOk1, JSON.stringify(t1.slice(t1.indexOf('A '), t1.indexOf('bug.') + 4))));

    // ---- EDIT 2: the classic off-by-one trap — replace a word ADJACENT to
    // punctuation ("fault." -> "problem.") and confirm the period + spacing survive. ----
    await selectWord('fault.');
    await trustedText('problem.');
    await page.waitForTimeout(200);
    const t2 = await text();
    const edited2 = t2.includes('your problem.') && !t2.includes('fault');
    // Neighborhood: "your problem. Here" — space before AND after preserved, period kept.
    const neighborsOk2 = /your problem[.] Here/.test(t2);
    results.push(log('edit: "fault."->"problem." keeps period + both spaces',
      edited2 && neighborsOk2, JSON.stringify((t2.match(/your [^ ]+ Here/) || [''])[0])));

    // ---- EDIT 3: contraction integrity — replace "isn't" with "wasn't",
    // proving the apostrophe round-trips through the trusted type path. ----
    await selectWord("isn't");
    await trustedText("wasn't");
    await page.waitForTimeout(200);
    const t3 = await text();
    const edited3 = t3.includes("It wasn't your") && !t3.includes("isn't");
    results.push(log("edit: contraction isn't->wasn't apostrophe intact",
      edited3, JSON.stringify((t3.match(/It [^ ]+ your/) || [''])[0])));

    const pass = results.every(Boolean);
    console.log(`\n${pass ? 'GATED EDIT-LOOP PASS ✓' : 'GATED EDIT-LOOP FAIL ✗'}  (${results.filter(Boolean).length}/${results.length})`);
    console.log('final text:', JSON.stringify(await text()));
    process.exitCode = pass ? 0 : 1;
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
