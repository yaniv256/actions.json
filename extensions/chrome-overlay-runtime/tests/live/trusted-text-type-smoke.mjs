// LIVE smoke (autonomous, 2026-07-06): proves trusted text.type emits REAL
// per-character key events that overtype a selection — the 0.1.172 fix
// (Input.dispatchKeyEvent keyDown+keyUp, not Input.insertText). Loads the
// unpacked extension in a real Chromium, serves an http contenteditable,
// selects a run, drives dispatchTrustedText via self.__inputTest, and asserts
// the selection was replaced.
//
// NOTE: a plain contenteditable honors both insertText AND key events, so this
// proves the new path types correctly and replaces a selection (regression
// guard). The canvas-Docs-specific behavior (insertText ignored, keyDown
// honored) can only be proven on a real Google Doc — that's the post-install
// step. This guards the mechanism and that the code path runs end to end.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/trusted-text-type-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

async function main() {
  const srv = http.createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end('<!doctype html><h1>trusted text.type smoke</h1>' +
      '<div id="ed" contenteditable="true" style="border:1px solid #000;padding:8px">' +
      'ALPHA REPLACE_ME OMEGA</div>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-smoke-'));
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

    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found in SW');

    // Select exactly "REPLACE_ME" in the contenteditable.
    await page.evaluate(() => {
      const ed = document.getElementById('ed');
      ed.focus();
      const text = ed.firstChild;
      const start = ed.textContent.indexOf('REPLACE_ME');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 'REPLACE_ME'.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Drive the trusted-text path: overtype the selection with real key events.
    const res = await sw.evaluate((id) => self.__inputTest.trustedText(id, 'INSERTED_OK'), tabId);
    console.log('trustedText result:', JSON.stringify(res));
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => document.getElementById('ed').textContent);
    console.log('editor after:', JSON.stringify(after));

    const replaced = after.includes('INSERTED_OK') && !after.includes('REPLACE_ME');
    const framed = after.includes('ALPHA') && after.includes('OMEGA'); // neighbors intact

    // FAILURE PATH (incident hosted-agent-docs-edit-corruption): punctuation.
    // Before the CDP_PUNCT_KEYS fix, charCodeAt fabricated colliding virtual
    // keys — "'"→VK_RIGHT (caret moved, char dropped), "."→VK_DELETE (deleted
    // forward), "!"→VK_PRIOR, "("→VK_DOWN. Typing this string then produced
    // caret jumps and forward-deletions instead of these exact characters.
    const PUNCT = `It's done. Really! (yes/no?) "quote" [a-b] {x} 50% #1 @z; ~\``;
    await page.evaluate(() => {
      const ed = document.getElementById('ed');
      ed.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false); // caret to end, no selection
      sel.addRange(range);
    });
    const res2 = await sw.evaluate(
      ({ id, text }) => self.__inputTest.trustedText(id, text),
      { id: tabId, text: ' ' + PUNCT },
    );
    console.log('punctuation trustedText result:', JSON.stringify(res2));
    await page.waitForTimeout(300);
    const after2 = await page.evaluate(() => document.getElementById('ed').textContent);
    console.log('editor after punctuation:', JSON.stringify(after2));
    const punctOk = after2.includes(PUNCT);
    // Also assert no forward-deletion happened (the "."→VK_DELETE symptom
    // would have chewed neighbors): everything from the first pass survives.
    const intactAfterPunct = after2.includes('INSERTED_OK') && after2.includes('OMEGA');
    console.log('punctuation verbatim:', punctOk, '| prior content intact:', intactAfterPunct);

    // REPEAT path (0.1.177): N trusted presses inside one debugger session.
    // Walk the caret left 10 chars with one call, then type a marker — it must
    // land 10 chars before the end, proving all 10 repeats applied.
    await page.evaluate(() => {
      const ed = document.getElementById('ed');
      ed.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
      sel.addRange(range);
    });
    // Fill a known 60-char run, caret to end, then walk LEFT 40 with repeat and
    // insert a marker. It must sit EXACTLY 40 chars from the end — the
    // coalescing bug (Docs dropped rapid repeats) landed it ~2 in. 40 is past
    // the drop threshold that 10 masked.
    const RUN = '0123456789'.repeat(6); // 60 chars
    await page.evaluate((run) => {
      const ed = document.getElementById('ed');
      ed.textContent = run; ed.focus();
      const sel = window.getSelection(); sel.removeAllRanges();
      const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false);
      sel.addRange(range);
    }, RUN);
    const t0 = Date.now();
    const resRep = await sw.evaluate(
      ({ id }) => self.__inputTest.trustedKey(id, 'ArrowLeft', [], 40),
      { id: tabId },
    );
    const repMs = Date.now() - t0;
    console.log('repeat result:', JSON.stringify(resRep), 'in', repMs, 'ms');
    await sw.evaluate(({ id }) => self.__inputTest.trustedText(id, '#'), { id: tabId });
    await page.waitForTimeout(200);
    const after3 = await page.evaluate(() => document.getElementById('ed').textContent);
    const markerPos = after3.indexOf('#');
    const fromEnd = after3.length - 1 - markerPos; // chars after the marker
    console.log('marker landed', fromEnd, 'chars from end (expected 40); text:', JSON.stringify(after3));
    const repeatOk = resRep.repeat === 40 && fromEnd === 40;
    const repeatFast = repMs < 3000;
    console.log('repeat walked exactly 40:', repeatOk, '| fast:', repeatFast);

    const resZero = await sw.evaluate(
      ({ id }) => self.__inputTest.trustedKey(id, 'ArrowLeft', [], 0),
      { id: tabId },
    );
    console.log('repeat:0 result:', JSON.stringify(resZero));
    const zeroOk = resZero.pressed === false && resZero.repeat === 0;

    pass = replaced && framed && punctOk && intactAfterPunct && repeatOk && repeatFast && zeroOk;
    console.log(pass ? 'TRUSTED TEXT SMOKE PASS ✓' : 'TRUSTED TEXT SMOKE FAIL ✗');
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
