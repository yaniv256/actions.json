// Self-driven LIVE smoke (Task #187, plan 2026-07-09-001 Gate 3): proves the
// runtime-liveness invariant end-to-end across the REAL extension↔bridge seam —
// the seam unit tests mock, so this is the only place the reap/probe path is
// actually exercised. No human install, no restart.
//
// It launches the REAL Rust bridge + the unpacked extension in a real Chromium,
// claims two fixture tabs onto the bridge, then:
//   1. asserts bridge /runtimes shows 2 LIVE runtimes in the U5 unified shape
//      (runtime_id + url + host + is_live; NO runtime_key on the agent surface);
//   2. CLOSES one tab and asserts the bridge reaps it (U2) — /runtimes drops to
//      the surviving one, within a beat, and the lifecycle log records a
//      tab_closed disconnect. This is the drag-504 guarantee, proven live.
//
// Run: xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/runtime-liveness-smoke.mjs
import { chromium } from '@playwright/test';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../..');
const REPO = path.resolve(EXT, '../..');
// The crate is part of the `mcp/` cargo WORKSPACE, so its binary lands in the
// workspace target dir (mcp/target/debug), NOT mcp/actions-json-mcp/target/debug
// — a stale leftover binary there will silently test old code (caught live once).
const BRIDGE_BIN = path.join(REPO, 'mcp/target/debug/actions-json-mcp');
const BRIDGE_PORT = 17399; // off the default 17345 so a running dev bridge doesn't collide

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRuntimes() {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/runtimes`);
  return res.json();
}

async function callBridgeTool(name, args = {}, route = {}) {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/mcp/tools/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args, ...route }),
  });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Poll /runtimes until `pred(json)` holds or we time out; returns the last json.
async function waitForRuntimes(pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await fetchRuntimes(); if (pred(last)) return last; } catch { /* bridge warming */ }
    await sleep(150);
  }
  return last;
}

async function main() {
  if (!fs.existsSync(BRIDGE_BIN)) {
    throw new Error(`bridge binary missing at ${BRIDGE_BIN} — run: cargo build --manifest-path mcp/actions-json-mcp/Cargo.toml`);
  }
  // background.js statically imports the a11y bundle; build it so the loaded
  // extension carries current code.
  execFileSync('node', [path.join(EXT, 'esbuild.a11y.mjs')], { stdio: 'inherit' });

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-store-'));
  const bridge = spawn(BRIDGE_BIN, [
    'serve', '--bind', `127.0.0.1:${BRIDGE_PORT}`, '--storage-root', storageRoot,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  bridge.stdout.on('data', (d) => process.stdout.write(`[bridge] ${d}`));
  bridge.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));

  // Fixture server: two visually distinct pages so runtime routing and
  // screenshot surface identity can be checked through the real bridge seam.
  const srv = http.createServer((q, r) => {
    r.setHeader('content-type', 'text/html');
    const color = q.url === '/board-a' ? '#dc2626' : '#16a34a';
    r.end(`<!doctype html><title>Fixture ${q.url}</title><style>body{margin:0;background:${color};color:white;font:48px sans-serif}</style><h1>liveness fixture ${q.url}</h1>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const urlA = `${base}/board-a`;
  const urlB = `${base}/board-b`;
  const wsBridge = `ws://127.0.0.1:${BRIDGE_PORT}/extension`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-smoke-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  let pass = false;
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    sw.on('console', (m) => console.log('[sw]', m.type(), m.text()));

    // Open two tabs and claim each onto the bridge via the real claim path.
    const pageA = ctx.pages()[0] || await ctx.newPage();
    await pageA.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const pageB = await ctx.newPage();
    await pageB.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const idOf = async (u) => sw.evaluate(async (uu) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === uu)?.id;
    }, u);
    const tabA = await idOf(urlA);
    const tabB = await idOf(urlB);
    if (tabA == null || tabB == null) throw new Error(`fixture tabs not found (A=${tabA} B=${tabB})`);

    for (const id of [tabA, tabB]) {
      const claim = await sw.evaluate(async ([tid, ws]) => self.__claimTest.claim(tid, ws), [id, wsBridge]);
      console.log(`claim tab ${id}:`, JSON.stringify(claim).slice(0, 200));
      if (!claim.ok) throw new Error(`claim failed for tab ${id}: ${claim.error}`);
    }

    // (1) Both runtimes register, LIVE, in the U5 unified shape.
    const two = await waitForRuntimes((j) => j.count === 2 && j.connected === true);
    console.log('runtimes after claim:', JSON.stringify(two));
    if (!(two?.count === 2)) throw new Error(`expected 2 live runtimes, got ${JSON.stringify(two)}`);
    const rows = two.runtimes || [];
    const hosts = rows.map((r) => r.host).sort();
    const shapeOk = rows.every((r) =>
      typeof r.runtime_id === 'string' && r.is_live === true &&
      r.runtime_key === undefined && r.tab === undefined);
    if (!shapeOk) throw new Error(`U5 shape violated (runtime_key/tab leaked or missing runtime_id): ${JSON.stringify(rows)}`);
    const hostsOk = hosts.length === 2 && hosts.every((h) => h === '127.0.0.1'); // same host, distinct urls
    console.log('U5 shape ok:', shapeOk, 'hosts:', JSON.stringify(hosts));

    // The MCP discovery tool is bridge-owned: it must return every live runtime
    // without dispatching the list operation to one extension tab.
    const claimed = await callBridgeTool('browser.claimed_tabs.list');
    console.log('bridge claimed-tabs:', JSON.stringify(claimed));
    const claimedOutput = claimed.output?.value ?? claimed.output;
    const claimedOk = claimedOutput?.scope === 'bridge'
      && claimedOutput?.complete === true
      && claimedOutput?.inventory_source === 'live_runtime_registry'
      && claimedOutput?.count === 2
      && claimedOutput.tabs.every((row) => typeof row.runtime_id === 'string' && row.bridge_url === undefined);
    if (!claimedOk) throw new Error(`bridge-global claimed-tabs contract failed: ${JSON.stringify(claimed)}`);

    // Screenshot capture is background-routed and therefore bypasses the
    // ordinary content-script action path. Prove its measurement envelope and
    // exact runtime routing through the real extension↔bridge seam.
    const rowA = rows.find((r) => r.url?.includes('/board-a'));
    const rowB = rows.find((r) => r.url?.includes('/board-b'));
    const shotArgs = {
      format: 'jpeg',
      quality: 60,
      delay_ms: 25,
      max_width: 800,
      policy_exception_report: {
        kind: 'generic',
        intended_tool: 'browser.screenshot',
        actions_json_path: 'none: fixture has no site-specific screenshot action',
        reason: 'Live contract test for the generic background screenshot primitive.',
      },
    };
    const shotA = await callBridgeTool('browser.screenshot', {
      ...shotArgs,
    }, { target_runtime_id: rowA?.runtime_id });
    const shotB = await callBridgeTool('browser.screenshot', {
      ...shotArgs,
    }, { target_runtime_id: rowB?.runtime_id });
    const valueA = shotA.output?.value ?? shotA.output;
    const valueB = shotB.output?.value ?? shotB.output;
    const screenshotOk = [valueA, valueB].every((value) =>
      value?.surface_identity === 'verified_active_tab'
      && value?.freshness === 'unverified'
      && value?.delay_ms_applied === 25
      && value?.screenshot_compaction?.compacted === true
      && value?.screenshot_compaction?.output_width <= 800
      && value?.data_url?.startsWith('data:image/jpeg;base64,'))
      && valueA.data_url !== valueB.data_url;
    console.log('background screenshot contract:', JSON.stringify({
      screenshotOk,
      a: { url: valueA?.url, identity: valueA?.surface_identity, freshness: valueA?.freshness, compaction: valueA?.screenshot_compaction },
      b: { url: valueB?.url, identity: valueB?.surface_identity, freshness: valueB?.freshness, compaction: valueB?.screenshot_compaction },
    }));
    if (!screenshotOk) throw new Error(`background screenshot contract failed: ${JSON.stringify({ shotA, shotB })}`);

    // Site capability discovery must derive its catalog scope from the same
    // exact runtime target used for dispatch. No redundant URL argument is
    // supplied here; this is the live regression for split-brain targeting.
    const siteA = await callBridgeTool('actions.site', { mode: 'list' }, {
      target_runtime_id: rowA?.runtime_id,
    });
    const siteB = await callBridgeTool('actions.site', { mode: 'list' }, {
      target_runtime_id: rowB?.runtime_id,
    });
    const siteValueA = siteA.output?.value ?? siteA.output;
    const siteValueB = siteB.output?.value ?? siteB.output;
    const siteScopeOk = siteValueA?.target_url_contains === urlA
      && siteValueB?.target_url_contains === urlB;
    console.log('runtime-derived site catalog scopes:', JSON.stringify({
      siteScopeOk,
      a: siteValueA?.target_url_contains,
      b: siteValueB?.target_url_contains,
    }));
    if (!siteScopeOk) throw new Error(`runtime-derived site catalog scope failed: ${JSON.stringify({ siteA, siteB })}`);

    // (2) THE drag-504 guarantee: close tab A; the bridge must reap its runtime.
    const survivorId = rows.find((r) => r.url?.includes('/board-b'))?.runtime_id;
    console.log('closing tab A; expecting survivor runtime:', survivorId);
    await pageA.close();

    const one = await waitForRuntimes((j) => j.count === 1);
    console.log('runtimes after tab-close:', JSON.stringify(one));
    const reaped = one?.count === 1 &&
      (one.runtimes || []).every((r) => !r.url?.includes('/board-a'));
    if (!reaped) throw new Error(`tab-close was NOT reaped — bridge still lists the closed tab: ${JSON.stringify(one)}`);

    // The reap MUST be recorded as a disconnect in the persistent lifecycle log.
    // Which reason depends on HOW the tab closed: onRemoved-while-WS-open →
    // tab_closed (U2's targeted reap); a full connection teardown (Playwright may
    // drop the tab's socket) → receive_loop_ended. Both are honest reaps of the
    // dead runtime — the invariant is that the dead runtime is logged as gone,
    // not which of the two paths fired.
    const logPath = path.join(storageRoot, 'logs', 'bridge-lifecycle.jsonl');
    let reapReason = null;
    try {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
      for (const ln of lines) {
        try {
          const e = JSON.parse(ln);
          const closedBoardA = JSON.stringify(e.runtimes || '').includes('/board-a');
          if (e.event === 'disconnect' && closedBoardA) reapReason = e.reason;
        } catch { /* skip */ }
      }
      console.log('lifecycle log lines:\n' + lines.join('\n'));
    } catch (err) { console.log('lifecycle log read failed:', String(err)); }
    const reapLogged = reapReason === 'tab_closed' || reapReason === 'receive_loop_ended';
    console.log('reap logged with reason:', reapReason, '→', reapLogged);

    pass = shapeOk && hostsOk && screenshotOk && siteScopeOk && reaped && reapLogged;
    console.log(pass ? 'LIVE LIVENESS SMOKE PASS ✓' : 'LIVE LIVENESS SMOKE FAIL ✗');
  } finally {
    await ctx.close();
    srv.close();
    bridge.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
