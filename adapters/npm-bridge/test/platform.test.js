'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  assetSlug,
  assetFileName,
  downloadUrl,
  binaryName,
} = require('../lib/platform');

test('every supported platform maps to its release slug', () => {
  assert.strictEqual(assetSlug('linux', 'x64'), 'linux-x64');
  assert.strictEqual(assetSlug('darwin', 'x64'), 'macos-x64');
  assert.strictEqual(assetSlug('darwin', 'arm64'), 'macos-arm64');
  assert.strictEqual(assetSlug('win32', 'x64'), 'win-x64');
});

test('unsupported platforms return null (so the CLI can fall back)', () => {
  assert.strictEqual(assetSlug('linux', 'arm64'), null);
  assert.strictEqual(assetSlug('win32', 'arm64'), null);
  assert.strictEqual(assetSlug('freebsd', 'x64'), null);
});

test('windows binary carries .exe; others do not', () => {
  assert.strictEqual(binaryName('win-x64'), 'actions-json-mcp.exe');
  assert.strictEqual(binaryName('linux-x64'), 'actions-json-mcp');
  assert.strictEqual(binaryName('macos-arm64'), 'actions-json-mcp');
});

test('asset file name matches package-mcp-bridge.sh pattern (.tar.gz everywhere)', () => {
  assert.strictEqual(
    assetFileName('0.1.118', 'linux-x64'),
    'actions-json-mcp-0.1.118-linux-x64.tar.gz'
  );
  assert.strictEqual(
    assetFileName('0.1.118', 'win-x64'),
    'actions-json-mcp-0.1.118-win-x64.tar.gz'
  );
});

test('download URL targets the extension-v<version> release tag', () => {
  assert.strictEqual(
    downloadUrl('0.1.118', 'macos-arm64'),
    'https://github.com/yaniv256/actions.json/releases/download/extension-v0.1.118/actions-json-mcp-0.1.118-macos-arm64.tar.gz'
  );
});
