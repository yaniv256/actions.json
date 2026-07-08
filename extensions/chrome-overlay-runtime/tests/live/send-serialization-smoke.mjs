// LIVE smoke (autonomous, 2026-07-06): proves the hosted-agent send-serialization
// fix (ext 0.1.175) at the SEAM the MCP runtime.agent.user_message tool cannot
// reach. That tool awaits each response to completion before dispatching the
// next, so two "concurrent" sends never overlap inside the session — the
// createResponse() queue/interrupt branches are only entered when isBusy() is
// true, which never happens through the tool. This harness loads the UNPACKED
// extension into real Chromium, imports the REAL bundled
// HostedRealtimeSessionManager (web_accessible src/agent/*.mjs), injects a
// controllable fake transport, and fires genuinely-overlapping createResponse()
// calls so the concurrency code actually runs.
//
// Asserts, against the shipped artifact:
//   A) queue     — a second send while a response is active waits for that
//                  response.done before its own response.create is emitted.
//   B) interrupt — a second send in interrupt mode emits response.cancel and
//                  then sends immediately (does not wait for the long response).
//   C) discard   — a tool result whose originating response was cancelled is
//                  dropped (_shouldDiscardToolResult true for the cancelled id).
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/send-serialization-smoke.mjs
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
    r.end('<!doctype html><h1>send-serialization smoke</h1>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendser-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  let pass = false;
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));
    // The web_accessible module import must run from the extension origin, so
    // navigate the page to a chrome-extension:// URL rather than the http fixture.
    const extId = new URL(sw.url()).host;
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`chrome-extension://${extId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // Drive the real manager in-page with a controllable fake transport.
    const result = await page.evaluate(async (id) => {
      const mod = await import(
        `chrome-extension://${id}/src/agent/realtime-session-manager.mjs`
      );
      const { HostedRealtimeSessionManager } = mod;
      if (!HostedRealtimeSessionManager) {
        return { ok: false, error: 'named export missing' };
      }

      // Fake transport: records every outbound event; does NOT auto-complete a
      // response — the test opens/closes the in-flight window explicitly by
      // feeding response.created / response.done through handleRealtimeEvent.
      const sent = [];
      const transport = {
        sendEvent(event) { sent.push(event); return Promise.resolve(); },
        close() { return Promise.resolve(); },
        setInputMuted() {}, setOutputMuted() {},
      };
      const transportFactory = { create: () => transport };
      const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };

      const mgr = new HostedRealtimeSessionManager({
        storage,
        transportFactory,
        developerTextResponseTimeoutMs: 4000,
      });
      // The manager only sends through this.transport once one exists; wire it
      // directly (start() would open a real socket). createResponse() uses
      // sendRealtimeEvent -> transport.sendEvent, so this is sufficient.
      mgr.transport = transport;
      mgr.state.status = 'connected';

      const typesSent = () => sent.map((e) => e.type);
      const lastCreateIndex = () => {
        for (let i = sent.length - 1; i >= 0; i--) {
          if (sent[i].type === 'response.create') return i;
        }
        return -1;
      };

      // ---- A) QUEUE ---------------------------------------------------------
      // Open a response window (A active), then fire a queued send B while A is
      // active. B must NOT emit response.create until A's response.done fires.
      mgr.handleRealtimeEvent({ type: 'response.created', response: { id: 'respA' } });
      const beforeQueueBusy = mgr.isBusy();
      sent.length = 0;
      const bSend = mgr.createResponse({ mode: 'queue', response: { instructions: 'B' } });
      // Give the microtask chain a tick; B should be parked on responseIdle.
      await new Promise((r) => setTimeout(r, 50));
      const bSentWhileActive = sent.some((e) => e.type === 'response.create');
      // Now complete A. B should unblock and send.
      mgr.handleRealtimeEvent({ type: 'response.done', response: { id: 'respA', status: 'completed' } });
      await bSend;
      const bSentAfterDone = sent.some((e) => e.type === 'response.create');
      const queuePass = beforeQueueBusy === true && bSentWhileActive === false && bSentAfterDone === true;

      // ---- B) INTERRUPT -----------------------------------------------------
      // Open a fresh response window (C active), then fire an interrupt send D.
      // D must emit response.cancel, and (because we complete via cancelled)
      // then send its own response.create — without waiting on a long response.
      // Complete B's response first so the manager is idle before we start C.
      mgr.handleRealtimeEvent({ type: 'response.done', response: { id: mgr.activeResponseId, status: 'completed' } });
      mgr.handleRealtimeEvent({ type: 'response.created', response: { id: 'respC' } });
      sent.length = 0;
      const dSend = mgr.createResponse({ mode: 'interrupt', response: { instructions: 'D' } });
      await new Promise((r) => setTimeout(r, 50));
      const cancelSent = sent.some((e) => e.type === 'response.cancel');
      const dCreateBeforeCancelDone = sent.some((e) => e.type === 'response.create');
      // The interrupt awaits idle; feed the cancelled/done for respC to release it.
      mgr.handleRealtimeEvent({ type: 'response.done', response: { id: 'respC', status: 'cancelled' } });
      await dSend;
      const dSentAfter = sent.some((e) => e.type === 'response.create');
      // cancel must precede the replacement create in the outbound order.
      const order = typesSent();
      const cancelIdx = order.indexOf('response.cancel');
      const createIdx = order.indexOf('response.create');
      const interruptPass =
        cancelSent === true &&
        dSentAfter === true &&
        cancelIdx !== -1 && createIdx !== -1 && cancelIdx < createIdx &&
        dCreateBeforeCancelDone === false; // create waits until after idle

      // ---- C) TOOL-RESULT DISCARD ------------------------------------------
      // A tool job whose originResponseId was cancelled must be discarded.
      const discardPass =
        mgr._shouldDiscardToolResult({ originResponseId: 'respC' }) === true &&
        mgr._shouldDiscardToolResult({ originResponseId: 'respLive' }) === false;

      return {
        ok: true,
        queuePass, interruptPass, discardPass,
        detail: {
          beforeQueueBusy, bSentWhileActive, bSentAfterDone,
          cancelSent, dCreateBeforeCancelDone, dSentAfter, order,
        },
      };
    }, extId);

    console.log('result:', JSON.stringify(result, null, 2));
    pass = result.ok && result.queuePass && result.interruptPass && result.discardPass;
    console.log('QUEUE:', result.queuePass, '| INTERRUPT:', result.interruptPass, '| DISCARD:', result.discardPass);
    console.log(pass ? 'SEND-SERIALIZATION SMOKE PASS ✓' : 'SEND-SERIALIZATION SMOKE FAIL ✗');
  } finally {
    await ctx.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
