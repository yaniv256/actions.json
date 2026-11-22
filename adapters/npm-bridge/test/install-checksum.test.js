'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');

const install = require('../lib/install');
const platform = require('../lib/platform');
const trust = require('../lib/release-trust.json');

function fetcher(routes) {
  return (url, _redirects, callback) => {
    const key = Object.keys(routes).find((candidate) => url.endsWith(candidate));
    if (!key) return callback(new Error(`404 ${url}`));
    callback(null, Readable.from([routes[key]]));
  };
}

function scenario(t, { tamperManifest = false, tamperAsset = false } = {}) {
  const version = `0.0.0-signed-${process.pid}-${Date.now()}-${Math.random()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-npm-signed-'));
  const stage = path.join(dir, 'stage'); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'actions-json'), 'REAL BINARY\n');
  const asset = platform.assetFileName(version, 'linux-x64');
  execFileSync('tar', ['-czf', path.join(dir, asset), '-C', stage, 'actions-json']);
  const good = fs.readFileSync(path.join(dir, asset));
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const prior = JSON.parse(JSON.stringify(trust.keys[0]));
  trust.keys[0].public_key_pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = { schema_version: 1, channel: 'stable', key_id: trust.keys[0].key_id, release_counter: 8, version, commit: 'abc', generated_at: new Date(0).toISOString(), assets: [{ filename: asset, kind: 'cli', platform: 'linux', arch: 'x64', bytes: good.length, sha256: crypto.createHash('sha256').update(good).digest('hex') }] };
  let bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = crypto.sign('sha256', bytes, pair.privateKey);
  if (tamperManifest) bytes = Buffer.from(bytes.toString().replace('abc', 'def'));
  const bad = Buffer.from(good); if (tamperAsset) bad[bad.length - 1] ^= 1;
  const routes = { 'release-manifest.json': bytes, 'release-manifest.sig': signature, [asset]: tamperAsset ? bad : good };
  const bin = install.binaryPath(version, 'linux-x64');
  t.after(() => { Object.assign(trust.keys[0], prior); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.dirname(bin), { recursive: true, force: true }); });
  return { version, bin, fetcher: fetcher(routes) };
}

test('npm compatibility download trusts the signed manifest before extracting', async (t) => {
  const item = scenario(t);
  assert.equal(await install.download(item.version, 'linux-x64', { fetcher: item.fetcher }), item.bin);
  assert.equal(fs.readFileSync(item.bin, 'utf8'), 'REAL BINARY\n');
});

test('concurrent verified downloads publish one complete atomic cache entry', async (t) => {
  const item = scenario(t);
  const paths = await Promise.all([
    install.download(item.version, 'linux-x64', { fetcher: item.fetcher }),
    install.download(item.version, 'linux-x64', { fetcher: item.fetcher }),
  ]);
  assert.deepEqual(paths, [item.bin, item.bin]);
  assert.equal(fs.readFileSync(item.bin, 'utf8'), 'REAL BINARY\n');
  const siblings = fs.readdirSync(path.dirname(path.dirname(item.bin)));
  assert.equal(siblings.some((name) => name.startsWith(`.${item.version}-linux-x64-`)), false);
});

test('tampered signed metadata fails closed before extraction', async (t) => {
  const item = scenario(t, { tamperManifest: true });
  await assert.rejects(() => install.download(item.version, 'linux-x64', { fetcher: item.fetcher }), { code: 'SIGNATURE_INVALID' });
  assert.equal(fs.existsSync(item.bin), false);
});

test('asset corruption is rejected against the signed digest', async (t) => {
  const item = scenario(t, { tamperAsset: true });
  await assert.rejects(() => install.download(item.version, 'linux-x64', { fetcher: item.fetcher }), { code: 'CHECKSUM_MISMATCH' });
  assert.equal(fs.existsSync(item.bin), false);
});

test('same-channel checksum text is retained only as a compatibility parser, not a trust root', () => {
  assert.equal(install.parseChecksums(`${'a'.repeat(64)}  x.tar.gz\n`).get('x.tar.gz'), 'a'.repeat(64));
});
