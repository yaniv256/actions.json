import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.join(import.meta.dirname, '../release-binaries.sh');

function run(...args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-json-release-fault-'));
  const key = path.join(root, 'readable-test-key');
  fs.writeFileSync(key, 'not used because the contract must fail before signing');
  return spawnSync('bash', [script, '--version', '0.1.300', '--counter', '1', '--signing-key', key, '--no-upload', ...args], {
    encoding: 'utf8',
  });
}

test('executable release gate rejects a partial native platform matrix before building', () => {
  const result = run('--platforms', 'linux-x64');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /complete releases require the extension and all four native platforms/);
  assert.doesNotMatch(result.stderr, /Compiling|creating release|uploading/);
});

test('executable release gate rejects an extension-less release before building', () => {
  const result = run('--no-extension');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /complete releases require the extension and all four native platforms/);
  assert.doesNotMatch(result.stderr, /Compiling|creating release|uploading/);
});
