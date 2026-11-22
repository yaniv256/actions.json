'use strict';

// Maps the current Node process platform/arch to the release asset slug used by
// scripts/package-mcp-bridge.sh (e.g. "macos-arm64"). Returns null for
// platforms with no prebuilt binary, so the CLI can fall back to a clear
// build-from-source message instead of downloading the wrong file.

// Node `${process.platform}-${process.arch}` -> release slug.
const SUPPORTED = {
  'linux-x64': 'linux-x64',
  'darwin-x64': 'macos-x64',
  'darwin-arm64': 'macos-arm64',
  'win32-x64': 'win-x64',
};

function assetSlug(platform, arch) {
  return SUPPORTED[`${platform}-${arch}`] || null;
}

// Base binary name; Windows builds carry a .exe suffix inside the tarball.
const BINARY_BASE = 'actions-json';

function binaryName(slug) {
  return slug && slug.startsWith('win-') ? `${BINARY_BASE}.exe` : BINARY_BASE;
}

// Release asset filename for a version + slug. Every platform ships a .tar.gz
// (tar is available on the Windows runner and Node extracts it the same way).
function assetFileName(version, slug) {
  return `${BINARY_BASE}-${version}-${slug}.tar.gz`;
}

// Base URL for every asset published under a version's release tag.
function releaseAssetUrl(version, file) {
  return `https://github.com/yaniv256/actions.json/releases/download/extension-v${version}/${file}`;
}

// GitHub release download URL for a version tag + asset.
function downloadUrl(version, slug) {
  return releaseAssetUrl(version, assetFileName(version, slug));
}

// The SHA256SUMS.txt manifest published alongside the tarballs by
// scripts/release-binaries.sh. Same release tag, fixed filename.
const CHECKSUMS_FILE = 'SHA256SUMS.txt';

function checksumsUrl(version) {
  return releaseAssetUrl(version, CHECKSUMS_FILE);
}

function manifestUrl(version) {
  return releaseAssetUrl(version, 'release-manifest.json');
}

function signatureUrl(version) {
  return releaseAssetUrl(version, 'release-manifest.sig');
}

module.exports = {
  assetSlug,
  assetFileName,
  downloadUrl,
  checksumsUrl,
  manifestUrl,
  signatureUrl,
  binaryName,
  BINARY_BASE,
  CHECKSUMS_FILE,
  SUPPORTED,
};
