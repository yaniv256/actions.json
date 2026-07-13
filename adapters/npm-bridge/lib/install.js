'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { assetSlug, downloadUrl, binaryName } = require('./platform');

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

// Download the tarball to a temp file, extract the binary into binaryDir, chmod
// it executable, and return its path. Synchronous-feeling via a callback the CLI
// awaits.
function download(version, slug) {
  return new Promise((resolve, reject) => {
    const url = downloadUrl(version, slug);
    const dir = binaryDir(version, slug);
    fs.mkdirSync(dir, { recursive: true });
    const tmpTar = path.join(os.tmpdir(), `actions-json-mcp-${version}-${slug}.tar.gz`);
    const out = fs.createWriteStream(tmpTar);

    follow(url, 5, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try {
            // Extract just the binary from the tarball into dir.
            execFileSync('tar', ['-xzf', tmpTar, '-C', dir, binaryName(slug)], {
              stdio: 'inherit',
            });
            const bin = binaryPath(version, slug);
            if (process.platform !== 'win32') {
              fs.chmodSync(bin, 0o755);
            }
            fs.rmSync(tmpTar, { force: true });
            resolve(bin);
          } catch (e) {
            reject(e);
          }
        });
      });
      out.on('error', reject);
    });
  });
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
  process.stderr.write(`Downloading actions-json-mcp ${version} (${slug})...\n`);
  return download(version, slug);
}

module.exports = { ensureBinary, binaryPath, packageVersion };
