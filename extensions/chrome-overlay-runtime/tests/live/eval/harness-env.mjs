// EVAL-U2 + U7 (self-contained Playwright, portable auth): stand up the eval environment
// with NO private tooling, so any actions.json.dev developer can run it. Mirrors
// tests/live/a11y-live-smoke.mjs: launch Chromium with the UNPACKED extension via
// --load-extension (works in Playwright's unbranded Chromium — the flag removal was
// branded-Chrome-only), grab the MV3 service worker, claim the Doc tab via the inert
// self.__claimTest hook.
//
// AUTH is a portable, developer-supplied SECRET: a gitignored cookies file each developer
// populates their own way (e.g. from their own logged-in Chrome via
// scripts/extract-google-cookies.mjs). We inject those cookies with Playwright addCookies
// into a throwaway profile — no persistent-profile juggling, nothing account-specific in
// the repo. Default path is gitignored; override with EVAL_COOKIES_FILE.
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(HERE, '../../..'); // extensions/chrome-overlay-runtime
export const DEFAULT_BRIDGE_URL = process.env.EVAL_BRIDGE_URL || 'ws://127.0.0.1:17345/extension';
export const DEFAULT_COOKIES_FILE = process.env.EVAL_COOKIES_FILE || path.join(HERE, 'eval-secrets.cookies.json');

// Two auth modes, BOTH shipped in the repo — only the endpoint/cookies are the secret:
//   MODE A (reliable, primary): connect to YOUR OWN already-logged-in Chrome over CDP,
//     reachable via a tunnel. Set EVAL_CDP_ENDPOINT (a gitignored config/secret) to its
//     CDP url (e.g. ws://<host>:9223/... or http://<host>:9223). Sidesteps Google's
//     cookie-transplant flakiness entirely — it's a genuinely authed browser. The
//     extension must be loaded in that Chrome (the developer's one-time setup).
//   MODE B (self-contained fallback): Playwright launches a fresh Chromium with the
//     unpacked extension and injects cookies from the gitignored secret file. Portable
//     but subject to Google's account-chooser flakiness.
export const EVAL_CDP_ENDPOINT = process.env.EVAL_CDP_ENDPOINT || null;

export class ProfileNotAuthenticatedError extends Error {
  constructor(url) {
    super(`not authenticated — the Doc opened a Google sign-in wall (${url}). The cookies in ` +
      `${DEFAULT_COOKIES_FILE} are missing/expired. Repopulate them (e.g. run ` +
      `scripts/extract-google-cookies.mjs against your logged-in Chrome). See README.md.`);
    this.name = 'ProfileNotAuthenticatedError';
  }
}
export class MissingCookiesError extends Error {
  constructor(file) {
    super(`no Google cookies secret at ${file}. Create it (gitignored) with YOUR auth cookies — ` +
      `e.g. node extensions/chrome-overlay-runtime/scripts/extract-google-cookies.mjs. See README.md.`);
    this.name = 'MissingCookiesError';
  }
}

