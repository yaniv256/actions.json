// Extension DEPLOYMENT machinery — the repo's own way to take a new (unpacked) extension
// build and load it into a real Chrome for testing, then have the extension take control
// of a tab. This is support/deployment machinery for the eval harness: "new extension
// version → load it into a Chrome → run the tests," so it lives in the repo, not in any
// private tooling.
//
// Chrome 137+ removed --load-extension in BRANDED Chrome (this is why we can't just pass a
// flag to a real installed Chrome). The portable path is CDP `Extensions.loadUnpacked`,
// which needs a --remote-debugging-pipe connection whose fds only a NATIVE process can own
// (WSL fds don't cross to a Windows chrome.exe). So the actual pipe work is done by small
// native-node helpers in this dir (load_unpacked.mjs / pipe_session.mjs / claim_tab.mjs).
//
// Two entry points:
//   deployExtensionSession() — launch a Chrome with the unpacked extension loaded and
//     driveable, returning a CDP endpoint (the eval harness's Mode A connects to it).
//   claimTab() — make the extension take control of a tab (headless popup-claim).
//
// Config (env or args), so this is portable — no machine-specific values baked in:
//   DEPLOY_CHROME       path to chrome.exe / chrome (required)
//   DEPLOY_NODE         path to a NATIVE node that can own the pipe fds (required on WSL:
//                       a Windows node.exe, since WSL node can't pass fds to Windows Chrome)
//   DEPLOY_USER_DATA    Chrome --user-data-dir (a logged-in profile for Google-authed tests)
//   DEPLOY_CDP_HOST     host:port the launched relay is reachable at from the test runner
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function deployConfig(overrides = {}) {
  const userDataDir = overrides.userDataDir || process.env.DEPLOY_USER_DATA;
  return {
    chrome: overrides.chrome || process.env.DEPLOY_CHROME,
    node: overrides.node || process.env.DEPLOY_NODE || process.execPath,
    userDataDir,
    // U1/R3: a DISTINCT eval-scoped Chrome profile so per-run cleanup can target exactly the
    // eval's Chrome (by this --user-data-dir marker) and NEVER the operator's real, logged-in
    // browser. Defaults to a fixed eval dir that is not the operator's DEPLOY_USER_DATA.
    evalUserDataDir: overrides.evalUserDataDir || process.env.EVAL_CHROME_USER_DATA
      || (process.platform === 'win32' || /^[A-Za-z]:\\/.test(userDataDir || '') ? 'C:\\temp\\chrome-eval' : '/tmp/chrome-eval'),
    cdpHost: overrides.cdpHost || process.env.DEPLOY_CDP_HOST || '127.0.0.1:9222',
    bridgeUrl: overrides.bridgeUrl || process.env.EVAL_BRIDGE_URL || 'ws://127.0.0.1:17345/extension',
  };
}

// Run a native-node deploy helper and return its first JSON line.
//
// stdout goes to a TEMP FILE, not a pipe. The helper spawns Chrome with
// stdio:['inherit',...] so Chrome SHARES the helper's stdout fd — and Chrome floods it
// with startup noise ("Created TensorFlow Lite XNNPACK delegate…"). If that fd is a pipe
// and it fills (~64KB), Chrome BLOCKS on the write before loadUnpacked ever responds, so
// the ready line never comes and the whole thing hangs. A file never blocks the writer.
// (Root cause of the "pipe_session exits/hangs silently" incident — the bug was the pipe
// stdio here, not the helper; the helper prints fine when its stdout is a file.)
function runHelper(nodePath, helper, args, { timeoutMs = 60000, detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const script = path.join(HERE, helper);
    const logPath = path.join(os.tmpdir(), `deploy-${helper.replace(/\W/g, '_')}-${Date.now()}.log`);
    const logFd = fs.openSync(logPath, 'w');
    const proc = spawn(nodePath, [script, ...args], { stdio: ['ignore', logFd, logFd], detached });
    fs.closeSync(logFd); // the child holds its own dup; we poll the file
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(to); clearInterval(poll); fn(arg); } };
    const to = setTimeout(() => { try { proc.kill(); } catch {} finish(reject, new Error(`${helper} timeout (see ${logPath})`)); }, timeoutMs);
    const poll = setInterval(() => {
      let txt = ''; try { txt = fs.readFileSync(logPath, 'utf8'); } catch { return; }
      const line = txt.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) { let parsed; try { parsed = JSON.parse(line); } catch { return; } finish(resolve, { result: parsed, proc, logPath }); }
    }, 300);
    proc.on('error', (e) => finish(reject, e));
    proc.on('exit', (code) => {
      let txt = ''; try { txt = fs.readFileSync(logPath, 'utf8'); } catch {}
      if (!txt.includes('{')) finish(reject, new Error(`${helper} exited ${code} with no result (see ${logPath})`));
    });
  });
}

