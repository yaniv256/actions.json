'use strict';

// Checksum verification for the downloaded release tarball.
//
// The npm wrapper downloads a release tarball, extracts a binary, chmods it
// executable and then EXECUTES it. Before this suite existed the published
// SHA256SUMS.txt asset was never consulted, so a corrupted or tampered archive
// was run without complaint. These tests pin the fail-closed contract.
//
// Network is stubbed via the `fetcher` seam on download(): the tests never
// touch the real network. The one exception is the real-format test at the
// bottom, which is skipped unless ACTIONS_JSON_LIVE_CHECKSUM=1.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');

const { download, binaryPath, parseChecksums } = require('../lib/install');
const { assetFileName, binaryName } = require('../lib/platform');

const SLUG = 'linux-x64';
const BIN_NAME = binaryName(SLUG);

// Build a real .tar.gz containing the binary, so extraction genuinely succeeds
// on the happy path and we are not testing against a mock archive.
function buildTarball(dir, contents) {
  const staging = fs.mkdtempSync(path.join(dir, 'stage-'));
  fs.writeFileSync(path.join(staging, BIN_NAME), contents, { mode: 0o644 });
  fs.writeFileSync(path.join(staging, 'VERSION'), 'test\n');
  const art = path.join(dir, `${path.basename(staging)}.tar.gz`);
  execFileSync('tar', ['-czf', art, '-C', staging, BIN_NAME, 'VERSION']);
  return fs.readFileSync(art);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// A fetcher with the same shape as follow(url, redirectsLeft, cb): it calls back
// with a readable stream of the body, or with an Error for a missing asset.
function makeFetcher(routes) {
  const seen = [];
  const fetcher = (url, redirectsLeft, cb) => {
    seen.push(url);
    const body = routes[Object.keys(routes).find((k) => url.endsWith(k))];
    if (body === undefined) {
      cb(new Error(`download failed: HTTP 404 for ${url}`));
      return;
    }
    cb(null, Readable.from([body]));
  };
  fetcher.seen = seen;
  return fetcher;
}

// Each test gets its own version string so binaryDir()/tmp paths never collide.
let counter = 0;
function scenario(t, { tamper = false, sums = null } = {}) {
  const version = `0.0.0-test${process.pid}-${counter++}`;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajb-checksum-'));
  const good = buildTarball(workdir, 'REAL BINARY PAYLOAD\n');
  const asset = assetFileName(version, SLUG);
  const published = sums === null
    ? `${sha256(good)}  ${asset}\n`
    : sums(sha256(good), asset);

  // The tampered payload is itself a VALID tarball carrying a different binary.
  // Using garbage bytes here would let the test pass for the wrong reason: tar
  // would fail on the malformed archive even with verification removed, so the
  // known-answer check could not tell a real guard from an absent one.
  const routes = {
    [asset]: tamper ? buildTarball(workdir, 'MALICIOUS PAYLOAD\n') : good,
  };
  if (published !== false) routes['SHA256SUMS.txt'] = Buffer.from(published);

  const bin = binaryPath(version, SLUG);
  const tmpTar = path.join(os.tmpdir(), `actions-json-mcp-${version}-${SLUG}.tar.gz`);

  t.after(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
    fs.rmSync(tmpTar, { force: true });
  });

  return { version, fetcher: makeFetcher(routes), bin, tmpTar, goodDigest: sha256(good) };
}

test('a tarball whose digest matches the published entry installs successfully', async (t) => {
  const s = scenario(t);
  const bin = await download(s.version, SLUG, { fetcher: s.fetcher });

  assert.strictEqual(bin, s.bin);
  assert.ok(fs.existsSync(bin), 'binary should be extracted');
  assert.strictEqual(fs.readFileSync(bin, 'utf8'), 'REAL BINARY PAYLOAD\n');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(bin).mode & 0o111, 0o111, 'binary should be executable');
  }
  assert.ok(
    s.fetcher.seen.some((u) => u.endsWith('SHA256SUMS.txt')),
    'SHA256SUMS.txt must actually be fetched'
  );
  assert.ok(!fs.existsSync(s.tmpTar), 'temp tarball removed on success');
});

test('a tampered tarball is rejected and nothing is extracted, chmodded, or left behind', async (t) => {
  const s = scenario(t, { tamper: true });

  await assert.rejects(
    () => download(s.version, SLUG, { fetcher: s.fetcher }),
    (err) => {
      assert.match(err.message, /checksum mismatch/i);
      assert.match(err.message, new RegExp(s.goodDigest), 'names the expected digest');
      assert.strictEqual(err.code, 'CHECKSUM_MISMATCH');
      return true;
    }
  );

  // FILESYSTEM assertions: catching the throw is not enough. If verification
  // ran after extraction, the binary would exist and be executable here.
  assert.ok(!fs.existsSync(s.bin), 'no binary may be extracted from an unverified archive');
  const dir = path.dirname(s.bin);
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepStrictEqual(leftovers, [], 'binary dir must contain no extracted files');
  assert.ok(!fs.existsSync(s.tmpTar), 'temp tarball removed on the failure path');
});

