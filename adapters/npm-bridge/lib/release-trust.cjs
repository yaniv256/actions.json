'use strict';

const crypto = require('node:crypto');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateManifest(manifest, signature, trust, options = {}) {
  const bytes = Buffer.isBuffer(manifest) ? manifest : Buffer.from(manifest);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('MANIFEST_INVALID', 'release manifest is not valid JSON'); }
  if (value.schema_version !== 1 || !Array.isArray(value.assets)) fail('MANIFEST_INVALID', 'unsupported release manifest schema');
  const key = trust.keys.find((candidate) => candidate.key_id === value.key_id);
  if (!key) fail('KEY_UNKNOWN', `release key ${value.key_id} is not trusted`);
  if (key.revoked) fail('KEY_REVOKED', `release key ${value.key_id} is revoked`);
  if (key.channel !== value.channel || (options.channel && options.channel !== value.channel)) fail('CHANNEL_MISMATCH', 'release channel does not match its trusted key');
  if (!Number.isSafeInteger(value.release_counter) || value.release_counter < key.minimum_counter || value.release_counter > key.maximum_counter) fail('COUNTER_INVALID', 'release counter is outside the trusted key window');
  if (Number.isSafeInteger(options.minimumCounter) && value.release_counter < options.minimumCounter && !options.allowDowngrade) fail('DOWNGRADE_REFUSED', `release counter ${value.release_counter} is older than installed counter ${options.minimumCounter}`);
  if (options.version && value.version !== options.version) fail('VERSION_MISMATCH', `release version ${value.version} does not match requested ${options.version}`);
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, 'base64');
  if (!crypto.verify('sha256', bytes, key.public_key_pem, sig)) fail('SIGNATURE_INVALID', 'release manifest signature is invalid');
  return value;
}

function selectAsset(manifest, { platform, arch, kind = 'cli' }) {
  const matches = manifest.assets.filter((asset) => asset.platform === platform && asset.arch === arch && asset.kind === kind);
  if (matches.length !== 1) fail('ASSET_MISSING', `expected exactly one ${kind} asset for ${platform}-${arch}`);
  return matches[0];
}

function verifyAsset(buffer, asset) {
  if (buffer.length !== asset.bytes) fail('ASSET_SIZE_MISMATCH', `asset ${asset.filename} has unexpected byte length`);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (digest !== asset.sha256) fail('ASSET_DIGEST_MISMATCH', `asset ${asset.filename} failed SHA-256 verification`);
  return true;
}

module.exports = { validateManifest, selectAsset, verifyAsset };
