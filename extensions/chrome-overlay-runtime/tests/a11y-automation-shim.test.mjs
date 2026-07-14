// U3 — AutomationShim unit tests against a recorded-style AX-tree fixture.
import {test} from 'node:test';
import assert from 'node:assert';
import {ShimTree, installAutomationShim} from '../src/a11y/automation_shim.js';

// Minimal CDP fixture: page with a heading, a button, and an assertive live
// region containing a text node. Shapes mirror Accessibility.getFullAXTree.
const FIXTURE_NODES = [
  {nodeId: '1', role: {value: 'rootWebArea'}, name: {value: 'Test Page'}, childIds: ['2', '3', '4'], backendDOMNodeId: 100},
  {nodeId: '2', role: {value: 'heading'}, name: {value: 'Title'}, childIds: [], backendDOMNodeId: 101,
    properties: [{name: 'level', value: {value: 1}}]},
  {nodeId: '3', role: {value: 'button'}, name: {value: 'Reply'}, childIds: [], backendDOMNodeId: 102,
    properties: [{name: 'focusable', value: {value: true}}, {name: 'focused', value: {value: true}}]},
  {nodeId: '4', role: {value: 'status'}, name: {value: ''}, childIds: ['5'], backendDOMNodeId: 103,
    properties: [
      {name: 'live', value: {value: 'assertive'}},
      {name: 'atomic', value: {value: true}},
      {name: 'relevant', value: {value: 'additions text'}},
    ]},
  {nodeId: '5', role: {value: 'staticText'}, name: {value: 'saved!'}, childIds: [], backendDOMNodeId: 104},
];

const fixtureCdp = async (method, params) => {
  if (method === 'Accessibility.enable') return {};
  if (method === 'Accessibility.getFullAXTree') return {nodes: FIXTURE_NODES};
  if (method === 'DOM.getBoxModel') {
    assert.strictEqual(params.backendNodeId, 102);
    return {model: {content: [10, 20, 110, 20, 110, 60, 10, 60]}};
  }
  if (method === 'DOM.resolveNode') {
    assert.strictEqual(params.backendNodeId, 102);
    return {object: {objectId: 'fixture-button'}};
  }
  if (method === 'Runtime.callFunctionOn') {
    assert.strictEqual(params.objectId, 'fixture-button');
    return {result: {value: {
      visible_center: {x: 60, y: 40},
      visible_rect: {left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40},
      receives_events: false,
      clickable: false,
      occluded_by: {tag_name: 'div', id: 'sticky-cover', text: 'Sticky cover'},
    }}};
  }
  if (method === 'Runtime.releaseObject') return {};
  throw new Error(`unexpected CDP call ${method}`);
};

const makeTree = async () => new ShimTree({cdp: fixtureCdp, tabId: 7, url: 'https://example.test/', focused: true}).refresh();

test('role/name/state mapping and tree walking match the fixture', async () => {
  const tree = await makeTree();
  const root = tree.root;
  assert.strictEqual(root.role, 'rootWebArea');
  assert.strictEqual(root.children.length, 3);
  const button = tree.nodeById('3');
  assert.strictEqual(button.name, 'Reply');
  assert.strictEqual(button.state.focused, true);
  assert.strictEqual(button.parent.id, '1');
  assert.strictEqual(button.previousSibling.role, 'heading');
  assert.strictEqual(button.nextSibling.role, 'status');
  assert.strictEqual(root.firstChild.role, 'heading');
  assert.strictEqual(root.lastChild.role, 'status');
  assert.strictEqual(tree.nodeById('5').root.id, '1');
});

test('actionability attestation separates AX identity from hit-test ownership', async () => {
  const tree = await makeTree();
  const hit = tree.query({role: 'button', name: 'Reply'});
  const attestation = await tree.actionability(hit);
  assert.strictEqual(attestation.actionability_attested, true);
  assert.strictEqual(attestation.receives_events, false);
  assert.strictEqual(attestation.clickable, false);
  assert.deepStrictEqual(attestation.visible_center, {x: 60, y: 40});
  assert.deepStrictEqual(attestation.occluded_by, {tag_name: 'div', id: 'sticky-cover', text: 'Sticky cover'});
});

test('synthetic desktop→window topology serves the suppression walk', async () => {
  const tree = await makeTree();
  // getTopLevelRoot(node).parent must resolve to a focused, visible window.
  const hostView = tree.root.parent;
  assert.strictEqual(hostView.role, 'window');
  assert.strictEqual(hostView.state.focused, true);
  assert.notStrictEqual(hostView.state.invisible, true);
  assert.strictEqual(hostView.parent.role, 'desktop');
  assert.strictEqual(tree.syntheticDesktop.children[0].id, 'synthetic-window');
});

test('containerLive* resolve from the nearest live ancestor', async () => {
  const tree = await makeTree();
  const textNode = tree.nodeById('5');
  assert.strictEqual(textNode.containerLiveStatus, 'assertive');
  assert.strictEqual(textNode.containerLiveAtomic, true);
  assert.strictEqual(textNode.containerLiveRelevant, 'additions text');
  assert.strictEqual(textNode.containerLiveBusy, false);
  const heading = tree.nodeById('2');
  assert.strictEqual(heading.containerLiveStatus, undefined);
});

test('query by role+name returns the node; clickable center from box model', async () => {
  const tree = await makeTree();
  const hit = tree.query({role: 'button', name: 'Reply'});
  assert.ok(hit);
  const center = await tree.clickableCenter(hit);
  assert.deepStrictEqual(center, {x: 60, y: 40});
  assert.strictEqual(tree.query({role: 'button', name: 'Nope'}), undefined);
});

test('outline is compact, live-annotated, and bounded', async () => {
  const tree = await makeTree();
  const o = tree.outline();
  assert.strictEqual(o.tab_id, 7);
  assert.match(o.outline, /rootWebArea "Test Page"/);
  assert.match(o.outline, /button "Reply".*\[focused\]/);
  assert.match(o.outline, /status.*\[live:assertive\]/);
});

test('missing members read as undefined (null-safe), no throw', async () => {
  const tree = await makeTree();
  const n = tree.nodeById('2');
  assert.strictEqual(n.textSelStart, undefined);
  assert.strictEqual(n.htmlTag, undefined);
  assert.strictEqual(n.someMemberWeNeverHeardOf, undefined);
  assert.deepStrictEqual(n.location, {left: 0, top: 0, width: 0, height: 0});
});

test('installAutomationShim wires observers, getDesktop, getFocus', async () => {
  globalThis.chrome = globalThis.chrome || {};
  globalThis.chrome.automation = globalThis.chrome.automation || {};
  const tree = await makeTree();
  const shim = installAutomationShim({getTree: async () => tree});
  const seen = [];
  globalThis.chrome.automation.addTreeChangeObserver('liveRegionTreeChanges', (r) => seen.push(r));
  assert.strictEqual(shim.observerCount(), 1);
  shim.dispatchTreeChange({type: 'textChanged', target: tree.nodeById('5')});
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].target.name, 'saved!');
  const desk = await globalThis.chrome.automation.getDesktop();
  assert.strictEqual(desk.role, 'desktop');
  const focus = await globalThis.chrome.automation.getFocus();
  assert.strictEqual(focus.name, 'Reply');
});

test('stale-tree refresh rebuilds maps', async () => {
  const tree = await makeTree();
  const before = tree.nodeById('3');
  await tree.refresh();
  const after = tree.nodeById('3');
  assert.ok(after && after.name === 'Reply');
  assert.notStrictEqual(before, after); // fresh wrappers after refresh
});
