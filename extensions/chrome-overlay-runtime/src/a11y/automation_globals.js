// Injected first into the a11y bundle (esbuild `inject`): fork modules read
// chrome.automation.* enum values at module top-level, so the value shim must
// exist before any fork module evaluates. Enum strings mirror Chromium's
// automation API (camelCase values); U3 verifies them against fixtures and
// installs the real function implementations (addTreeChangeObserver, getFocus,
// getDesktop) on this same object.
const g = globalThis;
g.chrome = g.chrome || {};
if (!g.chrome.automation) g.chrome.automation = {};
const A = g.chrome.automation;
const ensure = (key, val) => { if (!A[key]) A[key] = val; };
const strEnum = (...names) => Object.fromEntries(names.map(n => [n, n.charAt(0).toLowerCase() + n.slice(1).toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase())]));
// Enum objects (accessed as values by the fork):
ensure('EventType', new Proxy({}, { get: (_, p) => typeof p === 'string' ? p.charAt(0).toLowerCase() + p.slice(1).toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase()) : undefined }));
for (const name of ['RoleType', 'StateType', 'TreeChangeType', 'ActionType', 'NameFromType', 'Restriction', 'DefaultActionVerb', 'HasPopup', 'InvalidState', 'MarkerType', 'SortDirectionType', 'AriaCurrentState', 'IntentCommandType', 'IntentTextBoundaryType', 'IntentMoveDirectionType']) {
  ensure(name, new Proxy({}, { get: (_, p) => typeof p === 'string' ? p.charAt(0).toLowerCase() + p.slice(1).toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase()) : undefined }));
}
ensure('TreeChangeObserverFilter', { ALL_TREE_CHANGES: 'allTreeChanges', LIVE_REGION_TREE_CHANGES: 'liveRegionTreeChanges', NO_TREE_CHANGES: 'noTreeChanges', TEXT_MARKER_CHANGES: 'textMarkerChanges' });
// Runtime function slots (U3 replaces with real shim implementations):
ensure('addTreeChangeObserver', (_filter, _cb) => {});
ensure('removeTreeChangeObserver', (_cb) => {});
ensure('getFocus', (cb) => cb && cb(undefined));
ensure('getDesktop', (cb) => cb && cb(undefined));
ensure('setDocumentSelection', (_p) => {});
export {};
