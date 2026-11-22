import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

function setup(counter = 7, binaryVersion = '0.1.300') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-install-'));
  const release = path.join(dir, 'release'); fs.mkdirSync(release);
  const payload = path.join(dir, 'payload'); fs.mkdirSync(payload);
  const binary = path.join(payload, 'actions-json');
  fs.writeFileSync(binary, `#!/usr/bin/env sh\nif [ "$1" = version ]; then echo '{"result":{"version":"${binaryVersion}"}}'; fi\nexit 0\n`); fs.chmodSync(binary, 0o755);
  const assetName = 'actions-json-0.1.300-linux-x64.tar.gz';
  execFileSync('tar', ['-czf', path.join(release, assetName), '-C', payload, 'actions-json']);
  const asset = fs.readFileSync(path.join(release, assetName));
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const manifest = { schema_version: 1, channel: 'stable', key_id: 'actions-json-stable-2026-01', release_counter: counter, version: '0.1.300', commit: 'abc', generated_at: new Date(0).toISOString(), assets: [{ filename: assetName, kind: 'cli', platform: 'linux', arch: 'x64', bytes: asset.length, sha256: crypto.createHash('sha256').update(asset).digest('hex') }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(release, 'release-manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(release, 'release-manifest.sig'), crypto.sign('sha256', manifestBytes, keys.privateKey));
  let installer = fs.readFileSync(path.join(root, 'install-actions-json.sh'), 'utf8');
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).trim();
  installer = installer.replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/, publicPem);
  const installerPath = path.join(dir, 'install.sh'); fs.writeFileSync(installerPath, installer); fs.chmodSync(installerPath, 0o755);
  return { dir, release, installerPath };
}

function run(f, prefix, cwd = f.dir, extra = []) {
  return spawnSync('bash', [f.installerPath, '--version', '0.1.300', '--prefix', prefix, '--base-url', `file://${f.release}`, ...extra], { cwd, env: { ...process.env, HOME: path.join(f.dir, 'home'), XDG_STATE_HOME: path.join(f.dir, 'state') }, encoding: 'utf8' });
}

test('clean install verifies and creates canonical command plus safe aj alias', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix'); const result = run(f, prefix);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readlinkSync(path.join(prefix, 'bin', 'aj')), 'actions-json');
  assert.match(execFileSync(path.join(prefix, 'bin', 'actions-json'), ['version'], { encoding: 'utf8' }), /0\.1\.300/);
  const config = JSON.parse(fs.readFileSync(path.join(f.dir, 'home', '.actions-json', 'config.json'), 'utf8'));
  assert.deepEqual(config, {
    schema_version: 1,
    state_dir: path.join(f.dir, 'state', 'actions-json'),
    bind: fs.existsSync('/proc/sys/kernel/osrelease') && fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase().includes('microsoft')
      ? '0.0.0.0:17345'
      : '127.0.0.1:17345',
    storage_root: path.join(f.dir, 'home', '.local', 'share', 'actions-json', 'storage'),
  });
});

test('installer migrates legacy credentials into canonical config without changing them', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix');
  const home = path.join(f.dir, 'home'); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.actions-json.local.json'), JSON.stringify({
    bridge_handshake_secret: 'fixture-secret',
    openai_api_key: 'fixture-key',
  }));
  const result = run(f, prefix);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(home, '.actions-json', 'config.json'), 'utf8'));
  assert.equal(config.bridge_handshake_secret, 'fixture-secret');
  assert.equal(config.openai_api_key, 'fixture-key');
  assert.equal(config.schema_version, 1);
  assert.ok(config.state_dir);
  assert.ok(config.bind);
  assert.ok(config.storage_root);
});

test('installer writes explicit durable runtime settings and rejects conflicting upgrades', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix');
  const first = run(f, prefix, f.dir, ['--bind', '127.0.0.1:18445', '--storage-root', path.join(f.dir, 'storage'), '--actions', path.join(f.dir, 'actions.json')]);
  assert.equal(first.status, 0, first.stderr);
  const configPath = path.join(f.dir, 'home', '.actions-json', 'config.json');
  const firstConfig = fs.readFileSync(configPath, 'utf8');
  assert.match(firstConfig, /18445/);
  const conflicting = run(f, prefix, f.dir, ['--bind', '127.0.0.1:19445']);
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /--bind conflicts with existing config/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), firstConfig);
});

