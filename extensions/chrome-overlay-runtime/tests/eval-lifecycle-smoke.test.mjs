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
import { bridgeAuthHeaders, requireSpawnedBridgeSecret } from './live/support/bridge-secret.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = path.resolve(HERE, '../../../mcp/target/debug/actions-json-mcp');
const RUN = process.env.EVAL_SMOKE === '1' && existsSync(BRIDGE_BIN);

test('lifecycle: startEvalBridge comes up, teardown kills it, no listener remains', { skip: !RUN ? 'set EVAL_SMOKE=1 (needs the built bridge binary)' : false }, async () => {
  // deploy.mjs lives in the EXTENSION's tools/, not under tests/ — the old
  // './live/../tools/...' collapsed to 'tests/tools/...', which does not exist.
  // Invisible until now because this test only runs under EVAL_SMOKE=1.
  const { startEvalBridge, killStaleServeBridge } = await import('../tools/deploy/deploy.mjs');
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
  //
  // U12b gated those routes behind the per-installation handshake secret, so the
  // 200 is now conditional on presenting it. The discriminator still holds — and
  // is sharper: mcp-mode does not mount /actions at all (404), while serve-mode
  // mounts it and answers 401 unauthenticated, 200 with the secret. Asserting
  // BOTH separates "route absent" from "route present but refusing me", which a
  // bare 200-or-not could never tell apart.
  const unauthed = await fetch(`${b.httpBase}/actions`, { signal: AbortSignal.timeout(2000) });
  assert.equal(unauthed.status, 401, 'serve-mode must mount /actions and gate it — mcp-mode 404s');
  const refusal = await unauthed.json().catch(() => ({}));
  assert.equal(refusal.error?.code, 'bridge_secret_missing', 'an uncredentialed call must name WHY it was refused');

  // The secret comes from the bridge THIS test spawned — it prints it at startup,
  // and startEvalBridge captures that stdout into logPath.
  const secret = requireSpawnedBridgeSecret(b.logPath);
  const actions = await fetch(`${b.httpBase}/actions`, {
    headers: bridgeAuthHeaders(secret),
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(actions.status, 200, 'serve-mode must serve /actions once the handshake secret is presented');

  // Teardown: reverse-order idempotent kill.
  await lc.teardown();
  await new Promise((r) => setTimeout(r, 1000));

  // Down: no listener → connect refused / abort.
  let down = false;
  try { await fetch(`${b.httpBase}/health`, { signal: AbortSignal.timeout(1500) }); }
  catch { down = true; }
  assert.ok(down, 'no listener should remain after teardown (R1/R4)');
});
