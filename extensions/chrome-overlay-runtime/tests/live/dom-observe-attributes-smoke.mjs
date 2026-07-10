// Self-driven LIVE smoke for `dom.observe.attributes` (#171).
//
// THE DEFECT. `visible` in content.js is a RENDERING predicate, not an EXISTENCE one:
// visibilityGeometryFor begins with intersectRects(rect, viewportRect()), and
// isElementVisible is Boolean(visible_rect). Anything scrolled off screen is therefore
// "invisible" — present in the DOM, addressable, and inert to dom.observe.visible.
//
// Enumerate a scrollable collection through that filter and you under-report by however
// much is scrolled away. The under-report is indistinguishable from "those elements do
// not exist," which is exactly how trello.card.checklist.read came to return [] and to
// document itself as needing an accessibility read it does not need.
//
// Measured on a live Trello card: nine checklist rows in the DOM, dom.observe.visible
// returns 1 — the single row straddling the viewport edge at top: 930.8.
//
// A NOTE ON THE FIXTURE, because a previous version of this file was WRONG. Screen-reader
// clipping (`clip: rect(1px,1px,1px,1px)`) does NOT reproduce the defect: visibilityGeometryFor
// intersects with ancestors that clip via OVERFLOW and never reads an element's own clip,
// so sr-only rows come back visible:true. This fixture keeps the 1x1 sr-only shape, because
// that is what Trello ships and it proves the aria-label read, but the thing that actually
// hides the rows is SCROLL — they sit below the fold.
//
// Both directions, or it is not a check:
//   dom.observe.visible     -> sees only the rows in the viewport   (the red)
//   dom.observe.attributes  -> sees every row, on screen or not     (the green)
//   each match reports `visible`, so on-screen and off-screen are distinguishable
//
// Drives the real dispatch: chrome.tabs.sendMessage -> content.js onMessage ->
// executeAction. Same path the bridge uses, so a green covers workflow steps and direct
// calls alike. No bridge, no human install.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/dom-observe-attributes-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

// Twelve rows, spaced far enough apart that most fall below any plausible viewport.
const ROWS = Array.from({ length: 12 }, (_, i) => ({
  name: `item ${i + 1}`,
  checked: i % 3 === 0 ? 'true' : 'false',
}));

// The 1x1 sr-only input is Trello's real shape: the row's name exists ONLY as its
// aria-label, its textContent is "". Each row is 300px tall, so rows past the first
// few are scrolled out of a normal viewport — which is what actually hides them.
const FIXTURE =
  '<!doctype html><h1 id="heading">dom.observe.attributes smoke</h1>' +
  '<style>' +
  '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(1px,1px,1px,1px);white-space:nowrap}' +
  '.row{display:block;height:300px}' +
  '</style>' +
  '<div id="rows">' +
  ROWS.map(
    (r) =>
      `<label class="row"><input class="sr-only" type="checkbox" aria-label="${r.name}" aria-checked="${r.checked}"></label>`,
  ).join('') +
  '</div>';