/**
 * Launch a Chrome with the unpacked extension loaded + a CDP relay, and keep it alive.
 * Returns { ok, id, name, version, cdpEndpoint, proc }. cdpEndpoint is what the eval
 * harness's Mode A (EVAL_CDP_ENDPOINT) connects to.
 * @param {string} extensionDir - the unpacked extension dir (a WINDOWS path if Chrome is on Windows).
 */
export async function deployExtensionSession(extensionDir, overrides = {}) {
  const cfg = deployConfig(overrides);
  if (!cfg.chrome) throw new Error('DEPLOY_CHROME (chrome path) is required');
  if (!cfg.userDataDir) throw new Error('DEPLOY_USER_DATA (--user-data-dir) is required for an authed profile');
  // U1/R3: launch on the DEDICATED eval profile (marker for safe cleanup), seeded once from
  // the authed operator profile so it keeps the Google login. Seeding is a Windows-side copy
  // done only when the eval profile doesn't already exist — cheap after the first run, and it
  // means per-run cleanup can taskkill by the eval --user-data-dir without ever touching the
  // operator's real browser. Skip seeding (use the eval dir as-is) via EVAL_CHROME_NO_SEED.
  const launchDir = cfg.evalUserDataDir || cfg.userDataDir;
  if (cfg.evalUserDataDir && cfg.evalUserDataDir !== cfg.userDataDir && !process.env.EVAL_CHROME_NO_SEED) {
    await seedEvalProfile(cfg.node, cfg.userDataDir, cfg.evalUserDataDir).catch(() => {});
  }
  const { result, proc } = await runHelper(cfg.node, 'pipe_session.mjs',
    [cfg.chrome, launchDir, extensionDir], { timeoutMs: 40000, detached: true });
  if (!result.ok) throw new Error(`deploy failed: ${result.error || JSON.stringify(result)}`);
  // http:// endpoint so Playwright connectOverCDP can fetch /json/version and discover the
  // relay's WS. The relay now serves both HTTP (/json/version) and WS on cdpHost.
  // evalUserDataDir is echoed back so the run can kill exactly this Chrome on teardown.
  return { ...result, cdpEndpoint: `http://${cfg.cdpHost}`, evalUserDataDir: launchDir, proc };
}

// U1 — copy the authed operator profile into the eval profile ONCE (only if the eval dir is
// absent), so the eval's dedicated Chrome starts Google-logged-in. Windows-side robocopy via
// PowerShell; ignored stdio (never inherit an fd). Best-effort — a failure just means the
// eval Chrome may hit the sign-in wall, surfaced later as ProfileNotAuthenticatedError.
async function seedEvalProfile(node, srcDir, destDir) {
  const ps = process.env.EVAL_POWERSHELL || '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const s = String(srcDir).replace(/'/g, "''");
  const d = String(destDir).replace(/'/g, "''");
  // Only seed if dest doesn't exist yet; robocopy mirrors the profile tree.
  const cmd = `if (-not (Test-Path '${d}')) { robocopy '${s}' '${d}' /E /NFL /NDL /NJH /NJS /NP | Out-Null }`;
  await new Promise((resolve) => {
    let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
    let proc;
    try { proc = spawn(ps, ['-NoProfile', '-Command', cmd], { stdio: 'ignore' }); } catch { return finish(); }
    proc.on('error', finish); proc.on('exit', finish);
    setTimeout(finish, 60000); // profile copy can be large; bounded
  });
}

/**
 * Launch a SERVE-mode actions.json bridge for the eval and wait until it's healthy.
 * Serve-mode (not mcp-mode) mounts the HTTP tool routes (/mcp/tools/call) the eval's
 * agent driver needs — runtime.agent.await_event drains the bridge's event queue, which is
 * only reachable over HTTP, not the SW hook. The bridge also serves the /extension WS the
 * deployed extension connects to, so ONE process owns both.
 *
 * stdio is a FILE SINK (never a pipe inherited by a shell) — a long-lived bridge on an
 * inherited pipe wedges the parent (the deploy pipe-deadlock class). Returns
 * { httpBase, wsUrl, proc, logPath, kill } once GET /health returns ok.
 * @param {object} opts - { bind?, actions?, storageRoot?, binary?, host? }
 */