test('a missing SHA256SUMS.txt fails closed instead of silently skipping verification', async (t) => {
  const s = scenario(t, { sums: () => false });

  await assert.rejects(
    () => download(s.version, SLUG, { fetcher: s.fetcher }),
    (err) => {
      assert.match(err.message, /SHA256SUMS\.txt/);
      assert.strictEqual(err.code, 'CHECKSUMS_UNAVAILABLE');
      // Must not be confusable with a mismatch: distinct failure, distinct message.
      assert.doesNotMatch(err.message, /checksum mismatch/i);
      return true;
    }
  );

  assert.ok(!fs.existsSync(s.bin), 'no binary extracted when checksums are unavailable');
  assert.ok(!fs.existsSync(s.tmpTar), 'temp tarball removed on the failure path');
});

test('a SHA256SUMS.txt with no entry for the selected archive fails closed', async (t) => {
  const s = scenario(t, {
    sums: (digest) => `${digest}  some-other-asset-1.2.3-linux-x64.tar.gz\n`,
  });

  await assert.rejects(
    () => download(s.version, SLUG, { fetcher: s.fetcher }),
    (err) => {
      assert.match(err.message, /no checksum entry/i);
      assert.strictEqual(err.code, 'CHECKSUM_ENTRY_MISSING');
      assert.doesNotMatch(err.message, /checksum mismatch/i);
      return true;
    }
  );

  assert.ok(!fs.existsSync(s.bin), 'no binary extracted without a matching entry');
  assert.ok(!fs.existsSync(s.tmpTar), 'temp tarball removed on the failure path');
});

test('an unparseable SHA256SUMS.txt fails closed', async (t) => {
  const s = scenario(t, { sums: () => 'this is not a checksums file at all\n' });

  await assert.rejects(
    () => download(s.version, SLUG, { fetcher: s.fetcher }),
    (err) => {
      assert.match(err.message, /SHA256SUMS\.txt/);
      assert.ok(
        err.code === 'CHECKSUMS_UNPARSEABLE' || err.code === 'CHECKSUM_ENTRY_MISSING',
        `expected a fail-closed parse code, got ${err.code}`
      );
      return true;
    }
  );

  assert.ok(!fs.existsSync(s.bin), 'no binary extracted from an unparseable checksums file');
  assert.ok(!fs.existsSync(s.tmpTar), 'temp tarball removed on the failure path');
});

test('the parser reads the real published SHA256SUMS.txt format', () => {
  // Byte-for-byte copy of the asset published at extension-v0.1.217, produced by
  // `shasum -a 256` / `sha256sum`: <64 hex><two spaces><filename>, LF endings.
  const real = [
    '15eb29e6720c47545389688989cc833653df8aed08b553fe4a485600e5dec50f  actions-json-overlay-runtime-0.1.217.zip',
    'd5a6a401799aee25598ad4495449c5847662b7a7e6e21f14c9ec5f10baeb44d4  actions-json-mcp-0.1.217-linux-x64.tar.gz',
    '39010438864a7d7d7bac857be8967542387d2a6648903371e5cf853b2f949de2  actions-json-mcp-0.1.217-win-x64.tar.gz',
    'f5d88c3669f5aa48e0d764bfcaf6d5c746838063ff1f02825e4e7538a069f3a0  chrome-launcher-helper-0.1.217-win-x64.tar.gz',
    '39491d90184909f72a8961ec23fb15544d6dca2e5ca3c864c9edbee9395b9456  actions-json-mcp-0.1.217-macos-arm64.tar.gz',
    '4e7efc792b92bd403d7ef32ac3933a52c94d23c7c10f6b9f661424b4f740c1ce  actions-json-mcp-0.1.217-macos-x64.tar.gz',
    '',
  ].join('\n');

  const map = parseChecksums(real);
  assert.strictEqual(map.size, 6);
  assert.strictEqual(
    map.get('actions-json-mcp-0.1.217-linux-x64.tar.gz'),
    'd5a6a401799aee25598ad4495449c5847662b7a7e6e21f14c9ec5f10baeb44d4'
  );
  assert.strictEqual(
    map.get(assetFileName('0.1.217', 'macos-arm64')),
    '39491d90184909f72a8961ec23fb15544d6dca2e5ca3c864c9edbee9395b9456'
  );
});

test('the parser tolerates CRLF, blank lines, and the binary-mode * marker', () => {
  const map = parseChecksums(
    '\r\n' +
    'd5a6a401799aee25598ad4495449c5847662b7a7e6e21f14c9ec5f10baeb44d4  a.tar.gz\r\n' +
    '\r\n' +
    '39010438864a7d7d7bac857be8967542387d2a6648903371e5cf853b2f949de2 *b.tar.gz\r\n'
  );
  assert.strictEqual(map.get('a.tar.gz'), 'd5a6a401799aee25598ad4495449c5847662b7a7e6e21f14c9ec5f10baeb44d4');
  assert.strictEqual(map.get('b.tar.gz'), '39010438864a7d7d7bac857be8967542387d2a6648903371e5cf853b2f949de2');
});
