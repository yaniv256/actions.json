import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = fs.readFileSync(path.join(ROOT, 'tools/deploy/claim_tab.mjs'), 'utf8');
const harness = fs.readFileSync(path.join(ROOT, 'tests/live/eval/harness-env.mjs'), 'utf8');

test('native claim helper attests extension identity before querying tabs', () => {
  const attestation = helper.indexOf('extension_context_invalid');
  const query = helper.indexOf('const tabs = await chrome.tabs.query');

  assert.notEqual(attestation, -1, 'missing typed extension context failure');
  assert.notEqual(query, -1, 'missing tabs query');
  assert.ok(attestation < query, 'identity attestation must precede privileged tab access');
  assert.match(helper, /chrome\.runtime\.id/);
  assert.match(helper, /actions\.json Overlay Runtime/);
});

test('native claim helper reaps failed popup targets', () => {
  assert.match(helper, /Target\.closeTarget/);
});

test('eval harness never falls back to a historical unpacked extension id', () => {
  assert.doesNotMatch(harness, /dbbgeieflhabcibjmgbohhfmollnhbcp/);
  assert.match(harness, /EVAL_EXTENSION_ID/);
});
