// U5 — the announcer: where the brain (bundled ChromeVox LiveRegions/Output),
// the eyes (AutomationShim trees), and the ears (U4 observer records) meet.
// Drives LiveRegions.onTreeChange with shim-node TreeChange records and
// captures utterances at the TTS sink seam as announcement records
// {text, politeness, category, interrupt, tab, region, ts} (spec §6).
//
// Politeness correlation (plan KTD4): the fork's QueueMode is time-multiplexed
// (5s window) and TtsCategory is LIVE for both politeness levels, so politeness
// rides the U4 observer metadata, correlated batch-by-batch: batches dispatch
// sequentially (single-flight) and the sink stamps the active batch's metadata
// onto every utterance it emits. QueueMode only informs the `interrupt` hint.
import {
  LiveRegions,
  ChromeVox,
  ChromeVoxRange,
  CursorRange,
  QueueMode,
  LocaleOutputHelper,
} from '../../dist/a11y-bundle.js';
import {installAutomationShim} from './automation_shim.js';

export class Announcer {
  /**
   * @param {{getTree: (tabId?: number) => Promise<import('./automation_shim.js').ShimTree>,
   *          onAnnouncement: (record: object) => void}} opts
   */
  constructor({getTree, onAnnouncement}) {
    this.getTree_ = getTree;
    this.onAnnouncement_ = onAnnouncement;
    this.activeMeta_ = null;
    this.shim_ = null;
    this.dispatchChain_ = Promise.resolve();
  }

  start() {
    this.shim_ = installAutomationShim({getTree: () => this.getTree_()});
    const sink = {
      speak: (textOrSpannable, queueMode, _props) => {
        this.diag = this.diag || {};
        this.diag.spoke = (this.diag.spoke || 0) + 1;
        const text = String(textOrSpannable ?? '').trim();
        if (!text) return;
        const meta = this.activeMeta_ || {};
        this.onAnnouncement_({
          text,
          politeness: meta.politeness || 'polite',
          category: 'live',
          interrupt: queueMode === QueueMode.CATEGORY_FLUSH || queueMode === QueueMode.FLUSH,
          tab: meta.tabId ?? null,
          region: meta.region ?? null,
          region_role: meta.role ?? null,
          relevant: meta.relevant ?? null,
          ts: Date.now(),
        });
      },
      isSpeaking: () => false,
      stop: () => {},
      increaseOrDecreaseProperty: () => {},
      setProperty: () => {},
    };
    ChromeVox.tts = sink;
    ChromeVox.braille = {write: () => {}, writeRawImage: () => {}, freeze: () => {}, thaw: () => {}};
    ChromeVox.earcons = {playEarcon: () => {}, cancelEarcon: () => {}};
    // LocaleOutputHelper.instance is required by Output.assignLocaleAndAppend
    // (it calls instance.computeTextAndLocale on every formatted name). Its real
    // init() touches chrome.tts / accessibilityPrivate — privileged APIs we lack
    // — and we don't do TTS voice switching anyway (the agent consumes text, not
    // audio). Install a minimal instance that returns the text unchanged. Without
    // it, every Output.range_ throws "Cannot read properties of undefined
    // (reading 'computeTextAndLocale')" and nothing reaches the sink (spoke:0).
    if (LocaleOutputHelper && !LocaleOutputHelper.instance) {
      LocaleOutputHelper.instance = {
        computeTextAndLocale: (text) => ({text, locale: undefined}),
      };
    }
    if (!ChromeVoxRange.instance) ChromeVoxRange.init();
    if (!LiveRegions.instance) LiveRegions.init();
    return this;
  }

  /**
   * Point ChromeVoxRange at the tab's tree — the suppression gate's first
   * check (spec §2): a current range sharing the node's root is sufficient
   * to defeat shouldIgnoreLiveRegion_ for that tab.
   */
  focusTree(tree) {
    const root = tree?.root;
    if (!root) return;
    try {
      ChromeVoxRange.set(CursorRange.fromNode(root));
    } catch (e) {
      try { console.debug('[a11y] ChromeVoxRange.set fallback:', e?.message); } catch {}
    }
  }

