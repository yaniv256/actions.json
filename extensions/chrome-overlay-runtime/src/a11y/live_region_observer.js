// U4 — frame-aware live-region observer (docs/a11y-shim-spec.md §1).
// Injected as a SEPARATE observer-only content script with allFrames:true —
// content.js stays top-frame-only (re-injecting it tears down the live bridge
// connection; this script is idempotent and safe to re-inject). Emits typed
// per-changed-node TreeChange-shaped records, each burst terminated by one
// SUBTREE_UPDATE_END — the addTreeChangeObserver contract the fork's
// LiveRegions.onTreeChange consumes. NO utterance assembly here (that is the
// fork's job against shim nodes); this script only detects, types, and tags.
//
// Classic content script (not ESM). The logic lives in pure-ish factories so
// tests can drive it with fake documents/observers via the CommonJS export.
(function () {
  'use strict';

  const LIVE_SELECTOR = '[aria-live], [role="alert"], [role="status"], [role="log"]';
  const IMPLICIT_POLITENESS = { alert: 'assertive', status: 'polite', log: 'polite' };

  /** Politeness for a region element: aria-live wins, else implicit role. */
  function regionPoliteness(el) {
    const ariaLive = el.getAttribute && el.getAttribute('aria-live');
    if (ariaLive) return ariaLive;
    const role = el.getAttribute && el.getAttribute('role');
    return (role && IMPLICIT_POLITENESS[role.toLowerCase()]) || 'off';
  }

  /** Stable-ish identity for a region: id > css path (bounded depth). */
  function regionIdentity(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let n = el;
    for (let depth = 0; n && n.nodeType === 1 && depth < 6; depth++) {
      const tag = n.tagName ? n.tagName.toLowerCase() : '?';
      const idx = n.parentElement
        ? Array.prototype.indexOf.call(n.parentElement.children, n) + 1
        : 1;
      parts.unshift(`${tag}:nth-child(${idx})`);
      if (n.id) { parts[0] = `#${n.id}`; break; }
      n = n.parentElement;
    }
    return parts.join('>');
  }

  /** Map a MutationRecord to zero or more typed TreeChange record seeds. */
  function classifyMutation(mut) {
    const out = [];
    if (mut.type === 'characterData') {
      out.push({ type: 'textChanged', node: mut.target.parentElement || null, text: String(mut.target.data || '') });
    } else if (mut.type === 'childList') {
      for (const added of mut.addedNodes || []) {
        if (added.nodeType === 1) out.push({ type: 'subtreeCreated', node: added, text: added.textContent || '' });
        else if (added.nodeType === 3) out.push({ type: 'nodeCreated', node: added.parentElement || null, text: String(added.data || '') });
      }
      for (const removed of mut.removedNodes || []) {
        if (removed.nodeType === 1 || removed.nodeType === 3) out.push({ type: 'nodeRemoved', node: mut.target, text: '' });
      }
    }
    return out;
  }

  /**
   * Create an observer instance over a document. Dependencies injected for
   * tests: {doc, MutationObserverCtor, post(records), schedule(flushFn)}.
   */
  function createLiveRegionObserver(deps) {
    const doc = deps.doc;
    const MO = deps.MutationObserverCtor;
    const post = deps.post;
    const schedule = deps.schedule || ((fn) => setTimeout(fn, 0));
    const observed = new Set();
    let pending = [];
    let flushScheduled = false;

    const flush = () => {
      flushScheduled = false;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      batch.push({ kind: 'a11y.treeChange', type: 'subtreeUpdateEnd', region: null, text: '' });
      post(batch);
    };

    const enqueue = (region, seed) => {
      if (!seed.node && seed.type !== 'nodeRemoved') return;
      pending.push({
        kind: 'a11y.treeChange',
        type: seed.type,
        text: (seed.text || '').slice(0, 4000),
        region: {
          identity: regionIdentity(region),
          politeness: regionPoliteness(region),
          atomic: region.getAttribute && region.getAttribute('aria-atomic') === 'true',
          relevant: (region.getAttribute && region.getAttribute('aria-relevant')) || 'additions text',
          role: (region.getAttribute && region.getAttribute('role')) || null,
          busy: region.getAttribute && region.getAttribute('aria-busy') === 'true',
        },
      });
      if (!flushScheduled) {
        flushScheduled = true;
        schedule(flush);
      }
    };

    const observeRegion = (region) => {
      if (observed.has(region)) return;
      if (regionPoliteness(region) === 'off') return;
      observed.add(region);
      const mo = new MO((muts) => {
        for (const mut of muts) for (const seed of classifyMutation(mut)) enqueue(region, seed);
      });
      mo.observe(region, { subtree: true, childList: true, characterData: true });
    };

    const scanForRegions = (rootEl) => {
      if (!rootEl || !rootEl.querySelectorAll) return;
      if (rootEl.matches && rootEl.matches(LIVE_SELECTOR)) observeRegion(rootEl);
      for (const el of rootEl.querySelectorAll(LIVE_SELECTOR)) observeRegion(el);
    };

    // Watch the whole document for regions added later.
    const docWatcher = new MO((muts) => {
      for (const mut of muts) for (const added of mut.addedNodes || []) {
        if (added.nodeType === 1) scanForRegions(added);
      }
    });
    docWatcher.observe(doc.documentElement || doc, { subtree: true, childList: true });
    scanForRegions(doc.documentElement || doc);

    return {
      regionCount: () => observed.size,
      _flushNow: flush, // test hook
    };
  }

  // --- content-script bootstrap (idempotent; skipped in test envs) ---
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  const inExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage && typeof document !== 'undefined';
  if (inExtension && !g.__actionsJsonA11yObserver) {
    g.__actionsJsonA11yObserver = createLiveRegionObserver({
      doc: document,
      MutationObserverCtor: MutationObserver,
      post: (records) => {
        try {
          chrome.runtime.sendMessage({
            type: 'actions-json:a11y-tree-changes',
            records,
            frame_url: location.href,
            is_top_frame: window === window.top,
          });
        } catch (_e) { /* SW asleep or context gone — records drop; announcer refresh covers */ }
      },
    });
  }

  // Test export (Node createRequire); invisible to the content-script env.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createLiveRegionObserver, regionPoliteness, regionIdentity, classifyMutation };
  }
})();
