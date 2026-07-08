// Native-Windows-Node persistent pipe-session: install OUR extension AND expose the
// SAME instance for driving — the self-install + drive-same-instance flow.
//
// WHY this shape (see investigations/extension-self-install-not-loading.md):
//  - Extensions.loadUnpacked needs --remote-debugging-pipe; Chrome 149 will NOT
//    auto-load an unpacked extension on a later normal launch, so we must DRIVE the
//    very instance we installed into.
//  - Pipe and port are mutually exclusive, and a WSL process can't own the pipe fds.
//    So a NATIVE Windows node owns the pipe, loadUnpacked's our extension, then RELAYS
//    CDP between that pipe and a local WebSocket. Downstream drivers (puppeteer, the
//    actions.json bridge) connect to the WS exactly as they would to a debugging port —
//    but this instance already has our extension running.
//
// Usage (invoked by chrome_launcher.py via Windows node.exe):
//   node pipe_session.mjs <chromeExe> <userDataDir> <extPath> <wsPort>
// Emits one JSON line when ready: {"ok":true,"id","name","version","wsUrl"} then STAYS
// ALIVE relaying until killed. On failure: {"ok":false,"error"}.
//
// NETWORKING: bind the relay to 127.0.0.1:9222 (the DEFAULT wsPort). WSL reaches it via
// the EXISTING `netsh portproxy 9223 -> 127.0.0.1:9222` that chrome_endpoint already
// relies on — so from WSL the relay is reachable at ws://192.168.176.1:9223 with ZERO
// new port/firewall plumbing. The pipe-Chrome uses the pipe, so port 9222 is free for us.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';

const EXPECTED_NAME = 'actions.json Overlay Runtime';
const [chromeExe, userDataDir, extPath, wsPortArg] = process.argv.slice(2);
// Default 9222 so WSL reaches it via the existing 9223->9222 portproxy (see header).
const wsPort = Number(wsPortArg || 9222);

function fail(obj) { process.stdout.write(JSON.stringify({ ok: false, ...obj }) + '\n'); process.exit(1); }
if (!chromeExe || !userDataDir || !extPath) fail({ error: 'usage: pipe_session.mjs <chromeExe> <userDataDir> <extPath> <wsPort>' });

// 1) Launch a headed pipe-Chrome (headed so a driven window is possible; the flag lets
//    loadUnpacked run and Chrome honor the unpacked extension in THIS instance).
const child = spawn(chromeExe, [
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'] });

const pipeWrite = child.stdio[3];
const pipeRead = child.stdio[4];

// 2) Pipe framing (NUL-terminated JSON) + an internal request/response channel for our
//    own setup calls (loadUnpacked), kept separate from relayed client traffic by id space.
let buf = Buffer.alloc(0);
let setupId = 0;                       // our setup calls use ids 1..999 (namespaced high)
const SETUP_BASE = 1_000_000_000;      // client ids won't collide with this range
const pending = new Map();
const clients = new Set();

pipeRead.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let nul;
  while ((nul = buf.indexOf(0)) !== -1) {
    const raw = buf.slice(0, nul).toString('utf8');
    buf = buf.slice(nul + 1);
    let d; try { d = JSON.parse(raw); } catch { continue; }
    if (d.id != null && d.id >= SETUP_BASE && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); continue; }
    // Everything else (events + client responses) fans out to connected WS clients.
    for (const c of clients) { try { c.send(raw); } catch {} }
  }
});
const setupSend = (method, params = {}) => new Promise((res) => {
  const id = SETUP_BASE + (++setupId);
  pending.set(id, res);
  pipeWrite.write(JSON.stringify({ id, method, params }) + '\0');
});

child.on('exit', () => process.exit(0));
const timer = setTimeout(() => fail({ stage: 'timeout' }), 30000);

// 3) Install our extension, verify identity, then start the WS relay and announce ready.
setTimeout(async () => {
  const load = await setupSend('Extensions.loadUnpacked', { path: extPath });
  if (load.error) { clearTimeout(timer); fail({ stage: 'loadUnpacked', error: load.error }); return; }
  const id = load.result && load.result.id;
  let name = null, version = null;
  try { const m = JSON.parse(readFileSync(join(extPath, 'manifest.json'), 'utf8')); name = m.name; version = m.version; } catch (e) { version = 'manifest-read-error: ' + e.message; }
  if (name !== EXPECTED_NAME) { clearTimeout(timer); fail({ stage: 'identity', error: `manifest name mismatch: expected "${EXPECTED_NAME}" got ${JSON.stringify(name)}`, id }); return; }

  // HTTP + WS relay on ONE port so Playwright's connectOverCDP works: it fetches
  // http://host:port/json/version, reads webSocketDebuggerUrl, then connects that WS.
  // We serve /json/version pointing at THIS relay's WS, and upgrade WS on the same server.
  const httpServer = createHttpServer((req, res) => {
    if ((req.url || '').startsWith('/json/version')) {
      const host = (req.headers.host || `127.0.0.1:${wsPort}`);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        Browser: `${name}/${version}`,
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://${host}/devtools/browser/eval-relay`,
      }));
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (m) => { try { pipeWrite.write(m.toString() + '\0'); } catch {} });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  httpServer.on('listening', () => {
    clearTimeout(timer);
    const addr = httpServer.address();
    process.stdout.write(JSON.stringify({ ok: true, id, name, version, wsPort: addr.port, wsUrl: `ws://<host>:${addr.port}`, httpUrl: `http://<host>:${addr.port}` }) + '\n');
  });
  httpServer.on('error', (e) => { clearTimeout(timer); fail({ stage: 'http', error: String(e && e.message || e), id }); });
  httpServer.listen(wsPort, '127.0.0.1');
}, 1500);
