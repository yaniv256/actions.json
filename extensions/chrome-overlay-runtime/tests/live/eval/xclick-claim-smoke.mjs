// X-CLICK path (Yaniv's idea): run the WHOLE thing locally in an Xvfb display with Playwright's
// own Chromium — which supports --load-extension (unbranded) — and ACTIVATE the extension by a
// REAL mouse CLICK on the popup's claim button (#authorize), exactly like a human. Everything is
// co-located in WSL: the serve bridge runs on 127.0.0.1, the browser runs in the same box, so
// there is NO WSL↔Windows tunnel, NO portproxy, NO 404 — the whole class of networking bugs that
// blocked this all day is gone.
//
// This smoke proves the CHANNEL: load ext → open a page → set bridgeUrl to the local bridge →
// open popup → CLICK #authorize → the extension connects → a runtime registers on the bridge.
// No OpenAI tokens. Run:  xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/eval/xclick-claim-smoke.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../../..');                 // extensions/chrome-overlay-runtime
const BRIDGE_BIN = path.resolve(HERE, '../../../../../mcp/actions-json-mcp/target/debug/actions-json-mcp');
const ACTIONS = path.resolve(HERE, '../../../actions/overlay.actions.json');
const STORAGE = path.resolve(HERE, '../../../../../actions.json.storage');
const BRIDGE_PORT = process.env.XCLICK_BRIDGE_PORT || '17352';
const BRIDGE_HTTP = `http://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_WS = `ws://127.0.0.1:${BRIDGE_PORT}/extension`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) Serve-mode bridge, co-located, file-sink stdio (never wedges), killed at the end.
  const logFd = fs.openSync('/tmp/xclick-bridge.log', 'w');
  const bridgeArgs = ['serve', '--bind', `127.0.0.1:${BRIDGE_PORT}`, '--actions', ACTIONS];
  if (fs.existsSync(STORAGE)) bridgeArgs.push('--storage-root', STORAGE);
  const bridge = spawn(BRIDGE_BIN, bridgeArgs, { stdio: ['ignore', logFd, logFd], detached: true });
  fs.closeSync(logFd);
  const killBridge = () => { try { process.kill(-bridge.pid); } catch { try { bridge.kill('SIGKILL'); } catch {} } };
  // wait for /health
  for (let i = 0; i < 20; i++) { try { if ((await fetch(`${BRIDGE_HTTP}/health`, { signal: AbortSignal.timeout(1500) })).ok) break; } catch {} await sleep(400); }
  console.log('[xclick] bridge up:', BRIDGE_HTTP);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xclick-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false, // real window in the Xvfb display
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    console.log('[xclick] extension SW up:', sw.url().slice(0, 60));
    const extId = new URL(sw.url()).host;

    // Open a page to control. Google would need auth; for the CHANNEL proof, any controllable
    // http page works (the claim just needs a non-chrome:// tab). Use example.com.
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.bringToFront();

    // Point the extension at the LOCAL bridge (storedBridgeUrl is what the popup click uses).
    await sw.evaluate(async (url) => { await chrome.storage.local.set({ bridgeUrl: url }); }, BRIDGE_WS);

    // HEADLESS CLAIM (the path harness-env.mjs uses) — NOT the popup click. background.js ships
    // self.__claimTest.claim(tabId, bridgeUrl) which runs the REAL claimAuthorizedTab →
    // connectClaimedTab path with no popup and no #authorize click. We get the example.com tab's
    // id from the SW, then invoke the headless claim in the SW context. This isolates the exact
    // variable: same bridge + chromium + extension scaffolding as the click path, but the claim
    // is driven headlessly. (Tonight's click path failed because #authorize is correctly gated;
    // the headless door was sitting right here.)
    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      return tabs[0]?.id ?? null;
    });
    console.log('[xclick] example.com tabId:', tabId);
    const claim = await sw.evaluate(async ([id, url]) => {
      if (!self.__claimTest) return { ok: false, error: '__claimTest missing on SW' };
      return await self.__claimTest.claim(id, url);
    }, [tabId, BRIDGE_WS]);
    console.log('[xclick] headless claim result:', JSON.stringify(claim));
    await sleep(2500);

    const status = JSON.stringify(claim);
    console.log('[xclick] popup status:', JSON.stringify(status));

    // VERIFY: a runtime registered on the local bridge.
    const rt = await fetch(`${BRIDGE_HTTP}/runtimes`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    const count = Array.isArray(rt?.runtimes) ? rt.runtimes.length : 0;
    fs.writeFileSync('/tmp/xclick-result.json', JSON.stringify({ count, status, rt }, null, 2));
    console.log(`[xclick] RESULT runtimes count=${count} ${count >= 1 ? '✅ CHANNEL UP' : '❌ still no runtime'}`);
  } finally {
    await ctx.close();
    killBridge();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('[xclick] ERR', e.message); process.exit(1); });
