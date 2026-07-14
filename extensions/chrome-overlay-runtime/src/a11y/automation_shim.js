// U3 — AutomationShim core (docs/a11y-shim-spec.md).
// AutomationNode-compatible objects backed by the CDP Accessibility domain,
// with the synthetic desktop→window topology above each page root that the
// ChromeVox suppression/flush logic requires (spec §2). Transport-injected:
// production passes a chrome.debugger-backed `cdp(method, params)`; tests pass
// a fixture-backed one.

const debugSeenMissingMembers = new Set();

/** Unwrap a CDP AXValue ({type, value}) to its plain value. */
const axValue = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/** Collect a CDP AXNode's properties[] into a plain {name: value} map. */
const axProps = (raw) => {
  const out = {};
  for (const p of raw?.properties || []) out[p.name] = axValue(p.value);
  return out;
};

const EMPTY_RECT = Object.freeze({left: 0, top: 0, width: 0, height: 0});

/**
 * One AutomationNode-compatible wrapper over a CDP AXNode. Members follow the
 * spec §5 core set; unknown member reads resolve to undefined and are logged
 * once each (observability for U5 wiring, instead of silent misbehavior).
 */
class ShimNode {
  constructor(tree, raw) {
    this.tree_ = tree;
    this.raw_ = raw;
    this.props_ = axProps(raw);
    this.synthetic_ = Boolean(raw?.synthetic);
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && !debugSeenMissingMembers.has(prop)) {
          debugSeenMissingMembers.add(prop);
          try { console.debug(`[a11y-shim] unimplemented AutomationNode member read: ${prop}`); } catch {}
        }
        return undefined;
      },
    });
  }

  get id() { return this.raw_.nodeId; }
  get role() { return axValue(this.raw_.role); }
  get name() { return axValue(this.raw_.name); }
  get value() { return axValue(this.raw_.value); }
  get description() { return axValue(this.raw_.description); }
  get backendDOMNodeId() { return this.raw_.backendDOMNodeId; }
  get ignored() { return Boolean(this.raw_.ignored); }

  // --- state: CDP boolean/tristate properties as ChromeVox's state object.
  // ChromeVox reads state['focused'] / state[StateType.INVISIBLE] ('invisible').
  get state() {
    const s = {};
    for (const [k, v] of Object.entries(this.props_)) {
      if (typeof v === 'boolean') s[k] = v;
    }
    if (this.props_.hidden !== undefined) s.invisible = Boolean(this.props_.hidden);
    if (this.raw_.state) Object.assign(s, this.raw_.state); // synthetic override
    return s;
  }

  // --- tree links.
  get parent() { return this.tree_.parentOf(this); }
  get root() { return this.tree_.rootOf(this); }
  get children() { return this.tree_.childrenOf(this); }
  get firstChild() { return this.children[0]; }
  get lastChild() { const c = this.children; return c[c.length - 1]; }
  get indexInParent() {
    const p = this.parent;
    if (!p) return 0;
    return p.children.findIndex((c) => c.id === this.id);
  }
  get nextSibling() {
    const p = this.parent;
    if (!p) return undefined;
    return p.children[this.indexInParent + 1];
  }
  get previousSibling() {
    const p = this.parent;
    if (!p) return undefined;
    return p.children[this.indexInParent - 1];
  }

  // --- live-region attributes. CDP's Accessibility.getFullAXTree does NOT
  // reliably expose aria-live/aria-relevant/aria-atomic as AX properties on the
  // region node (aria-relevant in particular is essentially never present), so
  // the fork's containerLive* filter (live_regions.ts onTreeChange) would read
  // empty and DROP every non-'all' change — the "delivered but silent" spoke:0
  // failure. The U4 observer, running in the DOM, DOES capture the true
  // aria-live/relevant/atomic/busy at the source; the announcer stamps that
  // metadata onto the resolved node as liveOverride_ so these getters honor the
  // ground-truth DOM values first, falling back to any CDP props.
  liveRegionRoot_() {
    let n = this;
    while (n) {
      const live = (n.props_ ? n.props_.live : undefined) ?? (n.liveOverride_ ? n.liveOverride_.live : undefined);
      if (live !== undefined && live !== 'off') return n;
      n = n.parent;
    }
    return undefined;
  }
  // Override semantics: the override FILLS IN metadata CDP lacks (live/relevant
  // — CDP's AX tree drops aria-relevant, and often aria-live), so prefer the CDP
  // value when present and fall back to the override. But suppression flags
  // (busy) must never be LOWERED by the observer default: if EITHER source says
  // busy/atomic, honor it — otherwise the override's default:false would defeat
  // a genuinely-busy region's suppression (matching upstream ChromeVox).
  get containerLiveStatus() {
    const r = this.liveRegionRoot_();
    return r?.props_.live ?? r?.liveOverride_?.live;
  }
  get containerLiveRelevant() {
    const r = this.liveRegionRoot_();
    return r?.props_.relevant ?? r?.liveOverride_?.relevant;
  }
  get containerLiveBusy() {
    const r = this.liveRegionRoot_();
    return Boolean(r?.props_.busy || r?.liveOverride_?.busy);
  }
  get containerLiveAtomic() {
    const r = this.liveRegionRoot_();
    return Boolean(r?.props_.atomic || r?.liveOverride_?.atomic);
  }
  get liveAtomic() { return Boolean(this.props_.atomic || this.liveOverride_?.atomic); }

  // --- misc core members (spec §5), mapped or safe-defaulted.
  get restriction() { return this.props_.restriction; }
  get checked() { return this.props_.checked; }
  get invalidState() { return this.props_.invalid; }
  get hasPopup() { return this.props_.hasPopup; }
  get modal() { return Boolean(this.props_.modal); }
  get selected() { return this.props_.selected; }
  get posInSet() { return this.props_.posinset; }
  get setSize() { return this.props_.setsize; }
  get hierarchicalLevel() { return this.props_.level; }
  get placeholder() { return this.props_.placeholder; }
  get roleDescription() { return this.props_.roledescription; }
  get autoComplete() { return this.props_.autocomplete; }
  get accessKey() { return this.props_.keyshortcuts; }
  get activeDescendant() {
    const rel = this.props_.activedescendant;
    return rel?.relatedNodes?.[0]?.backendDOMNodeId !== undefined
      ? this.tree_.byBackendId(rel.relatedNodes[0].backendDOMNodeId)
      : undefined;
  }
  get nameFrom() { return axValue(this.raw_.name?.sources?.[0]?.type) ?? this.props_.nameFrom; }
  get display() { return undefined; }
  get htmlTag() { return undefined; }
  get detectedLanguage() { return this.props_.language; }
  get language() { return this.props_.language; }
  get docUrl() { return this.tree_.url; }
  get url() { return this.props_.url; }
  // Geometry: async in CDP; hot phase-1 paths only null-check it. Safe default
  // avoids `.left of undefined` throws in cosmetic paths (focus rings stubbed).
  get location() { return this.raw_.location || EMPTY_RECT; }
  get unclippedLocation() { return this.location; }
  get textSelStart() { return undefined; } // spec: dark on canvas; phase 2 via caret.probe
  get textSelEnd() { return undefined; }
  get standardActions() { return []; }
  get customActions() { return []; }
  get markers() { return []; }
  get defaultActionVerb() { return this.props_.defaultActionVerb; }

  matches(params = {}) {
    const wantRole = params.role;
    if (wantRole && this.role !== wantRole) return false;
    const st = params.state || {};
    const own = this.state;
    for (const [k, v] of Object.entries(st)) if (Boolean(own[k]) !== Boolean(v)) return false;
    if (params.attributes?.name !== undefined) {
      const want = params.attributes.name;
      if (want instanceof RegExp ? !want.test(this.name || '') : this.name !== want) return false;
    }
    return true;
  }
  find(params = {}) {
    const stack = [...this.children];
    while (stack.length) {
      const n = stack.shift();
      if (n.matches(params)) return n;
      stack.push(...n.children);
    }
    return undefined;
  }
  addEventListener() {}
  removeEventListener() {}
  // AutomationNode action methods — no-ops in phase 1 (ChromeVoxRange.set_
  // calls makeVisible() on every range move; real action dispatch maps to CDP
  // in a later phase; agent-initiated clicks go through pointer.click anyway).
  makeVisible() {}
  doDefault() {}
  focus() {}
  setSelection() {}
  setAccessibilityFocus() {}
  showContextMenu() {}
  scrollToPoint() {}
  performStandardAction() {}
}

