// U4 smoke — the run-owned lifecycle really starts + tears down its serve bridge, leaving no
// listener (R1/R4). This is a RUNTIME check (real process up/down), not a mock: the whole
// point is that teardown actually kills the child. Runs as `node --test` so the process is
// self-terminating and can NEVER wedge a shell (the bug this feature exists to prevent).
//
// Gated behind EVAL_SMOKE=1 because it spawns the real bridge binary; skipped by default in
// the unit suite. Run: EVAL_SMOKE=1 node --test extensions/chrome-overlay-runtime/tests/eval-lifecycle-smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = path.resolve(HERE, '../../../mcp/actions-json-mcp/target/debug/actions-json-mcp');
const RUN = process.env.EVAL_SMOKE === '1' && existsSync(BRIDGE_BIN);

test('lifecycle: startEvalBridge comes up, teardown kills it, no listener remains', { skip: !RUN ? 'set EVAL_SMOKE=1 (needs the built bridge binary)' : false }, async () => {
  const { startEvalBridge, killStaleServeBridge } = await import('./live/../tools/deploy/deploy.mjs');
  const { RunLifecycle } = await import('./live/eval/run-lifecycle.mjs');
  const BIND = '127.0.0.1:17361';
  const lc = new RunLifecycle();

  await killStaleServeBridge(BIND); // pre-clean any leftover
  const b = await startEvalBridge({ bind: BIND, host: BIND, timeoutMs: 20000 });
  lc.register('bridge', () => b.kill());

  // Up: /health responds.
  const up = await fetch(`${b.httpBase}/health`, { signal: AbortSignal.timeout(2000) });
  assert.equal(up.status, 200, 'bridge should be healthy after startEvalBridge');

  // Serve-mode mounts the HTTP tool routes await_event needs (V4 precondition).
  const actions = await fetch(`${b.httpBase}/actions`, { signal: AbortSignal.timeout(2000) });
  assert.equal(actions.status, 200, 'serve-mode must mount /actions (HTTP tool routes) — mcp-mode 404s');

  // Teardown: reverse-order idempotent kill.
  await lc.teardown();
  await new Promise((r) => setTimeout(r, 1000));

  // Down: no listener → connect refused / abort.
  let down = false;
  try { await fetch(`${b.httpBase}/health`, { signal: AbortSignal.timeout(1500) }); }
  catch { down = true; }
  assert.ok(down, 'no listener should remain after teardown (R1/R4)');
});
