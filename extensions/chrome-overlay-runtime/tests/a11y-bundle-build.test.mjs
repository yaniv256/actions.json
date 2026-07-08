// U2 smoke: the a11y bundle (ChromeVox policy core + Tier-B seams) builds and
// loads in a service-worker-like ESM context. Behavior is exercised in U5.
import {test} from 'node:test';
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const BUNDLE = path.resolve(HERE, '../dist/a11y-bundle.js');

test('a11y bundle builds from a clean tree', () => {
  execFileSync('node', [path.join(REPO, 'extensions/chrome-overlay-runtime/esbuild.a11y.mjs')], {stdio: 'pipe'});
});

test('a11y bundle loads and exports the policy core', async () => {
  const m = await import(BUNDLE);
  for (const name of ['LiveRegions', 'Output', 'ChromeVoxRange', 'ChromeVox', 'QueueMode', 'TtsCategory', 'CursorRange', 'AutomationUtil', 'AutomationPredicate']) {
    assert.ok(m[name] !== undefined, `missing export: ${name}`);
  }
  assert.strictEqual(typeof m.LiveRegions, 'function');
  assert.strictEqual(m.TtsCategory.LIVE, 'live');
});

test('LiveRegions.init subscribes via the TreeChange observer slot', async () => {
  const m = await import(BUNDLE);
  let subscribed = null;
  globalThis.chrome.automation.addTreeChangeObserver = (filter, cb) => { subscribed = {filter, cb}; };
  m.LiveRegions.init();
  assert.ok(subscribed, 'addTreeChangeObserver not called');
  assert.strictEqual(subscribed.filter, 'liveRegionTreeChanges');
  assert.strictEqual(typeof subscribed.cb, 'function');
});