/**
 * The per-tab shim tree plus the synthetic desktop→window topology.
 * Spec §2: synthetic desktop root (serves chrome.automation.getDesktop) →
 * per-tab synthetic window (role window, state.focused for the active tab) →
 * the tab's real AX page root; getTopLevelRoot(node).parent resolves to the
 * synthetic window, defeating the "delivered but silent" suppression default.
 */
export class ShimTree {
  /**
   * @param {{cdp: (method: string, params?: object) => Promise<any>,
   *          tabId?: number, url?: string, focused?: boolean}} opts
   */
  constructor({cdp, tabId = -1, url = '', focused = true}) {
    this.cdp = cdp;
    this.tabId = tabId;
    this.url = url;
    this.focused = focused;
    this.byId_ = new Map();
    this.byBackend_ = new Map();
    this.parentIds_ = new Map();
    this.rootId_ = null;
    this.desktop_ = null;
    this.window_ = null;
    this.stale = true;
  }

  async refresh() {
    await this.cdp('Accessibility.enable', {});
    const {nodes} = await this.cdp('Accessibility.getFullAXTree', {});
    this.byId_.clear(); this.byBackend_.clear(); this.parentIds_.clear();
    for (const raw of nodes) {
      const node = new ShimNode(this, raw);
      this.byId_.set(raw.nodeId, node);
      if (raw.backendDOMNodeId !== undefined) this.byBackend_.set(raw.backendDOMNodeId, node);
      for (const childId of raw.childIds || []) this.parentIds_.set(childId, raw.nodeId);
    }
    this.rootId_ = nodes.find((n) => this.parentIds_.get(n.nodeId) === undefined)?.nodeId ?? null;
    // Synthetic topology (spec §2).
    this.desktop_ = new ShimNode(this, {
      nodeId: 'synthetic-desktop', synthetic: true,
      role: {value: 'desktop'}, name: {value: 'actions.json a11y shim desktop'},
      state: {focused: false},
    });
    this.window_ = new ShimNode(this, {
      nodeId: 'synthetic-window', synthetic: true,
      role: {value: 'window'}, name: {value: this.url || `tab ${this.tabId}`},
      state: {focused: this.focused, invisible: false},
    });
    this.stale = false;
    return this;
  }

