import {
  listSiteActionsFromBundle,
  listSiteStorageFilesFromBundle,
  readSiteStorageFileFromBundle,
  resolveSiteActionFromBundle,
  siteBlockedPrimitiveNamesFromBundle,
} from "./agent/local-actions-catalog.mjs";
import {
  buildSemanticDeltas,
  diffStates,
  listStateProjectionsFromBundle,
  verifyStatePostcondition,
} from "./agent/state-projections.mjs";
import {
  buildRealtimeToolCatalog,
  filterRealtimeToolsForBlockedPrimitives,
} from "./agent/realtime-tool-catalog.mjs";
import {
  BridgeOutputDeliveryQueue,
} from "./agent/bridge-output-delivery.mjs";
import { ShimTree } from "./a11y/automation_shim.js";
// Static import — MV3 service workers DISALLOW dynamic import() (HTML spec).
// A dynamic import here silently failed and dropped the entire announcement
// pipeline; caught by the Playwright live smoke, invisible to Node-ESM unit
// tests where import() is legal.
import { Announcer } from "./a11y/announcer.js";
import {
  normalizeGatedRepeatArgs,
  runGatedRepeat,
} from "./a11y/gated-repeat.mjs";
import {
  TransferBuffer,
  TransferBufferError,
} from "./agent/transfer-buffer.mjs";
import {
  executeWorkflowAction,
} from "./agent/workflow-actions.mjs";
import {
  normalizeSiteActionCallArgs,
} from "./agent/site-action-args.mjs";
import {
  createCloudStore,
} from "./agent/cloud-store.mjs";
import {
  reconcileDay,
} from "./agent/usage-reconciler.mjs";
import {
  agentEventFromSessionEvent,
} from "./agent/agent-event-map.mjs";
import { DEFAULT_MODEL } from "./agent/realtime-model.mjs";

const SESSION_STATE_KEY = "ACTIONS_JSON_OVERLAY_SESSION_STATE";
const AGENT_KEY_STORAGE_KEY = "ACTIONS_JSON_OPENAI_API_KEY";
const AGENT_MEMORY_STORAGE_KEY = "ACTIONS_JSON_AGENT_MEMORY_V1";
const EXTENSION_STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";
// Retention for the on-disk agent memory/session log. Rehydration into a new
// hosted session stays at REHYDRATION_EVENT_LIMIT (session-memory-store.mjs);
// this cap only bounds what is kept and what runtime.session.log can return.
// 80 could not hold one full task run (~150 events), which blinded post-hoc
// debugging and made memory-contamination checks impossible.
const MAX_AGENT_LOG_EVENTS = 500;
const DEFAULT_SESSION_ID = "actions-json-default";
const DEFAULT_SESSION_GROUP_TITLE = "actions.json";
const DEFAULT_BRIDGE_URL = "ws://100.99.150.49:17345/extension";
const AGENT_OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const AGENT_OFFSCREEN_TARGET = "actions-json-agent-offscreen";
const EXTENSION_ACTIONS_URL = "actions/overlay.actions.json";
const BACKGROUND_BRIDGE_CONNECT_TIMEOUT_MS = 8000;
// Tab-lifecycle + dialog-dismiss tools are handled only in the background
// service worker (executeBackgroundHostedToolCall), not in content.js. Direct
// MCP-bridge tool calls (type:"action_call") must be intercepted in
// routeBridgeItemToTab and run here — forwarding them to the content script
// throws "No handler implemented", and dismiss_dialog in particular exists to
// rescue a tab whose content channel is frozen by a native modal.
const BRIDGE_BACKGROUND_ACTION_NAMES = new Set([
  "browser.navigate",
  "browser.open_tab",
  "browser.close_tab",
  "browser.dismiss_dialog",
  // a11y primitives run on the CDP-backed AutomationShim, which lives here in
  // the background worker (it owns chrome.debugger) — forwarding them to
  // content.js executeAction would throw "No handler implemented".
  "a11y.tree",
  "a11y.query",
  "a11y.watch",
  // keyboard.press_gated is trusted-CDP-only (it presses + reads the a11y layer
  // in one held debugger session), so it ALWAYS runs in the background worker —
  // there is no synthetic counterpart to A/B against, unlike keyboard.press.
  "keyboard.press_gated",
]);

// keyboard.press has TWO implementations selected by an optional `trusted` flag:
// the default synthetic path runs in content.js (portable, untrusted); when
// trusted:true it must run in the BACKGROUND worker so it can dispatch a real
// (trusted) key via CDP Input.dispatchKeyEvent — the only kind canvas editors
// (Google Slides/Docs/Sheets) honor. trusted is opt-in and always has a
// non-debugger counterpart, so the two paths can be A/B compared to confirm
// whether trusted is actually required. This predicate decides, per call,
// whether keyboard.press routes to the background worker.
const bridgeItemNeedsBackground = (item) => {
  if (item?.type !== "action_call") return false;
  if (BRIDGE_BACKGROUND_ACTION_NAMES.has(item?.name)) return true;
  if (item?.name === "keyboard.press" && item?.arguments && item.arguments.trusted === true) {
    return true;
  }
  if (item?.name === "text.type" && item?.arguments && item.arguments.trusted === true) {
    return true;
  }
  // pointer.drag with trusted:true runs in the background (CDP Input.dispatchMouseEvent):
  // a real animated pointer drag (the faded drag-ghost follows the cursor). The default
  // (untrusted) pointer.drag stays synthetic in content.js.
  if (item?.name === "pointer.drag" && item?.arguments && item.arguments.trusted === true) {
    return true;
  }
  return false;
};

let knownPrimitiveNamesPromise = null;
const getKnownPrimitiveNames = () => {
  if (!knownPrimitiveNamesPromise) {
    knownPrimitiveNamesPromise = (async () => {
      try {
        const response = await fetch(chrome.runtime.getURL(EXTENSION_ACTIONS_URL));
        if (!response.ok) {
          return null;
        }
        const manifest = await response.json();
        const primitives = manifest?.primitive_dictionary?.primitives;
        if (!Array.isArray(primitives) || primitives.length === 0) {
          return null;
        }
        const names = primitives
          .map((primitive) => primitive?.name)
          .filter((name) => typeof name === "string" && name);
        return names.length > 0 ? names : null;
      } catch (_error) {
        // Fail open: a manifest read problem must not block workflow execution.
        return null;
      }
    })();
  }
  return knownPrimitiveNamesPromise;
};
const HOSTED_SCREENSHOT_DEFAULTS = {
  format: "jpeg",
  quality: 60,
  max_width: 960,
  max_height: 960,
  max_kilobytes: 180,
  capture_timeout_ms: 10000,
};

let creatingAgentOffscreenDocument = null;
let bridgeSocket = null;
let bridgeState = null;
let bridgeReconnectTimer = null;
let bridgeReconnectAttempts = 0;
const bridgeRuntimeRoutes = new Map();

// Honest routing-failure next-steps, mirroring the bridge's route_error_next_step
// (mcp/actions-json-mcp/src/lib.rs). Both surfaces speak one error vocabulary so
// a wrong route self-corrects in one read, whichever side names the failure. The
// opaque `no_claimed_tab` is retired in favor of tab_closed / claim_missing here.
const ROUTE_ERROR_NEXT_STEP = {
  tab_closed:
    "The tab has closed. Re-list runtimes (bridge/runtimes) and reopen or re-claim the target before retrying.",
  claim_missing:
    "No claimed tab resolved for this call. Claim the target tab (claim_tab), then retry.",
};

const transferBuffer = new TransferBuffer();
const stateProjectionSnapshots = new Map();
const bridgeOutputDeliveryQueue = new BridgeOutputDeliveryQueue({
  emitDiagnostic: (event) => appendBackgroundDiagnosticEvent(event),
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("bridgeUrl");
  if (!existing.bridgeUrl) {
    await chrome.storage.local.set({ bridgeUrl: DEFAULT_BRIDGE_URL });
  }
});

// How long a single chrome.storage.local access may pend before we stop waiting
// on it. Under MV3 the background service worker is torn down and re-instantiated
// constantly; a storage access that never settles (dead worker context, zombie
// promise) MUST NOT hang the caller forever. Every claimed_tabs.* handler awaits
// SessionStore readiness, so an unbounded init promise wedges all tab-lifecycle
// calls into 504s while non-store handlers keep working. Bounding it turns a
// permanent hang into a fast, retryable degradation. (investigations/bridge-504-timeouts.md)
const SESSION_STORE_IO_TIMEOUT_MS = 3000;

// NOTE: withTimeout(promise, ms, label) is declared once later in this module and
// reused here — its const initializes before any SessionStore method runs (methods
// execute post-module-eval). Do NOT redeclare it: a second `const withTimeout`
// throws "Identifier already declared" at load and breaks the whole service worker.

// Bounded chrome.storage.local access — the shared *access* primitive every
// background-SW store uses instead of raw chrome.storage.local. An unbounded
// storage await on a background hot path becomes a 504 when MV3 recycles the
// worker mid-access and leaves a dead promise; bounding each access turns that
// permanent hang into a fast rejection the caller can degrade from. Callers own
// the readiness/degrade lifecycle (e.g. SessionStore.ensureReady); this helper
// owns only the timeout. (docs/plans/2026-07-07-001; investigations/bridge-504-timeouts.md)
const boundedStorageGet = (key, ms = SESSION_STORE_IO_TIMEOUT_MS) => {
  return withTimeout(chrome.storage.local.get(key), ms, "storage.local.get");
};
const boundedStorageSet = (items, ms = SESSION_STORE_IO_TIMEOUT_MS) => {
  return withTimeout(chrome.storage.local.set(items), ms, "storage.local.set");
};

class SessionStore {
  constructor() {
    this.state = { sessions: {} };
    // Self-healing readiness: a one-shot `this.ready = this.load()` that stalls
    // wedges EVERY reader forever (the 504 root cause). Instead, ensureReady()
    // re-initializes the load promise whenever the previous attempt rejected or
    // timed out, so a stuck init recovers on the next call rather than hanging
    // the whole tab-lifecycle surface.
    this.readyPromise = null;
    this.loaded = false;
  }

  async load() {
    const stored = await boundedStorageGet(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
      };
    }
    this.loaded = true;
  }

  // Await readiness without ever hanging permanently. If a prior load stalled or
  // rejected, start a fresh one; a caller after a failed load retries the init
  // rather than awaiting a dead promise. Once loaded, this is a no-op.
  async ensureReady() {
    if (this.loaded) return;
    if (!this.readyPromise) {
      this.readyPromise = this.load().catch((error) => {
        // Drop the failed promise so the NEXT ensureReady() re-attempts the load
        // instead of re-awaiting a rejected/stale one. The in-memory default
        // ({ sessions: {} }) is a safe fallback; a later save() re-persists it.
        this.readyPromise = null;
        throw error;
      });
    }
    try {
      await this.readyPromise;
    } catch (_error) {
      // Degrade to the in-memory default rather than propagating a hang/reject to
      // every tab-lifecycle handler. Storage may recover on a subsequent access.
    }
  }

  async save() {
    await boundedStorageSet({ [SESSION_STATE_KEY]: this.state })
      .catch(() => { /* best effort; in-memory state remains authoritative this run */ });
  }

  async getSession(sessionId = DEFAULT_SESSION_ID) {
    await this.ensureReady();
    const existing = this.state.sessions[sessionId];
    if (existing && typeof existing === "object") {
      return existing;
    }
    const created = {
      chromeGroupId: null,
      title: DEFAULT_SESSION_GROUP_TITLE,
      activeTabId: null,
      tabs: {},
    };
    this.state.sessions[sessionId] = created;
    await this.save();
    return created;
  }

  async getSessionEntries() {
    await this.ensureReady();
    return Object.entries(this.state.sessions);
  }
}

const sessionStore = new SessionStore();

const hasTabId = (tab) => tab && typeof tab.id === "number";

const runtimeKeyForTab = (tabId) => `chrome-tab:${tabId}`;

// U8 (R6-for-real): a MACHINE/BROWSER label, e.g. "mac · 7c19". The bridge's
// `host` is the SITE host (trello.com), so two browsers on the same page are
// indistinguishable without this (live-caught 2026-07-09: ext deployed on both
// Windows and Mac, agent could not tell them apart). Label = platform OS +
// a stable per-install id, so two Chromes on the SAME OS still differ.
// chrome.runtime.getPlatformInfo() needs no permission. Computed once, cached.
const DEVICE_ID_STORAGE_KEY = "actionsJsonDeviceId";
let deviceLabelPromise = null;
const getDeviceLabel = () => {
  if (!deviceLabelPromise) {
    deviceLabelPromise = (async () => {
      try {
        const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
        let id = stored?.[DEVICE_ID_STORAGE_KEY];
        if (typeof id !== "string" || !id) {
          // Short, stable, install-scoped. Survives restarts; regenerates only
          // on a fresh install/profile — which IS a different browser.
          id = Math.random().toString(36).slice(2, 6);
          await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: id });
        }
        const info = await chrome.runtime.getPlatformInfo().catch(() => null);
        const os = info?.os || "unknown";
        return `${os} · ${id}`;
      } catch (_error) {
        return null; // never block a claim on the label; the field is optional
      }
    })();
  }
  return deviceLabelPromise;
};

const newAuthorizationId = () => `authorization-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const sendBridgeItem = (item) => {
  if (bridgeSocket?.readyState === WebSocket.OPEN) {
    try {
      bridgeSocket.send(JSON.stringify(item));
      return true;
    } catch (error) {
      appendBackgroundDiagnosticEvent({
        type: "transport",
        name: "background.bridge.websocket_send",
        ok: false,
        summary: "Extension background failed to send a bridge protocol item.",
        input: {
          message_type: item?.type || null,
          runtime_id: item?.runtime_id || null,
          call_id: item?.call_id || null,
        },
        output: {
          error_message: error?.message || String(error),
          ready_state: bridgeSocket?.readyState ?? null,
        },
      });
      return false;
    }
  }
  return false;
};

const sendBridgeOutputItem = (item) => bridgeOutputDeliveryQueue.deliver(item, sendBridgeItem);

const newBridgeSessionId = () => `bridge-session-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const closeBridgeSocket = () => {
  clearTimeout(bridgeReconnectTimer);
  bridgeReconnectTimer = null;
  const previous = bridgeSocket;
  bridgeSocket = null;
  if (previous && previous.readyState !== WebSocket.CLOSED) {
    previous.close();
  }
};

const sendTabMessage = (tabId, message) =>
  new Promise((resolve, reject) => {
    try {
      if (chrome.tabs.sendMessage.length < 3) {
        Promise.resolve(chrome.tabs.sendMessage(tabId, message)).then(resolve, reject);
        return;
      }
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });

const sendTabMessageBestEffort = async (tabId, message) => {
  try {
    return await sendTabMessage(tabId, message);
  } catch (error) {
    if (chrome.tabs.sendMessage.length >= 3) {
      throw error;
    }
    return new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (callbackError) {
        reject(callbackError);
      }
    });
  }
};

const runtimeIdFromBridgeItem = (item) =>
  item?.runtime_id ||
  item?.target_runtime_id ||
  item?.arguments?.runtime_id ||
  item?.arguments?.target_runtime_id ||
  null;

const runtimeKeyFromBridgeItem = (item) =>
  item?.runtime_key ||
  item?.target_runtime_key ||
  item?.arguments?.runtime_key ||
  item?.arguments?.target_runtime_key ||
  null;

const tabIdFromRuntimeKey = (runtimeKey) => {
  const match = /^chrome-tab:(\d+)$/.exec(String(runtimeKey || ""));
  return match ? Number(match[1]) : null;
};

const rememberRuntimeRoute = (readyItem, tabId) => {
  if (!readyItem || typeof readyItem !== "object") return;
  const resolvedTabId = Number.isInteger(tabId) ? tabId : tabIdFromRuntimeKey(readyItem.runtime_key);
  if (!Number.isInteger(resolvedTabId)) return;
  if (readyItem.runtime_id) {
    bridgeRuntimeRoutes.set(`runtime_id:${readyItem.runtime_id}`, resolvedTabId);
  }
  if (readyItem.runtime_key) {
    bridgeRuntimeRoutes.set(`runtime_key:${readyItem.runtime_key}`, resolvedTabId);
  }
};

// Inverse of rememberRuntimeRoute: drop every route entry pointing at a tab
// when that tab is closed/reaped, so bridgeRuntimeRoutes doesn't accumulate
// stale runtime_id/runtime_key -> tabId mappings for tabs that no longer exist.
const forgetRuntimeRoutesForTab = (tabId) => {
  if (!Number.isInteger(tabId)) return;
  for (const [key, mappedTabId] of bridgeRuntimeRoutes) {
    if (mappedTabId === tabId) bridgeRuntimeRoutes.delete(key);
  }
};

// The runtime_id(s) currently routed to a tab. Used at tab-close time to tell
// the bridge exactly which runtime to reap, before the routes are forgotten.
const runtimeIdsForTab = (tabId) => {
  const ids = [];
  if (!Number.isInteger(tabId)) return ids;
  for (const [key, mappedTabId] of bridgeRuntimeRoutes) {
    if (mappedTabId === tabId && key.startsWith("runtime_id:")) {
      ids.push(key.slice("runtime_id:".length));
    }
  }
  return ids;
};

const resolveBridgeItemTabId = (item) => {
  const runtimeId = runtimeIdFromBridgeItem(item);
  const runtimeKey = runtimeKeyFromBridgeItem(item);
  let tabId = runtimeId ? bridgeRuntimeRoutes.get(`runtime_id:${runtimeId}`) : null;
  if (!Number.isInteger(tabId) && runtimeKey) {
    tabId = bridgeRuntimeRoutes.get(`runtime_key:${runtimeKey}`);
  }
  if (!Number.isInteger(tabId)) {
    const runtimeKeyTabId = tabIdFromRuntimeKey(runtimeKey);
    if (Number.isInteger(runtimeKeyTabId)) {
      tabId = runtimeKeyTabId;
    }
  }
  if (!Number.isInteger(tabId) && bridgeState?.activeRuntimeTabIds?.size === 1) {
    tabId = Array.from(bridgeState.activeRuntimeTabIds)[0];
  }
  if (!Number.isInteger(tabId) && Number.isInteger(bridgeState?.tabId)) {
    tabId = bridgeState.tabId;
  }
  return Number.isInteger(tabId) ? tabId : null;
};

const routeBridgeItemToTab = async (item) => {
  const runtimeId = runtimeIdFromBridgeItem(item);
  const runtimeKey = runtimeKeyFromBridgeItem(item);
  const tabId = resolveBridgeItemTabId(item);
  if (!Number.isInteger(tabId)) {
    appendBackgroundDiagnosticEvent({
      type: "transport",
      name: "background.bridge.routing",
      ok: false,
      summary: "Background bridge could not route a bridge message to a claimed tab.",
      input: {
        message_type: item?.type || null,
        call_id: item?.call_id || null,
        runtime_id: runtimeId,
        runtime_key: runtimeKey,
      },
      output: {
        connected_runtime_count: bridgeState?.activeRuntimeTabIds?.size || 0,
      },
    });
    return;
  }
  // browser.screenshot does not need the content script — capture it directly in
  // the background service worker so it works even when the page's main thread /
  // content-script channel is jammed (blocking modal, busy JS). This is the path
  // MCP-bridge tool calls actually travel (type: "action_call"), so intercepting
  // here (not in the hosted-agent executePrimitiveInTab) is what makes screenshots
  // reliable during a page stall.
  if (item?.type === "action_call" && item?.name === "browser.screenshot") {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_error) {
      tab = { id: tabId };
    }
    const result = await executeScreenshotDirect(tab, {
      call_id: item.call_id,
      arguments: item.arguments,
    });
    sendBridgeOutputItem(
      result.ok
        ? {
            type: "action_call_output",
            call_id: item.call_id || null,
            runtime_id: runtimeId,
            output: result.output,
          }
        : {
            type: "action_error",
            call_id: item.call_id || null,
            runtime_id: runtimeId,
            error: result.error || {
              code: "screenshot_capture_failed",
              message: "Background screenshot capture failed.",
              recoverable: true,
            },
          }
    );
    return;
  }
  // Tab-lifecycle + dialog-dismiss tools live only in the background service
  // worker (executeBackgroundHostedToolCall), never in content.js executeAction.
  // Direct MCP-bridge tool calls arrive as type:"action_call" and must be
  // intercepted HERE — for the same reason as browser.screenshot above: the
  // content-script channel can be jammed by a blocking modal or a torn-down
  // runtime. browser.dismiss_dialog especially exists to rescue a tab whose
  // content channel is frozen by a native beforeunload confirm; forwarding it
  // to that frozen content script is self-defeating. (Incident 2026-07-03:
  // dismiss_dialog was advertised by the bridge but threw "No handler
  // implemented for action: browser.dismiss_dialog" because this router only
  // special-cased screenshot — the hosted-agent path had the background check,
  // the direct-bridge path did not.)
  if (bridgeItemNeedsBackground(item)) {
    let result;
    try {
      result = await executeBackgroundHostedToolCall({
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments,
      }, tabId);
    } catch (error) {
      result = {
        ok: false,
        error: {
          code: "background_action_failed",
          message: error?.message || String(error),
          recoverable: true,
        },
      };
    }
    sendBridgeOutputItem(
      result && result.ok !== false && !result.error
        ? {
            type: "action_call_output",
            call_id: item.call_id || null,
            runtime_id: runtimeId,
            output: result.output,
          }
        : {
            type: "action_error",
            call_id: item.call_id || null,
            runtime_id: runtimeId,
            error: result?.error || {
              code: "background_action_failed",
              message: `Background action ${item.name} failed.`,
              recoverable: true,
            },
          }
    );
    return;
  }
  await sendTabMessageBestEffort(tabId, {
    type: "actions-json:bridge-message",
    item,
  });
};

