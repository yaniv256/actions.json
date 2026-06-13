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
const BINARY_BASE = 'actions-json-mcp';

function binaryName(slug) {
  return slug && slug.startsWith('win-') ? `${BINARY_BASE}.exe` : BINARY_BASE;
}

// Release asset filename for a version + slug. Every platform ships a .tar.gz
// (tar is available on the Windows runner and Node extracts it the same way).
function assetFileName(version, slug) {
  return `${BINARY_BASE}-${version}-${slug}.tar.gz`;
}

// GitHub release download URL for a version tag + asset.
function downloadUrl(version, slug) {
  const file = assetFileName(version, slug);
  return `https://github.com/yaniv256/actions.json/releases/download/extension-v${version}/${file}`;
}

module.exports = {
  assetSlug,
  assetFileName,
  downloadUrl,
  binaryName,
  BINARY_BASE,
  SUPPORTED,
};
