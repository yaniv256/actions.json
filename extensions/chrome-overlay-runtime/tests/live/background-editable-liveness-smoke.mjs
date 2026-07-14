// LIVE matrix: every public rich-editor insertion primitive must complete in
// lifecycle states where Chrome can pause requestAnimationFrame callbacks.
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');
const CALL_TIMEOUT_MS = 2500;

const editorMarkup = '<div id="editor" contenteditable="true">BEFORE</div>';

async function main() {
  console.log('editable lifecycle matrix: starting fixture');
  const srv = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/frame') {
      response.end(`<!doctype html><title>hidden frame</title>${editorMarkup}`);
      return;
    }
    response.end('<!doctype html><title>editable lifecycle matrix</title>' +
      editorMarkup + '<iframe id="fixture-frame" src="/frame"></iframe>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const url = `${origin}/`;
  const frameUrl = `${origin}/frame`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editable-lifecycle-'));
  const profileDir = path.join(dir, 'profile');
  const extensionDir = path.join(dir, 'extension');
  fs.cpSync(EXT, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.permissions = [...new Set([...(manifest.permissions || []), 'webNavigation'])];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(extensionDir, 'test-controller.html'),
    '<!doctype html><script type="module" src="src/background.js"></script>',
  );
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run'],
  });

  let pass = false;
  try {
    const initialWorker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(initialWorker.url()).host;
    const controller = await ctx.newPage();
    controller.on('console', (message) => console.log('extension controller:', message.type(), message.text()));
    controller.on('pageerror', (error) => console.log('extension controller error:', error.message));
    controller.on('requestfailed', (request) => console.log('extension controller request failed:', request.url(), request.failure()?.errorText));
    await controller.goto(`chrome-extension://${extensionId}/test-controller.html`);
    await controller.waitForFunction(() => Boolean(window.__agentTest), null, { timeout: 15000 });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    console.log('editable lifecycle matrix: resolving fixture frames');
    const tabId = await controller.evaluate((fixtureUrl) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('chrome.tabs.query timed out')), 5000);
      chrome.tabs.query({}, (tabs) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        const tab = tabs.find((candidate) => candidate.url === fixtureUrl);
        if (!tab?.id) reject(new Error('fixture tab not found'));
        else resolve(tab.id);
      });
    }), url);
    console.log('editable lifecycle matrix: fixture tab', tabId);
    const frames = await controller.evaluate(async (fixtureTabId) => {
      if (!chrome.webNavigation?.getAllFrames) throw new Error('webNavigation.getAllFrames unavailable');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('webNavigation.getAllFrames timed out')), 5000);
        chrome.webNavigation.getAllFrames({ tabId: fixtureTabId }, (entries) => {
          clearTimeout(timer);
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(entries || []);
        });
      });
    }, tabId);
    console.log('editable lifecycle matrix: frames', JSON.stringify(frames));
    const targets = {
      tabId,
      topFrameId: frames.find((entry) => entry.url === url)?.frameId ?? 0,
      childFrameId: frames.find((entry) => entry.url.endsWith('/frame'))?.frameId,
    };
    if (!Number.isInteger(targets.childFrameId)) throw new Error('fixture child frame not found');
    for (const frameId of [targets.topFrameId, targets.childFrameId]) {
      const outcome = await Promise.race([
        controller.evaluate(async ({ tabId: targetTabId, frameId: targetFrameId }) => {
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId, frameIds: [targetFrameId] },
            files: ['src/content.js'],
          });
          return 'injected';
        }, { tabId: targets.tabId, frameId }),
        new Promise((resolve) => setTimeout(() => resolve('setup-timeout'), 1500)),
      ]);
      console.log(`editable lifecycle matrix: frame ${frameId} ${outcome}`);
    }
    const backgroundProbe = await Promise.race([
      controller.evaluate(() => chrome.runtime.sendMessage({
        type: 'actions-json:transfer-buffer',
        primitive: 'transfer.write',
        arguments: { label: 'editable-lifecycle-probe', format: 'text/plain', value: 'probe' },
      })),
      new Promise((resolve) => setTimeout(() => resolve({ timed_out: true }), CALL_TIMEOUT_MS)),
    ]);
    console.log('editable lifecycle matrix: transfer background probe', JSON.stringify(backgroundProbe));

    const call = (state, frameId, name, args) => Promise.race([
      controller.evaluate(async ({ tabId, state, frameId, name, args }) => {
        const message = {
          type: 'actions-json:execute-action',
          call_id: `editable-lifecycle-${state}-${name}`,
          name,
          arguments: args,
        };
        return frameId === null
          ? chrome.tabs.sendMessage(tabId, message)
          : chrome.tabs.sendMessage(tabId, message, { frameId });
      }, { tabId: targets.tabId, state, frameId, name, args }),
      new Promise((resolve) => setTimeout(() => resolve({ timed_out: true }), CALL_TIMEOUT_MS)),
    ]);

    const resetAndFocus = async (frame) => frame.evaluate(() => {
      const editor = document.getElementById('editor');
      editor.textContent = 'BEFORE';
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const runInsertionSet = async ({ state, frameId, frame }) => {
      console.log(`${state}: starting insertion set`);
      const label = `editable-lifecycle-${state}`;
      const results = {};
      results.type = await call(state, frameId, 'text.type', { text: '-TYPE' });
      console.log(`${state}: text.type completed`, JSON.stringify(results.type));
      results.insert = await call(state, frameId, 'text.insert', {
        text: '-INSERT',
        mode: 'append',
        target: { selector: '#editor' },
      });
      console.log(`${state}: text.insert completed`, JSON.stringify(results.insert));
      results.write = await call(state, frameId, 'transfer.write', {
        label,
        format: 'text/plain',
        value: '-TRANSFER',
      });
      console.log(`${state}: transfer.write completed`, JSON.stringify(results.write));
      results.transfer = await call(state, frameId, 'transfer.insert', {
        label,
        mode: 'append',
        target: { selector: '#editor' },
      });
      console.log(`${state}: transfer.insert completed`, JSON.stringify(results.transfer));
      const text = await frame.evaluate(() => document.getElementById('editor').textContent);
      const completed = Object.values(results).every((result) =>
        result?.timed_out !== true && result?.ok === true && result?.output?.ok !== false);
      const inserted = ['-TYPE', '-INSERT', '-TRANSFER'].every((token) => text.includes(token));
      console.log(`${state} results:`, JSON.stringify(results));
      console.log(`${state} editor:`, JSON.stringify(text));
      return completed && inserted;
    };

    const topFrame = page.mainFrame();
    await page.bringToFront();
    await resetAndFocus(topFrame);
    const foregroundPassed = await runInsertionSet({
      state: 'foreground',
      frameId: targets.topFrameId,
      frame: topFrame,
    });

    await resetAndFocus(topFrame);
    const foreground = await ctx.newPage();
    await foreground.goto('about:blank');
    await foreground.bringToFront();
    const backgroundPassed = await runInsertionSet({
      state: 'background-tab',
      frameId: targets.topFrameId,
      frame: topFrame,
    });

    await page.bringToFront();
    const childFrame = page.frames().find((candidate) => candidate.url() === frameUrl);
    if (!childFrame) throw new Error('Playwright child frame not found');
    await resetAndFocus(childFrame);
    // Backgrounding the parent gives the child document visibilityState=hidden
    // without destroying its focused editable selection (display:none would).
    await foreground.bringToFront();
    const hiddenFramePassed = await runInsertionSet({
      state: 'hidden-frame',
      frameId: targets.childFrameId,
      frame: childFrame,
    });

    pass = foregroundPassed && backgroundPassed && hiddenFramePassed;
    console.log(pass ? 'EDITABLE LIFECYCLE MATRIX PASS ✓' : 'EDITABLE LIFECYCLE MATRIX FAIL ✗');
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