const decorateReadyItemForReplay = async ({ readyItem, tab, claim, bridgeSessionId, reason, attempt, claimedAtMs }) => ({
  ...readyItem,
  runtime_key: readyItem.runtime_key || claim.runtimeKey || runtimeKeyForTab(tab.id),
  authorization_id: readyItem.authorization_id || claim.authorizationId || null,
  extension_version: readyItem.extension_version || chrome.runtime.getManifest().version,
  // U8: which MACHINE/BROWSER this runtime lives on, distinct from the site host.
  // Null when unavailable — the bridge omits the field rather than storing null.
  device: readyItem.device || (await getDeviceLabel()),
  url: readyItem.url || tab.url || claim.url || null,
  tab: {
    tab_id: tab.id,
    window_id: typeof tab.windowId === "number" ? tab.windowId : null,
    title: tab.title || null,
    active: Boolean(tab.active),
  },
  replay: {
    bridge_session_id: bridgeSessionId,
    reason,
    attempt,
    // R10: never a constant null. Prefer an explicit claim time; fall back to
    // the claim record, then to now (the replay is happening for a live claim).
    claimed_at_ms: claimedAtMs || claim.claimedAtMs || Date.now(),
    replayed_at_ms: Date.now(),
  },
});

const requestRuntimeReadyForClaimedTab = async ({ tabId, tab, claim, bridgeUrl }) => {
  await injectContent(tabId);
  const response = await sendTabMessageBestEffort(tabId, {
    type: "actions-json:runtime-ready",
    bridgeUrl,
    runtimeKey: claim.runtimeKey || runtimeKeyForTab(tabId),
    authorizationId: claim.authorizationId,
    extensionVersion: chrome.runtime.getManifest().version,
  });
  if (response?.ok === false) {
    throw new Error(response.error || "Content runtime returned an error while preparing runtime_ready.");
  }
  if (!response?.readyItem || typeof response.readyItem !== "object") {
    throw new Error("Content runtime did not return a readyItem.");
  }
  return response.readyItem;
};

const replayClaimedTabsToBridge = async ({ bridgeUrl, bridgeSessionId, reason = "bridge_open", attempt = 1 }) => {
  const startedAtMs = Date.now();
  const entries = await sessionStore.getSessionEntries();
  const failures = [];
  let claimedCount = 0;
  let registeredCount = 0;
  let removedCount = 0;
  let changed = false;
  const activeRuntimeTabIds = new Set();

  for (const [_sessionId, session] of entries) {
    for (const [tabIdKey, claim] of Object.entries(session.tabs || {})) {
      const tabId = Number(tabIdKey);
      if (!Number.isInteger(tabId)) continue;
      claimedCount += 1;
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (error) {
        delete session.tabs[tabIdKey];
        changed = true;
        removedCount += 1;
        failures.push({
          tab_id: tabId,
          runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId),
          url: claim.url || null,
          stage: "tab_missing",
          error_message: error.message || String(error),
        });
        continue;
      }

      if (tab.url?.startsWith("chrome://")) {
        failures.push({
          tab_id: tabId,
          runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId),
          url: tab.url,
          stage: "restricted_url",
          error_message: "Chrome internal tabs cannot be controlled by actions.json.",
        });
        continue;
      }

      try {
        const readyItem = await requestRuntimeReadyForClaimedTab({ tabId, tab, claim, bridgeUrl });
        const decorated = await decorateReadyItemForReplay({
          readyItem,
          tab,
          claim,
          bridgeSessionId,
          reason,
          attempt,
        });
        if (!sendBridgeItem(decorated)) {
          throw new Error("Bridge WebSocket closed during claimed-tab replay.");
        }
        rememberRuntimeRoute(decorated, tabId);
        activeRuntimeTabIds.add(tabId);
        registeredCount += 1;
        claim.url = tab.url || claim.url || null;
        claim.title = tab.title || claim.title || null;
        claim.windowId = typeof tab.windowId === "number" ? tab.windowId : claim.windowId;
        claim.lastConnectedAtMs = Date.now();
        delete claim.lastReplayError;
        changed = true;
      } catch (error) {
        claim.lastReplayError = error.message || String(error);
        changed = true;
        failures.push({
          tab_id: tabId,
          runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId),
          authorization_id: claim.authorizationId || null,
          url: tab.url || claim.url || null,
          stage: "content_runtime_ready",
          error_message: error.message || String(error),
        });
      }
    }
  }

  if (changed) {
    await sessionStore.save();
  }

  const summary = {
    type: "bridge_runtime_replay_summary",
    bridge_session_id: bridgeSessionId,
    reason,
    started_at_ms: startedAtMs,
    finished_at_ms: Date.now(),
    claimed_count: claimedCount,
    registered_count: registeredCount,
    removed_count: removedCount,
    failed_count: failures.length,
    failures,
  };
  sendBridgeItem(summary);
  return { summary, activeRuntimeTabIds };
};

const scheduleBridgeReconnect = () => {
  if (!bridgeState?.shouldReconnect || !bridgeState.bridgeUrl) return;
  clearTimeout(bridgeReconnectTimer);
  const delay = Math.min(5000, 500 * 2 ** Math.min(bridgeReconnectAttempts, 4));
  bridgeReconnectAttempts += 1;
  bridgeReconnectTimer = setTimeout(() => connectBackgroundBridge(bridgeState, { reconnectAttempt: true }).catch(() => {
    scheduleBridgeReconnect();
  }), delay);
};

const connectBackgroundBridge = async (state, options = {}) => {
  if (!state?.bridgeUrl) {
    throw new Error("actions-json:bridge-connect requires bridgeUrl.");
  }
  // Defense-in-depth idempotency: never tear down a healthy shared socket to
  // register one more tab. If the socket is already OPEN for this bridgeUrl and
  // this is NOT a genuine reconnect attempt (which fires only on real socket
  // loss), reuse it — register the runtime on the existing transport and return.
  // The guard lives HERE (not only at the bridge-connect call site) so no current
  // or future caller can re-introduce the per-tab socket churn incident (2026-07-03).
  if (!options.reconnectAttempt && await attachRuntimeToOpenBridge({
    bridgeUrl: state.bridgeUrl,
    tabId: state.tabId,
    readyItem: state.readyItem,
    relayedReadyItems: state.relayedReadyItems || [],
  })) {
    return { ok: true, reused_socket: true };
  }
  const preserveReconnectOnFailure = Boolean(options.reconnectAttempt && state.shouldReconnect);
  bridgeState = {
    ...state,
    bridgeSessionId: newBridgeSessionId(),
    activeRuntimeTabIds: new Set(),
    shouldReconnect: false,
  };
  closeBridgeSocket();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeState.bridgeUrl);
    bridgeSocket = ws;
    let opened = false;
    let settled = false;
    const settleFailure = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);
      if (bridgeSocket === ws) {
        bridgeSocket = null;
      }
      bridgeState = {
        ...bridgeState,
        shouldReconnect: preserveReconnectOnFailure,
      };
      appendBackgroundDiagnosticEvent({
        type: "transport",
        name: "background.bridge.websocket",
        ok: false,
        summary: "Extension background failed to open the bridge WebSocket.",
        input: {
          bridge_url: bridgeState.bridgeUrl,
          tab_id: bridgeState.tabId,
          runtime_id: bridgeState.readyItem?.runtime_id || null,
        },
        output: {
          error_message: message,
          transport_owner: "extension_background",
        },
      });
      reject(new Error(message));
    };
    const connectTimeout = setTimeout(() => {
      if (bridgeSocket === ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      settleFailure(`Background bridge WebSocket did not open within ${BACKGROUND_BRIDGE_CONNECT_TIMEOUT_MS}ms.`);
    }, BACKGROUND_BRIDGE_CONNECT_TIMEOUT_MS);
    ws.addEventListener("open", async () => {
      if (bridgeSocket !== ws || settled) return;
      opened = true;
      settled = true;
      clearTimeout(connectTimeout);
      bridgeState = {
        ...bridgeState,
        shouldReconnect: true,
      };
      bridgeReconnectAttempts = 0;
      let replayResult = null;
      try {
        replayResult = await replayClaimedTabsToBridge({
          bridgeUrl: bridgeState.bridgeUrl,
          bridgeSessionId: bridgeState.bridgeSessionId,
          reason: "bridge_open",
          attempt: bridgeReconnectAttempts + 1,
        });
      } catch (error) {
        appendBackgroundDiagnosticEvent({
          type: "transport",
          name: "background.bridge.replay",
          ok: false,
          summary: "Extension background failed while replaying claimed tabs to the bridge.",
          input: {
            bridge_url: bridgeState.bridgeUrl,
            bridge_session_id: bridgeState.bridgeSessionId,
          },
          output: { error_message: error.message || String(error) },
        });
      }
      if (replayResult?.activeRuntimeTabIds) {
        bridgeState = {
          ...bridgeState,
          activeRuntimeTabIds: replayResult.activeRuntimeTabIds,
        };
      }
      if ((!replayResult || replayResult.summary.registered_count === 0) && bridgeState.readyItem) {
        sendBridgeItem(bridgeState.readyItem);
        rememberRuntimeRoute(bridgeState.readyItem, bridgeState.tabId);
      }
      for (const item of bridgeState.relayedReadyItems || []) {
        sendBridgeItem(item);
        // Relayed runtimes need a local route too, same as the single readyItem
        // above — otherwise they register with the bridge but stay unroutable.
        rememberRuntimeRoute(item, tabIdFromRuntimeKey(item?.runtime_key));
      }
      const pendingOutputFlush = bridgeOutputDeliveryQueue.flush(sendBridgeItem);
      appendBackgroundDiagnosticEvent({
        type: "transport",
        name: "background.bridge.websocket",
        ok: true,
        summary: "Extension background connected the bridge WebSocket.",
        input: {
          bridge_url: bridgeState.bridgeUrl,
          tab_id: bridgeState.tabId,
          runtime_id: bridgeState.readyItem?.runtime_id || null,
        },
        output: {
          transport_owner: "extension_background",
          replay_summary: replayResult?.summary || null,
          pending_output_flush: pendingOutputFlush,
        },
      });
      resolve();
    });
    ws.addEventListener("error", () => {
      if (bridgeSocket !== ws || opened) return;
      settleFailure(`Background bridge WebSocket failed to open: ${bridgeState.bridgeUrl}`);
    });
    ws.addEventListener("message", (event) => {
      if (bridgeSocket !== ws) return;
      let item = null;
      try {
        item = JSON.parse(event.data);
      } catch (error) {
        appendBackgroundDiagnosticEvent({
          type: "transport",
          name: "background.bridge.websocket",
          ok: false,
          summary: "Background bridge received invalid JSON from WebSocket.",
          output: { error_message: error.message || String(error) },
        });
        return;
      }
      if (item?.type === "runtime_probe") {
        // U3 probe-at-dispatch: the bridge suspects this runtime is stale and
        // asks us to confirm the tab still exists via chrome.tabs.get before it
        // dispatches a real call. Answer alive/dead; a get that throws = dead.
        (async () => {
          const probeId = item?.probe_id || null;
          const tabId = resolveBridgeItemTabId(item);
          let alive = false;
          if (Number.isInteger(tabId)) {
            try {
              await chrome.tabs.get(tabId);
              alive = true;
            } catch (_error) {
              alive = false;
            }
          }
          sendBridgeItem({ type: "runtime_probe_result", probe_id: probeId, alive });
        })();
        return;
      }
      if (item?.type === "credential_hydration") {
        handleCredentialHydrationItem(item)
          .catch((error) => rejectCredentialHydrationItem(item, error))
          .then((result) => sendBridgeOutputItem(result));
        return;
      }
      if (item?.type === "state_projection_call") {
        handleBridgeStateProjectionCall(item).catch((error) => {
          appendBackgroundDiagnosticEvent({
            type: "transport",
            name: "background.bridge.state_projection",
            ok: false,
            summary: "Background bridge failed to execute a state projection call.",
            input: {
              message_type: item?.type || null,
              call_id: item?.call_id || null,
              projection_name: item?.projection_name || null,
            },
            output: { error_message: error.message || String(error) },
          });
          sendBridgeOutputItem({
            type: "action_error",
            call_id: item?.call_id || null,
            runtime_id: runtimeIdFromBridgeItem(item),
            error: {
              code: "state_projection_failed",
              message: error.message || String(error),
              recoverable: true,
            },
          });
        });
        return;
      }
      if (item?.type === "site_action_call") {
        handleBridgeSiteActionCall(item).catch((error) => {
          appendBackgroundDiagnosticEvent({
            type: "transport",
            name: "background.bridge.site_action",
            ok: false,
            summary: "Background bridge failed to execute a site action call.",
            input: {
              message_type: item?.type || null,
              call_id: item?.call_id || null,
              action: item?.action || null,
            },
            output: { error_message: error.message || String(error) },
          });
          sendBridgeOutputItem({
            type: "action_error",
            call_id: item?.call_id || null,
            runtime_id: runtimeIdFromBridgeItem(item),
            error: {
              code: "site_action_failed",
              message: error.message || String(error),
              recoverable: true,
            },
          });
        });
        return;
      }
      routeBridgeItemToTab(item).catch((error) => {
        appendBackgroundDiagnosticEvent({
          type: "transport",
          name: "background.bridge.websocket",
          ok: false,
          summary: "Background bridge failed to forward a message to the content runtime.",
          input: {
            message_type: item?.type || null,
            call_id: item?.call_id || null,
            runtime_id: runtimeIdFromBridgeItem(item),
            runtime_key: runtimeKeyFromBridgeItem(item),
          },
          output: { error_message: error.message || String(error) },
        });
      });
    });
    ws.addEventListener("error", () => {
      if (bridgeSocket === ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    });
    ws.addEventListener("close", () => {
      if (bridgeSocket !== ws) return;
      bridgeSocket = null;
      if (!opened) {
        settleFailure(`Background bridge WebSocket closed before opening: ${bridgeState.bridgeUrl}`);
        return;
      }
      scheduleBridgeReconnect();
    });
  });
};

// The bridge socket is a single module-global shared by ALL claimed tabs. A tab's
// content script sends `bridge-connect` whenever it (re)connects — on open_tab, on
// navigate, on reconnect. Rebuilding the shared socket for each of those (the old
// behavior: connectBackgroundBridge always closeBridgeSocket()s) churns the one
// transport every other tab depends on, and if a rebuild times out
// (BACKGROUND_BRIDGE_CONNECT_TIMEOUT_MS) the connecting tab is left undrivable while
// the others race to recover it. (Incident 2026-07-03: every fresh open_tab/navigate
// tab was deaf to content primitives because its bridge-connect tore down + failed to
// reopen the shared socket.)
//
// Fix: make connect idempotent. If the shared socket is ALREADY OPEN for this bridge
// URL, DON'T rebuild it — just register the new tab (and any relayed runtimes) ON the
// existing socket, exactly the way a replay registers each tab, and keep the local
// route. Only fall through to a full (re)connect when there is no healthy socket.
// async because decorateReadyItemForReplay is. Its sole caller (connectBackgroundBridge) is
// already async and MUST await this: the return value is a boolean guard, and an un-awaited
// Promise is always truthy — which would report `reused_socket: true` on every reconnect and
// silently skip the socket rebuild.
const attachRuntimeToOpenBridge = async ({ bridgeUrl, tabId, readyItem, relayedReadyItems }) => {
  if (
    bridgeSocket?.readyState !== WebSocket.OPEN ||
    !bridgeState ||
    bridgeState.bridgeUrl !== bridgeUrl ||
    !readyItem ||
    typeof readyItem !== "object"
  ) {
    return false;
  }
  // Ask Chrome for the tab instead of synthesizing one. A hardcoded `title: null`
  // here reached the registry verbatim, and `runtime_matches_intent` matches on
  // url OR title OR host — so intent routing by title ("the Zara board runtime")
  // silently died for every runtime that attached to an already-open socket, which
  // is every runtime after the first reconnect. The other two callers of
  // decorateReadyItemForReplay already pass the real tab; this one was the outlier.
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    // The tab vanished between claim and attach. Degrade to what we know rather
    // than asserting a title we never read.
    tab = { id: tabId, url: readyItem.url || null };
  }
  const decorated = await decorateReadyItemForReplay({
    readyItem,
    tab,
    claim: { runtimeKey: readyItem.runtime_key, authorizationId: readyItem.authorization_id, url: readyItem.url },
    bridgeSessionId: bridgeState.bridgeSessionId || null,
    reason: "bridge_attach",
    attempt: 1,
  });
  if (!sendBridgeItem(decorated)) return false;
  rememberRuntimeRoute(decorated, tabId);
  if (bridgeState.activeRuntimeTabIds instanceof Set && Number.isInteger(tabId)) {
    bridgeState.activeRuntimeTabIds.add(tabId);
  }
  for (const item of relayedReadyItems || []) {
    if (sendBridgeItem(item)) {
      rememberRuntimeRoute(item, tabIdFromRuntimeKey(item?.runtime_key));
    }
  }
  appendBackgroundDiagnosticEvent({
    type: "transport",
    name: "background.bridge.attach",
    ok: true,
    summary: "Registered a runtime on the already-open bridge socket without rebuilding it.",
    input: { bridge_url: bridgeUrl, tab_id: tabId, runtime_id: readyItem.runtime_id || null },
    output: { reused_socket: true },
  });
  return true;
};

const injectContent = async (tabId) => {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content.js"],
  });
  // U4: the live-region observer is a SEPARATE observer-only script injected
  // into ALL frames — content.js stays top-frame-only (re-injecting it tears
  // down the live bridge connection; the observer is idempotent by guard).
  // Late frames are covered by the reconnect-on-update funnel re-running this;
  // frames inserted without navigation are a documented phase-1 bound.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/a11y/live_region_observer.js"],
    });
  } catch (_e) { /* some frames (about:blank, sandboxed) reject injection */ }
};

const connectClaimedTab = async (tabId, claim) => {
  await injectContent(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: "actions-json:connect",
    bridgeUrl: claim.bridgeUrl,
    runtimeKey: runtimeKeyForTab(tabId),
    authorizationId: claim.authorizationId,
    extensionVersion: chrome.runtime.getManifest().version,
  });
  // Record the LOCAL route for EVERY path that (re)connects a claimed tab —
  // claim, navigate, activate, reconnect-on-update all funnel through here.
  // The runtime_key is stable (chrome-tab:<tabId>), so recording it now means
  // bridge->content deliveries (heartbeat pings + primitive action_calls) can
  // always resolve the tab, even before the content script's own re-registration
  // lands. Centralizing this in connectClaimedTab prevents the class of bug where
  // a new connect path forgets to populate bridgeRuntimeRoutes (Incident 2026-07-03).
  rememberRuntimeRoute({ runtime_key: runtimeKeyForTab(tabId) }, tabId);
};

const ensureSessionGroup = async (session, tabId) => {
  let groupId = session.chromeGroupId;
  if (typeof groupId === "number") {
    try {
      await chrome.tabGroups.get(groupId);
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } catch (_error) {
      groupId = null;
    }
  }
  if (typeof groupId !== "number") {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    session.chromeGroupId = groupId;
  }
  await chrome.tabGroups.update(groupId, {
    title: session.title || DEFAULT_SESSION_GROUP_TITLE,
    color: "blue",
    collapsed: false,
  });
  return groupId;
};

const claimAuthorizedTab = async (message) => {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) {
    throw new Error("actions-json:authorize-tab requires tabId");
  }
  const tab = await chrome.tabs.get(tabId);
  if (!hasTabId(tab)) {
    throw new Error(`Chrome tab ${tabId} has no id`);
  }
  if (tab.url?.startsWith("chrome://")) {
    throw new Error(`Chrome internal tab ${tabId} cannot be authorized`);
  }

  const session = await sessionStore.getSession(DEFAULT_SESSION_ID);
  const groupId = await ensureSessionGroup(session, tab.id);
  const authorizationId = message.authorizationId || newAuthorizationId();
  const bridgeUrl = message.bridgeUrl || DEFAULT_BRIDGE_URL;
  session.activeTabId = tab.id;
  session.tabs[String(tab.id)] = {
    bridgeUrl,
    authorizationId,
    runtimeKey: runtimeKeyForTab(tab.id),
    url: tab.url || null,
  };
  await sessionStore.save();
  await connectClaimedTab(tab.id, session.tabs[String(tab.id)]);

  return {
    ok: true,
    tabId: tab.id,
    runtimeKey: runtimeKeyForTab(tab.id),
    authorizationId,
    groupId,
  };
};