// Load the developer-supplied cookies. Accepts a raw Playwright cookies array or
// { cookies: [...] }. Missing file throws (a run must not silently proceed unauthed and
// score a sign-in page). Normalizes to Playwright's addCookies shape.
export function loadEvalCookies(file = DEFAULT_COOKIES_FILE) {
  if (!fs.existsSync(file)) throw new MissingCookiesError(file);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = Array.isArray(parsed) ? parsed : parsed.cookies;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${file}: expected a non-empty cookies array or { cookies: [...] }`);
  return raw.map((c) => ({
    name: c.name, value: c.value,
    domain: c.domain || '.google.com',
    path: c.path || '/',
    httpOnly: !!c.httpOnly, secure: c.secure !== false,
    sameSite: c.sameSite || 'Lax',
    ...(c.expires ? { expires: c.expires } : {}),
  }));
}

/**
 * Stand up the eval env. Auto-selects the mode: if EVAL_CDP_ENDPOINT is set, connect to
 * your own already-authed Chrome over CDP (reliable); otherwise launch a fresh Chromium
 * and inject cookies (self-contained fallback). Both open a Doc, CLAIM it via the inert
 * __claimTest hook, and return the same helper surface the runner drives.
 * Mode selection:
 *   1. EVAL_CDP_ENDPOINT set → connect to that already-authed Chrome (extension already loaded).
 *   2. DEPLOY_CHROME + DEPLOY_USER_DATA set → DEPLOY the repo's extension into a Chrome first
 *      (tools/deploy), then connect to the endpoint it returns. This is the primary path:
 *      the repo takes its own new build, loads it into a real logged-in Chrome, and drives it.
 *   3. else → self-contained cookie/Playwright fallback.
 * @param {object} opts - { docUrl?, bridgeUrl?, cookiesFile?, cdpEndpoint? }
 */
export async function launchEvalEnv(opts = {}) {
  const endpoint = opts.cdpEndpoint || EVAL_CDP_ENDPOINT;
  if (endpoint) return connectAuthedChromeEnv({ ...opts, endpoint });
  if (process.env.DEPLOY_CHROME && process.env.DEPLOY_USER_DATA) return deployAndConnectEnv(opts);
  return launchCookieEnv(opts);
}

// PRIMARY: deploy the repo's extension into a real (logged-in) Chrome via the repo's own
// deployment machinery (tools/deploy), then connect to the CDP endpoint it returns. This
// is the "new build → load into Chrome → test" loop, all in-repo. The extension dir must
// be a path the deploy Chrome can read (a Windows path when Chrome is on Windows) — pass
// DEPLOY_EXT_PATH, else the local EXT_DIR.
async function deployAndConnectEnv(opts) {
  const { deployExtensionSession } = await import('../../../tools/deploy/deploy.mjs');
  const extPath = process.env.DEPLOY_EXT_PATH || EXT_DIR;
  const deployed = await deployExtensionSession(extPath);
  if (!deployed?.ok) throw new Error(`deploy failed: ${JSON.stringify(deployed)}`);
  console.log(`[eval] deployed ${deployed.name} v${deployed.version} id=${deployed.id} → ${deployed.cdpEndpoint}`);
  // The unpacked extension id is PATH-DERIVED (no manifest "key") so it VARIES per deploy —
  // thread the ACTUAL loadUnpacked id, never a hardcoded one, or the popup URL is wrong.
  const env = await connectAuthedChromeEnv({ ...opts, endpoint: deployed.cdpEndpoint, extensionId: deployed.id });
  // Fold the deploy session's teardown into the env cleanup so nothing leaks.
  const baseClose = env.close;
  env.close = async () => { await baseClose(); try { deployed.proc?.kill(); } catch {} };
  return env;
}

// MODE A: connect to a real, already-logged-in Chrome via RAW CDP over the relay.
// NOT Playwright's connectOverCDP — that is "significantly lower fidelity" over a custom
// relay (Playwright docs), asserts on relayed frames, and returns serviceWorkers():0. Raw
// CDP over the same relay works (proven: Target.*, claim). So the CDP path is pure raw CDP.
async function connectAuthedChromeEnv(opts) {
  const bridgeUrl = opts.bridgeUrl || DEFAULT_BRIDGE_URL;
  const { claimTab } = await import('../../../tools/deploy/deploy.mjs');
  const wsUrl = opts.endpoint.replace(/^http/, 'ws');
  const extId = opts.extensionId || process.env.EVAL_EXTENSION_ID;
  if (!extId) {
    throw new Error('EVAL_EXTENSION_ID is required when connecting to an existing CDP endpoint; use the id returned by deployment');
  }

  const ws = new WebSocket(wsUrl);
  let seq = 0; const pend = new Map(); const sessions = new Map();
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (x) => { let d; try { d = JSON.parse(x.toString()); } catch { return; }
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((r) => { const i = ++seq; pend.set(i, r); const o = { id: i, method, params }; if (sessionId) o.sessionId = sessionId; ws.send(JSON.stringify(o)); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cleanup = async () => { try { ws.close(); } catch {} };

  try {
    // Open (or find) the Doc via raw CDP.
    const docTarget = opts.docUrl || process.env.EVAL_DOC_URL || 'https://docs.google.com/document/create';
    let t = await cdp('Target.getTargets');
    let doc = (t.result?.targetInfos || []).find((x) => x.type === 'page' && (x.url || '').includes('docs.google.com/document/d/'));
    if (!doc) {
      await cdp('Target.createTarget', { url: docTarget });
      await sleep(4000);
      t = await cdp('Target.getTargets');
      doc = (t.result?.targetInfos || []).find((x) => x.type === 'page' && (x.url || '').includes('docs.google.com/document/d/'));
    }
    if (!doc) throw new ProfileNotAuthenticatedError(docTarget); // no doc tab → sign-in wall
    const docId = (doc.url.match(/document\/d\/([^/]+)/) || [])[1];

    // Attach to the Doc page for input/read.
    const at = await cdp('Target.attachToTarget', { targetId: doc.targetId, flatten: true });
    const sid = at.result?.sessionId;
    await cdp('Runtime.enable', {}, sid);
    const evalDoc = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid); return r.result?.result?.value; };
    if (/accounts\.google|ServiceLogin/.test(await evalDoc('location.href'))) throw new ProfileNotAuthenticatedError(await evalDoc('location.href'));

    // swEval: attach to the extension's SERVICE-WORKER target over raw CDP and evaluate
    // there — the raw-CDP equivalent of Playwright's sw.evaluate. The agent bridge
    // (makeBridgeHttpClient) drives runtime.agent.* over the bridge HTTP, but we also use
    // swEval to run code IN the SW. Attaches fresh each call so an MV3 SW that slept between
    // calls is re-woken by the attach.
    const swEval = async (fnBody, arg) => {
      const t = await cdp('Target.getTargets');
      const swTarget = (t.result?.targetInfos || []).find(
        (x) => (x.type === 'service_worker' || x.type === 'worker') && (x.url || '').includes(extId));
      if (!swTarget) throw new Error(`no service_worker target for extension ${extId} (SW dormant?)`);
      const a = await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
      const ssid = a.result?.sessionId;
      await cdp('Runtime.enable', {}, ssid);
      // Serialize the fn + arg and invoke — awaitPromise so async __agentTest.call resolves.
      const expr = `(${fnBody})(${JSON.stringify(arg)})`;
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ssid);
      if (r.result?.exceptionDetails) throw new Error('swEval: ' + (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)));
      return r.result?.result?.value;
    };

    // ROOT-CAUSE FIX (investigations/eval-extension-no-runtime-registration.md): the extension
    // defaults its bridge to DEFAULT_BRIDGE_URL (ws://…:17345/extension) at startup — NOT the
    // run-owned serve bridge (17346). So it registers no runtime on our bridge and
    // runtime.agent.await_event drains an empty queue → the agent never gets driven. Overwrite
    // chrome.storage.bridgeUrl with OUR url BEFORE claiming; the claim's connectClaimedTab reads
    // the claim's bridgeUrl and opens a socket to it, registering the runtime on 17346.
    // (connectBackgroundBridge is a module-local const, NOT on self — so we can't call it from
    // an SW eval; we drive the connect through the claim path, which does reach it.)
    const setUrl = await swEval("async (url) => { await chrome.storage.local.set({ bridgeUrl: url }); const s = await chrome.storage.local.get(['bridgeUrl']); return s.bridgeUrl; }", bridgeUrl);
    if (setUrl !== bridgeUrl) throw new Error(`failed to set extension bridgeUrl (got ${JSON.stringify(setUrl)}, want ${bridgeUrl})`);
    await sleep(500);

    // CLAIM via the raw-CDP helper (opens popup, fires authorize-tab) with the REAL ext id +
    // our bridge URL — connectClaimedTab opens/attaches the runtime to the 17346 socket.
    const claim = await claimTab(wsUrl, extId, 'docs.google.com/document/d/', { bridgeUrl });
    if (!claim?.ok) throw new Error(`claim failed: ${claim?.error || JSON.stringify(claim)}`);
    const tabId = claim.tabId;
    await sleep(2000);

    // VERIFY the runtime actually registered on OUR bridge — fail LOUDLY here instead of a
    // silent await_event timeout later (that's the exact confusion this investigation untangled).
    try {
      const httpBase = opts.endpoint.replace(/\/$/, '');
      const rt = await fetch(`${httpBase}/runtimes`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
      const count = Array.isArray(rt?.runtimes) ? rt.runtimes.length : 0;
      if (!count) console.warn(`[eval] WARNING: 0 runtimes registered on the bridge after claim — the agent will have no channel. bridge=${httpBase} rt=${JSON.stringify(rt)}`);
      else console.log(`[eval] runtime registered on bridge: count=${count}`);
    } catch { /* non-fatal probe */ }

    return {
      docUrl: doc.url, bridgeUrl, sleep, mode: 'cdp', tabId, swEval,
      // Read the doc text via /mobilebasic — a same-origin, cookie-authed HTML RENDER of
      // the doc (not a download like export?format=txt, whose target has an empty body).
      // Open it as a separate CDP page and read its innerText.
      readText: async () => {
        const et = await cdp('Target.createTarget', { url: `https://docs.google.com/document/d/${docId}/mobilebasic` });
        const etId = et.result?.targetId;
        try {
          const ea = await cdp('Target.attachToTarget', { targetId: etId, flatten: true });
          const esid = ea.result?.sessionId;
          await cdp('Runtime.enable', {}, esid);
          await sleep(1500); // let mobilebasic render
          const r = await cdp('Runtime.evaluate', { expression: '(document.querySelector(".doc-content")||document.body)?.innerText || ""', returnByValue: true }, esid);
          return r.result?.result?.value ?? '';
        } finally { try { await cdp('Target.closeTarget', { targetId: etId }); } catch {} }
      },
      // Seat caret in the canvas + dispatch a chord via CDP Input.
      pressChord: async (chord) => {
        await evalDoc(`document.querySelector('.kix-canvas-tile-content')?.click()`);
        const [mods, key] = parseChord(chord);
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mods, key, code: keyCode(key), windowsVirtualKeyCode: vk(key) }, sid);
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key, code: keyCode(key), windowsVirtualKeyCode: vk(key) }, sid);
      },
      insertText: async (text) => { await cdp('Input.insertText', { text }, sid); },
      close: cleanup,
    };
  } catch (e) { await cleanup(); throw e; }
}

