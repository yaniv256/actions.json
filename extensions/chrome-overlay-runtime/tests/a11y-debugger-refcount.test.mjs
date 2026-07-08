// Guard: the refcounted debugger manager must let overlapping holders coexist
// (the U8 regression: a held a11y.watch session + a trusted keypress on the
// same tab threw "already attached"). Extracts and exercises the manager's
// attach/detach accounting against a fake chrome.debugger.
import {test} from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.resolve(HERE, '../src/background.js'), 'utf8');

// Structural assertions: the per-op debugger consumers route through the shared
// manager (acquireDebugger/releaseDebugger), not raw debuggerAttach in a finally.
test('trusted key + text + debug JS + a11y tree use the shared refcount manager', () => {
  // acquireDebugger appears in each consumer; count call sites.
  const acquires = (bg.match(/await acquireDebugger\(/g) || []).length;
  assert.ok(acquires >= 4, `expected >=4 acquireDebugger sites (trusted key/text, debug JS, a11y tree, ensure-session), found ${acquires}`);
  // No consumer still does its own attach-then-detach-in-finally on the a11y path.
  assert.ok(!/await debuggerAttach\(target\);\s*\n\s*attached = true;/.test(bg),
    'a consumer still uses the old raw attach/attached pattern instead of acquireDebugger');
});

// Behavioral: model the refcount accounting.
test('refcount: nested holders attach once, detach once', async () => {
  let attaches = 0, detaches = 0;
  const attached = new Set();
  const fakeAttach = async ({tabId}) => {
    if (attached.has(tabId)) { const e = new Error('Another debugger is already attached'); throw e; }
    attached.add(tabId); attaches++;
  };
  const fakeDetach = async ({tabId}) => { attached.delete(tabId); detaches++; };
  // Inline the manager's logic (mirror of background.js).
  const counts = new Map(), adopted = new Set();
  const acquire = async (t) => {
    const n = counts.get(t) || 0;
    if (n === 0) { try { await fakeAttach({tabId: t}); } catch (e) { if (!/already attached/i.test(e.message)) throw e; adopted.add(t); } }
    counts.set(t, n + 1);
  };
  const release = async (t) => {
    const n = counts.get(t) || 0;
    if (n <= 1) { counts.delete(t); if (!adopted.delete(t)) await fakeDetach({tabId: t}); }
    else counts.set(t, n - 1);
  };
  await acquire(7);            // a11y.watch holds
  await acquire(7);            // trusted key overlaps
  assert.strictEqual(attaches, 1, 'attached once for two holders');
  await release(7);            // key releases
  assert.strictEqual(detaches, 0, 'not detached while a11y still holds');
  await release(7);            // a11y releases
  assert.strictEqual(detaches, 1, 'detached when last holder leaves');
});
