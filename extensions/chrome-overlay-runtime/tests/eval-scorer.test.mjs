// EVAL-U4 scorer unit tests. Covers VC3: match / mismatch / variant-acceptance /
// must_not / structural / normalization. Mirrors the goal-run check.py behavior.
import { test } from 'node:test';
import assert from 'node:assert';
import { scoreTask, normalize, neighborhoodDiff } from './live/eval/scorer.mjs';
import { DOCS_EDIT_TASKS } from './live/fixtures/docs-edit-tasks.mjs';

const byId = (id) => DOCS_EDIT_TASKS.find((t) => t.id === id);

test('happy path: must + must_not both satisfied → pass', () => {
  const t = byId(1); // recieve → receive
  const r = scoreTask(t, 'Volunteers receive a weekly digest with new sightings.');
  assert.ok(r.pass, JSON.stringify(r.fails));
});

test('mismatch: must present but must_not still present → fail', () => {
  const t = byId(1);
  const r = scoreTask(t, 'Volunteers recieve a weekly digest. receive a weekly digest');
  assert.equal(r.pass, false);
  assert.ok(r.fails.some((f) => f.includes('recieve')), r.fails.join('; '));
});

test('mismatch: must missing → fail', () => {
  const t = byId(8); // 50% → 60%
  const r = scoreTask(t, 'About 55% of submissions pass review.');
  assert.equal(r.pass, false);
  assert.ok(r.fails.some((f) => f.includes('60%')));
});

test('must_any: accepts either straight or curly apostrophe variant', () => {
  const t = byId(5); // Its → It's / It’s
  assert.ok(scoreTask(t, "It's worth doing carefully.").pass, 'straight quote variant');
  assert.ok(scoreTask(t, 'It’s worth doing carefully.').pass, 'curly quote variant');
});

test('must_any: fails when neither variant is present', () => {
  const t = byId(5);
  const r = scoreTask(t, 'Its worth doing carefully.');
  assert.equal(r.pass, false);
  assert.ok(r.fails.some((f) => f.includes('variants') || f.includes('Its worth')));
});

test('must_para_start: passes only when a paragraph actually starts with the needle', () => {
  const t = byId(18); // split at "The onboarding takes"
  assert.ok(scoreTask(t, ['To join a survey…', 'The onboarding takes about 15 minutes.']).pass);
  assert.equal(scoreTask(t, ['To join a survey… The onboarding takes about 15 minutes.']).pass, false);
});

test('must-empty + must_not (deletion task): passes when the removed text is gone', () => {
  const t = byId(6); // delete weather sentence
  assert.ok(scoreTask(t, 'Data Quality. Every sighting needs a photo.').pass);
  assert.equal(scoreTask(t, 'The weather this spring was unusually wet.').pass, false);
});

test('normalization: NBSP and smart quotes are folded to plain forms', () => {
  assert.equal(normalize('a b'), 'a b');
  assert.equal(normalize('It’s'), "It's");
  // a curly-quote result satisfies a straight-quote assertion after normalization
  const t = byId(7); // dont → don't / don’t (must_any)
  assert.ok(scoreTask(t, 'unverified and don’t count toward totals').pass);
});

test('scoreTask accepts both a joined string and a paragraph array', () => {
  const t = byId(3); // for for → for
  assert.ok(scoreTask(t, 'The tool has been running for three seasons now.').pass);
  assert.ok(scoreTask(t, ['intro', 'running for three seasons now.']).pass);
});

test('neighborhoodDiff surfaces where a failing assertion landed', () => {
  const t = byId(8);
  const notes = neighborhoodDiff(t, 'About 50% of submissions pass review.');
  assert.ok(notes.length > 0);
  assert.ok(notes.join(' ').includes('60%') || notes.join(' ').includes('50%'));
});
