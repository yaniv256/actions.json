import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');

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
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  try {
    const worker = context.serviceWorkers()[0]
      || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#target');
    const tabId = await worker.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === pageUrl)?.id;
    }, url);
    if (tabId == null) throw new Error('fixture tab not found');

    await worker.evaluate(
      (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['src/content.js'] }),
      tabId,
    );
    const result = await worker.evaluate(
      (id) => chrome.tabs.sendMessage(id, {
        type: 'actions-json:execute-action',
        call_id: `locator-actionability-${Date.now()}`,
        name: 'locator.element_info',
        arguments: { locator: { selector: '#target' } },
      }),
      tabId,
    );
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
    await context.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