// U7: claimed_tabs.list agrees with the unified bridge/runtimes view on one
// agent-facing id space — runtime_id, derived from the route map — and no
// longer leads with runtime_key (kept only as an internal debugging field).
const hostFromUrlLabel = (url) => {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch (_error) {
    return null;
  }
};
const serializeClaimedTab = (session, tab, claim) => {
  const url = tab.url || claim.url || null;
  return {
    runtime_id: runtimeIdsForTab(tab.id)[0] || null,
    tab_id: tab.id,
    url,
    title: tab.title || null,
    host: hostFromUrlLabel(url),
    active: Boolean(session.activeTabId === tab.id || tab.active),
    window_id: typeof tab.windowId === "number" ? tab.windowId : null,
    authorization_id: claim.authorizationId || null,
    bridge_url: claim.bridgeUrl || DEFAULT_BRIDGE_URL,
    // Internal id, retained for debugging; not the agent's addressing key.
    _runtime_key: claim.runtimeKey || runtimeKeyForTab(tab.id),
  };
};

const listClaimedTabs = async () => {
  const entries = await sessionStore.getSessionEntries();
  const tabs = [];
  let activeTabId = null;
  let changed = false;

  for (const [_sessionId, session] of entries) {
    activeTabId = session.activeTabId || activeTabId;
    for (const [tabIdKey, claim] of Object.entries(session.tabs || {})) {
      const tabId = Number(tabIdKey);
      if (!Number.isInteger(tabId)) continue;
      try {
        const tab = await chrome.tabs.get(tabId);
        tabs.push(serializeClaimedTab(session, tab, claim));
      } catch (_error) {
        delete session.tabs[tabIdKey];
        changed = true;
      }
    }
  }

  if (changed) {
    await sessionStore.save();
  }

  return {
    ok: true,
    active_tab_id: activeTabId,
    count: tabs.length,
    tabs,
  };
};

// True when a claimed tab already has a LIVE runtime registered on the current
// open bridge socket: the shared socket is OPEN, the tab is in the connected
// set, and its route is remembered. When all hold, the tab is already drivable
// and bringing it to the foreground does NOT change that — activation is a pure
// UI operation (chrome.tabs.update active + windows.update focused) that never
// touches the WebSocket or the content script. So the reconnect is gratuitous;
// re-injecting content.js into an already-connected tab tears down its live
// runtime and churns transport that other tabs depend on. Only reconnect when
// the tab is NOT currently healthy (e.g. it was reaped, or the socket rebuilt).
const claimedTabHasLiveRuntime = (tabId) => {
  if (!Number.isInteger(tabId)) return false;
  if (bridgeSocket?.readyState !== WebSocket.OPEN) return false;
  if (!(bridgeState?.activeRuntimeTabIds instanceof Set)) return false;
  if (!bridgeState.activeRuntimeTabIds.has(tabId)) return false;
  return bridgeRuntimeRoutes.get(`runtime_key:${runtimeKeyForTab(tabId)}`) === tabId;
};

const activateClaimedTab = async (message) => {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) {
    throw new Error("actions-json:claimed-tabs-activate requires tabId");
  }

  const entries = await sessionStore.getSessionEntries();
  for (const [_sessionId, session] of entries) {
    const claim = session.tabs?.[String(tabId)];
    if (!claim) continue;

    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(tabId, { active: true });
    claim.url = tab.url || claim.url || null;
    session.activeTabId = tabId;
    await sessionStore.save();

    // Foregrounding a healthy tab does not disturb its runtime — skip the
    // reconnect so activation stays non-disruptive to this tab and every other
    // tab on the shared socket. Only (re)connect when the runtime isn't live.
    if (claimedTabHasLiveRuntime(tabId)) {
      appendBackgroundDiagnosticEvent({
        type: "navigation",
        name: "background.claimed_tab.activate",
        ok: true,
        summary: "Claimed tab foregrounded without reconnecting — its runtime was already live.",
        input: { tab_id: tabId, runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId) },
        output: { reconnected: false, reused_runtime: true },
      });
      return {
        ok: true,
        scheduled: false,
        reconnected: false,
        reused_runtime: true,
        tab: serializeClaimedTab(session, { ...tab, active: true }, claim),
      };
    }

    const reconnectDelayMs = Number.isFinite(message.reconnectDelayMs)
      ? Math.max(0, Math.min(5000, Math.floor(message.reconnectDelayMs)))
      : 300;
    setTimeout(() => {
      connectClaimedTab(tabId, claim).catch((error) => {
        appendBackgroundDiagnosticEvent({
          type: "navigation",
          name: "background.claimed_tab.activate",
          ok: false,
          summary: "Claimed tab was activated but its content runtime reconnect failed.",
          input: {
            tab_id: tabId,
            runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId),
            reconnect_delay_ms: reconnectDelayMs,
          },
          output: {
            error_message: error.message || String(error),
          },
        });
      });
    }, reconnectDelayMs);

    return {
      ok: true,
      scheduled: true,
      reconnected: true,
      reconnect_delay_ms: reconnectDelayMs,
      tab: serializeClaimedTab(session, { ...tab, active: true }, claim),
    };
  }

  throw new Error(`Chrome tab ${tabId} is not claimed by actions.json.`);
};

// Wait for a tab to finish loading a real document (not about:blank) so content
// injection lands in the intended page. Resolves on the first complete status.
const waitForTabComplete = (tabId, timeoutMs = 15000) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // If it is already complete, resolve promptly.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") finish();
    }).catch(() => {});
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
  });

// Resolve the target tab for a tab-lifecycle op: explicit tab_id, else the
// session's active claimed tab. Returns { session, tabId, claim } or throws.
const resolveClaimedTarget = async (tabIdArg) => {
  const entries = await sessionStore.getSessionEntries();
  if (Number.isInteger(tabIdArg)) {
    for (const [_sessionId, session] of entries) {
      const claim = session.tabs?.[String(tabIdArg)];
      if (claim) return { session, tabId: tabIdArg, claim };
    }
    throw new Error(`Chrome tab ${tabIdArg} is not claimed by actions.json.`);
  }
  for (const [_sessionId, session] of entries) {
    const active = session.activeTabId;
    const claim = active != null ? session.tabs?.[String(active)] : null;
    if (claim) return { session, tabId: Number(active), claim };
  }
  throw new Error("No active claimed tab; pass tab_id.");
};

// browser.navigate: point a claimed tab at a URL, then reconnect its runtime so
// it stays drivable after the load. Defaults to the active claimed tab.
const navigateClaimedTab = async (message = {}) => {
  const url = typeof message.url === "string" ? message.url.trim() : "";
  const reload = message.reload === true;
  // A url is required only when we are actually navigating somewhere. Reload has
  // always been implemented below, but this guard rejected the call before it
  // could run, so the documented escape from a wedged tab was unreachable.
  if (!url && !reload) throw new Error("browser.navigate requires a url or reload:true.");
  if (url && /^(chrome|about|file|edge):/i.test(url)) {
    throw new Error("browser.navigate refuses chrome/about/file/edge URLs.");
  }
  const { session, tabId, claim } = await resolveClaimedTarget(
    Number(message.tab_id ?? message.tabId)
  );

  if (reload) {
    await chrome.tabs.reload(tabId);
  } else {
    await chrome.tabs.update(tabId, { url });
  }
  await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  claim.url = tab.url || claim.url || null;
  session.activeTabId = tabId;
  await sessionStore.save();
  // Re-establish the content runtime on the freshly loaded document.
  // connectClaimedTab now also refreshes the local route (rememberRuntimeRoute),
  // so the reconnected runtime stays reachable across the navigation.
  //
  // Do NOT swallow. A navigate whose reconnect fails leaves a runtime that is
  // still in the bridge registry but no longer heartbeating; the TTL sweep reaps
  // it ~60-80s later and the caller sees a 404 on a runtime_id this very call
  // handed back. (Incident 2026-07-09, the sibling of the open_tab swallow.)
  let connected = false;
  let connectError = null;
  try {
    await connectClaimedTab(tabId, claim);
    connected = true;
  } catch (error) {
    connectError = error?.message || String(error);
  }
  if (!connected) {
    return {
      ok: false,
      navigated: true,
      tab: serializeClaimedTab(session, tab, claim),
      connected,
      error: {
        code: "runtime_reconnect_failed",
        message:
          "The tab navigated, but its content script did not reconnect to the bridge transport, so the runtime will stop heartbeating and be reaped as stale.",
        recoverable: true,
        next_step: "Reload the tab and re-claim it; verify the runtime's last_seen_ms advances in actions-json://bridge/runtimes.",
        cause: connectError,
      },
    };
  }

  return {
    ok: true,
    navigated: true,
    connected,
    reloaded: message.reload === true,
    tab: serializeClaimedTab(session, tab, claim),
  };
};

// browser.open_tab: create a new tab (optionally at a URL), auto-claim +
// authorize it, and return a drivable runtime. The claim mirrors
// claimAuthorizedTab so the bridge registers the runtime via runtime_ready.
const openClaimedTab = async (message = {}) => {
  const url = typeof message.url === "string" && message.url.trim()
    ? message.url.trim()
    : "https://www.google.com/";
  if (/^(chrome|about|file|edge):/i.test(url)) {
    throw new Error("browser.open_tab refuses chrome/about/file/edge URLs.");
  }
  const active = message.active !== false;
  const created = await chrome.tabs.create({ url, active });
  if (!hasTabId(created)) {
    throw new Error("browser.open_tab: created tab has no id.");
  }
  const tabId = created.id;
  await waitForTabComplete(tabId);

  const session = await sessionStore.getSession(DEFAULT_SESSION_ID);
  await ensureSessionGroup(session, tabId);
  const authorizationId = newAuthorizationId();
  const bridgeUrl = await loadBridgeUrl().catch(() => DEFAULT_BRIDGE_URL);
  session.activeTabId = tabId;
  session.tabs[String(tabId)] = {
    bridgeUrl,
    authorizationId,
    runtimeKey: runtimeKeyForTab(tabId),
    url: url,
  };
  await sessionStore.save();

  const tab = await chrome.tabs.get(tabId);
  let readyItem = null;
  let registered = false;
  // `registered` says a row exists in the bridge registry. `connected` says the
  // content script is plugged into the transport that carries heartbeats. Only
  // the second keeps the runtime alive past the TTL sweep. Report both.
  let connected = false;
  let connectError = null;
  try {
    readyItem = await requestRuntimeReadyForClaimedTab({
      tabId,
      tab,
      claim: session.tabs[String(tabId)],
      bridgeUrl,
    });
    // Register the new runtime with the bridge NOW, the same way replay does —
    // otherwise the tab is claimed locally but the bridge never learns of it.
    const decorated = await decorateReadyItemForReplay({
      readyItem,
      tab,
      claim: session.tabs[String(tabId)],
      bridgeSessionId: bridgeState?.bridgeSessionId || null,
      reason: "open_tab",
      attempt: 1,
    });
    registered = sendBridgeItem(decorated);
    rememberRuntimeRoute(decorated, tabId);
    // CRUCIAL: requestRuntimeReadyForClaimedTab only sends `runtime-ready`, which
    // builds a readyItem token but does NOT make the content script establish its
    // live bridge connection (content `connect()` runs only on `actions-json:connect`).
    // The working re-claim path (claimAuthorizedTab) sends `connect` via
    // connectClaimedTab — so open_tab must do the same, or the content script is
    // registered with the bridge but never actually plugged into the transport that
    // carries heartbeats + primitive dispatch. (Incident 2026-07-03: fresh open_tab
    // tabs were deaf to content primitives; the re-claim path was not.) The connect
    // reuses the already-open shared socket via attachRuntimeToOpenBridge, so it no
    // longer churns the transport the other tabs depend on.
    // Do NOT swallow this. Registration puts a row in the bridge registry;
    // CONNECT is what plugs the content script into the transport carrying
    // heartbeats. A runtime that is registered but not connected never advances
    // last_seen_ms, so the bridge's TTL sweep reaps it ~60-80s later -- and the
    // caller, having been told registered:true, blames the sweep. Two states,
    // one word. (Incident 2026-07-09: a `.catch(() => {})` here silently
    // degraded every fresh tab to "will replay on next bridge open", which may
    // be hours away. It guarded the fix for incident 2026-07-03.)
    await connectClaimedTab(tabId, session.tabs[String(tabId)]);
    connected = true;
  } catch (error) {
    connectError = error?.message || String(error);
    appendBackgroundDiagnosticEvent({
      type: "navigation",
      name: "background.open_tab.connect_failed",
      ok: false,
      summary: "Opened tab was claimed and registered but never connected to the bridge transport; it will be reaped as stale.",
      input: { tab_id: tabId, url },
      output: { error_message: connectError },
    }).catch(() => {});
  }

  // A runtime that registered but never connected is a ghost: it is in the
  // registry, it may serve one dispatch, and the TTL sweep reaps it within
  // ~80s because last_seen_ms never advances. Fail loudly now rather than hand
  // the caller a runtime_id that dies under them.
  if (registered && !connected) {
    return {
      ok: false,
      opened: true,
      tab_id: tabId,
      runtime_id: readyItem?.runtime_id || null,
      runtime_key: runtimeKeyForTab(tabId),
      authorization_id: authorizationId,
      url: tab.url || url,
      ready: Boolean(readyItem),
      registered,
      connected,
      error: {
        code: "runtime_registered_but_not_connected",
        message:
          "The tab was claimed and registered, but its content script never connected to the bridge transport, so it will never heartbeat and the bridge will reap it as stale.",
        recoverable: true,
        next_step: "Reload the tab, or re-claim it; then verify the runtime appears in actions-json://bridge/runtimes and its last_seen_ms advances.",
        cause: connectError,
      },
    };
  }

  return {
    ok: true,
    opened: true,
    tab_id: tabId,
    runtime_id: readyItem?.runtime_id || null,
    runtime_key: runtimeKeyForTab(tabId),
    authorization_id: authorizationId,
    url: tab.url || url,
    ready: Boolean(readyItem),
    registered,
    connected,
  };
};

// browser.close_tab: close a claimed tab (defaults to the active one). Refuses
// to close the last remaining claimed tab. Removes the claim; the WS drop lets
// the bridge reap the runtime.
const closeClaimedTab = async (message = {}) => {
  const totalClaimed = (async () => {
    const entries = await sessionStore.getSessionEntries();
    let count = 0;
    for (const [_sessionId, session] of entries) {
      count += Object.keys(session.tabs || {}).length;
    }
    return count;
  });
  if ((await totalClaimed()) <= 1) {
    throw new Error("browser.close_tab refuses to close the last claimed tab.");
  }
  const { session, tabId } = await resolveClaimedTarget(Number(message.tab_id ?? message.tabId));

  delete session.tabs[String(tabId)];
  if (session.activeTabId === tabId) {
    const remaining = Object.keys(session.tabs || {});
    session.activeTabId = remaining.length ? Number(remaining[0]) : null;
  }
  await sessionStore.save();
  // Reap the runtime on the bridge NOW, BEFORE we wipe the routes. The route map
  // is the ONLY tabId -> runtime_id lookup, so forgetting it first makes the
  // onRemoved reap a silent no-op and the bridge keeps advertising the dead tab
  // until the TTL sweep ages it out ~30s later (live-caught 2026-07-09 on ext
  // 0.1.187: browser.close_tab did not reap instantly). Emit here rather than
  // relying on onRemoved, because THIS path clears the routes synchronously.
  for (const runtimeId of runtimeIdsForTab(tabId)) {
    sendBridgeItem({ type: "runtime_removed", runtime_id: runtimeId });
  }
  forgetRuntimeRoutesForTab(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});

  return { ok: true, closed: true, closed_tab_id: tabId, active_tab_id: session.activeTabId };
};

// browser.dismiss_dialog: dismiss a native JavaScript dialog (alert/confirm/prompt/
// beforeunload) that is blocking a claimed tab, via the CDP Page domain. A native
// modal freezes the page's main thread, so no content-script primitive can clear it;
// CDP operates below the page event loop, so Page.handleJavaScriptDialog works even
// while the tab is wedged on the dialog. This is the recovery path for a tab that got
// stuck after navigating away from an editor with unsaved changes.
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

const dismissDialogOnTab = async (message = {}) => {
  const { tabId } = await resolveClaimedTarget(
    Number(message.tab_id ?? message.tabId),
  );
  const accept = message.accept === undefined ? true : Boolean(message.accept);
  const target = { tabId };
  // Always operate over OUR OWN fresh CDP session. If another debugger is already
  // attached, force-detach it first: a wedge recovery must not inherit a stale
  // session whose in-flight command (e.g. a Runtime.evaluate blocked by the very
  // dialog we are dismissing) would make our commands queue behind it forever. CDP
  // serializes commands per session, so reusing a busy session hangs. The tab is
  // frozen anyway; whatever was attached is already stuck.
  let forcedDetach = false;
  try {
    await debuggerAttach(target);
  } catch (error) {
    if (!/already attached/i.test(String(error?.message || error))) {
      throw error;
    }
    await debuggerDetach(target).catch(() => {});
    forcedDetach = true;
    await debuggerAttach(target);
  }
  try {
    // handleJavaScriptDialog does not require Page.enable; keep the path minimal and
    // bounded so a stuck CDP transport surfaces as an error instead of hanging.
    await withTimeout(
      debuggerSendCommand(target, "Page.handleJavaScriptDialog", {
        accept,
        promptText:
          typeof message.prompt_text === "string" ? message.prompt_text : undefined,
      }),
      8000,
      "Page.handleJavaScriptDialog",
    );
    return { ok: true, dismissed: true, tab_id: tabId, accept, forced_detach: forcedDetach };
  } finally {
    await debuggerDetach(target).catch(() => {});
  }
};

const reconnectClaimedTab = async (tabId, tab) => {
  const entries = await sessionStore.getSessionEntries();
  for (const [_sessionId, session] of entries) {
    const claim = session.tabs?.[String(tabId)];
    if (!claim) {
      continue;
    }
    if (tab?.url?.startsWith("chrome://")) {
      return;
    }
    const previousUrl = claim.url || null;
    const newUrl = tab?.url || claim.url || null;
    const previousOrigin = originForUrl(previousUrl);
    const newOrigin = originForUrl(newUrl);
    const sameOrigin = Boolean(previousOrigin && newOrigin && previousOrigin === newOrigin);
    const sameDocument = Boolean(
      previousUrl &&
      newUrl &&
      withoutHash(previousUrl) === withoutHash(newUrl) &&
      previousUrl !== newUrl
    );
    claim.url = tab?.url || claim.url || null;
    session.activeTabId = tabId;
    await sessionStore.save();
    try {
      await connectClaimedTab(tabId, claim);
      await appendBackgroundDiagnosticEvent({
        type: "navigation",
        name: "background.navigation.lifecycle",
        ok: true,
        summary: "Authorized tab navigation completed and content runtime was reconnected.",
        input: {
          tab_id: tabId,
          runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId),
          authorization_id: claim.authorizationId || null,
          previous_url: previousUrl,
          new_url: newUrl,
          change_status: "complete",
          same_origin: sameOrigin,
          same_document: sameDocument,
        },
        output: {
          content_reconnected: true,
          overlay_reinject_attempted: true,
          catalog_reload_required: !sameOrigin,
        },
      });
    } catch (error) {
      await appendBackgroundDiagnosticEvent({
        type: "navigation",
        name: "background.navigation.lifecycle",
        ok: false,
        summary: "Authorized tab navigation completed but content runtime reconnect failed.",
        input: {
          tab_id: tabId,
          runtime_key: claim.runtimeKey || runtimeKeyForTab(tabId),
          authorization_id: claim.authorizationId || null,
          previous_url: previousUrl,
          new_url: newUrl,
          change_status: "complete",
          same_origin: sameOrigin,
          same_document: sameDocument,
        },
        output: {
          content_reconnected: false,
          overlay_reinject_attempted: true,
          catalog_reload_required: !sameOrigin,
          error_message: error.message || String(error),
        },
      });
      throw error;
    }
    return;
  }
};

if (chrome.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo?.status !== "complete") {
      return;
    }
    return reconnectClaimedTab(tabId, tab).catch((error) => {
      console.warn("actions.json failed to reconnect claimed tab", error);
    });
  });
}

