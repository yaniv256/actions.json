// EVAL-U5: run orchestrator. Loops the task set, aggregates ONE error-rate number, and
// writes per-trial artifacts (pass AND fail) sufficient to root-cause without re-running.
//
// Dependency injection keeps the loop testable: callers pass `bridge` (agent-session
// tools), `cdp` (baseline reset + result read-back), and `callSite` (docs.* — unused by
// the loop itself but reserved). The real wiring (MCP tools + CDP) lives in the operator
// entry (U6); the loop here is pure control flow over those.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOCS_EDIT_TASKS } from '../fixtures/docs-edit-tasks.mjs';
import { scoreTask, neighborhoodDiff } from './scorer.mjs';
import { resetBaseline, isPristine } from './baseline.mjs';
import { driveTask } from './session-driver.mjs';

/**
 * @param {object} deps - { bridge, cdp }.
 * @param {object} opts - { tasks?, runDir?, quietMs?, ceilingMs?, targetUrlContains? }.
 * @returns {Promise<{ total, failed, errorRate, clearsGoal, trials, runDir }>}
 */
export async function runEval(deps, opts = {}) {
  const { bridge, cdp } = deps;
  const tasks = opts.tasks || DOCS_EDIT_TASKS;
  const runDir = opts.runDir || path.join(process.cwd(), 'tests/live/eval/runs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });

  const trials = [];
  let failed = 0;

  for (const task of tasks) {
    const trial = { id: task.id, prompt: task.prompt };
    try {
      // 1) Reset to pristine baseline; verify it actually landed (a silent no-op reset
      //    would score every task against stale text).
      const reset = await resetBaseline(cdp);
      if (!reset.ok) throw new Error(`baseline reset: ${reset.error}`);
      const afterReset = await cdp.readText();
      if (!isPristine(afterReset)) throw new Error('baseline did not land (doc not pristine after reset)');

      // 2) Drive the real agent session on this task.
      const driven = await driveTask(bridge, task, opts);
      trial.timedOut = driven.timedOut;
      trial.toolCalls = driven.toolCalls;
      if (driven.error) trial.driveError = driven.error;

      // 3) Read the result and score.
      const actual = await cdp.readText();
      trial.actual = actual;
      const scored = scoreTask(task, actual);
      trial.pass = scored.pass && !driven.timedOut;
      trial.fails = driven.timedOut ? ['session timeout'] : scored.fails;
      if (!trial.pass) trial.diff = neighborhoodDiff(task, actual);
    } catch (e) {
      // A single task's failure (incl. a reset/timeout error) is a FAILED trial, not an
      // aborted run — the loop continues so one bad task doesn't lose the whole batch.
      trial.pass = false;
      trial.fails = [String(e && e.message || e)];
    }

    if (!trial.pass) failed += 1;
    trials.push(trial);
    // Write each trial artifact AS WE GO so a mid-run crash leaves captured trials on disk.
    writeFileSync(path.join(runDir, `trial-${String(task.id).padStart(2, '0')}-${trial.pass ? 'pass' : 'FAIL'}.json`), JSON.stringify(trial, null, 2));
    console.log(`T${task.id}: ${trial.pass ? 'PASS' : 'FAIL'}${trial.fails?.length ? ' — ' + trial.fails.join('; ') : ''}`);
  }

  const total = trials.length;
  const errorRate = total ? failed / total : 0;
  const clearsGoal = errorRate < 0.05;
  const summary = { total, failed, errorRate, clearsGoal, ranAt: new Date().toISOString() };
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ summary, trials }, null, 2));
  console.log(`\n=== error rate: ${(errorRate * 100).toFixed(1)}% (${failed}/${total} failed) — ${clearsGoal ? 'CLEARS <5% GOAL ✅' : 'does NOT clear <5% ❌'} ===`);
  console.log(`artifacts: ${runDir}`);
  return { ...summary, trials, runDir };
}
