// Live route-contract smoke for the hosted-agent primitives that were once
// falsely reported as advertised without content action routes.
//
// This drives the production path end to end inside an isolated Playwright
// browser: service worker -> content.js message listener -> executeAction ->
// concrete primitive handler. A static name match alone cannot make this pass.
//
// Run: npm run test:hosted-catalog-routes-live
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');
const LIVE_VALUE = 'HOSTED_ROUTE_LIVE_VALUE';

const withTimeout = async (promise, label, timeoutMs = 15000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html>' +
        '<h1 id="heading" data-state="ready">Hosted route contract</h1>' +
        '<input id="value-probe" type="text">' +
        '<button id="focus-target" type="button">Focus target</button>' +
        `<script>document.getElementById('value-probe').value = ${JSON.stringify(LIVE_VALUE)};</script>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-catalog-routes-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  const checks = [];
  try {
    const serviceWorker =
      context.serviceWorkers()[0] ||
      (await withTimeout(
        context.waitForEvent('serviceworker', { timeout: 15000 }),
        'extension service worker startup',
      ));
    const extensionId = new URL(serviceWorker.url()).host;
    const page = context.pages()[0] || (await context.newPage());
    await withTimeout(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }),
      'fixture navigation',
    );
    await withTimeout(
      page.waitForSelector('#focus-target', { state: 'visible' }),
      'fixture readiness',
    );

    // Playwright can lose an MV3 worker evaluation when Chrome suspends the
    // worker between protocol turns. Use an extension-owned page for the same
    // privileged APIs so the caller context remains stable for the smoke.
    const extensionPage = await context.newPage();
    await withTimeout(
      extensionPage.goto(`chrome-extension://${extensionId}/src/options.html`),
      'extension control page navigation',
    );

    const tabId = await withTimeout(
      extensionPage.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === targetUrl)?.id;
      }, url),
      'fixture tab lookup',
    );
    if (tabId == null) throw new Error('fixture tab not found in the service worker');

    await withTimeout(
      extensionPage.evaluate(
        (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] }),
        tabId,
      ),
      'content runtime injection',
    );

    const call = (name, args) =>
      extensionPage.evaluate(
        ([id, actionName, actionArgs]) =>
          chrome.tabs.sendMessage(id, {
            type: 'actions-json:execute-action',
            call_id: `hosted-route-${actionName}-${Date.now()}`,
            name: actionName,
            arguments: actionArgs,
          }),
        [tabId, name, args],
      );

    const attributes = await withTimeout(
      call('dom.observe.attributes', {
        selector: '#heading',
        attributes: ['data-state', 'text'],
      }),
      'dom.observe.attributes dispatch',
    );
    const value = await withTimeout(
      call('locator.value', {
        locator: { selector: '#value-probe' },
      }),
      'locator.value dispatch',
    );
    const focus = await withTimeout(
      call('dom.focus', {
        locator: { selector: '#focus-target' },
      }),
      'dom.focus dispatch',
    );

    const payload = (result) => result?.output?.value ?? result?.output ?? result;
    const attributePayload = payload(attributes);
    const valuePayload = payload(value);
    const focusPayload = payload(focus);
    const activeId = await page.evaluate(() => document.activeElement?.id || null);

    checks.push([
      'dom.observe.attributes traverses the production route',
      attributes?.ok === true && attributes?.output?.primitive === 'dom.observe.attributes',
    ]);
    checks.push([
      'dom.observe.attributes returns the requested live attributes',
      attributePayload?.matches?.[0]?.attributes?.['data-state'] === 'ready' &&
        attributePayload?.matches?.[0]?.attributes?.text === 'Hosted route contract',
    ]);
    checks.push([
      'locator.value traverses the production route and reads the live property',
      value?.ok === true &&
        value?.output?.primitive === 'locator.value' &&
        valuePayload?.value === LIVE_VALUE,
    ]);
    checks.push([
      'dom.focus traverses the production route and focuses the target',
      focus?.ok === true &&
        focus?.output?.primitive === 'dom.focus' &&
        focusPayload?.focused === true &&
        focusPayload?.active_is_target === true &&
        activeId === 'focus-target',
    ]);

    for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    const passed = checks.every(([, ok]) => ok);
    console.log(passed ? '\nhosted catalog routes: ALL GREEN' : '\nhosted catalog routes: FAILED');
    process.exitCode = passed ? 0 : 1;
  } finally {
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
