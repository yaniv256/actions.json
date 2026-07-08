'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The npm wrapper bundles its own copy of the primitive dictionary
// (dictionary/overlay.actions.json) so `npx @actions-json/bridge mcp` can serve
// the tool catalog with no repo checkout. That copy must stay a byte-identical
// mirror of the canonical extension overlay — the source of truth the release is
// built from. When it drifts, npx users get a fresh bridge binary but a stale
// tool catalog: the 0.1.148 multi-tab primitives (browser.navigate/open_tab/
// close_tab/dismiss_dialog) were missing from the bundle for exactly this
// reason. This test fails loudly if the mirror falls behind so the drift is
// caught at CI time, not by a user whose install is missing the headline
// feature.
const BUNDLED = path.join(__dirname, '..', 'dictionary', 'overlay.actions.json');
const CANONICAL = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'extensions',
  'chrome-overlay-runtime',
  'actions',
  'overlay.actions.json'
);

test('bundled dictionary is a byte-identical mirror of the extension overlay', () => {
  const bundled = fs.readFileSync(BUNDLED, 'utf8');
  const canonical = fs.readFileSync(CANONICAL, 'utf8');
  assert.strictEqual(
    bundled,
    canonical,
    'adapters/npm-bridge/dictionary/overlay.actions.json has drifted from ' +
      'extensions/chrome-overlay-runtime/actions/overlay.actions.json. ' +
      'Re-copy the canonical overlay into the wrapper bundle before release.'
  );
});

test('bundled dictionary exposes the multi-tab primitives', () => {
  const d = JSON.parse(fs.readFileSync(BUNDLED, 'utf8'));
  const toolNames = new Set((d.tools || []).map((t) => t.name));
  for (const name of [
    'browser.navigate',
    'browser.open_tab',
    'browser.close_tab',
    'browser.dismiss_dialog',
  ]) {
    assert.ok(
      toolNames.has(name),
      `bundled dictionary is missing the multi-tab tool "${name}"`
    );
  }
});