async function main() {
  const srv = http.createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end(FIXTURE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-observe-attributes-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  const results = [];
  let pass = false;
  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#rows input', { state: 'attached' });

    // The fixture's own claims, asserted BEFORE the primitive is tested. If every row is
    // on screen, or none of them are in the DOM, the experiment is vacuous and would pass
    // for the wrong reason. This is the instrument check that the last version of this
    // file skipped, and skipping it is how a wrong mechanism survives to be committed.
    const truth = await page.evaluate(() => {
      const els = [...document.querySelectorAll('#rows input')];
      const vh = window.innerHeight;
      const onScreen = els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < vh;
      }).length;
      const first = els[0].getBoundingClientRect();
      return { in_dom: els.length, on_screen: onScreen, first_size: [first.width, first.height] };
    });
    console.log('fixture truth:', JSON.stringify(truth));
    if (truth.in_dom !== ROWS.length) throw new Error(`fixture has ${truth.in_dom} rows in the DOM, expected ${ROWS.length}`);
    if (truth.on_screen === truth.in_dom) throw new Error('every row is on screen; the viewport defect would not reproduce');
    if (truth.on_screen === 0) throw new Error('no row is on screen; the positive control could not fire');

    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found in the service worker');

    // manifest.content_scripts is EMPTY — content.js is injected on demand when a tab is
    // claimed (background.js injectContent). Without this the tab has no onMessage listener
    // and sendMessage fails "Receiving end does not exist", which reads like a broken
    // primitive and is really an uninjected page.
    await sw.evaluate(
      (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] }),
      tabId,
    );

    const call = (name, args) =>
      sw.evaluate(
        ([id, n, a]) =>
          chrome.tabs.sendMessage(id, {
            type: 'actions-json:execute-action',
            call_id: `smoke-${n}-${Date.now()}`,
            name: n,
            arguments: a,
          }),
        [tabId, name, args],
      );

    // Two envelopes: transport { ok, output } wrapping the adapter
    // { adapter, ok, primitive, value: <payload> }. Unwrap both.
    const payload = (r) => r?.output?.value ?? r?.output ?? r;

    const SEL = '#rows input[type="checkbox"][aria-label]';

    const oldWay = payload(await call('dom.observe.visible', { selector: SEL }));
    const newWay = payload(await call('dom.observe.attributes', { selector: SEL, attributes: ['aria-label', 'aria-checked'] }));
    const heading = payload(await call('dom.observe.attributes', { selector: '#heading', attributes: ['text'] }));
    const badArgs = payload(await call('dom.observe.attributes', { selector: SEL }));

    console.log('dom.observe.visible    :', JSON.stringify({ match_count: oldWay?.match_count }));
    console.log('dom.observe.attributes :', JSON.stringify({ match_count: newWay?.match_count, visible_count: newWay?.visible_count }));
    console.log('  first match          :', JSON.stringify(newWay?.matches?.[0]));
    console.log('  last  match          :', JSON.stringify(newWay?.matches?.at(-1)));
    console.log('dom.observe.attributes (#heading):', JSON.stringify(heading?.matches?.[0]));
    console.log('dom.observe.attributes (no attrs):', JSON.stringify(badArgs?.error?.code ?? badArgs));

    const names = (newWay?.matches ?? []).map((m) => m.attributes['aria-label']);
    const checks = (newWay?.matches ?? []).map((m) => m.attributes['aria-checked']);

    // The red. dom.observe.visible sees only what is on screen — strictly fewer than exist.
    results.push(['RED: dom.observe.visible under-reports a scrolled list', oldWay?.match_count < ROWS.length]);
    // ...but it is not simply broken: it does see the rows that ARE on screen. Without this
    // control, a zero above would carry no information about the viewport at all.
    results.push(['CONTROL: dom.observe.visible still sees on-screen rows', oldWay?.match_count === truth.on_screen && oldWay?.match_count > 0]);

    // The green.
    results.push([`GREEN: dom.observe.attributes enumerates all ${ROWS.length} rows`, newWay?.match_count === ROWS.length]);
    results.push(['names read from aria-label, in document order', JSON.stringify(names) === JSON.stringify(ROWS.map((r) => r.name))]);
    results.push(['checked state read from aria-checked', JSON.stringify(checks) === JSON.stringify(ROWS.map((r) => r.checked))]);

    // It reports visibility rather than deciding for you: on-screen and off-screen are
    // distinguishable, and the two counts reconcile with the old primitive exactly.
    results.push(['visible_count agrees with dom.observe.visible', newWay?.visible_count === oldWay?.match_count]);
    results.push(['off-screen rows report visible:false', (newWay?.matches ?? []).some((m) => m.visible === false)]);
    results.push(['on-screen rows report visible:true', (newWay?.matches ?? []).some((m) => m.visible === true)]);

    results.push(['"text" pseudo-attribute yields textContent', heading?.matches?.[0]?.attributes?.text === 'dom.observe.attributes smoke']);
    results.push(['omitting attributes is a loud error, not an empty pass', badArgs?.error?.code === 'invalid_arguments']);

    pass = results.every(([, ok]) => ok);
  } finally {
    for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(pass ? '\ndom.observe.attributes: ALL GREEN' : '\ndom.observe.attributes: FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
