// EVAL-U6 (self-contained live entry): the ONE command any actions.json.dev developer
// runs to measure the hosted agent's real Docs-editing error rate. No private tooling —
// loads the unpacked extension into Playwright's Chromium, claims a real Doc via the
// inert __claimTest hook, and runs the task set through the real GPT-Realtime session.
//
// Run:  xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/eval/hosted-agent-eval-live.mjs
// Setup (one-time): see tests/live/eval/README.md — populate the gitignored Google
// cookies secret (scripts/extract-google-cookies.mjs), run the actions.json bridge, and
// configure the OpenAI key in the extension.
//
// Env:
//   EVAL_COOKIES_FILE  path to your gitignored Google cookies secret (default
//                      tests/live/eval/eval-secrets.cookies.json)
//   EVAL_DOC_URL       an existing sandbox Doc to edit (optional; else a new doc is created)
//   EVAL_BRIDGE_URL    bridge ws (default ws://127.0.0.1:17345/extension)
//   EVAL_TASK_IDS      comma-separated subset (e.g. "1,2,3") to run a cheap proof first
import { launchEvalEnv } from './harness-env.mjs';
import { runEval } from './run-eval.mjs';
import { DOCS_EDIT_TASKS } from '../fixtures/docs-edit-tasks.mjs';

