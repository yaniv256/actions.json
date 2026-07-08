// Token-free verification of the runtime-registration fix
// (investigations/eval-extension-no-runtime-registration.md): after deploy + set-bridgeUrl +
// claim, the deployed extension must register a runtime on the RUN'S serve bridge (17346),
// so runtime.agent.await_event has a channel. This is the exact gate that was failing
// (/runtimes count:0). NO OpenAI tokens — it stops at "is the channel up?", before driving
// any agent. Self-terminating (node --test) so it can't wedge the shell.
//
// Gated behind EVAL_SMOKE=1 (spawns the real bridge + deploys Chrome). Run:
//   EVAL_SMOKE=1 node --test extensions/chrome-overlay-runtime/tests/eval-runtime-registration-smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = path.resolve(HERE, '../../../mcp/actions-json-mcp/target/debug/actions-json-mcp');
const RUN = process.env.EVAL_SMOKE === '1' && existsSync(BRIDGE_BIN)
  && process.env.DEPLOY_CHROME && process.env.DEPLOY_USER_DATA;

test('deployed extension registers a runtime on the run-owned bridge after claim', { skip: !RUN ? 'set EVAL_SMOKE=1 + DEPLOY_* env (needs the built bridge + a logged-in Chrome)' : false }, async () => {
  const { launchEvalEnv } = await import('./live/eval/harness-env.mjs');
  const { startEvalBridge, killEvalChrome, killStaleServeBridge, deployConfig } = await import('./live/../tools/deploy/deploy.mjs');
  const cfg = deployConfig();

  await killStaleServeBridge(process.env.EVAL_BRIDGE_BIND || '0.0.0.0:17346');
  if (cfg.evalUserDataDir) await killEvalChrome(cfg.evalUserDataDir);

  const bridge = await startEvalBridge();
  process.env.EVAL_BRIDGE_URL = process.env.EVAL_BRIDGE_WS_URL || bridge.wsUrl;
  try {
    // Deploy + connect + set-bridgeUrl + claim happen inside launchEvalEnv (Mode A').
    // It already probes /runtimes and warns on 0 — here we ASSERT count>=1.
    const env = await launchEvalEnv();
    try {
      const rt = await fetch(`${bridge.httpBase}/runtimes`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
      const count = Array.isArray(rt?.runtimes) ? rt.runtimes.length : 0;
      // Write the result to a fixed file the TEST owns — shell redirects have been losing
      // output; a test-owned write can't be lost to a backgrounding/redirect collision.
      try { (await import('node:fs')).writeFileSync('/tmp/rtreg-result.json', JSON.stringify({ count, rt }, null, 2)); } catch {}
      assert.ok(count >= 1, `expected >=1 runtime registered on the run bridge, got ${count} (rt=${JSON.stringify(rt)})`);
    } finally { await env.close?.(); }
  } finally {
    bridge.kill();
    if (cfg.evalUserDataDir) await killEvalChrome(cfg.evalUserDataDir);
  }
});
