'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');
const { packageVersion } = require('../lib/install');
const { downloadUrl, SUPPORTED } = require('../lib/platform');

test('the binary pin is explicit and syntactically valid', () => {
  assert.strictEqual(packageVersion(), pkg.bridgeBinaryVersion);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+$/);
});

test('every supported binary asset exists in the pinned GitHub release', async () => {
  const slugs = [...new Set(Object.values(SUPPORTED))];
  const results = await Promise.all(slugs.map(async (slug) => {
    const url = downloadUrl(packageVersion(), slug);
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return { slug, status: response.status, url: response.url };
  }));

  assert.deepStrictEqual(
    results.filter(({ status }) => status !== 200),
    [],
    `missing pinned release assets: ${JSON.stringify(results, null, 2)}`
  );
});

test('the packed npm artifact installs and reports its wrapper version in isolation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-json-npm-bridge-'));
  try {
    const packageRoot = path.join(__dirname, '..');
    const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', tmp], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.strictEqual(packed.status, 0, packed.stderr);

    const tarball = path.join(tmp, packed.stdout.trim());
    const prefix = path.join(tmp, 'install');
    const installed = spawnSync(
      'npm',
      ['install', '--silent', '--prefix', prefix, '--cache', path.join(tmp, 'cache'), tarball],
      { encoding: 'utf8' }
    );
    assert.strictEqual(installed.status, 0, installed.stderr);

    const executable = process.platform === 'win32'
      ? path.join(prefix, 'node_modules', '.bin', 'actions-json-bridge.cmd')
      : path.join(prefix, 'node_modules', '.bin', 'actions-json-bridge');
    const version = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: path.join(tmp, 'home') },
    });
    assert.strictEqual(version.status, 0, version.stderr);
    assert.strictEqual(version.stdout.trim(), pkg.version);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
