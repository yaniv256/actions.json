import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { assertCompleteReleaseAssets, requiredReleaseAssetNames } from '../release-manifest.mjs';

const require = createRequire(import.meta.url);
const { validateManifest, selectAsset, verifyAsset } = require('../../adapters/npm-bridge/lib/release-trust.cjs');

function fixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const asset = Buffer.from('native binary');
  const manifest = { schema_version: 1, channel: 'stable', key_id: 'key-1', release_counter: 12, version: '0.1.300', commit: 'abc', generated_at: new Date(0).toISOString(), assets: [{ filename: 'actions-json-0.1.300-linux-x64.tar.gz', kind: 'cli', platform: 'linux', arch: 'x64', bytes: asset.length, sha256: crypto.createHash('sha256').update(asset).digest('hex') }] };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = crypto.sign('sha256', bytes, privateKey);
  const trust = { schema_version: 1, keys: [{ key_id: 'key-1', channel: 'stable', minimum_counter: 10, maximum_counter: 20, revoked: false, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) }] };
  return { asset, bytes, signature, trust };
}

test('accepts an authentic channel-bound monotonic manifest and exact asset', () => {
  const f = fixture();
  const manifest = validateManifest(f.bytes, f.signature, f.trust, { channel: 'stable', version: '0.1.300', minimumCounter: 11 });
  assert.equal(selectAsset(manifest, { platform: 'linux', arch: 'x64' }).filename, 'actions-json-0.1.300-linux-x64.tar.gz');
  assert.equal(verifyAsset(f.asset, manifest.assets[0]), true);
});

for (const [name, mutate, code] of [
  ['tampered manifest', (f) => { f.bytes = Buffer.from(f.bytes.toString().replace('abc', 'def')); }, 'SIGNATURE_INVALID'],
  ['revoked key', (f) => { f.trust.keys[0].revoked = true; }, 'KEY_REVOKED'],
  ['wrong channel', () => {}, 'CHANNEL_MISMATCH'],
  ['downgrade', () => {}, 'DOWNGRADE_REFUSED'],
]) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f);
  const options = name === 'wrong channel' ? { channel: 'beta' } : name === 'downgrade' ? { minimumCounter: 13 } : {};
  assert.throws(() => validateManifest(f.bytes, f.signature, f.trust, options), { code });
});

test('rejects corrupt assets and wrong platform selection', () => {
  const f = fixture();
  const manifest = validateManifest(f.bytes, f.signature, f.trust);
  assert.throws(() => verifyAsset(Buffer.from('corrupt'), manifest.assets[0]), { code: 'ASSET_SIZE_MISMATCH' });
  assert.throws(() => selectAsset(manifest, { platform: 'windows', arch: 'x64' }), { code: 'ASSET_MISSING' });
});

test('accepts an overlapping replacement key only inside its declared counter window', () => {
  const f = fixture();
  const replacement = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const manifest = JSON.parse(f.bytes);
  manifest.key_id = 'key-2'; manifest.release_counter = 18;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = crypto.sign('sha256', bytes, replacement.privateKey);
  f.trust.keys.push({ key_id: 'key-2', channel: 'stable', minimum_counter: 15, maximum_counter: 30, revoked: false, public_key_pem: replacement.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(validateManifest(bytes, signature, f.trust).key_id, 'key-2');
  f.trust.keys[1].minimum_counter = 19;
  assert.throws(() => validateManifest(bytes, signature, f.trust), { code: 'COUNTER_INVALID' });
});

test('release builder and npm installer pin the identical trust registry', () => {
  const releaseTrust = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../release-trust.json')));
  const npmTrust = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../adapters/npm-bridge/lib/release-trust.json')));
  assert.deepEqual(npmTrust, releaseTrust);
});

test('complete release contract requires the exact cross-platform payload matrix', () => {
  const version = '0.1.300';
  const expected = [
    'actions-json-0.1.300-linux-x64.tar.gz',
    'actions-json-0.1.300-macos-arm64.tar.gz',
    'actions-json-0.1.300-macos-x64.tar.gz',
    'actions-json-0.1.300-win-x64.tar.gz',
    'actions-json-overlay-runtime-0.1.300.zip',
    'chrome-launcher-helper-0.1.300-win-x64.tar.gz',
  ];
  const complete = expected.map((filename) => ({ filename }));
  assert.deepEqual(requiredReleaseAssetNames(version), expected);
  assert.deepEqual(assertCompleteReleaseAssets(complete, version), expected);
  assert.throws(() => assertCompleteReleaseAssets(complete.slice(1), version), /incomplete release asset matrix.*missing/);
  assert.throws(
    () => assertCompleteReleaseAssets([...complete, { filename: 'debug-symbols.zip' }], version),
    /incomplete release asset matrix.*unexpected/,
  );
});

test('builder fails closed on a partial matrix and emits a verifiable complete contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-json-release-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = '0.1.300';
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(root, 'key.pem');
  const trustPath = path.join(root, 'trust.json');
  fs.writeFileSync(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(trustPath, JSON.stringify({
    schema_version: 1,
    keys: [{
      key_id: 'test-key', channel: 'stable', minimum_counter: 1, maximum_counter: 9,
      revoked: false, public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    }],
  }));
  const assets = requiredReleaseAssetNames(version).map((filename) => {
    const file = path.join(root, filename);
    fs.writeFileSync(file, `fixture:${filename}`);
    return file;
  });
  const script = path.join(import.meta.dirname, '../release-manifest.mjs');
  assert.throws(() => execFileSync(process.execPath, [script, 'build', '--version', version, '--counter', '2', '--channel', 'stable', '--key-id', 'test-key', '--signing-key', keyPath, '--out-dir', root, ...assets.slice(1)], { stdio: 'pipe' }), /incomplete release asset matrix/);
  execFileSync(process.execPath, [script, 'build', '--version', version, '--counter', '2', '--channel', 'stable', '--key-id', 'test-key', '--signing-key', keyPath, '--out-dir', root, '--commit', 'abc123', ...assets]);
  execFileSync(process.execPath, [script, 'verify', '--manifest', path.join(root, 'release-manifest.json'), '--signature', path.join(root, 'release-manifest.sig'), '--trust', trustPath, '--asset-dir', root, '--channel', 'stable', '--version', version]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json')));
  assert.equal(manifest.release_contract.profile, 'complete');
  assert.deepEqual(manifest.release_contract.required_assets, requiredReleaseAssetNames(version));
  fs.writeFileSync(assets[0], 'corrupt after signing');
  assert.throws(
    () => execFileSync(process.execPath, [script, 'verify', '--manifest', path.join(root, 'release-manifest.json'), '--signature', path.join(root, 'release-manifest.sig'), '--trust', trustPath, '--asset-dir', root], { stdio: 'pipe' }),
    /unexpected byte length|failed SHA-256 verification/,
  );
});
