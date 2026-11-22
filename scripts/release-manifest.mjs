#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { validateManifest, verifyAsset } = require('../adapters/npm-bridge/lib/release-trust.cjs');

function args(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith('--')) result._.push(item);
    else result[item.slice(2)] = values[++index];
  }
  return result;
}

function assetMetadata(file, version) {
  const filename = path.basename(file);
  const bridge = new RegExp(`^actions-json-${version}-(linux|macos|win)-(x64|arm64)\\.tar\\.gz$`).exec(filename);
  const extension = filename === `actions-json-overlay-runtime-${version}.zip`;
  const helper = new RegExp(`^chrome-launcher-helper-${version}-(win)-(x64)\\.tar\\.gz$`).exec(filename);
  const match = bridge || helper;
  if (!match && !extension) throw new Error(`unrecognized release asset: ${filename}`);
  const bytes = fs.readFileSync(file);
  return {
    filename,
    kind: extension ? 'extension' : helper ? 'browser-helper' : 'cli',
    platform: extension ? 'browser' : match[1] === 'win' ? 'windows' : match[1],
    arch: extension ? 'any' : match[2],
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export function requiredReleaseAssetNames(version) {
  const platforms = ['linux-x64', 'macos-x64', 'macos-arm64', 'win-x64'];
  return [
    `actions-json-overlay-runtime-${version}.zip`,
    ...platforms.map((platform) => `actions-json-${version}-${platform}.tar.gz`),
    `chrome-launcher-helper-${version}-win-x64.tar.gz`,
  ].sort();
}

export function assertCompleteReleaseAssets(assets, version) {
  const expected = requiredReleaseAssetNames(version);
  const actual = assets.map((asset) => asset.filename).sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length || unexpected.length || new Set(actual).size !== actual.length) {
    const details = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
      new Set(actual).size !== actual.length ? 'duplicate asset names' : '',
    ].filter(Boolean).join('; ');
    throw new Error(`incomplete release asset matrix (${details})`);
  }
  return expected;
}

function sameAssetNames(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    [...left].sort().every((name, index) => name === right[index]);
}

export function main(argv = process.argv.slice(2)) {
const [command, ...rest] = argv;
const options = args(rest);
if (command === 'build') {
  for (const required of ['version', 'counter', 'channel', 'key-id', 'signing-key', 'out-dir']) if (!options[required]) throw new Error(`--${required} is required`);
  const assets = options._.map((file) => assetMetadata(file, options.version)).sort((a, b) => a.filename.localeCompare(b.filename));
  if (!assets.length) throw new Error('at least one release asset is required');
  const requiredAssets = assertCompleteReleaseAssets(assets, options.version);
  const manifest = {
    schema_version: 1,
    release_contract: {
      schema_version: 1,
      profile: 'complete',
      required_assets: requiredAssets,
      installer_config_schema: 1,
    },
    channel: options.channel,
    key_id: options['key-id'],
    release_counter: Number(options.counter),
    version: options.version,
    commit: options.commit || process.env.GITHUB_SHA || 'unknown',
    generated_at: new Date().toISOString(),
    assets,
  };
  if (!Number.isSafeInteger(manifest.release_counter) || manifest.release_counter < 1) throw new Error('--counter must be a positive integer');
  fs.mkdirSync(options['out-dir'], { recursive: true });
  const manifestPath = path.join(options['out-dir'], 'release-manifest.json');
  const signaturePath = path.join(options['out-dir'], 'release-manifest.sig');
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(signaturePath, crypto.sign('sha256', bytes, fs.readFileSync(options['signing-key'])));
  process.stdout.write(`${manifestPath}\n${signaturePath}\n`);
} else if (command === 'required-assets') {
  if (!options.version) throw new Error('--version is required');
  process.stdout.write(`${requiredReleaseAssetNames(options.version).join('\n')}\n`);
} else if (command === 'verify') {
  for (const required of ['manifest', 'signature', 'trust', 'asset-dir']) if (!options[required]) throw new Error(`--${required} is required`);
  const value = validateManifest(fs.readFileSync(options.manifest), fs.readFileSync(options.signature), JSON.parse(fs.readFileSync(options.trust)), {
    channel: options.channel,
    version: options.version,
    minimumCounter: options['minimum-counter'] ? Number(options['minimum-counter']) : undefined,
    allowDowngrade: options['allow-downgrade'] === 'true',
  });
  const requiredAssets = assertCompleteReleaseAssets(value.assets, value.version);
  if (value.release_contract?.schema_version !== 1 || value.release_contract?.profile !== 'complete' ||
      !sameAssetNames(value.release_contract.required_assets, requiredAssets)) {
    throw new Error('signed manifest does not declare the complete release contract');
  }
  for (const asset of value.assets) {
    const assetPath = path.join(options['asset-dir'], asset.filename);
    if (!fs.statSync(assetPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`signed release asset is missing: ${asset.filename}`);
    verifyAsset(fs.readFileSync(assetPath), asset);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, version: value.version, release_counter: value.release_counter })}\n`);
} else {
  throw new Error('usage: release-manifest.mjs build|required-assets|verify ...');
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
