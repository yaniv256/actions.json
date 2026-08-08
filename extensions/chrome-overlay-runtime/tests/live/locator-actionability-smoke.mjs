import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

async function withTimeout(promise, label, timeoutMs = 15000) {
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
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html>
      <section id="scroll" style="position:absolute;left:100px;top:100px;width:260px;height:140px;overflow:auto">
        <div id="sticky" style="position:sticky;top:0;z-index:2;height:44px;background:white">Sticky controls</div>
        <div style="height:56px"></div>
        <label id="target" style="display:block;width:32px;height:32px;background:lightgreen">Toggle</label>
        <div style="height:180px"></div>
      </section>
      <script>document.getElementById('scroll').scrollTop = 100;</script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-actionability-smoke-'));
  let context;

  try {
    console.log('[locator-actionability] launching Chromium');
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      timeout: 15000,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    });
    console.log('[locator-actionability] Chromium context ready');
    console.log('[locator-actionability] waiting for extension service worker');
    const worker = context.serviceWorkers()[0]
      || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    console.log('[locator-actionability] extension service worker ready');
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || (await context.newPage());
    console.log('[locator-actionability] navigating fixture');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#target');
    console.log('[locator-actionability] fixture ready');
    const extensionPage = await context.newPage();
    await withTimeout(
      extensionPage.goto(`chrome-extension://${extensionId}/src/options.html`),
      'extension control page navigation',
    );
    const tabId = await withTimeout(
      extensionPage.evaluate(async (pageUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === pageUrl)?.id;
      }, url),
      'fixture tab lookup',
    );
    if (tabId == null) throw new Error('fixture tab not found');
    console.log('[locator-actionability] fixture tab resolved');

    await withTimeout(
      extensionPage.evaluate(
        (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] }),
        tabId,
      ),
      'content runtime injection',
    );
    console.log('[locator-actionability] content script injected');
    const result = await withTimeout(
      extensionPage.evaluate(
        (id) => chrome.tabs.sendMessage(id, {
          type: 'actions-json:execute-action',
          call_id: `locator-actionability-${Date.now()}`,
          name: 'locator.element_info',
          arguments: { locator: { selector: '#target' } },
        }),
        tabId,
      ),
      'locator.element_info dispatch',
    );
    console.log('[locator-actionability] locator call returned');
    const value = result?.output?.value;
    if (!result?.ok || !result?.output?.ok || !value) {
      throw new Error(`locator.element_info failed: ${JSON.stringify(result)}`);
    }

    const truth = await page.evaluate(({ x, y }) => {
      const target = document.querySelector('#target');
      const hit = document.elementFromPoint(x, y);
      return {
        hit_is_target: hit === target || target.contains(hit),
        scroll_top: document.querySelector('#scroll').scrollTop,
      };
    }, value.clickable_center);
    const checks = {
      initial_occlusion_detected: value.initial_visibility?.receives_events === false,
      initial_scroll_required: value.initial_visibility?.state === 'requires_scroll',
      recovery_was_scrolled: value.scroll_operations_performed?.length > 0,
      final_receives_events: value.visibility?.receives_events === true,
      final_clickable: value.clickable === true,
      actual_hit_is_target: truth.hit_is_target === true,
      scroll_changed: truth.scroll_top < 100,
    };
    for (const [name, passed] of Object.entries(checks)) {
      console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
    }
    if (!Object.values(checks).every(Boolean)) {
      throw new Error(`actionability checks failed: ${JSON.stringify({ value, truth })}`);
    }
    console.log('\nlocator actionability: ALL GREEN');
  } finally {
    try {
      if (context) await withTimeout(context.close(), 'Chromium context close');
    } finally {
      try {
        await withTimeout(closeServer(server), 'fixture server close');
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