if (chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessionStore
      .getSessionEntries()
      .then(async (entries) => {
        let changed = false;
        for (const [_sessionId, session] of entries) {
          if (session.tabs && Object.prototype.hasOwnProperty.call(session.tabs, String(tabId))) {
            delete session.tabs[String(tabId)];
            if (session.activeTabId === tabId) {
              session.activeTabId = null;
            }
            changed = true;
          }
        }
        // Tell the bridge to reap this tab's runtime NOW, while our WS stays
        // open — a single tab closing does not tear down the connection, so
        // without this the bridge keeps advertising a dead runtime (the
        // drag-504 lying-liveness gap). Emit before forgetting the routes, so
        // we still know which runtime_id(s) mapped to the closed tab.
        for (const runtimeId of runtimeIdsForTab(tabId)) {
          sendBridgeItem({ type: "runtime_removed", runtime_id: runtimeId });
        }
        // Always drop the local routes for a removed tab, even if it wasn't in
        // session.tabs — otherwise bridgeRuntimeRoutes leaks stale entries for
        // externally-closed tabs (Incident 2026-07-03, inverse leak).
        forgetRuntimeRoutesForTab(tabId);
        if (changed) {
          await sessionStore.save();
        }
      })
      .catch((error) => {
        console.warn("actions.json failed to remove claimed tab", error);
      });
  });
}

const callbackApi = (invoke) =>
  new Promise((resolve, reject) => {
    invoke((result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });

const debuggerAttach = (target) =>
  callbackApi((callback) => chrome.debugger.attach(target, "1.3", callback));

const debuggerDetach = (target) =>
  callbackApi((callback) => chrome.debugger.detach(target, callback));

const debuggerSendCommand = (target, method, params) =>
  callbackApi((callback) => chrome.debugger.sendCommand(target, method, params, callback));

// Shared, refcounted debugger session manager (U8). Chrome allows only ONE
// debugger client per tab, but this extension has several independent
// consumers (trusted keys, debug JS, screenshots, the a11y announcer's
// persistent tree). Each used to attach/detach on its own, assuming sole
// ownership — so the moment two overlap (e.g. the persistent a11y session +
// a trusted keypress) the second throws "Another debugger is already
// attached". This manager makes them coexist: acquire() attaches once and
// hands out a shared session; release() detaches only when the last holder
// leaves. Long-lived holders (a11y.watch) and per-op holders (a key press)
// share the same underlying attach.
const debuggerRefcounts = new Map(); // tabId -> count
const debuggerAdopted = new Set();   // tabIds we adopted (didn't cleanly attach; don't force-detach)
const acquireDebugger = async (tabId) => {
  const n = debuggerRefcounts.get(tabId) || 0;
  if (n === 0) {
    try {
      await debuggerAttach({ tabId });
    } catch (error) {
      if (!/already attached/i.test(String(error?.message || error))) throw error;
      debuggerAdopted.add(tabId); // someone outside the manager holds it; ride along
    }
  }
  debuggerRefcounts.set(tabId, n + 1);
};
const releaseDebugger = async (tabId) => {
  const n = debuggerRefcounts.get(tabId) || 0;
  if (n <= 1) {
    debuggerRefcounts.delete(tabId);
    if (!debuggerAdopted.delete(tabId)) {
      await debuggerDetach({ tabId }).catch(() => {});
    }
  } else {
    debuggerRefcounts.set(tabId, n - 1);
  }
};
chrome.debugger.onDetach?.addListener((source) => {
  if (Number.isInteger(source?.tabId)) {
    debuggerRefcounts.delete(source.tabId);
    debuggerAdopted.delete(source.tabId);
    a11yDebuggerSessions.delete(source.tabId);
  }
});

// Persistent a11y debugger session (U8): the announcer keeps a ShimTree whose
// CDP closure must stay valid for resolveNode_'s later DOM.querySelector calls,
// so the session must OUTLIVE each batch. Held open (one refcount) while the
// tab is watched, via the shared manager so trusted keys / debug JS coexist.
const a11yDebuggerSessions = new Set(); // tabIds a11y.watch holds
const ensureA11yDebuggerSession = async (tabId) => {
  if (a11yDebuggerSessions.has(tabId)) return;
  await acquireDebugger(tabId);       // one persistent refcount for a11y
  a11yDebuggerSessions.add(tabId);
};
// Build a ShimTree over the shared session (no detach — a11y holds a refcount).
const a11yTreeFromSession = async (tabId) => {
  await ensureA11yDebuggerSession(tabId);
  const target = { tabId };
  let url = "";
  let focused = true;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab?.url || "";
    focused = Boolean(tab?.active);
  } catch (_e) { /* best effort */ }
  return new ShimTree({
    cdp: (method, params) => debuggerSendCommand(target, method, params),
    tabId,
    url,
    focused,
  }).refresh();
};

// CDP modifier bitmask (Input.dispatchKeyEvent): Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
const CDP_MODIFIER_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// Modifier keys pressed as REAL held keys around a chord. A combined `rawKeyDown`
// carrying only a `modifiers` BITMASK reaches Google Docs but does NOT trigger its
// shortcut/command layer — Ctrl+A / Ctrl+Home / Ctrl+Down (and Shift-extend
// selection) all no-op (measured live: investigations/
// hosted-agent-debugger-not-attached-new-tab.md, X13). Docs needs the modifier
// modeled as a genuinely-held keyDown across the chord. Shift is included: the
// select-back path (dispatchTrustedText) hits the same class.
const CDP_HELD_MODIFIER_KEYS = [
  { bit: CDP_MODIFIER_BITS.control, code: "ControlLeft", keyCode: 17, key: "Control" },
  { bit: CDP_MODIFIER_BITS.alt, code: "AltLeft", keyCode: 18, key: "Alt" },
  { bit: CDP_MODIFIER_BITS.meta, code: "MetaLeft", keyCode: 91, key: "Meta" },
  { bit: CDP_MODIFIER_BITS.shift, code: "ShiftLeft", keyCode: 16, key: "Shift" },
];

// Run `fn` with each modifier in `modifierBits` pressed as a real held key —
// keyDown before, keyUp after (reverse order, in a finally so a throw can't leave
// a modifier stuck down). Assumes the debugger is already attached to `target`;
// the caller owns acquire/release. Additive: the chord events `fn` dispatches
// still carry the `modifiers` bitmask too, so surfaces that read it are unaffected.
const withHeldModifiers = async (target, modifierBits, fn) => {
  const held = CDP_HELD_MODIFIER_KEYS.filter((mod) => (modifierBits & mod.bit) !== 0);
  for (const mod of held) {
    await debuggerSendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: modifierBits,
      key: mod.key,
      code: mod.code,
      windowsVirtualKeyCode: mod.keyCode,
      nativeVirtualKeyCode: mod.keyCode,
    });
  }
  try {
    return await fn();
  } finally {
    for (const mod of [...held].reverse()) {
      try {
        await debuggerSendCommand(target, "Input.dispatchKeyEvent", {
          type: "keyUp",
          modifiers: 0,
          key: mod.key,
          code: mod.code,
          windowsVirtualKeyCode: mod.keyCode,
          nativeVirtualKeyCode: mod.keyCode,
        });
      } catch (_e) {
        // best-effort release; caller's debugger detach still runs
      }
    }
  }
};

// Minimal key metadata for CDP Input.dispatchKeyEvent. For single printable
// characters we derive code/keyCode/text; named keys map explicitly. This covers
// the keys the trusted-input work needs (chords like Ctrl+A, and Enter/Escape/
// Backspace/Delete/Tab/arrows) without shipping a full keyboard table.
const cdpKeyInfo = (rawKey) => {
  const named = {
    Enter: { code: "Enter", keyCode: 13, key: "Enter", text: "\r" },
    Escape: { code: "Escape", keyCode: 27, key: "Escape" },
    Backspace: { code: "Backspace", keyCode: 8, key: "Backspace" },
    Delete: { code: "Delete", keyCode: 46, key: "Delete" },
    Tab: { code: "Tab", keyCode: 9, key: "Tab" },
    ArrowUp: { code: "ArrowUp", keyCode: 38, key: "ArrowUp" },
    ArrowDown: { code: "ArrowDown", keyCode: 40, key: "ArrowDown" },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37, key: "ArrowLeft" },
    ArrowRight: { code: "ArrowRight", keyCode: 39, key: "ArrowRight" },
    Home: { code: "Home", keyCode: 36, key: "Home" },
    End: { code: "End", keyCode: 35, key: "End" },
    " ": { code: "Space", keyCode: 32, key: " ", text: " " },
    Space: { code: "Space", keyCode: 32, key: " ", text: " " },
  };
  if (named[rawKey]) return named[rawKey];
  if (rawKey.length === 1) {
    const ch = rawKey;
    const upper = ch.toUpperCase();
    const isLetter = upper >= "A" && upper <= "Z";
    const isDigit = ch >= "0" && ch <= "9";
    if (isLetter || isDigit) {
      return {
        code: isLetter ? `Key${upper}` : `Digit${ch}`,
        keyCode: upper.charCodeAt(0),
        key: ch,
        text: ch,
      };
    }
    // Punctuation must use the real US-layout OEM virtual-key codes.
    // charCodeAt is NOT a VK for punctuation: "'" is 0x27 = VK_RIGHT, "." is
    // 0x2E = VK_DELETE, "!" is 0x21 = VK_PRIOR — an editor processes those as
    // caret navigation / deletion instead of typing (incident:
    // actions.json.storage scopes/private/docs/investigations/
    // hosted-agent-docs-edit-corruption.md).
    if (CDP_PUNCT_KEYS[ch]) {
      const p = CDP_PUNCT_KEYS[ch];
      return { code: p.code, keyCode: p.keyCode, key: ch, text: ch };
    }
    // Unknown printable char (unicode, emoji fragments): never fabricate a VK.
    // keyCode 0 has no editing-key collision; the text payload still commits.
    return { code: "", keyCode: 0, key: ch, text: ch };
  }
  return { code: rawKey, keyCode: 0, key: rawKey };
};

// US-layout OEM virtual keys for ASCII punctuation (base and shifted share the
// physical key, hence the same code/keyCode; `text` carries the actual char).
const CDP_PUNCT_KEYS = {
  "'": { code: "Quote", keyCode: 222 },
  '"': { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  "<": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  ">": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "?": { code: "Slash", keyCode: 191 },
  ";": { code: "Semicolon", keyCode: 186 },
  ":": { code: "Semicolon", keyCode: 186 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "{": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "}": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  "|": { code: "Backslash", keyCode: 220 },
  "`": { code: "Backquote", keyCode: 192 },
  "~": { code: "Backquote", keyCode: 192 },
  "-": { code: "Minus", keyCode: 189 },
  _: { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "+": { code: "Equal", keyCode: 187 },
  "!": { code: "Digit1", keyCode: 49 },
  "@": { code: "Digit2", keyCode: 50 },
  "#": { code: "Digit3", keyCode: 51 },
  $: { code: "Digit4", keyCode: 52 },
  "%": { code: "Digit5", keyCode: 53 },
  "^": { code: "Digit6", keyCode: 54 },
  "&": { code: "Digit7", keyCode: 55 },
  "*": { code: "Digit8", keyCode: 56 },
  "(": { code: "Digit9", keyCode: 57 },
  ")": { code: "Digit0", keyCode: 48 },
};

// Dispatch a TRUSTED keypress (keyDown+keyUp) into a tab via CDP. Unlike
// content.js keyboard.press (untrusted, ignored by canvas editors), these events
// carry isTrusted:true so Google Slides/Docs/Sheets honor them (Ctrl+A selects,
// arrows navigate, Delete deletes). Attaches the debugger, sends the chord,
// detaches. Returns { pressed, key, modifiers, fidelity:"trusted" }.
const dispatchTrustedKey = async (tabId, rawKey, rawModifiers, rawRepeat) => {
  if (!Number.isInteger(tabId)) {
    throw new Error("input.key requires an authorized browser tab");
  }
  const key = String(rawKey || "");
  if (!key) {
    throw new Error("input.key requires a key");
  }
  const modifiers = (Array.isArray(rawModifiers) ? rawModifiers : []).map((m) => String(m).toLowerCase());
  const modifierBits = modifiers.reduce((bits, m) => bits | (CDP_MODIFIER_BITS[m] || 0), 0);
  // repeat: press the same chord N times inside ONE debugger session — the fast
  // path for positional caret walks (ArrowRight x400). Looping OUTSIDE this
  // function costs a debugger acquire/release round-trip per press (~0.5s/key);
  // inside one session the same walk runs in milliseconds per key.
  // repeat: undefined -> 1 (normal keypress). Explicit 0 -> no-op (chunked
  // positional walks compute segment sizes; a zero segment must press nothing).
  const rawRepeatNum = rawRepeat === undefined || rawRepeat === null ? 1 : Math.floor(Number(rawRepeat));
  const repeat = Number.isFinite(rawRepeatNum) ? Math.min(1000, Math.max(0, rawRepeatNum)) : 1;
  if (repeat === 0) {
    return { pressed: false, key, modifiers, repeat: 0, fidelity: "trusted" };
  }
  const info = cdpKeyInfo(key);
  // With a non-shift modifier held (e.g. Ctrl/Meta), suppress the text payload so
  // the browser treats it as a shortcut (Ctrl+A) rather than typing a character.
  const nonTextModifier = (modifierBits & ~CDP_MODIFIER_BITS.shift) !== 0;
  const base = {
    modifiers: modifierBits,
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
  };
  // Hold the non-shift modifiers (Ctrl/Alt/Meta) as real keys around the chord so
  // Docs' shortcut layer fires (see withHeldModifiers / X13). Shift stays out of
  // the held set here: a shifted printable still needs its text payload and the
  // existing shift handling suffices for dispatchTrustedKey's callers.
  const heldBits = modifierBits & ~CDP_MODIFIER_BITS.shift;
  const target = { tabId };
  let acquired = false;
  try {
    // Shared refcounted attach — coexists with a held a11y.watch session on the
    // same tab (previously a second attach here threw "already attached").
    await acquireDebugger(tabId);
    acquired = true;
    await withHeldModifiers(target, heldBits, async () => {
      // A canvas editor (Google Docs) advances its caret on a requestAnimationFrame
      // loop that consumes AT MOST ONE navigation key per frame. Firing a burst of
      // ArrowRight keyDown+keyUp faster than one-per-frame COALESCES — extra
      // presses in the same frame are dropped, so a walk of N lands ~2-3 chars in
      // (measured live; reproduced offline by tests/live/caret-walk-coalesce-smoke).
      // Each repeated press is therefore a DISCRETE keyDown+keyUp spaced past one
      // frame (~16ms). We wait ~24ms — comfortably over a 60fps frame, still fast
      // (a 78-char walk ~1.9s). autoRepeat is NOT used: Docs treats an autoRepeat
      // burst as a single held key (one caret move), the opposite of what we need.
      const FRAME_GAP_MS = 25;
      const isRepeat = repeat > 1;
      for (let i = 0; i < repeat; i += 1) {
        await debuggerSendCommand(target, "Input.dispatchKeyEvent", {
          ...base,
          type: info.text && !nonTextModifier ? "keyDown" : "rawKeyDown",
          ...(info.text && !nonTextModifier ? { text: info.text } : {}),
        });
        await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
        // Space presses past one animation frame so the editor consumes each one.
        if (isRepeat && i < repeat - 1) await new Promise((r) => setTimeout(r, FRAME_GAP_MS));
      }
    });
  } finally {
    if (acquired) await releaseDebugger(tabId);
  }
  return { pressed: true, key, modifiers, repeat, fidelity: "trusted" };
};

// Trusted, ANIMATED drag via CDP Input.dispatchMouseEvent (mirrors dispatchTrustedKey's
// attach/dispatch/detach). The DEFAULT "animated" card move: a real pointer travels the
// path so the browser renders the faded drag-image FOLLOWING the cursor — the beautiful
// slide (investigations/drag-operations-primitive.md). Content.js pointer.drag (synthetic,
// untrusted) can't produce the drag-ghost; native HTML5 draggable ignores it. Trusted CDP
// mousePressed → MANY interpolated mouseMoved → mouseReleased is what a human drag is, so
// the browser animates it. Choreography (per Yaniv's spec + DnD thresholds): press at
// source, a few small pickup jitters to cross the drag threshold, then LOTS of interpolated
// move points along the (straight) path so the ghost glides smoothly, then release at the
// end. Coordinates are viewport CSS pixels (same space as pointer.click). Returns
// { dragged, from, to, points, fidelity:"trusted" }.
const dispatchTrustedDrag = async (tabId, rawFrom, rawTo, rawOpts) => {
  if (!Number.isInteger(tabId)) {
    throw new Error("pointer.drag (trusted) requires an authorized browser tab");
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const fromX = num(rawFrom?.x); const fromY = num(rawFrom?.y);
  const toX = num(rawTo?.x); const toY = num(rawTo?.y);
  if ([fromX, fromY, toX, toY].some((n) => Number.isNaN(n))) {
    throw new Error("pointer.drag (trusted) requires numeric from.{x,y} and to.{x,y} viewport coordinates");
  }
  const opts = rawOpts && typeof rawOpts === "object" ? rawOpts : {};
  // "lots and lots of points" — default a smooth 60; the per-step delay keeps it visible.
  const points = Math.min(200, Math.max(12, Math.floor(Number(opts.points ?? opts.steps) || 60)));
  const moveDelayMs = Math.min(60, Math.max(4, Math.floor(Number(opts.move_delay_ms) || 12)));
  const target = { tabId };
  const mouse = (type, x, y, extra = {}) =>
    debuggerSendCommand(target, "Input.dispatchMouseEvent", {
      type, x: Math.round(x), y: Math.round(y), button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0, ...extra,
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let acquired = false;
  try {
    await acquireDebugger(tabId);
    acquired = true;
    // Move onto the source (no button), then press.
    await mouse("mouseMoved", fromX, fromY, { buttons: 0, clickCount: 0 });
    await mouse("mousePressed", fromX, fromY);
    await sleep(moveDelayMs * 2);
    // Pickup jitter: small moves at the source cross the browser's drag-start threshold so a
    // real drag begins (and the drag-image appears).
    for (let j = 1; j <= 4; j += 1) {
      await mouse("mouseMoved", fromX + j * 4, fromY + j * 2);
      await sleep(moveDelayMs);
    }
    // Glide: LOTS of interpolated points along the straight path so the ghost slides.
    for (let i = 1; i <= points; i += 1) {
      const t = i / points;
      await mouse("mouseMoved", fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
      await sleep(moveDelayMs);
    }
    // Settle over the target, then release to drop.
    await mouse("mouseMoved", toX, toY);
    await sleep(moveDelayMs * 3);
    await mouse("mouseReleased", toX, toY);
  } finally {
    if (acquired) await releaseDebugger(tabId);
  }
  return {
    dragged: true,
    from: { x: fromX, y: fromY },
    to: { x: toX, y: toY },
    points,
    fidelity: "trusted",
  };
};

// Read the current accessibility value for a tab — the signal the gated-repeat
// loop matches each expected regex against. GENERAL by design (not Docs-bound):
// the primary source is the announcer's most-recent announcement (the same live
// stream a11y.watch exposes); when that is empty we fall back to a focused-node
// accessible-text read via page script. Docs' word-caret announcement proved
// reliable this way (verified live 2026-07-07). The definitive per-surface source
// + read dwell are tuned by the live smoke (plan U6 / OQ1); this function is the
// swappable seam.
const readCurrentA11yValue = async (tabId) => {
  // SOURCE PRIORITY (corrected live 2026-07-07, plan U6/OQ1): on real Google Docs
  // the aria-live REGION node (#docs-aria-speakable) holds the precise caret WORD
  // ("you"), while the buffered announcement STREAM interleaves coarse ChromeVox
  // role echoes ("Application"). Reading the stream first (the old order) made the
  // gate see "Application" and halt-loud on a press that actually landed. So read
  // the region node FIRST; use the announcement buffer only as a fallback for
  // surfaces that don't publish a speakable region.
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const speak = document.getElementById("docs-aria-speakable");
        if (speak && speak.textContent && speak.textContent.trim()) return speak.textContent.trim();
        const el = document.activeElement;
        if (!el) return "";
        return (el.getAttribute("aria-label") || el.textContent || el.value || "").trim();
      },
    });
    const regionText = String(result ?? "").trim();
    if (regionText) return regionText;
  } catch (_e) {
    // fall through to the announcement buffer
  }
  // Fallback: last buffered a11y announcement (surfaces without a speakable region).
  const buf = readA11yAnnouncements(tabId);
  if (Array.isArray(buf) && buf.length) {
    const last = buf[buf.length - 1];
    const text = (last && (last.text ?? last.value ?? last.name)) || "";
    if (String(text).trim()) return String(text).trim();
  }
  return "";
};

// Accessibility-gated key-repeat (plan 2026-07-07-004): press a key/chord and
// gate each repeat on the a11y layer's return, with count | until-regex |
// path-of-regexes stop modes and positive/negative polarity. The DECISION logic
// lives in ./a11y/gated-repeat.mjs (unit-tested); this wires it to the real
// trusted-CDP press (one keyDown/keyUp per step, spaced, inside ONE held
// debugger session so the a11y read reflects each press) and the a11y read.
const GATED_FRAME_GAP_MS = 40; // per-press dwell: press consumed + announcement emitted before read (tuned in U6)
const dispatchGatedRepeat = async (tabId, rawArgs) => {
  if (!Number.isInteger(tabId)) {
    throw new Error("keyboard.press_gated requires an authorized browser tab");
  }
  const plan = normalizeGatedRepeatArgs(rawArgs); // throws on invalid args (key/stop/count/regex/polarity)
  const target = { tabId };
  let acquired = false;
  try {
    await acquireDebugger(tabId);
    acquired = true;
    // One trusted keyDown+keyUp for `key`+`modifiers`, mirroring dispatchTrustedKey's
    // single-press shape (withHeldModifiers so Docs' shortcut layer fires for chords),
    // then a frame-gap dwell so the surface consumes it and emits its a11y announcement.
    const press = async (rawKey, modifiers) => {
      // Support a compact chord in the key field ("Control+ArrowRight"), mirroring
      // the keyboard.press handler: split into base key + modifiers so the CDP
      // event carries a real key AND the held-modifier bits.
      const rawKeyStr = String(rawKey || "");
      const chordParts = rawKeyStr.includes("+") ? rawKeyStr.split("+").filter(Boolean) : [];
      const key = chordParts.length > 1 ? chordParts.at(-1) : rawKeyStr;
      const allMods = [
        ...(Array.isArray(modifiers) ? modifiers : []),
        ...(chordParts.length > 1 ? chordParts.slice(0, -1) : []),
      ];
      const info = cdpKeyInfo(key);
      const modBits = allMods
        .map((m) => String(m).toLowerCase())
        .reduce((bits, m) => bits | (CDP_MODIFIER_BITS[m] || 0), 0);
      const nonTextMod = (modBits & ~CDP_MODIFIER_BITS.shift) !== 0;
      const heldBits = modBits & ~CDP_MODIFIER_BITS.shift;
      const base = {
        modifiers: modBits,
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
      };
      await withHeldModifiers(target, heldBits, async () => {
        await debuggerSendCommand(target, "Input.dispatchKeyEvent", {
          ...base,
          type: info.text && !nonTextMod ? "keyDown" : "rawKeyDown",
          ...(info.text && !nonTextMod ? { text: info.text } : {}),
        });
        await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      });
      await new Promise((r) => setTimeout(r, GATED_FRAME_GAP_MS));
    };
    const read = async () => readCurrentA11yValue(tabId);
    const result = await runGatedRepeat(plan, { press, read });
    return { ...result, fidelity: "trusted" };
  } finally {
    if (acquired) await releaseDebugger(tabId);
  }
};

// Trusted multi-character type as REAL per-character key events (CDP
// Input.dispatchKeyEvent keyDown+keyUp), NOT Input.insertText.
//
// WHY (verified live 2026-07-06 on Google Docs): Input.insertText is a
// text-commit command that canvas editors (Docs/Slides/Sheets) IGNORE against a
// live selection — the selected run survives, the insert is dropped. A real
// keyDown carrying a `text` payload — the exact event dispatchTrustedKey sends,
// which was proven to overtype a Find-made selection — DOES reach the canvas and
// replaces the selection. So we type the string character by character with the
// same key-event shape as a single trusted keypress. This is the fix that
// unblocks select-and-replace / delete-by-space on canvas editors (the old
// select_and_type "fire-and-forget" failure was really insertText-not-honored,
// not a timing bug).
const dispatchTrustedText = async (tabId, rawText, selectBackChars = 0) => {
  if (!Number.isInteger(tabId)) {
    throw new Error("text.type trusted requires an authorized browser tab");
  }
  const text = String(rawText ?? "");
  const count = Number.isFinite(Number(selectBackChars)) ? Math.max(0, Math.floor(Number(selectBackChars))) : 0;
  const target = { tabId };
  let acquired = false;
  try {
    await acquireDebugger(tabId); // shared, coexists with a held a11y session
    acquired = true;
    // Optionally extend a selection backward by `count` chars (Shift+Left) BEFORE
    // inserting, so a single atomic call both selects and overtypes — the caller
    // gives the character length of the phrase to replace (e.g. from a Find match).
    // Shift is held as a REAL key across all N ArrowLeft presses (withHeldModifiers):
    // a per-event `modifiers: shift` bitmask alone does NOT extend the selection on
    // Docs — the same class as the Ctrl-chord bug (X13). Held once around the whole
    // run, not re-pressed per key.
    if (count > 0) {
      const left = cdpKeyInfo("ArrowLeft");
      await withHeldModifiers(target, CDP_MODIFIER_BITS.shift, async () => {
        for (let i = 0; i < count; i += 1) {
          const base = {
            modifiers: CDP_MODIFIER_BITS.shift,
            key: left.key,
            code: left.code,
            windowsVirtualKeyCode: left.keyCode,
            nativeVirtualKeyCode: left.keyCode,
          };
          await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
          await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
        }
      });
    }
    // Type each character as a real trusted keyDown (with text payload) + keyUp —
    // the mechanism canvas editors honor. The first character replaces the live
    // selection; the rest insert sequentially at the caret.
    for (const ch of Array.from(text)) {
      const info = cdpKeyInfo(ch);
      const base = {
        modifiers: 0,
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.keyCode,
        nativeVirtualKeyCode: info.keyCode,
      };
      await debuggerSendCommand(target, "Input.dispatchKeyEvent", {
        ...base,
        type: "keyDown",
        text: info.text != null ? info.text : ch,
      });
      await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    }
  } finally {
    if (acquired) await releaseDebugger(tabId);
  }
  return { typed: true, length: text.length, selected_back: count, fidelity: "trusted" };
};

const debugExpressionFor = (source, args) => {
  const serializedArgs = JSON.stringify(args && typeof args === "object" ? args : {});
  return `
    (async () => {
      const args = ${serializedArgs};
      const helpers = {
        normalizeText(value) {
          return String(value || "").replace(/\\s+/g, " ").trim();
        },
        visibleText(element) {
          return element ? this.normalizeText(element.textContent || element.getAttribute("aria-label")) : "";
        }
      };
      ${source}
    })()
  `;
};

const evaluateWithDebugger = async (message, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) {
    throw new Error("debug.run_javascript requires an authorized browser tab");
  }
  const source = message.source || message.javascript;
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("debug.run_javascript requires source");
  }

  const target = { tabId };
  let acquired = false;
  try {
    await acquireDebugger(tabId); // shared, coexists with a held a11y session
    acquired = true;
    const response = await debuggerSendCommand(target, "Runtime.evaluate", {
      expression: debugExpressionFor(source, message.args),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;
      const description = details.exception?.description || details.text || "debug evaluation failed";
      throw new Error(description);
    }
    const remote = response?.result || {};
    return {
      ok: true,
      result: Object.prototype.hasOwnProperty.call(remote, "value") ? remote.value : remote.description,
      url: sender.tab?.url || null,
      execution: {
        adapter: "extension",
        capability_class: "debug",
        transport: "chrome.debugger"
      }
    };
  } finally {
    if (acquired) await releaseDebugger(tabId);
  }
};

const captureVisibleTab = (message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  const capture = () => {
    chrome.tabs.captureVisibleTab(
      windowId,
      {
        format: message.format === "jpeg" ? "jpeg" : "png",
        quality: Number.isInteger(message.quality) ? message.quality : undefined,
      },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      }
    );
  };

  const activateTab = () => {
    chrome.tabs.update(tabId, { active: true }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      capture();
    });
  };

  if (tabId) {
    if (windowId && chrome.windows?.update) {
      chrome.windows.update(windowId, { focused: true }, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        activateTab();
      });
      return true;
    }
    activateTab();
  } else {
    capture();
  }

  return true;
};

