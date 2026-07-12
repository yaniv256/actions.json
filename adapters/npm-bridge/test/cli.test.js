'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('--version reports the npm wrapper version without downloading a binary', () => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.trim(), '0.1.204');
  assert.strictEqual(result.stderr, '');
});