// The bridge agent-session tools are exposed by the running bridge over its MCP/HTTP
// interface. In the self-contained live path we drive them through the SAME service
// worker we already have a handle to, via inert test hooks the runtime exposes
// (runtime.agent.* are also reachable from the SW). This bridge adapter calls them.
// Build the agent-session bridge. runtime.agent.* — CRITICALLY await_event — must go through
// the BRIDGE's HTTP tool interface (POST /mcp/tools/call), because await_event drains the
// bridge's agent-event QUEUE (Rust, Spec 038). The SW only FORWARDS events to that queue and
// has NO await_event handler, so driving await_event through the __agentTest SW hook returns
// "Unknown action" and the driver spins to its ceiling. Route everything through the bridge so
// start/user_message/stop/await_event share one queue-consistent path.
// (The bridge must be launched in serve-mode so /mcp/tools/call is mounted; EVAL_BRIDGE_URL's
// host:port is that same bridge — the one the extension is connected to.)
function makeBridgeHttpClient(bridgeWsUrl, targetUrlContains) {
  // ws://host:port/extension  →  http://host:port/mcp/tools/call
  const u = new URL(bridgeWsUrl);
  const httpBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  const call = async (name, args, timeoutMs = 30000) => {
    const res = await fetch(`${httpBase}/mcp/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args || {}, target_url_contains: targetUrlContains, timeout_ms: timeoutMs }),
    });
    if (!res.ok) throw new Error(`bridge ${name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    if (j.error) return { output: { error: j.error } };
    // await_event's idle/events/cursor live under output.value; driver reads `.output ?? res`.
    return { output: j.output?.value ?? j.output };
  };
  return {
    start: (a) => call('runtime.agent.start', a),
    userMessage: (a) => call('runtime.agent.user_message', a),
    awaitEvent: (a) => call('runtime.agent.await_event', a, (a?.timeout_ms || 25000) + 5000),
    stop: (a) => call('runtime.agent.stop', a),
  };
}

// Instrument: append a structured, timestamped step trace to EVAL_TRACE (a file), so an
// integrated run is OBSERVABLE even when stdout is swallowed/redirected. Phase-0: build the
// instrument you need rather than debug blind.
import { appendFileSync } from 'node:fs';
const TRACE = process.env.EVAL_TRACE || '';
const trace = (step, data) => { const line = `[trace ${Date.now()}] ${step}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`; console.log(line); if (TRACE) try { appendFileSync(TRACE, line + '\n'); } catch {} };

async function main() {
  const only = (process.env.EVAL_TASK_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const tasks = only.length ? DOCS_EDIT_TASKS.filter((t) => only.includes(t.id)) : DOCS_EDIT_TASKS;
  trace('start', { tasks: tasks.map((t) => t.id) });

  const { startEvalBridge, killStaleServeBridge, killEvalChrome, deployConfig } = await import('../../../tools/deploy/deploy.mjs');
  const { RunLifecycle } = await import('./run-lifecycle.mjs');
  const cfg = deployConfig();
  const lifecycle = new RunLifecycle(); // U4/R1 — the run owns every child it starts

  // U4/KTD3/R4 — PRE-CLEAN FIRST: sweep any serve bridge + eval Chrome a prior crashed run
  // leaked (SIGKILL skips finally, so the next run's pre-clean is what makes cleanup crash-safe).
  // Both are marker-scoped: the eval bridge by its bind port, Chrome by its dedicated data dir —
  // never Claude's 17345 bridge, never the operator's real browser.
  await killStaleServeBridge(process.env.EVAL_BRIDGE_BIND || '0.0.0.0:17346');
  if (cfg.evalUserDataDir) await killEvalChrome(cfg.evalUserDataDir);
  trace('pre-clean-done', { bridgeBind: process.env.EVAL_BRIDGE_BIND || '0.0.0.0:17346', evalDir: cfg.evalUserDataDir });

  // U4/R2/R5 — the eval OWNS its serve bridge (HTTP tool routes for runtime.agent.await_event).
  // Started ONLY here, never from bash. Registered so teardown/signals kill it.
  let evalBridge = null;
  if (!process.env.EVAL_BRIDGE_URL) {
    evalBridge = await startEvalBridge();
    lifecycle.register('serve-bridge', () => evalBridge.kill());
    process.env.EVAL_BRIDGE_URL = process.env.EVAL_BRIDGE_WS_URL || evalBridge.wsUrl;
    trace('serve-bridge-up', { httpBase: evalBridge.httpBase, extConnects: process.env.EVAL_BRIDGE_URL, log: evalBridge.logPath });
  } else {
    trace('serve-bridge-skipped', { EVAL_BRIDGE_URL: process.env.EVAL_BRIDGE_URL });
  }
  const httpBase = evalBridge ? evalBridge.httpBase : (process.env.EVAL_BRIDGE_HTTP || 'http://127.0.0.1:17346');

  // U4/R1 — best-effort teardown on Ctrl-C / TERM / uncaught. SIGKILL is uncatchable → the
  // next run's pre-clean sweeps it. Registered once; handlers just fire teardown then exit.
  let signalTearingDown = false;
  const onSignal = (sig) => async () => {
    if (signalTearingDown) return; signalTearingDown = true;
    trace('signal', { sig });
    try { await lifecycle.teardown(); } finally { process.exit(130); }
  };
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));

  try {
    const env = await launchEvalEnv();
    // Register Chrome teardown: the harness env close AND a hard marker-scoped Chrome kill.
    lifecycle.register('eval-chrome', async () => { try { await env.close(); } catch {} if (cfg.evalUserDataDir) await killEvalChrome(cfg.evalUserDataDir); });
    trace('env-ready', { mode: env.mode, docUrl: env.docUrl, tabId: env.tabId });

    // Did the extension actually connect + register a runtime on THIS bridge? (await_event
    // drains that bridge's queue — if no runtime connected, it idles forever.)
    try {
      const rt = await fetch(`${httpBase}/runtimes`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
      trace('runtimes', { count: Array.isArray(rt?.runtimes) ? rt.runtimes.length : rt, sample: JSON.stringify(rt).slice(0, 200) });
    } catch (e) { trace('runtimes-err', { error: String(e.message || e) }); }

    // Drive runtime.agent.* over the serve-bridge's HTTP tool interface (LOCAL httpBase).
    const bridge = makeBridgeHttpClient(httpBase.replace(/^http/, 'ws') + '/extension', 'docs.google.com/document/d/');
    trace('drive-begin');
    const result = await runEval({ bridge, cdp: env }, { tasks, targetUrlContains: 'docs.google.com/document/d/' });
    trace('drive-done', { clearsGoal: result.clearsGoal, failed: result.failed, total: result.total });
    process.exitCode = result.clearsGoal ? 0 : 1;
  } finally {
    await lifecycle.teardown(); // U4/R1 — reverse order: Chrome then bridge; idempotent
    trace('teardown-done');
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
