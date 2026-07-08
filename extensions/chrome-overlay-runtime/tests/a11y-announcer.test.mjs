// U5 — announcer golden tests: REAL bundled ChromeVox LiveRegions/Output
// driven over fixture shim trees; utterances captured at the TTS sink.
// Golden expectations mirror upstream live_regions_test.js scenarios where
// they survive the shim boundary (inherited tests, not just inherited code).
import {test, before} from 'node:test';
import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ShimTree} from '../src/a11y/automation_shim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
before(() => {
  execFileSync('node', [path.resolve(HERE, '../esbuild.a11y.mjs')], {stdio: 'pipe'});
});

const fixtureNodes = ({live = 'assertive', busy = false} = {}) => [
  {nodeId: '1', role: {value: 'rootWebArea'}, name: {value: 'Page'}, childIds: ['2', '4'], backendDOMNodeId: 100},
  {nodeId: '2', role: {value: 'button'}, name: {value: 'Reply'}, childIds: [], backendDOMNodeId: 102,
    properties: [{name: 'focused', value: {value: true}}]},
  // Blink computes an atomic status region's accessible name from contents.
  {nodeId: '4', role: {value: 'status'}, name: {value: 'saved!'}, childIds: ['5'], backendDOMNodeId: 103,
    properties: [
      {name: 'live', value: {value: live}},
      {name: 'atomic', value: {value: true}},
      {name: 'relevant', value: {value: 'additions text'}},
      ...(busy ? [{name: 'busy', value: {value: true}}] : []),
    ]},
  {nodeId: '5', role: {value: 'staticText'}, name: {value: 'saved!'}, childIds: [], backendDOMNodeId: 104},
];

const makeHarness = async (opts) => {
  const cdp = async (method) => {
    if (method === 'Accessibility.enable') return {};
    if (method === 'Accessibility.getFullAXTree') return {nodes: fixtureNodes(opts)};
    throw new Error(`unexpected CDP ${method}`);
  };
  const tree = await new ShimTree({cdp, tabId: 7, url: 'https://example.test/', focused: true}).refresh();
  const {Announcer} = await import('../src/a11y/announcer.js');
  const records = [];
  const announcer = new Announcer({getTree: async () => tree, onAnnouncement: (r) => records.push(r)}).start();
  return {tree, announcer, records};
};

const batch = (type, text, politeness) => ({
  records: [
    {kind: 'a11y.treeChange', type, text, region: {identity: '#sp', politeness, atomic: true, relevant: 'additions text', role: 'status', busy: false}},
    {kind: 'a11y.treeChange', type: 'subtreeUpdateEnd', text: '', region: null},
  ],
});

test('POSITIVE golden: focused-tab live-region change is NOT suppressed', async () => {
  const {announcer, records} = await makeHarness({live: 'assertive'});
  await announcer.handleBatch(7, batch('textChanged', 'saved!', 'assertive'));
  assert.ok(records.length >= 1, 'expected an announcement — suppression gate must pass on the focused tab');
  assert.match(records[0].text, /saved!/);
});

test('politeness rides observer metadata, not QueueMode (assertive)', async () => {
  const {announcer, records} = await makeHarness({live: 'assertive'});
  await announcer.handleBatch(7, batch('textChanged', 'saved!', 'assertive'));
  assert.strictEqual(records[0].politeness, 'assertive');
  assert.strictEqual(records[0].tab, 7);
  assert.strictEqual(records[0].region, '#sp');
});

test('polite region announces with polite politeness', async () => {
  const {announcer, records} = await makeHarness({live: 'polite'});
  await announcer.handleBatch(7, batch('textChanged', 'saved!', 'polite'));
  assert.ok(records.length >= 1);
  assert.strictEqual(records[0].politeness, 'polite');
});

test('upstream suppression case: busy region emits nothing', async () => {
  const {announcer, records} = await makeHarness({live: 'assertive', busy: true});
  await announcer.handleBatch(7, batch('textChanged', 'saved!', 'assertive'));
  assert.strictEqual(records.length, 0, 'containerLiveBusy must suppress, matching upstream');
});

test('AE1 rapid-fire: consecutive assertive changes both carry assertive politeness', async () => {
  const {announcer, records} = await makeHarness({live: 'assertive'});
  await announcer.handleBatch(7, batch('textChanged', 'saved!', 'assertive'));
  await announcer.handleBatch(7, batch('textChanged', 'saved!', 'assertive'));
  // The fork's 20ms same-node throttle + WeakSet dedupe may coalesce the
  // second announcement (upstream behavior, preserved). Every record that IS
  // emitted must carry metadata-sourced politeness despite QueueMode's 5s
  // time-multiplexing forcing QUEUE on the second.
  assert.ok(records.length >= 1);
  for (const r of records) assert.strictEqual(r.politeness, 'assertive');
});
