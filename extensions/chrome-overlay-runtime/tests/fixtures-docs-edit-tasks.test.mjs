// EVAL-U1 shape guard: the Docs-edit task fixture must stay well-formed so the eval
// harness (baseline reset, run loop, scoring) can trust it. Covers AE3 (every baseline
// reference resolves to exactly one known baseline).
import { test } from 'node:test';
import assert from 'node:assert';
import { DOCS_EDIT_TASKS, BASELINE_PARAGRAPHS, KNOWN_BASELINES } from './live/fixtures/docs-edit-tasks.mjs';

test('fixture holds the full 20-task set', () => {
  assert.equal(DOCS_EDIT_TASKS.length, 20, 'expected the full 20-task goal-run set');
});

test('every task has id, prompt, and a baseline reference', () => {
  for (const t of DOCS_EDIT_TASKS) {
    assert.ok(Number.isInteger(t.id), `task id must be an integer: ${JSON.stringify(t)}`);
    assert.ok(typeof t.prompt === 'string' && t.prompt.trim().length > 0, `task ${t.id} needs a non-empty prompt`);
    assert.ok(typeof t.baseline === 'string' && t.baseline.length > 0, `task ${t.id} needs a baseline reference`);
  }
});

test('task ids are unique (a duplicate id would collide in the run report)', () => {
  const ids = DOCS_EDIT_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'task ids must be unique');
});

test('every baseline reference resolves to exactly one known baseline (AE3)', () => {
  for (const t of DOCS_EDIT_TASKS) {
    assert.ok(KNOWN_BASELINES.has(t.baseline), `task ${t.id} references unknown baseline ${JSON.stringify(t.baseline)}`);
  }
});

test('every task carries at least one scoring assertion', () => {
  for (const t of DOCS_EDIT_TASKS) {
    const hasAssertion =
      (Array.isArray(t.must) && t.must.length > 0) ||
      (Array.isArray(t.must_not) && t.must_not.length > 0) ||
      (Array.isArray(t.must_para_start) && t.must_para_start.length > 0);
    assert.ok(hasAssertion, `task ${t.id} has no scoring assertion (must / must_not / must_para_start)`);
  }
});

test('the baseline document is non-empty and deterministic', () => {
  assert.ok(Array.isArray(BASELINE_PARAGRAPHS) && BASELINE_PARAGRAPHS.length > 0, 'baseline paragraphs must be present');
  for (const p of BASELINE_PARAGRAPHS) assert.ok(typeof p === 'string', 'each baseline paragraph is a string');
});