  /**
   * Resolve a U4 record's region/changed node to a shim node. Order:
   * (1) region identity as a CSS selector via CDP DOM;
   * (2) descendant text match inside live regions (textChanged path);
   * (3) any live region node (last resort — better an attributed announcement
   *     than a dropped one).
   */
  async resolveNode_(tree, record) {
    const identity = record.region?.identity;
    if (identity && tree.cdp) {
      try {
        const {root} = await tree.cdp('DOM.getDocument', {depth: 1});
        const {nodeId} = await tree.cdp('DOM.querySelector', {nodeId: root.nodeId, selector: identity});
        if (nodeId) {
          const {node} = await tree.cdp('DOM.describeNode', {nodeId});
          const hit = node?.backendNodeId !== undefined ? tree.byBackendId(node.backendNodeId) : undefined;
          if (hit) return this.descendantForText_(hit, record.text) || hit;
        }
      } catch { /* fall through */ }
    }
    for (const n of tree.byId_.values()) {
      if (n.props_?.live && n.props_.live !== 'off') {
        const hit = this.descendantForText_(n, record.text);
        if (hit) return hit;
      }
    }
    for (const n of tree.byId_.values()) {
      if (n.props_?.live && n.props_.live !== 'off') return n;
    }
    return undefined;
  }

  descendantForText_(regionNode, text) {
    if (!text) return undefined;
    const stack = [regionNode];
    while (stack.length) {
      const n = stack.shift();
      if (n.name === text || n.value === text) return n;
      stack.push(...n.children);
    }
    return undefined;
  }

  /**
   * Handle one U4 batch (the background sink hook feeds this). Single-flight:
   * batches queue so metadata correlation can't interleave.
   */
  diagnostics() { return this.diag || null; }

  handleBatch(tabId, entry) {
    this.dispatchChain_ = this.dispatchChain_.then(() => this.dispatchBatch_(tabId, entry)).catch((e) => {
      try { console.warn('[a11y] announcer batch failed', e); } catch {}
    });
    return this.dispatchChain_;
  }

  async dispatchBatch_(tabId, entry) {
    this.diag = this.diag || {batches: 0, treeNull: 0, records: 0, resolved: 0, unresolved: 0, dispatched: 0, spoke: 0, lastErr: null};
    this.diag.batches += 1;
    let tree;
    try {
      tree = await this.getTree_(tabId);
    } catch (e) { this.diag.lastErr = 'getTree:' + (e?.message || e); tree = null; }
    if (!tree) { this.diag.treeNull += 1; return; }
    this.focusTree(tree);
    for (const record of entry.records || []) {
      if (record.type === 'subtreeUpdateEnd') {
        this.activeMeta_ = {tabId, politeness: this.activeMeta_?.politeness, region: this.activeMeta_?.region};
        this.shim_.dispatchTreeChange({type: 'subtreeUpdateEnd', target: tree.root});
        continue;
      }
      this.diag.records += 1;
      const target = await this.resolveNode_(tree, record);
      if (!target) { this.diag.unresolved += 1; continue; }
      this.diag.resolved += 1;
      // Stamp the observer's DOM-sourced live metadata onto the resolved node
      // AND its live-region root, so the fork's containerLive* filter sees the
      // ground truth (CDP AX props are unreliable/absent for aria-relevant).
      // Without this, containerLiveRelevant is empty and the fork drops the
      // change before queuing it — the spoke:0 silent drop.
      const liveMeta = {
        live: record.region?.politeness || 'polite',
        relevant: record.region?.relevant || 'additions text',
        atomic: Boolean(record.region?.atomic),
        busy: Boolean(record.region?.busy),
      };
      target.liveOverride_ = liveMeta;
      const regionRoot = target.liveRegionRoot_?.();
      if (regionRoot && regionRoot !== target) regionRoot.liveOverride_ = liveMeta;
      this.activeMeta_ = {
        tabId,
        politeness: record.region?.politeness || 'polite',
        region: record.region?.identity || null,
        role: record.region?.role || null,
        relevant: record.region?.relevant || null,
      };
      this.diag.dispatched += 1;
      this.shim_.dispatchTreeChange({type: record.type, target});
    }
    // Let the fork's queued processing (SUBTREE_UPDATE_END path) run before the
    // batch's metadata goes out of scope.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.activeMeta_ = null;
  }
}
