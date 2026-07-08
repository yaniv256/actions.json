// U3 — RunLifecycle manager unit tests. Covers V5 (unit) + R1 ownership semantics:
// register kill fns, tear them down once in reverse order, never let one bad kill strand
// the others. Pure module, no processes.
import { test } from 'node:test';
import assert from 'node:assert';
import { RunLifecycle } from './live/eval/run-lifecycle.mjs';

test('teardown calls all kills in REVERSE registration order', async () => {
  const order = [];
  const lc = new RunLifecycle();
  lc.register('a', () => order.push('a'));
  lc.register('b', () => order.push('b'));
  lc.register('c', () => order.push('c'));
  await lc.teardown();
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('teardown is idempotent — kills run at most once across repeated calls', async () => {
  let calls = 0;
  const lc = new RunLifecycle();
  lc.register('x', () => { calls += 1; });
  await lc.teardown();
  await lc.teardown();
  await lc.teardown();
  assert.equal(calls, 1);
});

test('a throwing kill does not strand siblings; teardown still resolves', async () => {
  const ran = [];
  const lc = new RunLifecycle();
  lc.register('first', () => ran.push('first'));
  lc.register('boom', () => { throw new Error('kill failed'); });
  lc.register('last', () => ran.push('last'));
  await assert.doesNotReject(() => lc.teardown());
  // reverse order: last, boom(throws), first — both non-throwing siblings ran
  assert.deepEqual(ran, ['last', 'first']);
});

test('empty manager teardown is a clean no-op', async () => {
  const lc = new RunLifecycle();
  await assert.doesNotReject(() => lc.teardown());
});

test('async kill fns are awaited', async () => {
  const done = [];
  const lc = new RunLifecycle();
  lc.register('slow', async () => { await new Promise((r) => setTimeout(r, 10)); done.push('slow'); });
  await lc.teardown();
  assert.deepEqual(done, ['slow']);
});
