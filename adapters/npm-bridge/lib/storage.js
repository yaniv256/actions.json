'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Default storage location when the caller doesn't pass --storage-root.
// Lives in the user's home dir (not cwd) so it resolves no matter where the
// coding agent launches the bridge.
function defaultStorageRoot() {
  return (
    process.env.ACTIONS_JSON_STORAGE ||
    path.join(os.homedir(), '.actions-json', 'storage')
  );
}

// The bundled seed skeleton (storage.json + scope READMEs + private placeholder),
// mirroring examples/actions.json.storage. The PUBLIC site maps are NOT bundled;
// they are cloned from the public maps repo on first run (see clonePublicMaps)
// so a fresh install arrives stocked with real, working maps to try.
const SEED_DIR = path.join(__dirname, '..', 'seed');
const PUBLIC_MAPS_REPO = 'https://github.com/yaniv256/actions.json.storage.public.git';

// Recursively copy the seed skeleton into the target.
function copySeed(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copySeed(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// Clone the public site maps into scopes/public so the workspace ships with
// something to try. Best-effort: if git is missing or the clone fails (offline,
// etc.), seed an empty scopes/public and tell the user how to get the maps —
// never fail the whole seed over the optional maps.
function clonePublicMaps(target) {
  const publicDir = path.join(target, 'scopes', 'public');
  if (fs.existsSync(publicDir) && fs.readdirSync(publicDir).length > 0) return;
  try {
    execFileSync('git', ['clone', '--depth', '1', PUBLIC_MAPS_REPO, publicDir], {
      stdio: 'ignore',
    });
    process.stderr.write(`Cloned public site maps into ${publicDir}\n`);
  } catch (_e) {
    fs.mkdirSync(publicDir, { recursive: true });
    process.stderr.write(
      `Could not clone public site maps (need git + network). ` +
        `Get them later with:\n  git clone ${PUBLIC_MAPS_REPO} "${publicDir}"\n`
    );
  }
}

// Ensure the storage root exists; create it from the bundled seed on first run,
// then clone the public maps. Returns the absolute path. Never overwrites
// existing storage.
function ensureStorageRoot(root) {
  const target = root || defaultStorageRoot();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copySeed(SEED_DIR, target);
    fs.mkdirSync(path.join(target, 'scopes', 'private'), { recursive: true });
    clonePublicMaps(target);
    process.stderr.write(`Created actions.json storage at ${target}\n`);
  }
  return path.resolve(target);
}

module.exports = { ensureStorageRoot, defaultStorageRoot };
