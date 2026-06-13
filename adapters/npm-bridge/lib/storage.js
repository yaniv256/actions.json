'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Default storage location when the caller doesn't pass --storage-root.
// Lives in the user's home dir (not cwd) so it resolves no matter where the
// coding agent launches the bridge.
function defaultStorageRoot() {
  return (
    process.env.ACTIONS_JSON_STORAGE ||
    path.join(os.homedir(), '.actions-json', 'storage')
  );
}

const TEMPLATE_DIR = path.join(__dirname, '..', 'template');

// Recursively copy the template, skipping the .gitkeep placeholders (they only
// exist to ship empty dirs inside the package/repo).
function copyTemplate(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.gitkeep') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTemplate(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// Ensure the storage root exists; create it from the bundled template on
// first run. Returns the absolute path. Never overwrites existing storage.
function ensureStorageRoot(root) {
  const target = root || defaultStorageRoot();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyTemplate(TEMPLATE_DIR, target);
    // Recreate the empty scope dirs that .gitkeep stood in for.
    for (const p of [
      ['scopes', 'private', 'sites'],
      ['scopes', 'public', 'sites'],
      ['scopes', 'shared'],
    ]) {
      fs.mkdirSync(path.join(target, ...p), { recursive: true });
    }
    process.stderr.write(`Created actions.json storage at ${target}\n`);
  }
  return path.resolve(target);
}

module.exports = { ensureStorageRoot, defaultStorageRoot };
