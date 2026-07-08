// U4 — live-region observer tests over a fake DOM (no jsdom; the observer's
// dependencies are injected: doc, MutationObserver ctor, post, schedule).
import {test} from 'node:test';
import assert from 'node:assert';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {createLiveRegionObserver, regionPoliteness, classifyMutation} =
  require('../src/a11y/live_region_observer.js');

// --- minimal fake DOM ---
class FakeEl {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.attrs = attrs;
    this.id = attrs.id || '';
    this.children = children;
    this.parentElement = null;
    for (const c of children) if (c.nodeType === 1) c.parentElement = this;
    this.textContent = attrs.text || '';
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  matches(sel) {
    if (this.attrs['aria-live'] && sel.includes('[aria-live]')) return true;
    const role = (this.attrs.role || '').toLowerCase();
    return Boolean(role && sel.includes(`[role="${role}"]`));
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children || []) {
        if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); }
      }
    };
    walk(this);
    return out;
  }
}
const fakeText = (data, parent) => ({nodeType: 3, data, parentElement: parent || null});

class FakeMO {
  static instances = [];
  constructor(cb) { this.cb = cb; this.targets = []; FakeMO.instances.push(this); }
  observe(target, opts) { this.targets.push({target, opts}); }
  fire(muts) { this.cb(muts); }
}

const harness = (rootChildren) => {
  FakeMO.instances = [];
  const docEl = new FakeEl('html', {}, rootChildren);
  const posts = [];
  const flushers = [];
  const obs = createLiveRegionObserver({
    doc: {documentElement: docEl},
    MutationObserverCtor: FakeMO,
    post: (records) => posts.push(records),
    schedule: (fn) => flushers.push(fn),
  });
  const runFlush = () => { while (flushers.length) flushers.shift()(); };
  return {docEl, posts, obs, runFlush, mos: FakeMO.instances};
};

test('detects explicit aria-live and implicit alert/status/log; skips off', () => {
  const {obs} = harness([
    new FakeEl('div', {'aria-live': 'polite'}),
    new FakeEl('div', {role: 'alert'}),
    new FakeEl('div', {role: 'status'}),
    new FakeEl('div', {role: 'log'}),
    new FakeEl('div', {'aria-live': 'off'}),
    new FakeEl('div', {}),
  ]);
  assert.strictEqual(obs.regionCount(), 4);
});

test('politeness: aria-live wins; implicit roles map; alert=assertive', () => {
  assert.strictEqual(regionPoliteness(new FakeEl('d', {'aria-live': 'assertive', role: 'log'})), 'assertive');
  assert.strictEqual(regionPoliteness(new FakeEl('d', {role: 'alert'})), 'assertive');
  assert.strictEqual(regionPoliteness(new FakeEl('d', {role: 'status'})), 'polite');
  assert.strictEqual(regionPoliteness(new FakeEl('d', {})), 'off');
});

test('classification: characterData→textChanged, adds→created, removes→nodeRemoved', () => {
  const parent = new FakeEl('div', {});
  const t = fakeText('hello', parent);
  assert.deepStrictEqual(classifyMutation({type: 'characterData', target: t}).map(s => s.type), ['textChanged']);
  const seeds = classifyMutation({type: 'childList', target: parent, addedNodes: [new FakeEl('span', {text: 'x'}), fakeText('y', parent)], removedNodes: [new FakeEl('em', {})]});
  assert.deepStrictEqual(seeds.map(s => s.type), ['subtreeCreated', 'nodeCreated', 'nodeRemoved']);
});

test('a burst flushes once, typed records + one subtreeUpdateEnd, metadata attached', () => {
  const region = new FakeEl('div', {'aria-live': 'assertive', 'aria-atomic': 'true', id: 'sp'});
  const {posts, runFlush, mos} = harness([region]);
  const regionMO = mos.find(m => m.targets.some(t => t.target === region));
  const t = fakeText('space', region);
  regionMO.fire([{type: 'characterData', target: t}]);
  regionMO.fire([{type: 'characterData', target: t}]);
  runFlush();
  assert.strictEqual(posts.length, 1, 'one batched post per burst');
  const batch = posts[0];
  assert.strictEqual(batch.at(-1).type, 'subtreeUpdateEnd');
  const changes = batch.slice(0, -1);
  assert.ok(changes.length >= 1);
  assert.strictEqual(changes[0].type, 'textChanged');
  assert.strictEqual(changes[0].text, 'space');
  assert.strictEqual(changes[0].region.identity, '#sp');
  assert.strictEqual(changes[0].region.politeness, 'assertive');
  assert.strictEqual(changes[0].region.atomic, true);
  assert.strictEqual(changes[0].region.relevant, 'additions text');
});

test('dynamically added region gets observed via the doc watcher', () => {
  const {docEl, obs, mos} = harness([]);
  assert.strictEqual(obs.regionCount(), 0);
  const late = new FakeEl('div', {role: 'status'});
  docEl.children.push(late); late.parentElement = docEl;
  const docWatcher = mos[0]; // first observer created watches the document
  docWatcher.fire([{addedNodes: [late], removedNodes: []}]);
  assert.strictEqual(obs.regionCount(), 1);
});