test('failed activation rolls back a newly-created installation config', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix');
  const bin = path.join(prefix, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const installed = path.join(bin, 'actions-json');
  fs.writeFileSync(installed, '#!/usr/bin/env sh\nexit 17\n'); fs.chmodSync(installed, 0o755);
  const result = run(f, prefix);
  assert.equal(result.status, 17);
  assert.equal(
    fs.existsSync(path.join(f.dir, 'home', '.actions-json', 'config.json')),
    false,
  );
});

test('occupied aj is preserved and project pin mismatch fails closed', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix'); fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'aj'), 'mine');
  assert.equal(run(f, prefix).status, 0); assert.equal(fs.readFileSync(path.join(prefix, 'bin', 'aj'), 'utf8'), 'mine');
  const project = path.join(f.dir, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, '.actions-json-version'), '9.9.9\n');
  const mismatch = run(f, path.join(f.dir, 'other'), project); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /pins actions-json/);
});

test('signed archive is rejected when its executable reports another version', () => {
  const f = setup(7, '0.1.3000');
  const result = run(f, path.join(f.dir, 'prefix'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate binary version mismatch/);
});

test('monotonic counter rejects downgrade unless explicit recovery is requested', () => {
  const high = setup(8); const prefix = path.join(high.dir, 'prefix'); assert.equal(run(high, prefix).status, 0);
  const low = setup(7); const sharedState = path.join(high.dir, 'state');
  const invoke = (extra = []) => spawnSync('bash', [low.installerPath, '--version', '0.1.300', '--prefix', prefix, '--base-url', `file://${low.release}`, ...extra], { cwd: low.dir, env: { ...process.env, HOME: path.join(high.dir, 'home'), XDG_STATE_HOME: sharedState }, encoding: 'utf8' });
  assert.match(invoke().stderr, /downgrade refused/); assert.equal(invoke(['--recover']).status, 0);
});

test('Windows installer persists BOM-free config and rolls back the installation tuple', () => {
  const source = fs.readFileSync(path.join(root, 'install-actions-json.ps1'), 'utf8');
  assert.match(source, /Text\.UTF8Encoding\(\$false\)/);
  assert.match(source, /StateDir conflicts with existing config/);
  assert.match(source, /binaryBackup/);
  assert.match(source, /aliasBackup/);
  assert.match(source, /counterBackup/);
  // Bridge passphrase: prompted securely, never replacing an existing secret.
  assert.match(source, /Read-Host -AsSecureString 'Bridge passphrase'/);
  assert.match(source, /if \(-not \$existingSecret\)/);
  assert.match(source, /ACTIONS_JSON_BRIDGE_SECRET must be at least/);
});

function runWithEnv(f, prefix, env, extra = []) {
  return spawnSync('bash', [f.installerPath, '--version', '0.1.300', '--prefix', prefix, '--base-url', `file://${f.release}`, ...extra], { cwd: f.dir, env: { ...process.env, HOME: path.join(f.dir, 'home'), XDG_STATE_HOME: path.join(f.dir, 'state'), ...env }, encoding: 'utf8' });
}

test('installer stores a chosen bridge passphrase without echoing it', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix');
  const result = runWithEnv(f, prefix, { ACTIONS_JSON_BRIDGE_SECRET: '  quiet-fox9  ' });
  assert.equal(result.status, 0, result.stderr);
  const configPath = path.join(f.dir, 'home', '.actions-json', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.bridge_handshake_secret, 'quiet-fox9');
  assert.equal((fs.statSync(configPath).mode & 0o777), 0o600);
  assert.equal(`${result.stdout}${result.stderr}`.includes('quiet-fox9'), false);
  assert.match(result.stdout, /bridge passphrase saved/);
});

test('installer rejects a bridge passphrase shorter than the minimum before installing', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix');
  const result = runWithEnv(f, prefix, { ACTIONS_JSON_BRIDGE_SECRET: 'short' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /at least 8 characters/);
  assert.equal(fs.existsSync(path.join(prefix, 'bin', 'actions-json')), false);
});

test('installer never replaces an existing bridge secret', () => {
  const f = setup(); const prefix = path.join(f.dir, 'prefix');
  const home = path.join(f.dir, 'home'); fs.mkdirSync(path.join(home, '.actions-json'), { recursive: true });
  fs.writeFileSync(path.join(home, '.actions-json', 'config.json'), JSON.stringify({ schema_version: 1, bridge_handshake_secret: 'already-paired-secret' }));
  const result = runWithEnv(f, prefix, { ACTIONS_JSON_BRIDGE_SECRET: 'a-different-one' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(home, '.actions-json', 'config.json'), 'utf8'));
  assert.equal(config.bridge_handshake_secret, 'already-paired-secret');
});