  get root() { return this.rootId_ !== null ? this.byId_.get(this.rootId_) : undefined; }
  get syntheticDesktop() { return this.desktop_; }
  get syntheticWindow() { return this.window_; }
  byBackendId(backendId) { return this.byBackend_.get(backendId); }
  nodeById(id) { return this.byId_.get(id); }

  parentOf(node) {
    if (node.synthetic_) {
      return node.id === 'synthetic-window' ? this.desktop_ : undefined;
    }
    const pid = this.parentIds_.get(node.id);
    if (pid !== undefined) return this.byId_.get(pid);
    // Page root's parent is the synthetic window — the topology ChromeVox's
    // getTopLevelRoot(node).parent walk expects.
    return this.window_;
  }
  rootOf(node) {
    // ChromeVox semantics: node.root is the node's own tree root (the page
    // root for page nodes; the desktop for synthetic ones).
    if (node.synthetic_) return this.desktop_;
    return this.root;
  }
  childrenOf(node) {
    if (node.synthetic_) {
      if (node.id === 'synthetic-desktop') return this.window_ ? [this.window_] : [];
      return this.root ? [this.root] : [];
    }
    return (node.raw_.childIds || []).map((id) => this.byId_.get(id)).filter(Boolean);
  }

  /** Find the focused node (CDP 'focused' property), if any. */
  focusedNode() {
    for (const n of this.byId_.values()) if (n.props_.focused) return n;
    return undefined;
  }

  /** a11y.query: resolve by role and/or accessible name (exact or substring). */
  query({role, name, name_contains} = {}) {
    for (const n of this.byId_.values()) {
      if (n.ignored) continue;
      if (role && n.role !== role) continue;
      if (name !== undefined && n.name !== name) continue;
      if (name_contains !== undefined && !(n.name || '').includes(name_contains)) continue;
      if (!role && name === undefined && name_contains === undefined) continue;
      return n;
    }
    return undefined;
  }