// Capture a tab's visible pixels WITHOUT involving its content script.
// chrome.tabs.captureVisibleTab runs entirely in the background service worker,
// so this succeeds even when the page's main thread / content-script message
// channel is jammed (blocking modal, busy JS). This is the reliable-screenshot
// path used by executePrimitiveInTab so an investigator can always see the page.
const captureTabDirect = (tab, { format = "png", quality } = {}) =>
  new Promise((resolve) => {
    const doCapture = () => {
      chrome.tabs.captureVisibleTab(
        tab.windowId,
        {
          format: format === "jpeg" ? "jpeg" : "png",
          quality: Number.isInteger(quality) ? quality : undefined,
        },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true, dataUrl });
        }
      );
    };
    // captureVisibleTab only captures the ACTIVE tab of its window, so focus
    // the window and activate the tab first. These calls are background→browser
    // (chrome.tabs / chrome.windows) and do not depend on the page thread.
    if (tab.windowId && chrome.windows?.update) {
      chrome.windows.update(tab.windowId, { focused: true }, () => {
        chrome.tabs.update(tab.id, { active: true }, () => {
          // Ignore lastError here — capture will surface a real failure.
          doCapture();
        });
      });
    } else {
      chrome.tabs.update(tab.id, { active: true }, () => doCapture());
    }
  });

const executeScreenshotDirect = async (tab, call = {}) => {
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const format = args.format === "jpeg" ? "jpeg" : "png";
  const result = await captureTabDirect(tab, { format, quality: args.quality });
  if (!result.ok) {
    return {
      ok: false,
      call_id: call.call_id,
      output: null,
      error: {
        code: "screenshot_capture_failed",
        message: result.error || "captureVisibleTab failed",
      },
    };
  }
  return {
    ok: true,
    call_id: call.call_id,
    output: {
      ok: true,
      primitive: "browser.screenshot",
      adapter: "extension",
      transport: "background_capture",
      value: {
        data_url: result.dataUrl,
        mime_type: format === "jpeg" ? "image/jpeg" : "image/png",
        url: tab.url || null,
        captured_at: new Date().toISOString(),
        note: "Captured directly in the background (content-script bypass); no page-side resize applied.",
      },
    },
    error: null,
  };
};

const bridgeHttpOrigin = (bridgeUrl = DEFAULT_BRIDGE_URL) => {
  const url = new URL(bridgeUrl || DEFAULT_BRIDGE_URL);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const loadBridgeUrl = async () => {
  const stored = await chrome.storage.local.get("bridgeUrl");
  return stored?.bridgeUrl || DEFAULT_BRIDGE_URL;
};

const hostedToolArguments = (call) => {
  const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : {};
  if (call?.name !== "browser.screenshot") {
    return args;
  }
  return {
    ...HOSTED_SCREENSHOT_DEFAULTS,
    ...args,
  };
};

const readJsonResponse = async (response) => {
  let text = "";
  try {
    text = typeof response.text === "function" ? await response.text() : "";
  } catch (error) {
    return {
      __invalidJson: true,
      error: "Unable to read bridge response body.",
      read_error: error.message || String(error),
    };
  }
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      __invalidJson: true,
      error: "Unable to parse bridge response as JSON.",
      parse_error: error.message || String(error),
    };
  }
};

const publicBridgeResponseDetails = (body) => {
  if (!body?.__invalidJson) {
    return body;
  }
  const details = {
    error: body.error,
  };
  if (body.parse_error) {
    details.parse_error = body.parse_error;
  }
  if (body.read_error) {
    details.read_error = body.read_error;
  }
  return details;
};

