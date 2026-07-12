'use strict';

const test = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');
const { packageVersion } = require('../lib/install');

test('the npm wrapper downloads binaries from its published release', () => {
  assert.strictEqual(pkg.version, '0.1.204');
  assert.strictEqual(packageVersion(), '0.1.204');
});
