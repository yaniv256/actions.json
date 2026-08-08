import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'write-actions-json', 'SKILL.md');

test('write-actions-json preserves undo and shared human edits after editor incidents', async () => {
  const skill = await readFile(skillPath, 'utf8');

  for (const requiredGuidance of [
    'An Unintended Editor Mutation Is An Incident — Preserve Undo Before Recovery',
    'Prove focus before undo.',
    'Do not reload, navigate, close the tab, broadly replace content',
    "This prohibition overrides an action output's normal reload",
    'Shared Documents Have Multiple Writers — A Read Is Not Authority',
    'Every agent read is a **timestamped observation**',
    'A local manuscript is a fallback source, not a restoration point.',
    'treat every unexplained delta as another writer\'s work',
    'assert that editor-only cues/secrets/forbidden markers are absent',
    'Mutation Scope Is An Interface Contract, Not Operator Memory',
    'Each site action declares an **allowed write-set**',
    'Prove preservation as well as change.',
    'A selection primitive must make its scope visible in its result.',
    'complete selected content',
    '`large_selection` warning',
    'selection receipt',
  ]) {
    assert.match(skill, new RegExp(requiredGuidance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
