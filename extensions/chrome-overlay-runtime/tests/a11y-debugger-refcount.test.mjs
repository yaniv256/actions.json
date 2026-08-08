// Guard: the refcounted debugger manager must let overlapping holders coexist
// (the U8 regression: a held a11y.watch session + a trusted keypress on the
// same tab threw "already attached"). Extracts and exercises the manager's
// attach/detach accounting against a fake chrome.debugger.
import {test} from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DebuggerSessionManager} from '../src/agent/debugger-session-manager.mjs';

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

test('a11y adds its first holder and only attests an already-recorded holder', () => {
  assert.match(bg, /if \(a11yDebuggerSessions\.has\(tabId\)\) \{[\s\S]*?await debuggerSessionManager\.attestHeld\(tabId\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?const inFlight = a11yDebuggerSessionInitializers\.get\(tabId\);[\s\S]*?if \(inFlight\) return inFlight;[\s\S]*?await acquireDebugger\(tabId\);/,
    'a11y must acquire its own first holder before using non-incrementing attestation');
});

test('a11y first-holder setup is single-flight and watch surfaces ownership failure', () => {
  assert.match(bg, /const a11yDebuggerSessionInitializers = new Map\(\)/,
    'concurrent first watches need a shared initializer');
  assert.doesNotMatch(bg, /try\s*\{\s*await ensureA11yDebuggerSession\(tabId\);\s*\}\s*catch/,
    'a11y.watch must not report watching:true after debugger ownership fails');
  assert.match(bg, /await ensureA11yDebuggerSession\(tabId\);/,
    'a11y.watch must await debugger ownership before reporting success');
});

test('transient debugger detach preserves the logical a11y holder until tab removal', () => {
  const detachHandler = bg.match(/chrome\.debugger\.onDetach\?\.addListener\(\(source\) => \{([\s\S]*?)\n\}\);/)?.[1] || '';
  assert.match(detachHandler, /debuggerSessionManager\.handleDetach\(source\.tabId\)/);
  assert.doesNotMatch(detachHandler, /a11yDebuggerSessions\.delete/,
    'onDetach must not discard the logical a11y holder');
  assert.match(bg, /chrome\.tabs\.onRemoved\.addListener[\s\S]*?debuggerSessionManager\?\.handleTabRemoved\(tabId\)[\s\S]*?a11yDebuggerSessions\?\.delete\(tabId\)/,
    'tab removal must explicitly clear debugger and a11y ownership');
});

test('site-action exceptions preserve structured debugger recovery guidance', () => {
  assert.match(bg, /const siteActionExceptionEnvelope = \(error\) => \(\{[\s\S]*?code: error\?\.code \|\| "site_action_failed"[\s\S]*?recoverable:[\s\S]*?retryable:[\s\S]*?next_step:/,
    'site actions must retain typed debugger ownership metadata');
  const uses = bg.match(/error: siteActionExceptionEnvelope\(error\)/g) || [];
  assert.ok(uses.length >= 2,
    'both WebSocket and runtime-message site-action failure paths must preserve metadata');
});

// Behavioral: model the refcount accounting.
test('refcount: production manager nests holders and detaches once', async () => {
  let attaches = 0, detaches = 0;
  const attached = new Set();
  const fakeAttach = async ({tabId}) => {
    if (attached.has(tabId)) { const e = new Error('Another debugger is already attached'); throw e; }
    attached.add(tabId); attaches++;
  };
  const fakeDetach = async ({tabId}) => { attached.delete(tabId); detaches++; };
  const manager = new DebuggerSessionManager({
    attach: fakeAttach,
    detach: fakeDetach,
    sendCommand: async ({tabId}) => {
      if (!attached.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      return {result: {type: 'undefined'}};
    },
  });
  await manager.acquire(7);            // a11y.watch holds
  await manager.acquire(7);            // trusted key overlaps
  assert.strictEqual(attaches, 1, 'attached once for two holders');
  await manager.release(7);            // key releases
  assert.strictEqual(detaches, 0, 'not detached while a11y still holds');
  await manager.release(7);            // a11y releases
  assert.strictEqual(detaches, 1, 'detached when last holder leaves');
});