export async function startEvalBridge(opts = {}) {
  const bind = opts.bind || process.env.EVAL_BRIDGE_BIND || '0.0.0.0:17346';
  const host = opts.host || process.env.EVAL_BRIDGE_HOST || bind.replace('0.0.0.0', '127.0.0.1');
  const binary = opts.binary || process.env.EVAL_BRIDGE_BINARY
    || path.resolve(HERE, '../../../../mcp/target/debug/actions-json-mcp');
  const actions = opts.actions || process.env.EVAL_BRIDGE_ACTIONS
    || path.resolve(HERE, '../../actions/overlay.actions.json');
  const storageRoot = opts.storageRoot || process.env.EVAL_BRIDGE_STORAGE || path.resolve(HERE, '../../../../../actions.json.storage');
  const args = ['serve', '--bind', bind, '--actions', actions];
  if (storageRoot && fs.existsSync(storageRoot)) args.push('--storage-root', storageRoot);

  const logPath = path.join(os.tmpdir(), `eval-bridge-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const proc = spawn(binary, args, { stdio: ['ignore', logFd, logFd], detached: true });
  fs.closeSync(logFd);
  proc.unref(); // don't keep the parent event loop alive on this child

  const httpBase = `http://${host}`;
  const wsUrl = `ws://${host}/extension`;
  const kill = () => { try { process.kill(-proc.pid); } catch { try { proc.kill(); } catch {} } };
  // Poll /health until up (or fail with the log for diagnosis).
  const deadline = Date.now() + (opts.timeoutMs || 20000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { httpBase, wsUrl, proc, logPath, kill };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  kill();
  throw new Error(`eval bridge did not become healthy at ${httpBase} (see ${logPath})`);
}

/**
 * U2/R3 — build the Windows command that force-kills ONLY the Chrome launched on the eval
 * `--user-data-dir` marker, never a bare "all chrome" kill. Pure + testable: no execution.
 * Matches the marker in each process's command line via WMI, so it can't touch the operator's
 * real browser (a different --user-data-dir). Throws on an empty marker — an unscoped kill is
 * exactly the accident this guards against.
 */
export function evalChromeKillCommand(marker) {
  if (!marker || !String(marker).trim()) throw new Error('evalChromeKillCommand: a non-empty user-data-dir marker is required (refusing an unscoped kill)');
  // Escape backslashes + single quotes for the PowerShell -match regex / string literal.
  const esc = String(marker).replace(/\\/g, '\\\\').replace(/'/g, "''");
  // Get-CimInstance filters to chrome.exe processes whose CommandLine contains the eval dir;
  // Stop-Process -Force kills exactly those. -match is regex, hence the escaped backslashes.
  return `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${esc}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

/**
 * U4/R2/R4 — kill any stale eval SERVE bridge left by a prior run. The serve bridge is a LOCAL
 * (WSL) process, identified by its listen port (the eval uses a dedicated port, default 17346).
 * pkill by the exact `serve --bind <host:port>` marker so it never touches Claude's own
 * mcp-mode bridge on 17345. Ignored stdio, never throws — safe from pre-clean and teardown.
 */
export async function killStaleServeBridge(bind = process.env.EVAL_BRIDGE_BIND || '0.0.0.0:17346') {
  await new Promise((resolve) => {
    let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
    let proc;
    // Match the full "serve --bind <bind>" so we only kill the eval's serve bridge.
    try { proc = spawn('pkill', ['-9', '-f', `actions-json-mcp serve --bind ${bind}`], { stdio: 'ignore' }); }
    catch { return finish(); }
    proc.on('error', finish); proc.on('exit', finish);
    setTimeout(finish, 5000);
  });
}

/**
 * U2/R3 — execute evalChromeKillCommand over the Windows boundary (via the same node/PowerShell
 * path the deploy uses). No-op + never throws when nothing matches, so it is safe to call from
 * BOTH pre-clean and finally teardown. Output goes nowhere (ignored stdio) — never inherits the
 * caller's fd (that inheritance is the shell-wedge bug this whole change exists to prevent).
 */
export async function killEvalChrome(marker, overrides = {}) {
  const cmd = evalChromeKillCommand(marker); // throws on empty marker — intentional
  const ps = process.env.EVAL_POWERSHELL || '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let proc;
    try {
      proc = spawn(ps, ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
    } catch { return finish(); } // PS not present (non-WSL) → no-op
    proc.on('error', finish);
    proc.on('exit', finish);
    setTimeout(finish, 10000); // never hang teardown on a slow kill
  });
}

/**
 * Make the extension CLAIM a tab (the headless equivalent of the popup claim), over a CDP
 * endpoint. Returns { ok, tabId, response }.
 */
export async function claimTab(cdpWsUrl, extensionId, targetUrlContains, overrides = {}) {
  const cfg = deployConfig(overrides);
  const { result } = await runHelper(cfg.node, 'claim_tab.mjs',
    [cdpWsUrl, extensionId, targetUrlContains, cfg.bridgeUrl], { timeoutMs: 45000 });
  return result;
}
