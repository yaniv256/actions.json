// LIVE class-guard smoke: trusted MODIFIER-CHORD dispatch on Google Docs.
//
// Root cause (investigations/hosted-agent-debugger-not-attached-new-tab.md, X13,
// measured live 2026-07-07 on a real Doc, ext 0.1.182): a trusted modifier chord
// dispatched as ONE `rawKeyDown` carrying only a `modifiers` bitmask reaches Google
// Docs but does NOT trigger its shortcut/command layer — Ctrl+A / Ctrl+Home /
// Ctrl+Down AND the Shift-extend select-back all no-op, so docs.cursor_to_paragraph
// (Ctrl+Home + Ctrl+Down×N) never moves the caret and the atomic overtype never
// selects. Plain keys work. The fix (withHeldModifiers) presses each modifier as a
// GENUINELY-HELD key across the chord.
//
// This is a STANDING CLASS-GUARD, not a chord allowlist: the fixture models the real
// invariant — a command fires only when its modifier is a genuinely-held key (tracked
// from real modifier keydown/keyup), never from the DOM event's `.ctrlKey`/`.shiftKey`
// flag — and asserts the full matrix the trusted-input primitives emit. A new chord at
// any dispatch site is one line in CASES.
//
// PROVEN NEGATIVE CONTROL (red→green ritual — run once when changing the fix):
//   git checkout HEAD~1 -- extensions/chrome-overlay-runtime/src/background.js  # pre-fix
//   xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/trusted-ctrl-chord-smoke.mjs  # FAILS
//   git checkout HEAD  -- extensions/chrome-overlay-runtime/src/background.js   # fix
//   xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/trusted-ctrl-chord-smoke.mjs  # PASSES
// (`git stash` of a COMMITTED fix reports "no changes" and silently leaves the fix in —
// use the HEAD~1 checkout for a genuine RED baseline.)
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/trusted-ctrl-chord-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

const FIXTURE = `<!doctype html>
<h1>ctrl chord class-guard</h1>
<input id="ed" style="width:600px" value="hello world" />
<div id="state"></div>
<script>
  // Docs-like model: a command fires ONLY when its modifier is a genuinely-held key
  // (tracked from real Control/Shift keydown/keyup), NOT when the DOM event carries
  // only .ctrlKey/.shiftKey. This is the crux of the live bug.
  const ed = document.getElementById('ed');
  const out = document.getElementById('state');
  const flags = { selectAll:false, docHome:false, paraDown:false, selectBack:false };
  let ctrlHeld = false, shiftHeld = false;
  const render = () => { out.textContent = JSON.stringify({ ...flags, ctrlHeld, shiftHeld }); };
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Control') { ctrlHeld = true; render(); return; }
    if (e.key === 'Shift')   { shiftHeld = true; render(); return; }
    // The command layer consults ONLY the tracked held-modifier state, never e.ctrlKey/e.shiftKey.
    if ((e.key === 'a' || e.key === 'A') && ctrlHeld) { flags.selectAll = true; e.preventDefault(); }
    else if (e.key === 'Home' && ctrlHeld)            { flags.docHome  = true; e.preventDefault(); }
    else if (e.key === 'ArrowDown' && ctrlHeld)       { flags.paraDown = true; e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && shiftHeld)      { flags.selectBack = true; e.preventDefault(); } // Shift-extend
    render();
  });
  ed.addEventListener('keyup', (e) => {
    if (e.key === 'Control') { ctrlHeld = false; render(); }
    if (e.key === 'Shift')   { shiftHeld = false; render(); }
  });
  ed.focus();
  window.__flags = () => ({ ...flags });
  window.__reset = () => { for (const k in flags) flags[k] = false; ctrlHeld = false; shiftHeld = false; render(); };
  render();
</script>`;

// Data-driven matrix — add a new chord as one row. Each drives the REAL compiled
// dispatch via self.__inputTest and asserts its command flag becomes true.
const CASES = [
  { name: 'Ctrl+A (select-all)',   drive: (sw,id) => sw.evaluate(({id}) => self.__inputTest.trustedKey(id, 'a', ['control'], 1), {id}),        flag: 'selectAll' },
  { name: 'Ctrl+Home (doc-home)',  drive: (sw,id) => sw.evaluate(({id}) => self.__inputTest.trustedKey(id, 'Home', ['control'], 1), {id}),     flag: 'docHome' },
  { name: 'Ctrl+Down (para-down)', drive: (sw,id) => sw.evaluate(({id}) => self.__inputTest.trustedKey(id, 'ArrowDown', ['control'], 1), {id}), flag: 'paraDown' },
  { name: 'Shift select-back (dispatchTrustedText selected_back:3)', drive: (sw,id) => sw.evaluate(({id}) => self.__inputTest.trustedText(id, 'X', 3), {id}), flag: 'selectBack' },
];

async function main() {
  const srv = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(FIXTURE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-chord-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  let pass = true;
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

    // Matrix: each chord must fire its command (GREEN on fix, RED on pre-fix).
    for (const c of CASES) {
      await page.evaluate(() => window.__reset());
      const res = await c.drive(sw, tabId);
      await page.waitForTimeout(300);
      const got = (await page.evaluate(() => window.__flags()))[c.flag];
      const ok = got === true;
      pass = pass && ok;
      console.log(`${ok ? '✓' : '✗'} ${c.name} → ${c.flag}=${got} (expected true)`, ok ? '' : JSON.stringify(res));
    }

    // Negative discrimination: prove the fixture actually requires a HELD modifier —
    // a chord whose modifier is only a bitmask flag (no held key) must NOT fire. We
    // simulate the pre-fix shape by dispatching a bare keydown with e.ctrlKey set via
    // the page (not through the fix). If this "fires", the fixture is too weak.
    await page.evaluate(() => window.__reset());
    await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
      document.getElementById('ed').dispatchEvent(ev);
    });
    await page.waitForTimeout(100);
    const negFired = (await page.evaluate(() => window.__flags())).selectAll;
    const negOk = negFired === false;
    pass = pass && negOk;
    console.log(`${negOk ? '✓' : '✗'} negative: bitmask-only Ctrl+A did NOT fire (fixture discriminates) → selectAll=${negFired}`);

    console.log(pass ? 'CTRL CHORD CLASS-GUARD PASS ✓ (all held-modifier chords fire; bitmask-only does not)'
                     : 'CTRL CHORD CLASS-GUARD FAIL ✗');
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
