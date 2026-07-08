// EVAL-U5 orchestrator control-flow tests (no real session/money): inject fake bridge +
// cdp to prove aggregation, timeout-as-failure, run-continues-past-failure, and per-trial
// artifact capture. Covers AE2 (K/N error rate) and R9 (artifacts incl. failures).
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runEval } from './live/eval/run-eval.mjs';
import { BASELINE_TEXT } from './live/eval/baseline.mjs';

// A bridge fake that emits ONE response event then goes idle — models a real session
// (the driver requires seeing activity before it accepts idle-as-done, so a fake that
// only ever returns idle would never complete). quietMs:0 in opts makes it instant.
function makeBridge() {
  let emitted = false;
  let seq = 0;
  return {
    start: async () => ({ ok: true }),
    // Reset per task: each userMessage begins a new response, so the next awaitEvent
    // emits one event (so the driver sees activity) before going idle. Without the reset,
    // task 2 would only ever see idle and spin to the ceiling.
    userMessage: async () => { emitted = false; return { ok: true }; },
    awaitEvent: async () => {
      if (!emitted) { emitted = true; return { output: { events: [{ seq: ++seq, type: 'response.done' }] } }; }
      return { output: { idle: true, silent_ms: 5000 } };
    },
    stop: async () => ({ ok: true }),
  };
}

// A cdp fake: the loop reads twice per task (after reset → pristine; after edit →
// the scripted result). Return pristine baseline then the per-task actual, in order.
function makeStatefulCdp(tasks, actualByTaskId) {
  const order = [];
  for (const t of tasks) { order.push(BASELINE_TEXT); order.push(actualByTaskId[t.id]); }
  let call = 0;
  return {
    sleep: () => Promise.resolve(), pressChord: async () => {}, insertText: async () => {},
    readText: async () => order[call++],
  };
}

test('aggregates K/N error rate and flags <5% (AE2)', async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'eval-run-'));
  const tasks = [
    { id: 1, prompt: 'fix recieve', must: ['receive'], must_not: ['recieve'] },
    { id: 2, prompt: 'fix feild', must: ['field'], must_not: ['feild'] },
  ];
  const cdp = makeStatefulCdp(tasks, { 1: 'receive ok', 2: 'feild still wrong' }); // task 2 fails
  const r = await runEval({ bridge: makeBridge(), cdp }, { tasks, runDir, quietMs: 0 });
  assert.equal(r.total, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.errorRate, 0.5);
  assert.equal(r.clearsGoal, false);
});

test('writes a per-trial artifact for every trial incl. failures (R9)', async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'eval-run-'));
  const tasks = [{ id: 7, prompt: 'x', must: ['present'], must_not: [] }];
  let call = 0;
  const cdp = {
    sleep: () => Promise.resolve(), pressChord: async () => {}, insertText: async () => {},
    readText: async () => (call++ === 0 ? BASELINE_TEXT : 'nope not there'),
  };
  await runEval({ bridge: makeBridge(), cdp }, { tasks, runDir, quietMs: 0 });
  const files = readdirSync(runDir);
  const trialFile = files.find((f) => f.startsWith('trial-07'));
  assert.ok(trialFile && trialFile.includes('FAIL'), `expected a FAIL trial artifact, got ${files}`);
  const trial = JSON.parse(readFileSync(path.join(runDir, trialFile), 'utf8'));
  assert.equal(trial.id, 7);
  assert.ok('actual' in trial && Array.isArray(trial.fails));
  assert.ok(files.includes('summary.json'));
});

test('a baseline that never lands is a failed trial, not a crash', async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), 'eval-run-'));
  const tasks = [{ id: 3, prompt: 'x', must: ['whatever'] }];
  const cdp = {
    sleep: () => Promise.resolve(), pressChord: async () => {}, insertText: async () => {},
    readText: async () => 'garbage that is not the pristine baseline', // isPristine → false
  };
  const r = await runEval({ bridge: makeBridge(), cdp }, { tasks, runDir, quietMs: 0 });
  assert.equal(r.failed, 1);
  assert.ok(r.trials[0].fails.join(' ').toLowerCase().includes('baseline'));
});
