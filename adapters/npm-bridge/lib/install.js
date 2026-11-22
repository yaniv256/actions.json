'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  assetSlug,
  downloadUrl,
  manifestUrl,
  signatureUrl,
  assetFileName,
  binaryName,
} = require('./platform');
const trust = require('./release-trust.json');
const { validateManifest, selectAsset } = require('./release-trust.cjs');

// The bridge binary version to download. This is pinned separately from the
// package version so the wrapper can ship changes (e.g. the bundled dictionary)
// without rebuilding identical bridge binaries. Falls back to the package
// version if the pin isn't set.
function packageVersion() {
  const pkg = require('../package.json');
  return pkg.bridgeBinaryVersion || pkg.version;
}

// Where we cache the downloaded binary: alongside the package, keyed by version
// + slug so a version bump re-downloads rather than running a stale binary.
function binaryDir(version, slug) {
  return path.join(__dirname, '..', '.bin', `${version}-${slug}`);
}

function binaryPath(version, slug) {
  return path.join(binaryDir(version, slug), binaryName(slug));
}

function follow(url, redirectsLeft, cb) {
  https
    .get(url, { headers: { 'User-Agent': 'actions-json-bridge-npx' } }, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectsLeft <= 0) {
          cb(new Error('too many redirects'));
          return;
        }
        res.resume();
        follow(res.headers.location, redirectsLeft - 1, cb);
        return;
      }
      if (res.statusCode !== 200) {
        cb(new Error(`download failed: HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      cb(null, res);
    })
    .on('error', cb);
}

// Parse a SHA256SUMS.txt body into filename -> lowercase hex digest.
//
// The producing side is scripts/release-binaries.sh, which appends
// `shasum -a 256 <file>` (falling back to `sha256sum <file>`). Both emit
// `<64 hex><two spaces><filename>`. We also accept the GNU binary-mode marker
// (` *file`) and single-space separators so a coreutils flag change upstream
// cannot silently brick every install. Unrecognised lines are ignored; a body
// with no recognisable line at all yields an empty map, which the caller treats
// as unparseable and fails closed on.
function parseChecksums(text) {
  const map = new Map();
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line);
    if (!m) continue;
    map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

function verificationError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Read a URL into a Buffer via the injected fetcher (defaults to follow()).
function fetchBuffer(fetcher, url) {
  return new Promise((resolve, reject) => {
    fetcher(url, 5, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

// Stream a URL to a file via the injected fetcher, hashing as it goes so the
// tarball is never read into memory twice. Resolves with the hex digest.
function fetchToFileHashing(fetcher, url, destPath) {
  return new Promise((resolve, reject) => {
    fetcher(url, 5, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(destPath);
      res.on('error', reject);
      out.on('error', reject);
      res.on('data', (c) => hash.update(c));
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(hash.digest('hex'))));
    });
  });
}

// Authenticate the exact release manifest against the installer-pinned channel
// key, then select one platform asset from that signed statement. The sibling
// SHA256SUMS file is compatibility metadata and is deliberately not consulted.
async function verifiedReleaseAsset(fetcher, version, slug) {
  const manifestLocation = manifestUrl(version);
  const signatureLocation = signatureUrl(version);
  let manifestBytes;
  let signatureBytes;
  try {
    [manifestBytes, signatureBytes] = await Promise.all([
      fetchBuffer(fetcher, manifestLocation),
      fetchBuffer(fetcher, signatureLocation),
    ]);
  } catch (e) {
    throw verificationError(
      `Cannot verify the download: signed release metadata could not be fetched (${e.message}). Refusing to install an unverified binary.`,
      'SIGNED_MANIFEST_UNAVAILABLE'
    );
  }
  const manifest = validateManifest(manifestBytes, signatureBytes, trust, { channel: 'stable', version });
  return selectAsset(manifest, {
    platform: slug.startsWith('win-') ? 'windows' : slug.split('-')[0],
    arch: slug.split('-')[1],
    kind: 'cli',
  });
}

// Download the tarball into an owner-private, same-filesystem staging directory,
// authenticate its signed-manifest entry, then atomically publish the extracted
// binary into binaryDir. Concurrent installers may race through verification,
// but only a complete staged directory can become the cache winner.
//
// Verification sits strictly between download and extraction: nothing is
// extracted, chmodded or executed until the digest matches. Every failure path
// removes its private staging directory, so a rejected archive is not left on
// disk and another process can never observe a partial cache entry.
//
// `fetcher` is a seam for tests (same shape as follow()); production uses follow().
async function download(version, slug, { fetcher = follow } = {}) {
  const url = downloadUrl(version, slug);
  const asset = assetFileName(version, slug);
  const dir = binaryDir(version, slug);
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, `.${version}-${slug}-`));
  const tmpTar = path.join(stage, asset);

  try {
    const releaseAsset = await verifiedReleaseAsset(fetcher, version, slug);
    if (releaseAsset.filename !== asset) {
      throw verificationError(`Signed manifest selected ${releaseAsset.filename}, expected ${asset}.`, 'ASSET_NAME_MISMATCH');
    }
    const actual = await fetchToFileHashing(fetcher, url, tmpTar);
    const expected = releaseAsset.sha256;

    if (actual !== expected) {
      throw verificationError(
        `Checksum mismatch for ${asset}: the release publishes SHA-256 ${expected} but the ` +
          `file downloaded from ${url} hashes to ${actual}. The download was corrupted or ` +
          'tampered with. Refusing to install it.',
        'CHECKSUM_MISMATCH'
      );
    }

    // Verified. Only now may we extract and mark anything executable.
    execFileSync('tar', ['-xzf', tmpTar, '-C', stage, binaryName(slug)], {
      stdio: 'inherit',
    });
    const stagedBin = path.join(stage, binaryName(slug));
    if (process.platform !== 'win32') {
      fs.chmodSync(stagedBin, 0o755);
    }
    fs.rmSync(tmpTar, { force: true });
    try {
      fs.renameSync(stage, dir);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !fs.statSync(binaryPath(version, slug), { throwIfNoEntry: false })?.isFile()) {
        throw error;
      }
    }
    return binaryPath(version, slug);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Ensure the binary exists locally; download it on first run. Returns the path.
async function ensureBinary() {
  const version = packageVersion();
  const slug = assetSlug(process.platform, process.arch);
  if (!slug) {
    const msg =
      `No prebuilt actions-json-mcp binary for ${process.platform}-${process.arch} yet.\n` +
      'Build it from source instead:\n' +
      '  git clone https://github.com/yaniv256/actions.json.git\n' +
      '  cd actions.json\n' +
      '  cargo build --release --manifest-path mcp/actions-json-mcp/Cargo.toml\n' +
      'then run mcp/target/release/actions-json-mcp.';
    const e = new Error(msg);
    e.code = 'UNSUPPORTED_PLATFORM';
    throw e;
  }
  const bin = binaryPath(version, slug);
  if (fs.existsSync(bin)) {
    return bin;
  }
  process.stderr.write(
    `Downloading actions-json-mcp ${version} (${slug}) and verifying its signed release manifest...\n`
  );
  return download(version, slug);
}

module.exports = {
  ensureBinary,
  binaryPath,
  packageVersion,
  download,
  parseChecksums,
  verifiedReleaseAsset,
};