  /** Clickable center for a node, via DOM box model (CDP). */
  async clickableCenter(node) {
    if (!node?.backendDOMNodeId) return null;
    try {
      const {model} = await this.cdp('DOM.getBoxModel', {backendNodeId: node.backendDOMNodeId});
      const q = model?.content;
      if (!q || q.length < 8) return null;
      return {x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4), y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4)};
    } catch { return null; }
  }

  /**
   * Attest that the accessibility node's geometric center is owned by the
   * page element itself. AX bounds identify a node, but do not prove that a
   * sticky header, overlay, or another hit-test surface receives a pointer.
   */
  async actionability(node) {
    const visibleCenter = await this.clickableCenter(node);
    const result = {
      visible_center: visibleCenter,
      visible_rect: null,
      clickable: false,
      receives_events: null,
      actionability_attested: false,
      occluded_by: null,
    };
    if (!node?.backendDOMNodeId) return result;

    let objectId = null;
    try {
      const resolved = await this.cdp('DOM.resolveNode', {backendNodeId: node.backendDOMNodeId});
      objectId = resolved?.object?.objectId || null;
      if (!objectId) return result;
      const evaluated = await this.cdp('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function() {
          const rect = this.getBoundingClientRect();
          const visibleRect = {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = (rect.width > 0 && rect.height > 0)
            ? document.elementFromPoint(x, y)
            : null;
          const receives = Boolean(hit && (hit === this || this.contains(hit)));
          const text = hit && typeof hit.textContent === 'string'
            ? hit.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)
            : '';
          return {
            visible_center: {x: Math.round(x), y: Math.round(y)},
            visible_rect: visibleRect,
            receives_events: receives,
            clickable: receives,
            occluded_by: !receives && hit ? {
              tag_name: String(hit.tagName || '').toLowerCase() || null,
              id: hit.id || null,
              text,
            } : null,
          };
        }`,
      });
      const value = evaluated?.result?.value;
      if (!value || typeof value !== 'object') return result;
      return {...result, ...value, actionability_attested: true};
    } catch {
      return result;
    } finally {
      if (objectId) {
        try { await this.cdp('Runtime.releaseObject', {objectId}); } catch {}
      }
    }
  }

  /**
   * a11y.tree: compact role/name outline for agent consumption. Skips ignored
   * and empty structural nodes; depth-limits to keep envelopes bounded.
   */
  outline({maxDepth = 12, maxNodes = 800} = {}) {
    const lines = [];
    const walk = (node, depth) => {
      if (!node || lines.length >= maxNodes) return;
      const name = node.name ? ` "${String(node.name).slice(0, 120)}"` : '';
      const val = node.value !== undefined && node.value !== '' ? ` = ${String(node.value).slice(0, 60)}` : '';
      const live = node.props_?.live && node.props_.live !== 'off' ? ` [live:${node.props_.live}]` : '';
      const focused = node.state.focused ? ' [focused]' : '';
      if (!node.ignored && (node.role || name)) {
        lines.push(`${'  '.repeat(depth)}${node.role || '?'}${name}${val}${live}${focused}`);
      }
      if (depth >= maxDepth) return;
      for (const c of node.children) walk(c, node.ignored ? depth : depth + 1);
    };
    walk(this.root, 0);
    return {url: this.url, tab_id: this.tabId, node_count: this.byId_.size, outline: lines.join('\n')};
  }
}

/**
 * Install the runtime chrome.automation functions over the value shim that
 * automation_globals.js injected (spec §4). `getTree` supplies the active
 * tab's refreshed ShimTree; observers receive TreeChange records from the U4
 * observer via dispatchTreeChange.
 */
// Module-global observer registry: the bundled LiveRegions is a singleton that
// subscribes exactly once (its constructor); re-installing the shim (new tab
// focus, tests) must preserve that subscription rather than orphan it.
const TREE_CHANGE_OBSERVERS = new Set();

export function installAutomationShim({getTree}) {
  const observers = TREE_CHANGE_OBSERVERS;
  const A = globalThis.chrome.automation;
  A.addTreeChangeObserver = (_filter, cb) => { observers.add(cb); };
  A.removeTreeChangeObserver = (cb) => { observers.delete(cb); };
  A.getDesktop = async (cb) => {
    const tree = await getTree();
    const d = tree?.syntheticDesktop;
    if (cb) cb(d);
    return d;
  };
  A.getFocus = async (cb) => {
    const tree = await getTree();
    const f = tree?.focusedNode();
    if (cb) cb(f);
    return f;
  };
  A.setDocumentSelection = (_p) => {
    try { console.debug('[a11y-shim] setDocumentSelection: no-op in phase 1'); } catch {}
  };
  return {
    dispatchTreeChange(record) { for (const cb of observers) { try { cb(record); } catch (e) { try { console.warn('[a11y-shim] observer error', e); } catch {} } } },
    observerCount: () => observers.size,
  };
}
