// Guard against the recurring "No handler implemented" trap: any a11y primitive
// whose handler lives in executeBackgroundHostedToolCall MUST be listed in
// BRIDGE_BACKGROUND_ACTION_NAMES, or a direct bridge action_call falls through
// to content.js and throws. (a11y.events.read / subscribe / configure are
// BRIDGE-side, handled in Rust, and correctly NOT in this set.)
import {test} from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.resolve(HERE, '../src/background.js'), 'utf8');

// a11y primitives dispatched inside executeBackgroundHostedToolCall.
const bgHandled = [...bg.matchAll(/if \(call\.name === "(a11y\.[a-z_.]+)"\)/g)].map((m) => m[1]);
// The routing allow-list contents.
const setBlock = bg.match(/BRIDGE_BACKGROUND_ACTION_NAMES = new Set\(\[([\s\S]*?)\]\)/)[1];
const routed = new Set([...setBlock.matchAll(/"(a11y\.[a-z_.]+)"/g)].map((m) => m[1]));

test('every background-handled a11y primitive is routed to the background', () => {
  assert.ok(bgHandled.length >= 3, `expected background a11y handlers, found ${bgHandled}`);
  for (const name of bgHandled) {
    assert.ok(routed.has(name), `${name} has a background handler but is missing from BRIDGE_BACKGROUND_ACTION_NAMES — it will throw "No handler implemented" on a direct bridge call`);
  }
});
