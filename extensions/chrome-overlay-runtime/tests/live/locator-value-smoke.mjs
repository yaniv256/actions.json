// Self-driven LIVE smoke for the `locator.value` primitive (#206).
//
// Why this exists: nothing in the locator vocabulary could read a form control's
// LIVE `.value` property. `locator.text_content` returns textContent||aria-label,
// and an <input> has neither. Every `text_contains` filter reads
// getAttribute("value") — the ATTRIBUTE — which React and friends never write;
// they set the property. `a11y.query` reports the accessible value but reads
// Chrome's a11y tree, which lags the DOM and returns found:false for an input
// that is demonstrably visible.
//
// The fixture below reproduces exactly that shape: the input's value exists ONLY
// on the property. `value` attribute absent. If locator.value read the attribute
// (the old, wrong way) it would return null and this test would fail.
//
// Both directions, or it is not a check:
//   <input> with a property-only value -> { value: "<typed>", settable: true }
//   <a> with no value at all           -> { value: null,      settable: false }
//
// Drives the real dispatch: chrome.tabs.sendMessage -> content.js onMessage ->
// executeAction. That is the same path the bridge uses, so a green here is a
// green for workflow steps and direct calls alike. No bridge, no human install.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/locator-value-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

const PROPERTY_ONLY_VALUE = 'LIVE_PROPERTY_ONLY';

async function main() {
  const srv = http.createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    // #probe carries NO value attribute. The inline script sets the PROPERTY.
    // #anchor is the negative control: an <a> has no value at all.
    r.end(
      '<!doctype html><h1>locator.value smoke</h1>' +
        '<input id="probe" type="text">' +
        '<a id="anchor" href="#">Learn more</a>' +
        `<script>document.getElementById('probe').value = ${JSON.stringify(PROPERTY_ONLY_VALUE)};</script>`,
    );
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-value-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  const results = [];
  let pass = false;
  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#probe', { state: 'attached' });

    // The fixture's own claim, before we test the primitive. If the attribute is
    // present the fixture is wrong and every later assertion is meaningless.
    const truth = await page.evaluate(() => {
      const el = document.getElementById('probe');
      return { property: el.value, attribute: el.getAttribute('value') };
    });
    console.log('fixture truth:', JSON.stringify(truth));
    if (truth.property !== PROPERTY_ONLY_VALUE) throw new Error('fixture did not set the property');
    if (truth.attribute !== null) throw new Error('fixture leaked a value ATTRIBUTE; the test would be vacuous');

    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found in the service worker');

    // manifest.content_scripts is EMPTY — content.js is injected on demand, when a
    // tab is claimed (background.js injectContent). Without this the tab has no
    // onMessage listener and sendMessage fails with "Receiving end does not exist",
    // which reads like a broken primitive and is really an uninjected page.
    await sw.evaluate(
      (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] }),
      tabId,
    );

    // Real dispatch: SW -> content.js onMessage("actions-json:execute-action") ->
    // executeAction. Exactly the path the bridge uses, so a green here is a green
    // for workflow steps and direct MCP calls alike.
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

    const input = await call('locator.value', { locator: { selector: '#probe' } });
    const anchor = await call('locator.value', { locator: { selector: '#anchor' } });
    console.log('input :', JSON.stringify(input));
    console.log('anchor:', JSON.stringify(anchor));

    // Two envelopes: transport { ok, output } wrapping the adapter
    // { adapter, ok, primitive, value: <payload> }. Unwrap both.
    const payload = (r) => r?.output?.value ?? r?.output ?? r;
    const iv = payload(input);
    const av = payload(anchor);

    results.push(['input.value reads the LIVE property', iv?.value === PROPERTY_ONLY_VALUE]);
    results.push(['input.settable is true', iv?.settable === true]);
    results.push(['input.tag_name is input', iv?.tag_name === 'input']);
    results.push(['anchor.value is null', av?.value === null]);
    results.push(['anchor.settable is false', av?.settable === false]);
    results.push(['anchor.tag_name is a', av?.tag_name === 'a']);

    pass = results.every(([, ok]) => ok);
  } finally {
    for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(pass ? '\nlocator.value: ALL GREEN' : '\nlocator.value: FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