function parseChord(chord) { const p = chord.split('+'); const key = p.pop(); const mods = p.reduce((m, x) => m | ({ Control: 2, Shift: 8, Alt: 1, Meta: 4 }[x] || 0), 0); return [mods, key]; }
function keyCode(key) { return key.length === 1 ? `Key${key.toUpperCase()}` : key; }
function vk(key) { return key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Backspace: 8, Delete: 46, ArrowRight: 39, ArrowLeft: 37 }[key] || 0); }

// MODE B: launch a fresh Chromium with the unpacked extension + injected cookies.
async function launchCookieEnv(opts) {
  const bridgeUrl = opts.bridgeUrl || DEFAULT_BRIDGE_URL;
  const cookies = loadEvalCookies(opts.cookiesFile || DEFAULT_COOKIES_FILE); // throws early if absent
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-profile-'));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
  });
  const cleanup = async () => { await ctx.close(); fs.rmSync(profileDir, { recursive: true, force: true }); };
  try { await ctx.addCookies(cookies); } catch (e) { await cleanup(); throw e; }
  return wireEnv({ ctx, bridgeUrl, cleanup, opts, isCdp: false });
}

// Shared: open/find a Doc, resolve its tab in the SW, claim it, return the driver helpers.
async function wireEnv({ ctx, bridgeUrl, cleanup, opts, isCdp }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // Find or open the Doc. CDP mode may already have a doc tab open; else navigate one.
    const docTarget = opts.docUrl || process.env.EVAL_DOC_URL;
    let page = ctx.pages().find((p) => (p.url() || '').includes('docs.google.com/document/d/'));
    if (!page) {
      page = ctx.pages().find((p) => !/^chrome-extension:/.test(p.url() || '')) || await ctx.newPage();
      await page.goto(docTarget || 'https://docs.google.com/document/create', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await sleep(3500);

    const landedUrl = page.url();
    if (/accounts\.google|ServiceLogin/.test(landedUrl)) throw new ProfileNotAuthenticatedError(landedUrl);
    const hasCanvas = await page.evaluate(() => !!document.querySelector('.kix-canvas-tile-content'));
    if (!hasCanvas) throw new Error(`no Docs canvas at ${landedUrl} — not on an editable Doc`);

    // CLAIM the tab via the raw-CDP helper (deploy.claimTab), NOT Playwright's sw.evaluate.
    // Playwright's connectOverCDP does not fully surface MV3 service-worker targets through
    // the pipe↔WS relay (serviceWorkers():0, and it can even assert on relayed frames), but
    // the native claim_tab helper drives raw CDP over the same relay and works — it opens the
    // extension popup page (waking+holding the SW) and fires authorize-tab from that context.
    // The extension id is the ACTUAL deployed id (path-derived, varies) — never hardcoded.
    const extId = opts.extensionId || process.env.EVAL_EXTENSION_ID;
    // sw/tabId are populated differently per path and must live in the OUTER scope so the
    // return below can reference them regardless of branch. The CDP path has no Playwright
    // service-worker handle (connectOverCDP doesn't surface MV3 SW targets through the relay),
    // so sw stays null there; the cookie/Playwright path sets both.
    let sw = null;
    let tabId = null;
    if (isCdp && opts.endpoint) {
      if (!extId) throw new Error('EVAL_EXTENSION_ID is required for CDP claim');
      const { claimTab } = await import('../../../tools/deploy/deploy.mjs');
      const wsUrl = opts.endpoint.replace(/^http/, 'ws');
      const claim = await claimTab(wsUrl, extId, 'docs.google.com/document/d/', { bridgeUrl });
      if (!claim?.ok) throw new Error(`claim failed: ${claim?.error || JSON.stringify(claim)}`);
      tabId = claim?.tabId ?? claim?.result?.tabId ?? null;
    } else {
      // Cookie/Playwright fallback path: the SW is directly reachable (no relay), use the hook.
      sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
      tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || '').includes('docs.google.com/document/d/'))?.id);
      if (tabId == null) throw new Error('Doc tab not found in the service worker');
      const claim = await sw.evaluate(async ([id, url]) => self.__claimTest.claim(id, url), [tabId, bridgeUrl]);
      if (!claim?.ok) throw new Error(`claim failed: ${claim?.error || JSON.stringify(claim)}`);
    }
    await sleep(1500);

    return {
      ctx, page, sw, tabId, docUrl: page.url(), bridgeUrl, sleep, mode: isCdp ? 'cdp' : 'cookie',
      readText: async () => {
        // Cross-origin fetch() FROM the doc page is CORS/COEP-blocked; open a SEPARATE
        // page navigated straight to the export URL (same-origin, cookie-authed).
        const id = (page.url().match(/document\/d\/([^/]+)/) || [])[1];
        const exportPage = await ctx.newPage();
        try {
          await exportPage.goto(`https://docs.google.com/document/d/${id}/export?format=txt`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          return await exportPage.evaluate(() => document.body?.innerText ?? '');
        } finally { await exportPage.close(); }
      },
      pressChord: async (chord) => {
        await page.evaluate(() => document.querySelector('.kix-canvas-tile-content')?.click());
        await page.keyboard.press(chord);
      },
      insertText: async (text) => { await page.keyboard.type(text); },
      close: cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
