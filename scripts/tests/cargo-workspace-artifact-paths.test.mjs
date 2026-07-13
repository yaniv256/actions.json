import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

const packageScript = await read('scripts/package-mcp-bridge.sh');
assert.match(packageScript, /workspace_target_dir="\$repo_root\/mcp\/target"/);
assert.match(packageScript, /target_dir="\$workspace_target_dir\/release"/);
assert.match(packageScript, /target_dir="\$workspace_target_dir\/\$target\/release"/);
assert.doesNotMatch(packageScript, /target_dir="\$bridge_dir\/target/);

const activeFiles = [
  'docs/development-cycle.md',
  'skills/actions-json-dev-cycle/SKILL.md',
  'skills/write-actions-json/SKILL.md',
  'adapters/npm-bridge/lib/install.js',
  'extensions/chrome-overlay-runtime/tests/eval-runtime-registration-smoke.test.mjs',
  'extensions/chrome-overlay-runtime/tests/eval-lifecycle-smoke.test.mjs',
  'extensions/chrome-overlay-runtime/tests/live/eval/xclick-claim-smoke.mjs',
  'extensions/chrome-overlay-runtime/tools/deploy/deploy.mjs',
];

for (const path of activeFiles) {
  const source = await read(path);
  assert.doesNotMatch(source, /mcp\/actions-json-mcp\/target/, `${path} still names the crate-local target`);
  assert.match(source, /mcp\/target/, `${path} must name the Cargo workspace target`);
}

console.log('Packaging, staging, install, deploy, and smoke paths use the Cargo workspace target.');