const appendAgentMemoryEvent = async (event) => {
  // Fire-and-forget event logging on the background hot path. Route both storage
  // accesses through the bounded helper so a wedged chrome.storage under MV3
  // recycling cannot hang this (F1, docs/plans/2026-07-07-001). On a bounded-get
  // timeout we degrade to empty memory rather than skipping the append; on a
  // bounded-set timeout we drop the event — either way we never propagate a
  // rejection into the caller, matching the fire-and-forget intent.
  let stored;
  try {
    stored = await boundedStorageGet(AGENT_MEMORY_STORAGE_KEY);
  } catch (_error) {
    stored = null; // storage stalled — start from empty, don't hang or throw
  }
  const existing = stored?.[AGENT_MEMORY_STORAGE_KEY];
  const memory = existing && typeof existing === "object"
    ? existing
    : { visitorId: null, events: [] };
  const events = Array.isArray(memory.events) ? memory.events : [];
  events.push({
    id: event.id || `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp || new Date().toISOString(),
    ...event,
  });
  await boundedStorageSet({
    [AGENT_MEMORY_STORAGE_KEY]: {
      visitorId: typeof memory.visitorId === "string" ? memory.visitorId : null,
      events: events.slice(-MAX_AGENT_LOG_EVENTS),
    },
  }).catch(() => { /* storage stalled — drop this event rather than hang or throw */ });
};

const originForUrl = (value) => {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value).origin;
  } catch (_error) {
    const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(value);
    return match ? match[1] : null;
  }
};

const withoutHash = (value) => (typeof value === "string" ? value.split("#")[0] : null);

const appendBackgroundDiagnosticEvent = async (event) =>
  appendAgentMemoryEvent(event).catch((error) => {
    console.warn("actions.json failed to append background diagnostic event", error);
  });

const toolNames = (tools = []) =>
  (Array.isArray(tools) ? tools : [])
    .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
    .filter(Boolean);

const mergeToolCatalogs = (primaryTools = [], fallbackTools = []) => {
  const merged = [];
  const seen = new Set();
  for (const tool of [
    ...(Array.isArray(primaryTools) ? primaryTools : []),
    ...(Array.isArray(fallbackTools) ? fallbackTools : []),
  ]) {
    if (typeof tool?.name !== "string" || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    merged.push(tool);
  }
  return merged;
};

const executePrimitiveInTab = async (tab, call = {}) => {
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "actions-json:execute-action",
    call_id: call.call_id,
    name: call.name,
    arguments: hostedToolArguments(call),
  });
  return {
    ok: response?.ok !== false,
    call_id: call.call_id,
    output: response?.output,
    error: response?.error || null,
  };
};

const executeStateProjectionInTab = async (tab, { bundle, projectionName, summaryName, maxBytes } = {}, call = {}) => {
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "actions-json:execute-state-projection",
    call_id: call.call_id,
    bundle,
    projection_name: projectionName,
    summary_name: summaryName || null,
    max_bytes: maxBytes,
  });
  return {
    ok: response?.ok !== false,
    call_id: call.call_id,
    output: response?.output,
    error: response?.error || null,
  };
};

function stateSnapshotKey(tab, projectionName) {
  return `${tab.id}:${projectionName}`;
}

const executeStateProjectionModesInTab = async (tab, { bundle, mode, args = {}, call = {} } = {}) => {
  const projectionName = args.projection_name || args.projection;
  if (typeof projectionName !== "string" || !projectionName) {
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "invalid_input",
        message: "actions.site state_read/state_summary/state_diff mode requires projection_name.",
      },
    };
  }
  const stateResult = await executeStateProjectionInTab(
    tab,
    {
      bundle,
      projectionName,
      summaryName: mode === "state_summary" ? args.summary_name || "agent_context" : null,
      maxBytes: args.max_bytes,
    },
    call,
  );
  if (stateResult.ok === false || stateResult.output?.ok === false) {
    return stateResult;
  }
  if (mode === "state_summary") {
    return stateResult;
  }
  const key = stateSnapshotKey(tab, projectionName);
  if (mode === "state_diff") {
    const previous = stateProjectionSnapshots.get(key);
    const current = stateResult.output?.state;
    if (current === undefined) {
      return {
        ok: false,
        call_id: call.call_id,
        error: {
          code: "state_diff_requires_full_state",
          message: "actions.site state_diff requires a full state projection result.",
        },
      };
    }
    const patches = previous?.state === undefined ? [] : diffStates(previous.state, current);
    stateProjectionSnapshots.set(key, {
      state: current,
      state_hash: stateResult.output.state_hash || null,
      observed_at: stateResult.output.observed_at || new Date().toISOString(),
    });
    return {
      ok: true,
      call_id: call.call_id,
      output: {
        ok: true,
        projection: projectionName,
        baseline: previous ? "previous_snapshot" : "initialized",
        patch_format: "json_patch",
        patches,
        semantic_deltas: buildSemanticDeltas(patches),
        previous_state_hash: previous?.state_hash || null,
        state_hash: stateResult.output.state_hash || null,
        observed_at: stateResult.output.observed_at || null,
      },
      error: null,
    };
  }
  if (stateResult.output?.state !== undefined) {
    stateProjectionSnapshots.set(key, {
      state: stateResult.output.state,
      state_hash: stateResult.output.state_hash || null,
      observed_at: stateResult.output.observed_at || new Date().toISOString(),
    });
  }
  return stateResult;
};

const bridgeStateProjectionBundle = (item) => {
  if (!item?.projection || typeof item.projection !== "object") return null;
  const mapPath = typeof item.map_path === "string" && item.map_path ? item.map_path : null;
  if (!mapPath) return null;
  return {
    entries: [
      {
        path: mapPath,
        content: JSON.stringify({
          protocol: "actions.json",
          state_projections: [item.projection],
        }),
      },
    ],
  };
};

const executeBridgeStateProjectionItem = async (item, tab) => {
  const callId = item?.call_id || null;
  const mode = item?.mode;
  if (mode !== "state_read" && mode !== "state_summary" && mode !== "state_diff") {
    return {
      ok: false,
      call_id: callId,
      error: {
        code: "invalid_input",
        message: "state_projection_call mode must be state_read, state_summary, or state_diff.",
        recoverable: true,
      },
    };
  }
  let bundle = bridgeStateProjectionBundle(item);
  if (!bundle) {
    const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
    bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];
  }
  return executeStateProjectionModesInTab(tab, {
    bundle,
    mode,
    args: {
      projection_name: item.projection_name,
      summary_name: item.summary_name || undefined,
      max_bytes: item.max_bytes || undefined,
    },
    call: { call_id: callId },
  });
};

const handleBridgeStateProjectionCall = async (item) => {
  const callId = item?.call_id || null;
  const runtimeId = runtimeIdFromBridgeItem(item);
  const fail = (code, message, extra = {}) => {
    sendBridgeOutputItem({
      type: "action_error",
      call_id: callId,
      runtime_id: runtimeId,
      error: { code, message, recoverable: true, ...extra },
    });
  };
  const tabId = resolveBridgeItemTabId(item);
  if (!Number.isInteger(tabId)) {
    fail("claim_missing", "Bridge state projection call could not be routed to a claimed tab.", {
      next_step: ROUTE_ERROR_NEXT_STEP.claim_missing,
    });
    return;
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    fail("tab_closed", "Bridge state projection call routed to a tab that no longer exists.", {
      tab_id: tabId,
      next_step: ROUTE_ERROR_NEXT_STEP.tab_closed,
    });
    return;
  }
  const result = await executeBridgeStateProjectionItem(item, tab);
  if (result.ok === false || result.output?.ok === false) {
    sendBridgeItem({
      type: "action_error",
      call_id: callId,
      runtime_id: runtimeId,
      error: result.error || result.output?.error || {
        code: "state_projection_failed",
        message: "State projection execution failed in the extension runtime.",
      },
    });
    return;
  }
  sendBridgeItem({
    type: "action_call_output",
    call_id: callId,
    runtime_id: runtimeId,
    output: result.output,
  });
};

const bridgeSiteActionBundle = (item) => {
  if (!item?.map || typeof item.map !== "object") return null;
  const mapPath = typeof item.map_path === "string" && item.map_path ? item.map_path : null;
  if (!mapPath) return null;
  return {
    entries: [
      {
        path: mapPath,
        content: JSON.stringify(item.map),
      },
    ],
  };
};

const executeBridgeSiteActionItem = async (item, tab) => {
  const callId = item?.call_id || null;
  if (typeof item?.action !== "string" || !item.action) {
    return {
      ok: false,
      call_id: callId,
      error: {
        code: "invalid_input",
        message: "site_action_call requires action.",
        recoverable: true,
      },
    };
  }
  let bundle = bridgeSiteActionBundle(item);
  if (!bundle) {
    const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
    bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];
  }
  return executeSiteActionCallInTab(tab, {
    bundle,
    args: {
      action: item.action,
      arguments: item.arguments && typeof item.arguments === "object" ? item.arguments : {},
    },
    call: { call_id: callId },
  });
};

const handleBridgeSiteActionCall = async (item) => {
  const callId = item?.call_id || null;
  const runtimeId = runtimeIdFromBridgeItem(item);
  const fail = (code, message, extra = {}) => {
    sendBridgeItem({
      type: "action_error",
      call_id: callId,
      runtime_id: runtimeId,
      error: { code, message, recoverable: true, ...extra },
    });
  };
  const tabId = resolveBridgeItemTabId(item);
  if (!Number.isInteger(tabId)) {
    fail("claim_missing", "Bridge site action call could not be routed to a claimed tab.", {
      next_step: ROUTE_ERROR_NEXT_STEP.claim_missing,
    });
    return;
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    fail("tab_closed", "Bridge site action call routed to a tab that no longer exists.", {
      tab_id: tabId,
      next_step: ROUTE_ERROR_NEXT_STEP.tab_closed,
    });
    return;
  }
  const result = await executeBridgeSiteActionItem(item, tab);
  if (result.ok === false || result.output?.ok === false) {
    const outputItem = {
      type: "action_error",
      call_id: callId,
      runtime_id: runtimeId,
      error: result.error || result.output?.error || {
        code: "site_action_failed",
        message: "Site action execution failed in the extension runtime.",
      },
    };
    const sent = sendBridgeOutputItem(outputItem);
    await appendBackgroundDiagnosticEvent({
      type: "transport",
      name: "background.bridge.site_action_output",
      ok: sent,
      summary: sent
        ? "Extension background sent site action failure to the bridge."
        : "Extension background could not send site action failure to the bridge.",
      input: {
        call_id: callId,
        runtime_id: runtimeId,
        action: item?.action || null,
        output_type: outputItem.type,
      },
      output: {
        sent,
        bridge_socket_state: bridgeSocket?.readyState ?? null,
        result_ok: result.ok !== false && result.output?.ok !== false,
      },
    });
    return;
  }
  const outputItem = {
    type: "action_call_output",
    call_id: callId,
    runtime_id: runtimeId,
    output: result.output,
  };
  const sent = sendBridgeOutputItem(outputItem);
  await appendBackgroundDiagnosticEvent({
    type: "transport",
    name: "background.bridge.site_action_output",
    ok: sent,
    summary: sent
      ? "Extension background sent site action output to the bridge."
      : "Extension background could not send site action output to the bridge.",
    input: {
      call_id: callId,
      runtime_id: runtimeId,
      action: item?.action || null,
      output_type: outputItem.type,
    },
    output: {
      sent,
      bridge_socket_state: bridgeSocket?.readyState ?? null,
      result_ok: true,
    },
  });
};

const getClaimedActiveTab = async () => {
  const entries = await sessionStore.getSessionEntries();
  const claimedTabIds = [];
  let activeTabId = null;
  for (const [_sessionId, session] of entries) {
    if (Number.isInteger(session.activeTabId)) {
      activeTabId = session.activeTabId;
    }
    for (const tabIdKey of Object.keys(session.tabs || {})) {
      const tabId = Number(tabIdKey);
      if (Number.isInteger(tabId)) {
        claimedTabIds.push(tabId);
      }
    }
  }

  const candidateIds = [
    activeTabId,
    claimedTabIds.length === 1 ? claimedTabIds[0] : null,
  ].filter((tabId) => Number.isInteger(tabId));

  for (const tabId of candidateIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.id) {
        return tab;
      }
    } catch (_error) {
      // Stale claimed tab records are pruned by claimed-tab listing/replay paths.
    }
  }
  return null;
};

const getHostedToolDefaultTab = async () => {
  const claimedTab = await getClaimedActiveTab();
  if (claimedTab?.id) {
    return { tab: claimedTab, source: "claimed_active_tab" };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { tab: tab || null, source: "browser_active_tab" };
};

// a11y.tree / a11y.query (U3, docs/a11y-shim-spec.md): build a fresh CDP-backed
// ShimTree for the routed tab and run the operation. Per-call refresh is the
// simplest-correct phase-1 policy; attach/detach mirrors dispatchTrustedKey.
const runA11yTreeOp = async (tabId, op) => {
  if (!Number.isInteger(tabId)) {
    throw new Error("a11y primitives require an authorized browser tab");
  }
  const target = { tabId };
  let acquired = false;
  try {
    await acquireDebugger(tabId);
    acquired = true;
    let url = "";
    let focused = true;
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab?.url || "";
      focused = Boolean(tab?.active);
    } catch (_e) { /* tab metadata is best-effort */ }
    const tree = await new ShimTree({
      cdp: (method, params) => debuggerSendCommand(target, method, params),
      tabId,
      url,
      focused,
    }).refresh();
    return await op(tree);
  } finally {
    if (acquired) await releaseDebugger(tabId);
  }
};

// a11y.watch (U8): start listening to a tab's live regions. Injects the
// observer content script into ALL frames (idempotent by guard — safe on
// already-connected tabs, which is exactly the gap: the observer otherwise
// only lands on tabs claimed AFTER this version loaded), ensures the announcer
// is running, and — when requested — enables the site's screen-reader mode
// idempotently (verifying it is ON rather than blind-toggling). This is the
// R8 "screen-reader-mode capability" as a callable primitive.
const runA11yWatch = async (tabId, { enableScreenReader = true, screenReaderChord = "Control+Alt+z" } = {}) => {
  if (!Number.isInteger(tabId)) {
    throw new Error("a11y.watch requires an authorized browser tab");
  }
  // 1) Inject the observer into every frame (idempotent).
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/a11y/live_region_observer.js"],
    });
  } catch (e) {
    // Some frames reject injection (sandboxed / about:blank) — the top frame
    // is what matters for phase-1 canvas editors.
  }
  // 2) Open the persistent a11y debugger session so the announcer's ShimTree
  //    CDP closure stays alive across the batch (the U8 drop was per-op detach).
  try { await ensureA11yDebuggerSession(tabId); } catch (_e) { /* adopted or unavailable */ }
  // 3) Ensure the announcer is wired (lazy — first tree-change would also do it).
  await getA11yAnnouncer().catch(() => {});
  // 3) Enable the site screen-reader mode idempotently, if asked (canvas Docs
  //    needs it to populate live regions richly). Verify by the aria-live flag.
  let screenReader = "not_requested";
  if (enableScreenReader) {
    const readState = async () => {
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const el = document.getElementById("docs-aria-speakable");
            return el ? el.textContent : null;
          },
        });
        return result;
      } catch (_e) { return null; }
    };
    const isOn = (s) => typeof s === "string" && /enabled/i.test(s);
    let state = await readState();
    if (!isOn(state)) {
      // Toggle once, then verify; if it flipped the wrong way, toggle back.
      const parts = String(screenReaderChord).split("+");
      const key = parts.at(-1);
      const modifiers = parts.slice(0, -1);
      await dispatchTrustedKey(tabId, key, modifiers);
      await new Promise((r) => setTimeout(r, 250));
      state = await readState();
      if (!isOn(state)) {
        await dispatchTrustedKey(tabId, key, modifiers);
        await new Promise((r) => setTimeout(r, 250));
        state = await readState();
      }
    }
    screenReader = isOn(state) ? "enabled" : `unverified(${state ?? "no-signal"})`;
  }
  // Diagnostic: how many observer batches has this tab's log received so far,
  // and did the observer's global install (probed in the isolated world)?
  let observerInstalled = null;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => Boolean(globalThis.__actionsJsonA11yObserver) &&
        (globalThis.__actionsJsonA11yObserver.regionCount?.() ?? -1),
    });
    observerInstalled = result;
  } catch (_e) { observerInstalled = "probe_failed"; }
  const batchCount = (a11yEventLogs.get(tabId) || []).length;
  let announcerDiag = null;
  try {
    const ann = await a11yAnnouncerPromise;
    announcerDiag = ann?.diagnostics?.() ?? null;
  } catch (_e) { /* not started */ }
  return {
    watching: true,
    tab_id: tabId,
    screen_reader: screenReader,
    observer_regions: observerInstalled,
    observer_batches_received: batchCount,
    announcer_diag: announcerDiag,
    store_size: (a11yAnnouncements.get(tabId) || []).length,
  };
};

const executeBackgroundHostedToolCall = async (call = {}, routedTabId = null) => {
  if (call.name === "a11y.watch") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    const tabId = Number.isInteger(routedTabId) ? routedTabId : Number(args.tab_id ?? args.tabId);
    const output = await runA11yWatch(tabId, {
      enableScreenReader: args.enable_screen_reader !== false,
      screenReaderChord: typeof args.screen_reader_chord === "string" ? args.screen_reader_chord : undefined,
    });
    return { ok: true, call_id: call.call_id, output, error: null };
  }
  if (call.name === "a11y.tree") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    const tabId = Number.isInteger(routedTabId) ? routedTabId : Number(args.tab_id ?? args.tabId);
    const output = await runA11yTreeOp(tabId, async (tree) =>
      tree.outline({
        maxDepth: Number.isInteger(args.max_depth) ? args.max_depth : 12,
        maxNodes: Number.isInteger(args.max_nodes) ? args.max_nodes : 800,
      }));
    return { ok: true, call_id: call.call_id, output, error: null };
  }
  if (call.name === "a11y.query") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    const tabId = Number.isInteger(routedTabId) ? routedTabId : Number(args.tab_id ?? args.tabId);
    const output = await runA11yTreeOp(tabId, async (tree) => {
      const node = tree.query({
        role: args.role,
        name: args.name,
        name_contains: args.name_contains,
      });
      if (!node) {
        return { found: false, role: args.role || null, name: args.name ?? args.name_contains ?? null };
      }
      const center = await tree.clickableCenter(node);
      return {
        found: true,
        role: node.role,
        name: node.name,
        value: node.value ?? null,
        state: node.state,
        backend_dom_node_id: node.backendDOMNodeId ?? null,
        clickable_center: center,
      };
    });
    return { ok: true, call_id: call.call_id, output, error: null };
  }
  // keyboard.press with trusted:true runs here (CDP). Without the flag it never
  // reaches this function — it flows to the content.js synthetic path.
  if (call.name === "keyboard.press" && call.arguments && call.arguments.trusted === true) {
    const args = call.arguments;
    const rawKey = String(args.key || "");
    // Support a compact chord like "Control+A" in the key field, mirroring the synthetic path.
    const chordParts = rawKey.includes("+") ? rawKey.split("+").filter(Boolean) : [];
    const key = chordParts.length > 1 ? chordParts.at(-1) : rawKey;
    const modifiers = [
      ...(Array.isArray(args.modifiers) ? args.modifiers : []),
      ...(chordParts.length > 1 ? chordParts.slice(0, -1) : []),
    ];
    const tabId = Number.isInteger(routedTabId) ? routedTabId : (args.tab_id ?? args.tabId);
    return {
      ok: true,
      call_id: call.call_id,
      output: await dispatchTrustedKey(Number(tabId), key, modifiers, args.repeat),
      error: null,
    };
  }
  if (call.name === "keyboard.press_gated") {
    const args = call.arguments || {};
    const tabId = Number.isInteger(routedTabId) ? routedTabId : (args.tab_id ?? args.tabId);
    return {
      ok: true,
      call_id: call.call_id,
      output: await dispatchGatedRepeat(Number(tabId), args),
      error: null,
    };
  }
  if (call.name === "text.type" && call.arguments && call.arguments.trusted === true) {
    const args = call.arguments;
    const tabId = Number.isInteger(routedTabId) ? routedTabId : (args.tab_id ?? args.tabId);
    return {
      ok: true,
      call_id: call.call_id,
      output: await dispatchTrustedText(Number(tabId), args.text, args.select_back_chars),
      error: null,
    };
  }
  // pointer.drag with trusted:true runs here (CDP animated pointer drag).
  if (call.name === "pointer.drag" && call.arguments && call.arguments.trusted === true) {
    const args = call.arguments;
    const tabId = Number.isInteger(routedTabId) ? routedTabId : (args.tab_id ?? args.tabId);
    return {
      ok: true,
      call_id: call.call_id,
      output: await dispatchTrustedDrag(Number(tabId), args.from, args.to, args),
      error: null,
    };
  }
  if (call.name === "browser.claimed_tabs.list") {
    return {
      ok: true,
      call_id: call.call_id,
      output: await listClaimedTabs(),
      error: null,
    };
  }
  if (call.name === "browser.claimed_tabs.activate") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    return {
      ok: true,
      call_id: call.call_id,
      output: await activateClaimedTab({
        tabId: args.tab_id ?? args.tabId,
        reconnectDelayMs: args.reconnect_delay_ms ?? args.reconnectDelayMs,
      }),
      error: null,
    };
  }
  if (call.name === "browser.navigate") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    return {
      ok: true,
      call_id: call.call_id,
      output: await navigateClaimedTab(args),
      error: null,
    };
  }
  if (call.name === "browser.open_tab") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    return {
      ok: true,
      call_id: call.call_id,
      output: await openClaimedTab(args),
      error: null,
    };
  }
  if (call.name === "browser.close_tab") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    return {
      ok: true,
      call_id: call.call_id,
      output: await closeClaimedTab(args),
      error: null,
    };
  }
  if (call.name === "browser.dismiss_dialog") {
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    return {
      ok: true,
      call_id: call.call_id,
      output: await dismissDialogOnTab(args),
      error: null,
    };
  }
  return null;
};

const transferSourceForSender = (sender = {}) => ({
  tab_id: sender.tab?.id ?? null,
  url: sender.tab?.url || null,
  frame_id: sender.frameId ?? null,
});

const transferErrorResult = (primitive, error, evidence = {}) => {
  const code = error instanceof TransferBufferError ? error.code : "transfer_failed";
  return {
    ok: false,
    primitive,
    adapter: "extension",
    error: {
      code,
      message: error.message || String(error),
      recoverable: true,
      evidence,
    },
  };
};

const handleTransferBufferMessage = async (message = {}, sender = {}) => {
  const primitive = message.primitive || message.name;
  const args = message.arguments && typeof message.arguments === "object" ? message.arguments : {};
  try {
    if (primitive === "transfer.write") {
      return {
        ok: true,
        result: {
          ok: true,
          primitive,
          adapter: "extension",
          value: transferBuffer.write({
            ...args,
            source: {
              ...transferSourceForSender(sender),
              ...(args.source && typeof args.source === "object" ? args.source : {}),
            },
          }),
        },
      };
    }
    if (primitive === "transfer.read") {
      return {
        ok: true,
        result: {
          ok: true,
          primitive,
          adapter: "extension",
          value: transferBuffer.read(args),
        },
      };
    }
    if (primitive === "transfer.clear") {
      return {
        ok: true,
        result: {
          ok: true,
          primitive,
          adapter: "extension",
          value: transferBuffer.clear(args),
        },
      };
    }
    if (primitive === "transfer.insert") {
      const rendered = transferBuffer.render(args);
      return {
        ok: true,
        result: {
          ok: true,
          primitive,
          adapter: "extension",
          value: {
            ...rendered,
            text: rendered.rendered_text,
          },
        },
      };
    }
    return {
      ok: true,
      result: transferErrorResult(primitive || "transfer.unknown", new Error(`Unknown transfer primitive: ${primitive || "unknown"}`), {
        primitive,
      }),
    };
  } catch (error) {
    return {
      ok: true,
      result: transferErrorResult(primitive || "transfer.unknown", error, {
        primitive,
        label: args.label || null,
        id: args.id || null,
      }),
    };
  }
};

const handleStorageReadFileMessage = async (message = {}, sender = {}) => {
  const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
  const bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];
  const args = message.arguments && typeof message.arguments === "object" ? message.arguments : {};
  const pageUrl = sender.tab?.url || message.pageUrl || "";
  const result = readSiteStorageFileFromBundle(bundle, pageUrl, args);
  if (!result.ok) {
    return {
      ok: true,
      result: {
        ok: false,
        primitive: "storage.read_file",
        adapter: "extension",
        error: {
          ...result.error,
          recoverable: true,
        },
      },
    };
  }
  return {
    ok: true,
    result: {
      ok: true,
      primitive: "storage.read_file",
      adapter: "extension",
      value: result.value,
    },
  };
};

const logHostedLocalRouting = async ({ call, routingInput, localResult }) => {
  await appendBackgroundDiagnosticEvent({
    type: "routing",
    name: "background.hosted_tool.routing",
    ok: localResult.ok !== false,
    summary:
      localResult.ok !== false
        ? `Hosted tool ${call.name || "unknown"} routed to extension-local runtime.`
        : `Hosted tool ${call.name || "unknown"} failed in extension-local runtime.`,
    input: routingInput,
    output: {
      route: "extension_local",
      ok: localResult.ok !== false,
      primitive: localResult.output?.primitive || localResult.output?.adapter || null,
      error_code: localResult.error?.code || null,
      error_message: localResult.error?.message || null,
    },
  });
};

const executeLocalHostedToolCall = async (tab, call = {}) => {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
  const bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];

  if (call.name === "storage.read_file") {
    const result = readSiteStorageFileFromBundle(bundle, tab.url || "", args);
    if (!result.ok) {
      return {
        ok: false,
        call_id: call.call_id,
        error: result.error,
      };
    }
    return {
      ok: true,
      call_id: call.call_id,
      output: {
        ok: true,
        primitive: "storage.read_file",
        adapter: "extension",
        value: result.value,
      },
      error: null,
    };
  }

  if (call.name !== "actions.site") {
    return executePrimitiveInTab(tab, call);
  }

  const mode = args.mode;
  const targetUrl = args.target_url_contains || tab.url || "";

  if (mode === "list") {
    const storageFiles = listSiteStorageFilesFromBundle(bundle, tab.url || "");
    return {
      ok: true,
      call_id: call.call_id,
      output: {
        ok: true,
        target_url_contains: targetUrl,
        actions: listSiteActionsFromBundle(bundle, tab.url || "", targetUrl),
        state_projections: listStateProjectionsFromBundle(bundle, tab.url || ""),
        files: storageFiles.files,
        skills: storageFiles.skills,
      },
      error: null,
    };
  }

  if (mode === "state_read" || mode === "state_summary" || mode === "state_diff") {
    return executeStateProjectionModesInTab(tab, { bundle, mode, args, call });
  }

  if (mode !== "call") {
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "invalid_input",
        message: "actions.site mode must be list, call, state_read, or state_summary.",
      },
    };
  }

  return executeSiteActionCallInTab(tab, { bundle, args, call });
};

const executeSiteActionCallInTab = async (tab, { bundle, args, call }) => {
  const normalized = normalizeSiteActionCallArgs(args);
  if (!normalized) {
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "invalid_input",
        message:
          "actions.site call mode needs the site action name in the top-level 'action' parameter, " +
          "for example {\"mode\": \"call\", \"action\": \"site.do.thing\", \"arguments\": {}}. " +
          "Get valid action names from actions.site with mode 'list'.",
      },
    };
  }

  const resolved = resolveSiteActionFromBundle(bundle, tab.url || "", {
    action: normalized.action,
    arguments: normalized.actionArguments,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      call_id: call.call_id,
      error: resolved.error,
    };
  }
  if (resolved.static_output !== undefined) {
    return {
      ok: true,
      call_id: call.call_id,
      output: resolved.static_output,
      error: null,
    };
  }
  if (resolved.workflow) {
    const knownPrimitives = await getKnownPrimitiveNames();
    const workflowResult = await executeWorkflowAction({
      actionName: resolved.workflow.action_name,
      workflow: resolved.workflow.definition,
      input: resolved.workflow.input,
      ...(knownPrimitives ? { limits: { knownPrimitives } } : {}),
      executePrimitive: async (primitiveCall) => {
        // A workflow step must reach the same handler a direct bridge call would.
        // The a11y primitives and the trusted-CDP paths live in THIS worker (it
        // owns chrome.debugger); forwarding them to content.js executeAction
        // throws "No handler implemented". Route on the SAME predicate the
        // direct-bridge path uses at bridgeItemNeedsBackground — never a second
        // list, which would drift out of step with it.
        const primitiveItem = {
          type: "action_call",
          name: primitiveCall.name,
          arguments: primitiveCall.arguments,
        };
        const primitiveResult = bridgeItemNeedsBackground(primitiveItem)
          ? await executeBackgroundHostedToolCall(
              { name: primitiveCall.name, call_id: call.call_id, arguments: primitiveCall.arguments },
              tab?.id,
            )
          : await executePrimitiveInTab(tab, {
              ...call,
              name: primitiveCall.name,
              arguments: primitiveCall.arguments,
            });
        if (primitiveResult?.ok === false) {
          return primitiveResult;
        }
        // Unwrap to the TRUE payload, then hand the engine an explicit {ok, output}
        // so normalizeStepResult never has to guess.
        //
        // There are two envelopes, and only content-script results wear the second:
        //   transport (both branches):  { ok, call_id, output, error }
        //   adapter   (in-tab only):    output = { adapter, ok, primitive, value: <payload> }
        // A background primitive's payload sits directly in `output`.
        //
        // Get this wrong in either direction and a gate silently reads undefined:
        //   - unwrap too little -> a content-script gate sees output.value.clickable_center
        //     instead of output.clickable_center (broke `verifyBoardBeforeSearch` in 0.1.192);
        //   - unwrap too much / leave it bare -> normalizeStepResult's `value` heuristic
        //     fires on a11y.query's payload, whose `value` is the node's accessible value
        //     (null for a link), and steps.<id>.output becomes that null (0.1.191 and older).
        let payload = primitiveResult;
        if (payload && typeof payload === "object" && Object.hasOwn(payload, "output")) {
          payload = payload.output;
        }
        if (
          payload &&
          typeof payload === "object" &&
          Object.hasOwn(payload, "value") &&
          Object.hasOwn(payload, "primitive")
        ) {
          // The adapter envelope always names the primitive it ran; a bare payload never does.
          payload = payload.value;
        }
        return { ok: true, output: payload };
      },
    });
    let postconditionResult = null;
    if (workflowResult.ok !== false && resolved.workflow.postcondition) {
      const projectionName = resolved.workflow.postcondition.projection_name;
      const stateResult = await executeStateProjectionInTab(
        tab,
        {
          bundle,
          projectionName,
        },
        call,
      );
      if (stateResult.ok === false || stateResult.output?.ok === false) {
        postconditionResult = {
          ok: false,
          error: stateResult.error || stateResult.output?.error || {
            code: "state_postcondition_projection_failed",
            message: "State postcondition projection failed.",
          },
        };
      } else {
        postconditionResult = await verifyStatePostcondition({
          postcondition: resolved.workflow.postcondition.definition,
          state: stateResult.output.state,
          input: resolved.workflow.input,
        });
      }
    }
    const workflowOk = workflowResult.ok !== false && (postconditionResult?.ok !== false);
    const workflowOutput = postconditionResult
      ? {
          ...(workflowResult.output || {}),
          postcondition: {
            ok: postconditionResult.ok === true,
            projection: resolved.workflow.postcondition.projection_name,
          },
        }
      : workflowResult.output;
    const workflowError = workflowResult.error || postconditionResult?.error || null;
    await appendBackgroundDiagnosticEvent({
      type: "workflow",
      name: resolved.workflow.action_name,
      ok: workflowOk,
      summary:
        workflowOk === false
          ? `Workflow failed: ${workflowError?.message || resolved.workflow.action_name}.`
          : `Workflow completed: ${workflowResult.steps?.length || 0} steps.`,
      input: {
        action: normalized.action,
        arguments: resolved.workflow.input,
      },
      output: workflowOutput || workflowError || null,
      steps: workflowResult.steps || [],
    });
    return {
      ok: workflowOk,
      call_id: call.call_id,
      output: workflowOutput,
      error: workflowError,
    };
  }
  return executePrimitiveInTab(tab, {
    ...call,
    name: resolved.resolved.name,
    arguments: resolved.resolved.arguments,
  });
};

// Background tools that operate on the hosted agent's active tab but don't
// carry a tab id in their args — resolve the default tab for them so the hosted
// agent can call them the same as I can. a11y.* was the dangling connector: the
// primitives were exposed to the hosted path, but only keyboard.press had its
// tab resolved, so a11y.query/tree arrived with no tab and threw "requires an
// authorized browser tab." (The blind agent reached for the eyes I built and
// hit a wire I forgot to connect.)
const HOSTED_DEFAULT_TAB_TOOLS = new Set([
  "a11y.tree",
  "a11y.query",
  "a11y.watch",
]);

const executeHostedToolCallInner = async (call = {}) => {
  // A trusted keyboard.press targets a specific tab; resolve the hosted default
  // tab first so the trusted keypress lands on the active tab (other background
  // actions carry their own tab id in args).
  let backgroundRoutedTabId = null;
  const isTrustedKey = call.name === "keyboard.press" && call.arguments && call.arguments.trusted === true;
  const isTrustedText = call.name === "text.type" && call.arguments && call.arguments.trusted === true;
  const argHasTab = call.arguments && (Number.isInteger(call.arguments.tab_id) || Number.isInteger(call.arguments.tabId));
  if (isTrustedKey || isTrustedText || (HOSTED_DEFAULT_TAB_TOOLS.has(call.name) && !argHasTab)) {
    const { tab } = await getHostedToolDefaultTab();
    backgroundRoutedTabId = tab?.id ?? null;
  }
  const backgroundResult = await executeBackgroundHostedToolCall(call, backgroundRoutedTabId);
  if (backgroundResult) {
    await logHostedLocalRouting({
      call,
      routingInput: {
        tool: call.name || null,
        call_id: call.call_id || null,
        active_tab_id: null,
        active_tab_url: null,
        active_tab_source: "background",
        requested_target_url_contains: null,
      },
      localResult: backgroundResult,
    });
    return backgroundResult;
  }

  const { tab, source: activeTabSource } = await getHostedToolDefaultTab();
  if (!tab?.id) {
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "no_active_tab",
        message: "No active browser tab is available for hosted tool execution.",
      },
    };
  }
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const requestedTargetUrlContains = typeof args.target_url_contains === "string" && args.target_url_contains
    ? args.target_url_contains
    : tab.url || null;
  const routingInput = {
    tool: call.name || null,
    call_id: call.call_id || null,
    active_tab_id: tab.id,
    active_tab_url: tab.url || null,
    active_tab_source: activeTabSource,
    requested_target_url_contains: requestedTargetUrlContains,
  };
  let localException = null;
  try {
    const localResult = await executeLocalHostedToolCall(tab, call);
    if (localResult.ok !== false || localResult.error) {
      await logHostedLocalRouting({ call, routingInput, localResult });
      return localResult;
    }
  } catch (error) {
    // A thrown local exception is a real failure signal, not just "runtime
    // absent". Record it before any fallback so a bridge-side error can never
    // mask the local root cause (incident 2026-06-12: a ReferenceError in the
    // workflow path surfaced to users as an unrelated "Bridge returned 404").
    localException = error?.message || String(error);
    await appendBackgroundDiagnosticEvent({
      type: "routing",
      name: "background.hosted_tool.routing",
      ok: false,
      summary: `Hosted tool ${call.name || "unknown"} threw in extension-local runtime; attempting bridge fallback.`,
      input: routingInput,
      output: {
        route: "extension_local",
        ok: false,
        error_code: "local_execution_exception",
        error_message: localException,
      },
    });
  }
  try {
    const bridgeUrl = await loadBridgeUrl();
    const bridgeTargetUrlContains = requestedTargetUrlContains || tab.url || undefined;
    const response = await fetch(`${bridgeHttpOrigin(bridgeUrl)}/mcp/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: call.name,
        target_url_contains: bridgeTargetUrlContains,
        arguments: hostedToolArguments(call),
      }),
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      await appendBackgroundDiagnosticEvent({
        type: "routing",
        name: "background.hosted_tool.routing",
        ok: false,
        summary: `Hosted tool ${call.name || "unknown"} bridge route failed with ${response.status}.`,
        input: {
          ...routingInput,
          bridge_target_url_contains: bridgeTargetUrlContains || null,
          bridge_origin: bridgeHttpOrigin(bridgeUrl),
        },
        output: {
          route: "bridge",
          ok: false,
          bridge_status: response.status,
          error_code: "bridge_tool_call_failed",
          error_message: `Bridge returned ${response.status}.`,
          bridge_details: publicBridgeResponseDetails(body),
        },
      });
      return {
        ok: false,
        call_id: call.call_id,
        error: {
          code: localException ? "local_execution_exception" : "bridge_tool_call_failed",
          message: localException
            ? `Extension-local execution threw: ${localException} (bridge fallback also failed with ${response.status}).`
            : `Bridge returned ${response.status}.`,
          details: {
            ...publicBridgeResponseDetails(body),
            ...(localException ? { local_exception: localException } : {}),
          },
        },
      };
    }
    if (body?.__invalidJson) {
      await appendBackgroundDiagnosticEvent({
        type: "routing",
        name: "background.hosted_tool.routing",
        ok: false,
        summary: `Hosted tool ${call.name || "unknown"} bridge route returned invalid JSON.`,
        input: {
          ...routingInput,
          bridge_target_url_contains: bridgeTargetUrlContains || null,
          bridge_origin: bridgeHttpOrigin(bridgeUrl),
        },
        output: {
          route: "bridge",
          ok: false,
          bridge_status: response.status,
          error_code: "bridge_tool_call_failed",
          error_message: "Bridge response was not valid JSON.",
          bridge_details: publicBridgeResponseDetails(body),
        },
      });
      return {
        ok: false,
        call_id: call.call_id,
        error: {
          code: "bridge_tool_call_failed",
          message: "Bridge response was not valid JSON.",
          details: publicBridgeResponseDetails(body),
        },
      };
    }
    await appendBackgroundDiagnosticEvent({
      type: "routing",
      name: "background.hosted_tool.routing",
      ok: true,
      summary: `Hosted tool ${call.name || "unknown"} routed through bridge.`,
      input: {
        ...routingInput,
        bridge_target_url_contains: bridgeTargetUrlContains || null,
        bridge_origin: bridgeHttpOrigin(bridgeUrl),
      },
      output: {
        route: "bridge",
        ok: true,
        bridge_status: response.status,
        bridge_call_id: body?.call_id || null,
      },
    });
    return body;
  } catch (error) {
    await appendBackgroundDiagnosticEvent({
      type: "routing",
      name: "background.hosted_tool.routing",
      ok: false,
      summary: `Hosted tool ${call.name || "unknown"} bridge route threw before completion.`,
      input: routingInput,
      output: {
        route: "bridge",
        ok: false,
        error_code: "bridge_tool_call_failed",
        error_message: error.message || String(error),
      },
    });
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "bridge_tool_call_failed",
        message: error.message || String(error),
      },
    };
  }
};

