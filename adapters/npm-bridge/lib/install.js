'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  assetSlug,
  downloadUrl,
  checksumsUrl,
  assetFileName,
  binaryName,
} = require('./platform');

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

// Fetch SHA256SUMS.txt from the release and return the expected digest for
// `asset`. Every failure mode below is distinct and named: a user who hits one
// needs to know whether the release is missing its checksums, the manifest is
// malformed, or this specific archive simply is not listed.
async function expectedDigestFor(fetcher, version, asset) {
  const url = checksumsUrl(version);
  let body;
  try {
    body = await fetchBuffer(fetcher, url);
  } catch (e) {
    throw verificationError(
      `Cannot verify the download: SHA256SUMS.txt could not be fetched from ${url} (${e.message}). ` +
        'Refusing to install an unverified binary.',
      'CHECKSUMS_UNAVAILABLE'
    );
  }

  const sums = parseChecksums(body.toString('utf8'));
  if (sums.size === 0) {
    throw verificationError(
      `Cannot verify the download: SHA256SUMS.txt at ${url} contains no readable ` +
        '"<sha256>  <filename>" lines. Refusing to install an unverified binary.',
      'CHECKSUMS_UNPARSEABLE'
    );
  }

  const expected = sums.get(asset);
  if (!expected) {
    throw verificationError(
      `Cannot verify the download: SHA256SUMS.txt at ${url} has no checksum entry for ${asset}. ` +
        `It lists: ${[...sums.keys()].join(', ')}. Refusing to install an unverified binary.`,
      'CHECKSUM_ENTRY_MISSING'
    );
  }
  return expected;
}

// Download the tarball to a temp file, VERIFY its SHA-256 against the release's
// published SHA256SUMS.txt, then extract the binary into binaryDir, chmod it
// executable, and return its path.
//
// Verification sits strictly between download and extraction: nothing is
// extracted, chmodded or executed until the digest matches. Every failure path
// removes the temp tarball, so a rejected archive is not left on disk.
//
// `fetcher` is a seam for tests (same shape as follow()); production uses follow().
async function download(version, slug, { fetcher = follow } = {}) {
  const url = downloadUrl(version, slug);
  const asset = assetFileName(version, slug);
  const dir = binaryDir(version, slug);
  fs.mkdirSync(dir, { recursive: true });
  const tmpTar = path.join(os.tmpdir(), `actions-json-mcp-${version}-${slug}.tar.gz`);

  try {
    const actual = await fetchToFileHashing(fetcher, url, tmpTar);
    const expected = await expectedDigestFor(fetcher, version, asset);

    if (actual !== expected) {
      throw verificationError(
        `Checksum mismatch for ${asset}: the release publishes SHA-256 ${expected} but the ` +
          `file downloaded from ${url} hashes to ${actual}. The download was corrupted or ` +
          'tampered with. Refusing to install it.',
        'CHECKSUM_MISMATCH'
      );
    }

    // Verified. Only now may we extract and mark anything executable.
    execFileSync('tar', ['-xzf', tmpTar, '-C', dir, binaryName(slug)], {
      stdio: 'inherit',
    });
    const bin = binaryPath(version, slug);
    if (process.platform !== 'win32') {
      fs.chmodSync(bin, 0o755);
    }
    return bin;
  } finally {
    fs.rmSync(tmpTar, { force: true });
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
    `Downloading actions-json-mcp ${version} (${slug}) and verifying its published SHA-256...\n`
  );
  return download(version, slug);
}

module.exports = {
  ensureBinary,
  binaryPath,
  packageVersion,
  download,
  parseChecksums,
};