const hasAgentOffscreenDocument = async () => {
  if (!chrome.runtime.getContexts) {
    return false;
  }
  const offscreenUrl = chrome.runtime.getURL(AGENT_OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
};

const ensureAgentOffscreenDocument = async () => {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("Chrome offscreen documents are unavailable in this browser.");
  }
  if (await hasAgentOffscreenDocument()) {
    return;
  }
  if (!creatingAgentOffscreenDocument) {
    creatingAgentOffscreenDocument = chrome.offscreen.createDocument({
      url: AGENT_OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
      justification: "Keep the actions.json GPT Realtime voice session alive across page navigation.",
    });
  }
  try {
    await creatingAgentOffscreenDocument;
  } finally {
    creatingAgentOffscreenDocument = null;
  }
};

const sendAgentOffscreenCommand = async (message) => {
  await ensureAgentOffscreenDocument();
  return chrome.runtime.sendMessage({
    ...(await withHostedSessionTools(message)),
    target: AGENT_OFFSCREEN_TARGET,
  });
};

const loadDefaultHostedRealtimeTools = async () => {
  const manifestUrl = chrome.runtime.getURL(EXTENSION_ACTIONS_URL);
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to load ${EXTENSION_ACTIONS_URL}: ${response.status}`);
  }
  const manifest = await response.json();
  const dictionary = manifest.primitive_dictionary;
  if (!dictionary) {
    throw new Error("Extension actions manifest does not declare a primitive dictionary.");
  }
  let tools = buildRealtimeToolCatalog({ dictionary, host: "extension" });
  const [tab] = chrome.tabs?.query
    ? await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    : [];
  let blockedPrimitives = [];
  if (tab?.url) {
    const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
    blockedPrimitives = siteBlockedPrimitiveNamesFromBundle(
      stored?.[EXTENSION_STORAGE_BUNDLE_KEY],
      tab.url,
    );
    tools = filterRealtimeToolsForBlockedPrimitives(tools, blockedPrimitives);
  }
  return {
    tools,
    activeTabUrl: tab?.url || null,
    blockedPrimitives,
  };
};

const withHostedSessionTools = async (message) => {
  if (
    message?.type !== "actions-json:agent-session-start" &&
    message?.type !== "actions-json:agent-session-tools"
  ) {
    return message;
  }
  const inputToolNames = toolNames(message.tools);
  if (inputToolNames.length > 0) {
    const loaded = await loadDefaultHostedRealtimeTools();
    const tools = mergeToolCatalogs(message.tools, loaded.tools);
    const forwardedToolNames = toolNames(tools);
    await appendAgentMemoryEvent({
      type: "tool",
      name: "background.hosted_session.tools",
      ok: true,
      summary: "Background merged caller-provided hosted Realtime tools with extension defaults.",
      output: {
        message_type: message.type,
        source: "caller_provided_plus_extension_default_catalog",
        input_tool_count: inputToolNames.length,
        input_tool_names: inputToolNames,
        forwarded_tool_count: forwardedToolNames.length,
        forwarded_tool_names: forwardedToolNames,
        has_actions_site: forwardedToolNames.includes("actions.site"),
        has_pointer_click: forwardedToolNames.includes("pointer.click"),
        active_tab_url: loaded.activeTabUrl,
        blocked_primitives: loaded.blockedPrimitives,
      },
    }).catch(() => {});
    return {
      ...message,
      tools,
    };
  }
  const loaded = await loadDefaultHostedRealtimeTools();
  const forwardedToolNames = toolNames(loaded.tools);
  await appendAgentMemoryEvent({
    type: "tool",
    name: "background.hosted_session.tools",
    ok: true,
    summary: "Background backfilled hosted Realtime tools before forwarding to offscreen.",
    output: {
      message_type: message.type,
      source: "extension_default_catalog",
      input_tool_count: inputToolNames.length,
      input_tool_names: inputToolNames,
      forwarded_tool_count: forwardedToolNames.length,
      forwarded_tool_names: forwardedToolNames,
      has_actions_site: forwardedToolNames.includes("actions.site"),
      has_pointer_click: forwardedToolNames.includes("pointer.click"),
      active_tab_url: loaded.activeTabUrl,
      blocked_primitives: loaded.blockedPrimitives,
    },
  }).catch(() => {});
  return {
    ...message,
    tools: loaded.tools,
  };
};

const sendExistingAgentOffscreenCommand = async (message) => {
  if (!(await hasAgentOffscreenDocument())) {
    return null;
  }
  return chrome.runtime.sendMessage({
    ...message,
    target: AGENT_OFFSCREEN_TARGET,
  });
};

const disconnectedAgentSessionState = () => ({
  status: "disconnected",
  model: DEFAULT_MODEL,
  error: null,
  inputMuted: false,
  outputMuted: false,
  textOnly: true,
});

const stoppedAgentSessionState = () => ({
  status: "stopped",
  model: DEFAULT_MODEL,
  error: null,
  inputMuted: false,
  outputMuted: false,
  textOnly: true,
});

const respondWithAgentSessionState = async () => {
  const response = await sendExistingAgentOffscreenCommand({
    type: "actions-json:agent-session-state",
  });
  return response || { ok: true, state: disconnectedAgentSessionState() };
};

const stopExistingAgentSession = async () => {
  const response = await sendExistingAgentOffscreenCommand({
    type: "actions-json:agent-session-stop",
  });
  return response || { ok: true, state: stoppedAgentSessionState() };
};

const sendAgentUserMessage = async (message) => {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    throw new Error("runtime.agent.user_message requires non-empty text");
  }
  const response = await sendExistingAgentOffscreenCommand({
    type: "actions-json:agent-session-user-message",
    text,
  });
  return response || { ok: false, error: "No active hosted Realtime session." };
};

const closeAgentOffscreenSession = async () => {
  if (!(await hasAgentOffscreenDocument())) {
    return {
      ok: true,
      closed: true,
      state: stoppedAgentSessionState(),
    };
  }
  const response = await chrome.runtime.sendMessage({
    type: "actions-json:agent-session-stop",
    target: AGENT_OFFSCREEN_TARGET,
  });
  await chrome.offscreen?.closeDocument?.();
  return {
    ok: response?.ok !== false,
    closed: true,
    state: response?.state || stoppedAgentSessionState(),
    ...(response?.error ? { error: response.error } : {}),
  };
};

const forwardAgentTextResponseToast = async (event = {}) => {
  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (!text) return { ok: true, forwarded: false };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id) return { ok: true, forwarded: false };
  await sendTabMessageBestEffort(tab.id, {
    type: "actions-json:agent-toast",
    text,
    request_id: event.request_id || null,
  }).catch(() => null);
  return { ok: true, forwarded: true, tab_id: tab.id };
};

// Spec 038: the runtime_id of the tab the hosted agent is currently driving,
// so forwarded agent-output events land in the right per-runtime queue on the
// bridge. Resolved from the active claimed tab via the bridgeRuntimeRoutes map
// (runtime_id -> tabId), inverted for the active tab.
const activeHostedRuntimeId = async () => {
  let activeTabId = null;
  for (const [, session] of await sessionStore.getSessionEntries()) {
    activeTabId = session.activeTabId || activeTabId;
  }
  if (activeTabId == null) return null;
  for (const [key, tabId] of bridgeRuntimeRoutes.entries()) {
    if (tabId === activeTabId && key.startsWith("runtime_id:")) {
      return key.slice("runtime_id:".length);
    }
  }
  return null;
};

const handleAgentSessionEventMessage = async (message = {}) => {
  if (message.event?.type === "actions_json.agent_text_response") {
    await forwardAgentTextResponseToast(message.event);
  }
  // Forward agent-OUTPUT events to the bridge for runtime.agent.await_event.
  const mapped = agentEventFromSessionEvent(message.event);
  if (mapped) {
    const runtimeId = await activeHostedRuntimeId();
    if (runtimeId) {
      sendBridgeItem({
        type: "agent_event",
        runtime_id: runtimeId,
        ts: new Date().toISOString(),
        kind: mapped.kind,
        payload: mapped.payload,
      });
    }
  }
  return { ok: true };
};

const proxyAgentStorage = async (message) => {
  if (message.type === "actions-json:agent-storage-get") {
    return {
      ok: true,
      value: await chrome.storage.local.get(message.key),
    };
  }
  if (message.type === "actions-json:agent-storage-set") {
    await chrome.storage.local.set(message.values || {});
    return { ok: true };
  }
  if (message.type === "actions-json:agent-storage-remove") {
    await chrome.storage.local.remove(message.key);
    return { ok: true };
  }
  throw new Error(`Unsupported agent storage message: ${message.type}`);
};

const redactedOpenAiKey = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 16 || !trimmed.startsWith("sk-")) {
    return "configured";
  }
  const prefix = trimmed.startsWith("sk-proj-") ? "sk-proj" : "sk";
  return `${prefix}...${trimmed.slice(-4)}`;
};

const getOpenAiCredentialState = async () => {
  const stored = await chrome.storage.local.get(AGENT_KEY_STORAGE_KEY);
  const key = stored?.[AGENT_KEY_STORAGE_KEY];
  const configured = typeof key === "string" && key.length > 0;
  return {
    configured,
    redacted: configured ? redactedOpenAiKey(key) : null,
  };
};

const respondWithCredentialState = async () => {
  return {
    ok: true,
    credential: await getOpenAiCredentialState(),
  };
};

const respondWithAgentSessionLog = async (message) => {
  const stored = await chrome.storage.local.get(AGENT_MEMORY_STORAGE_KEY);
  const memory = stored?.[AGENT_MEMORY_STORAGE_KEY];
  const events = Array.isArray(memory?.events) ? memory.events : [];
  const boundedLimit = Math.max(1, Math.min(Number(message.limit) || MAX_AGENT_LOG_EVENTS, MAX_AGENT_LOG_EVENTS));
  return {
    ok: true,
    log: {
      ok: true,
      visitorId: typeof memory?.visitorId === "string" ? memory.visitorId : null,
      eventCount: events.length,
      events: events.slice(-boundedLimit),
    },
  };
};

const respondWithAgentMemoryClear = async () => {
  const stored = await chrome.storage.local.get(AGENT_MEMORY_STORAGE_KEY);
  const memory = stored?.[AGENT_MEMORY_STORAGE_KEY];
  const clearedEventCount = Array.isArray(memory?.events) ? memory.events.length : 0;
  await chrome.storage.local.remove(AGENT_MEMORY_STORAGE_KEY);
  return {
    ok: true,
    cleared: true,
    cleared_event_count: clearedEventCount,
  };
};

const saveAgentCredential = async (message) => {
  const key = typeof message.apiKey === "string" ? message.apiKey.trim() : "";
  if (!key) {
    throw new Error("OpenAI API key is required");
  }
  await chrome.storage.local.set({ [AGENT_KEY_STORAGE_KEY]: key });
  return {
    ok: true,
    credential: await getOpenAiCredentialState(),
  };
};

const clearAgentCredential = async () => {
  await chrome.storage.local.remove(AGENT_KEY_STORAGE_KEY);
  return {
    ok: true,
    credential: { configured: false, redacted: null },
  };
};

const handleCredentialHydrationItem = async (item = {}) => {
  const provider = item.provider || "openai";
  if (provider !== "openai") {
    throw new Error(`Unsupported credential provider: ${provider}`);
  }
  const apiKey = typeof item.credential?.api_key === "string"
    ? item.credential.api_key.trim()
    : "";
  if (!apiKey) {
    throw new Error("Credential hydration requires credential.api_key.");
  }
  const result = await saveAgentCredential({ apiKey });
  await appendBackgroundDiagnosticEvent({
    type: "credential",
    name: "background.credential_hydration",
    ok: true,
    summary: "Background accepted bridge-provided OpenAI credential hydration.",
    input: {
      provider,
      source: item.source || null,
      configured: true,
    },
    output: {
      configured: result.credential.configured,
      redacted: result.credential.redacted,
    },
  });
  return {
    type: "credential_hydration_result",
    provider,
    ok: true,
    configured: result.credential.configured,
    redacted: result.credential.redacted,
  };
};

const rejectCredentialHydrationItem = async (item = {}, error) => {
  const provider = item.provider || "openai";
  await appendBackgroundDiagnosticEvent({
    type: "credential",
    name: "background.credential_hydration",
    ok: false,
    summary: "Background rejected bridge-provided credential hydration.",
    input: {
      provider,
      source: item.source || null,
      configured: false,
    },
    output: {
      error_message: error.message || String(error),
    },
  });
  return {
    type: "credential_hydration_result",
    provider,
    ok: false,
    configured: false,
    error: {
      code: "credential_hydration_failed",
      message: error.message || String(error),
    },
  };
};

// Spec 037: expenditure persistence + live cost meter fan-out.
const cloudStore = createCloudStore({
  getConfig: async () => {
    const stored = await chrome.storage.local.get("actionsJsonCloudStorage");
    return stored.actionsJsonCloudStorage || null;
  },
});

const EXPENDITURE_FLUSH_ALARM = "actions-json-expenditure-flush";
const RECONCILE_ALARM = "actions-json-usage-reconcile";
chrome.alarms?.create?.(EXPENDITURE_FLUSH_ALARM, { periodInMinutes: 1 });
chrome.alarms?.create?.(RECONCILE_ALARM, { periodInMinutes: 60 * 6 });
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === EXPENDITURE_FLUSH_ALARM) {
    cloudStore.flush().catch(() => {});
  }
  if (alarm?.name === RECONCILE_ALARM) {
    runDailyReconciliation().catch(() => {});
  }
});

// D-9: once per completed UTC day, compare our estimates to the Costs API
// actual. Inert without the optional usage-read key; one record per day.
async function runDailyReconciliation() {
  const stored = await chrome.storage.local.get([
    "actionsJsonUsageReadKey",
    "actionsJsonDayCostHistory",
    "actionsJsonLastReconciledDate",
  ]);
  const apiKey = stored.actionsJsonUsageReadKey;
  if (!apiKey) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (stored.actionsJsonLastReconciledDate === yesterday) return;
  const history = stored.actionsJsonDayCostHistory || {};
  const estimatedUsd = Number(history[yesterday]) || 0;
  const result = await reconcileDay({ dateStr: yesterday, estimatedUsd, apiKey });
  await cloudStore.appendLine(
    `expenditure/${yesterday}/reconciliation`,
    JSON.stringify({ kind: "reconciliation", ts: new Date().toISOString(), ...result }),
  );
  await chrome.storage.local.set({
    actionsJsonLastReconciledDate: yesterday,
    actionsJsonTrackingError: { date: yesterday, errorPct: result.errorPct },
  });
}

// Records arrive per response; the day-counter update is read-modify-write
// across awaits, so intake is serialized through a promise chain to keep
// bursty tool-call sequences from losing cost.
let expenditureIntakeChain = Promise.resolve();
function handleExpenditureRecord(record) {
  const run = expenditureIntakeChain.then(() => handleExpenditureRecordSerial(record));
  expenditureIntakeChain = run.catch(() => {});
  return run;
}

async function handleExpenditureRecordSerial(record) {
  const day = (record.ts || new Date().toISOString()).slice(0, 10);
  const sessionId = record.session_id || "unknown-session";
  await cloudStore.appendLine(
    `expenditure/${day}/${sessionId}`,
    JSON.stringify(record),
  );
  if (record.kind === "realtime_response_usage" && record.usage_observed) {
    const stored = await chrome.storage.local.get([
      "actionsJsonDayCost",
      "actionsJsonDayCostHistory",
    ]);
    const current = stored.actionsJsonDayCost;
    const usd =
      current?.date === day ? current.usd + record.estimated_cost_usd : record.estimated_cost_usd;
    // History keyed by day feeds the D-9 reconciler; keep the last 14 days.
    const history = stored.actionsJsonDayCostHistory || {};
    history[day] = usd;
    const keep = Object.keys(history).sort().slice(-14);
    const trimmed = Object.fromEntries(keep.map((d) => [d, history[d]]));
    await chrome.storage.local.set({
      actionsJsonDayCost: { date: day, usd },
      actionsJsonDayCostHistory: trimmed,
    });
    return { dayUsd: usd };
  }
  return {};
}

async function fanOutCostMeter(meter) {
  const stored = await chrome.storage.local.get("actionsJsonDayCost");
  const enriched = { ...meter, dayUsd: stored.actionsJsonDayCost?.usd ?? 0 };
  const { tabs } = await listClaimedTabs();
  for (const tab of tabs || []) {
    try {
      await Promise.resolve(
        chrome.tabs.sendMessage(tab.tab_id, {
          type: "actions-json:cost-meter-update",
          meter: enriched,
        }),
      ).catch(() => {});
    } catch {
      // A tab without a content script must not break the fan-out.
    }
  }
}

// U4: per-tab ring log of live-region TreeChange records from the observer
// script. The U5 announcer registers itself as the sink to drive the fork's
// LiveRegions; until then (and always, for diagnostics) records land here.
const A11Y_EVENT_LOG_LIMIT = 200;
const a11yEventLogs = new Map(); // tabId -> [{records, frame_url, frame_id, ts}]
let a11yTreeChangeSink = null; // set by the announcer wiring below
const setA11yTreeChangeSink = (fn) => { a11yTreeChangeSink = fn; };
const readA11yEventLog = (tabId) => a11yEventLogs.get(tabId) || [];

// U5: announcer wiring — ChromeVox LiveRegions/Output (dist/a11y-bundle.js)
// driven by observer records, utterances captured as announcement records.
// Lazy: the bundle loads on the first tree-change batch. Announcements land in
// a per-tab ring here; U6 adds bridge transport + subscription policy.
const A11Y_ANNOUNCEMENT_LIMIT = 100;
const a11yAnnouncements = new Map(); // tabId -> [record]
const readA11yAnnouncements = (tabId) => a11yAnnouncements.get(tabId) || [];
// Self-test hook (Task #71): lets the Playwright live-smoke harness drive the
// a11y path from the service worker without the bridge or a human round-trip.
// Inert in normal operation; only a test explicitly reads self.__a11yTest.
self.__a11yRoutingProbe = async () => {
  // The 0.1.170 fix: hosted a11y.* with no tab id must resolve the default tab.
  const inSet = HOSTED_DEFAULT_TAB_TOOLS.has("a11y.watch") && HOSTED_DEFAULT_TAB_TOOLS.has("a11y.query") && HOSTED_DEFAULT_TAB_TOOLS.has("a11y.tree");
  let resolvedTab = null, err = null;
  try {
    const r = await executeHostedToolCall({ name: "a11y.watch", call_id: "probe", arguments: { enable_screen_reader: false } });
    resolvedTab = r && r.ok && r.output ? r.output.tab_id : (r && r.error ? "err:" + r.error.code : null);
  } catch (e) { err = String(e && e.message || e); }
  return { a11y_in_default_tab_set: inSet, tabless_watch_result: resolvedTab, err };
};
self.__a11yTest = {
  watch: (tabId) => runA11yWatch(tabId, { enableScreenReader: false }),
  read: (tabId) => ({ announcements: readA11yAnnouncements(tabId) }),
  eventLog: (tabId) => (a11yEventLogs.get(tabId) || []),
  // Feed a synthetic observer batch straight to the announcer, isolating the
  // announcer pipeline (getTree → resolveNode_ → fork → sink → store) from tab
  // injection. Requires a real tabId with a live region in its AX tree.
  feedBatch: async (tabId, records) => {
    const ann = await getA11yAnnouncer();
    setA11yTreeChangeSink((t, e) => ann.handleBatch(t, e));
    await ann.handleBatch(tabId, { records });
    await new Promise((r) => setTimeout(r, 50));
    return { diag: ann.diagnostics?.() ?? null, store: readA11yAnnouncements(tabId).length };
  },
};
// Inert in normal operation; only a test reads self.__inputTest. Drives the
// trusted-text path (dispatchTrustedText) so the Playwright harness can prove
// trusted text.type emits real per-char key events that a contenteditable
// honors (guards the 0.1.172 insertText→keyDown regression).
self.__inputTest = {
  trustedText: (tabId, text, selectBackChars) => dispatchTrustedText(tabId, text, selectBackChars),
  trustedKey: (tabId, key, modifiers, repeat) => dispatchTrustedKey(tabId, key, modifiers || [], repeat),
  // Drives the accessibility-gated key-repeat (dispatchGatedRepeat) so the live
  // harness can prove the gate advances/halts against a coalescing fixture.
  gatedRepeat: (tabId, args) => dispatchGatedRepeat(tabId, args),
};
// Inert in normal operation; only the eval harness reads self.__claimTest. Runs
// the REAL popup claim path (claimAuthorizedTab → connectClaimedTab) headlessly
// for a given tabId, so the harness can make the extension take control of a
// tab with NO human popup click (plan 2026-07-07-005 U7 — closes the
// self-install/iterate loop). Surfaces the full result/error rather than a bare
// message ack, so a failed bridge connect is VISIBLE, not a silent count:0.
self.__claimTest = {
  claim: async (tabId, bridgeUrl) => {
    try {
      const url = bridgeUrl || (await loadBridgeUrl().catch(() => DEFAULT_BRIDGE_URL));
      await chrome.storage.local.set({ bridgeUrl: url });
      const result = await claimAuthorizedTab({ tabId: Number(tabId), bridgeUrl: url });
      return { ok: true, bridgeUrl: url, result };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), stack: String(error?.stack || "") };
    }
  },
  // Report the live bridge/claim state so the harness can verify registration.
  state: async () => {
    const stored = await chrome.storage.local.get("bridgeUrl");
    const bs = typeof bridgeState !== "undefined" ? bridgeState : null;
    return {
      bridgeUrl: stored.bridgeUrl ?? null,
      hasBridgeState: Boolean(bs),
      shouldReconnect: bs?.shouldReconnect ?? null,
      wsReadyState: bs?.ws?.readyState ?? null,
      bridgeSessionId: bs?.bridgeSessionId ?? null,
    };
  },
};
// Inert in normal operation; only the eval harness reads self.__agentTest. Lets the
// self-contained Playwright eval (tests/live/eval/) drive a REAL hosted GPT-Realtime
// session from the service worker with no bridge MCP client — it calls the same
// executeHostedToolCall dispatcher the bridge uses for runtime.agent.* tools, so
// runtime.agent.start / user_message / await_event / stop all route identically.
self.__agentTest = {
  call: async (name, args = {}) => {
    try {
      const result = await executeHostedToolCall({ name, call_id: `evaltest-${Date.now()}`, arguments: args || {} });
      return result;
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  },
};
// Inert in normal operation; only a test reads self.__sessionStoreTest. Proves
// the 504 fix live (investigations/bridge-504-timeouts.md): when
// chrome.storage.local.get hangs (the MV3 SW-churn wedge), a session-store read
// must DEGRADE (resolve to the in-memory default) instead of hanging forever and
// 504-ing every claimed_tabs.* call. Drives the REAL SessionStore + listClaimedTabs
// in the live service worker with storage.local wedged/unwedged.
self.__sessionStoreTest = {
  // Replace chrome.storage.local.get with a hang; returns a restore fn.
  wedgeStorageGet: () => {
    const orig = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = () => new Promise(() => {});
    return () => { chrome.storage.local.get = orig; };
  },
  // A fresh store whose FIRST load hits the wedge — the exact live condition.
  freshStoreEntries: async () => {
    const store = new SessionStore();
    return store.getSessionEntries();
  },
  // The real handler the bridge calls for browser.claimed_tabs.list.
  listClaimedTabs: () => listClaimedTabs(),
};
// Hosted-agent inject queue (KTD5) — drained onto hosted tool results.
const hostedA11yInjectQueue = [];
const A11Y_PIGGYBACK_MAX_RECORDS = 5;
const A11Y_PIGGYBACK_MAX_CHARS = 1200;
const drainHostedA11yAnnouncements = () => {
  if (!hostedA11yInjectQueue.length) return null;
  const out = [];
  let chars = 0;
  while (hostedA11yInjectQueue.length && out.length < A11Y_PIGGYBACK_MAX_RECORDS) {
    const next = hostedA11yInjectQueue[0];
    const len = (next.text || "").length;
    if (out.length > 0 && chars + len > A11Y_PIGGYBACK_MAX_CHARS) break;
    out.push(hostedA11yInjectQueue.shift());
    chars += len;
  }
  return out.length ? out : null;
};

// KTD5: hosted tool calls execute extension-locally (bridge only as fallback),
// so inject-mode announcements piggyback HERE, where hosted results assemble —
// the bridge drains its own queue for MCP tool calls. act -> hear.
const executeHostedToolCall = async (call = {}) => {
  const result = await executeHostedToolCallInner(call);
  const announcements = drainHostedA11yAnnouncements();
  if (announcements && result && typeof result === "object") {
    result.announcements = announcements;
  }
  return result;
};
let a11yAnnouncerPromise = null;
const getA11yAnnouncer = () => {
  if (!a11yAnnouncerPromise) {
    a11yAnnouncerPromise = (async () => {
      const announcer = new Announcer({
        // Per-batch tree snapshot: attach → refresh → detach. The snapshot's
        // maps outlive the session; CDP-dependent resolution inside the
        // announcer degrades gracefully to text-match (its documented order).
        getTree: async (tabId) => {
          if (!Number.isInteger(tabId)) return null;
          try {
            // Persistent session — NOT runA11yTreeOp: the announcer keeps this
            // tree and calls its CDP closure later (resolveNode_), so the
            // debugger must stay attached, not detach in a `finally`.
            return await a11yTreeFromSession(tabId);
          } catch (e) {
            console.warn("[a11y] announcer tree snapshot failed", e?.message);
            return null;
          }
        },
        onAnnouncement: (record) => {
          const tabId = record.tab;
          const list = a11yAnnouncements.get(tabId) || [];
          list.push(record);
          if (list.length > A11Y_ANNOUNCEMENT_LIMIT) list.splice(0, list.length - A11Y_ANNOUNCEMENT_LIMIT);
          a11yAnnouncements.set(tabId, list);
          // Forward to the bridge (subscription policy + MCP piggyback live
          // there — U6). runtime_key is the stable per-tab route key.
          try {
            sendBridgeItem({
              type: "a11y_announcement",
              runtime_key: Number.isInteger(tabId) ? runtimeKeyForTab(tabId) : null,
              record,
              ts: new Date().toISOString(),
            });
          } catch (_e) { /* bridge socket down — ring log still has it */ }
          // Hosted-agent inject drain (KTD5): hosted tool calls execute
          // extension-locally and never traverse the bridge, so assertive
          // announcements queue HERE and piggyback on hosted results. Mirrors
          // the bridge's default policy (assertive→inject) as a constant.
          if (record.politeness === "assertive") {
            hostedA11yInjectQueue.push(record);
            if (hostedA11yInjectQueue.length > A11Y_ANNOUNCEMENT_LIMIT) hostedA11yInjectQueue.shift();
          }
        },
      }).start();
      setA11yTreeChangeSink((tabId, entry) => announcer.handleBatch(tabId, entry));
      return announcer;
    })();
  }
  return a11yAnnouncerPromise;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "actions-json:a11y-tree-changes") {
    const tabId = sender?.tab?.id;
    if (Number.isInteger(tabId)) {
      const entry = {
        records: message.records || [],
        frame_url: message.frame_url || null,
        frame_id: sender.frameId ?? null,
        is_top_frame: Boolean(message.is_top_frame),
        ts: Date.now(),
      };
      const log = a11yEventLogs.get(tabId) || [];
      log.push(entry);
      if (log.length > A11Y_EVENT_LOG_LIMIT) log.splice(0, log.length - A11Y_EVENT_LOG_LIMIT);
      a11yEventLogs.set(tabId, log);
      // AWAIT the announcer before dispatching — it's lazy/async, and the sink
      // is null until it resolves. The old fire-and-forget getA11yAnnouncer()
      // + `if (a11yTreeChangeSink)` dropped every batch that arrived before the
      // first init completed (which, for a freshly-watched tab, is ALL of the
      // early ones). This was THE announcement-pipeline drop.
      getA11yAnnouncer()
        .then(() => {
          if (a11yTreeChangeSink) a11yTreeChangeSink(tabId, entry);
        })
        .catch((e) => console.warn("[a11y] announcer dispatch failed", e?.message));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "actions-json:marker-trusted-key") {
    // Marker-runner relay: a recipe step keyboard.press{trusted:true} runs in the
    // content script, which cannot attach the debugger itself. Dispatch the real
    // CDP key on the sender's own tab only — no cross-tab reach.
    // __testTabId is honored ONLY when there is no real sender tab (the live
    // caret-walk harness drives this seam from the service worker); production
    // messages always carry sender.tab and never hit this branch.
    const tabId = sender?.tab?.id ?? (Number.isInteger(message.__testTabId) ? message.__testTabId : undefined);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Trusted key dispatch requires a sender tab." });
      return false;
    }
    dispatchTrustedKey(tabId, message.key, message.modifiers || [], message.repeat)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:marker-trusted-text") {
    // Same relay for text.type{trusted:true} — real per-char CDP key events on the sender tab.
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "Trusted text dispatch requires a sender tab." });
      return false;
    }
    dispatchTrustedText(tabId, message.text, message.select_back_chars)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:expenditure-record") {
    handleExpenditureRecord(message.record || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:cost-meter-update") {
    fanOutCostMeter(message.meter || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-event") {
    handleAgentSessionEventMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:authorize-tab") {
    claimAuthorizedTab(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:claimed-tabs-list") {
    listClaimedTabs()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:claimed-tabs-activate") {
    activateClaimedTab(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:capture-visible-tab") {
    return captureVisibleTab(message, sender, sendResponse);
  }

  if (message?.type === "actions-json:transfer-buffer") {
    handleTransferBufferMessage(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:storage-read-file") {
    handleStorageReadFileMessage(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:debug-evaluate") {
    evaluateWithDebugger(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:bridge-connect") {
    // connectBackgroundBridge reuses a healthy shared socket internally (idempotent)
    // and only rebuilds when there is no open socket — so a per-tab connect no longer
    // churns the transport other tabs depend on.
    connectBackgroundBridge({
      bridgeUrl: message.bridgeUrl || DEFAULT_BRIDGE_URL,
      tabId: sender?.tab?.id,
      readyItem: message.readyItem,
      relayedReadyItems: Array.isArray(message.relayedReadyItems) ? message.relayedReadyItems : [],
    })
      .then((result) => sendResponse({ ok: true, transport_owner: "extension_background", reused_socket: Boolean(result?.reused_socket) }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:bridge-state-projection-call") {
    const tab = sender?.tab;
    if (!tab?.id) {
      sendResponse({
        ok: false,
        error: {
          code: "claim_missing",
          message: "Bridge state projection call requires a content-script sender tab.",
          recoverable: true,
          next_step: ROUTE_ERROR_NEXT_STEP.claim_missing,
        },
      });
      return true;
    }
    executeBridgeStateProjectionItem(message.item || {}, tab)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: "state_projection_failed",
          message: error.message || String(error),
          recoverable: true,
        },
      }));
    return true;
  }

  if (message?.type === "actions-json:bridge-site-action-call") {
    const tab = sender?.tab;
    if (!tab?.id) {
      sendResponse({
        ok: false,
        error: {
          code: "claim_missing",
          message: "Bridge site action call requires a content-script sender tab.",
          recoverable: true,
          next_step: ROUTE_ERROR_NEXT_STEP.claim_missing,
        },
      });
      return true;
    }
    executeBridgeSiteActionItem(message.item || {}, tab)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: {
          code: "site_action_failed",
          message: error.message || String(error),
          recoverable: true,
        },
      }));
    return true;
  }

  if (message?.type === "actions-json:bridge-protocol") {
    const sent = sendBridgeOutputItem(message.item);
    if (!sent) {
      appendBackgroundDiagnosticEvent({
        type: "transport",
        name: "background.bridge.websocket",
        ok: false,
        summary: "Content runtime emitted a bridge protocol item while the background WebSocket was disconnected.",
        input: {
          message_type: message.item?.type || null,
          runtime_id: message.item?.runtime_id || null,
          call_id: message.item?.call_id || null,
        },
        output: {
          connected: false,
        },
      });
    }
    sendResponse({ ok: sent, connected: sent });
    return true;
  }

  if (message?.type === "actions-json:agent-credential-state") {
    respondWithCredentialState()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-save-credential") {
    saveAgentCredential(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-clear-credential") {
    clearAgentCredential()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-log") {
    respondWithAgentSessionLog(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-memory-clear") {
    respondWithAgentMemoryClear()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (
    message?.type === "actions-json:agent-session-start" ||
    message?.type === "actions-json:agent-session-tools"
  ) {
    sendAgentOffscreenCommand(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-state") {
    respondWithAgentSessionState()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-stop") {
    stopExistingAgentSession()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-mute") {
    sendExistingAgentOffscreenCommand(message)
      .then((result) => sendResponse(result || { ok: false, error: "No active hosted voice session." }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-output-mute") {
    sendExistingAgentOffscreenCommand(message)
      .then((result) => sendResponse(result || { ok: false, error: "No active hosted voice session." }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-user-message") {
    sendAgentUserMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:agent-session-close") {
    closeAgentOffscreenSession()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (
    message?.target === "background" &&
    (
      message?.type === "actions-json:agent-storage-get" ||
      message?.type === "actions-json:agent-storage-set" ||
      message?.type === "actions-json:agent-storage-remove"
    )
  ) {
    proxyAgentStorage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.target === "background" && message?.type === "actions-json:agent-tool-execute") {
    executeHostedToolCall(message.call)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});
