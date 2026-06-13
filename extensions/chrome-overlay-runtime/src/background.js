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
  TransferBuffer,
  TransferBufferError,
} from "./agent/transfer-buffer.mjs";
import {
  executeWorkflowAction,
} from "./agent/workflow-actions.mjs";
import {
  normalizeSiteActionCallArgs,
} from "./agent/site-action-args.mjs";

const SESSION_STATE_KEY = "ACTIONS_JSON_OVERLAY_SESSION_STATE";
const AGENT_KEY_STORAGE_KEY = "ACTIONS_JSON_OPENAI_API_KEY";
const AGENT_MEMORY_STORAGE_KEY = "ACTIONS_JSON_AGENT_MEMORY_V1";
const EXTENSION_STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";
const MAX_AGENT_LOG_EVENTS = 80;
const DEFAULT_SESSION_ID = "actions-json-default";
const DEFAULT_SESSION_GROUP_TITLE = "actions.json";
const DEFAULT_BRIDGE_URL = "ws://100.99.150.49:17345/extension";
const AGENT_OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const AGENT_OFFSCREEN_TARGET = "actions-json-agent-offscreen";
const EXTENSION_ACTIONS_URL = "actions/overlay.actions.json";
const BACKGROUND_BRIDGE_CONNECT_TIMEOUT_MS = 8000;

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
const transferBuffer = new TransferBuffer();
const stateProjectionSnapshots = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("bridgeUrl");
  if (!existing.bridgeUrl) {
    await chrome.storage.local.set({ bridgeUrl: DEFAULT_BRIDGE_URL });
  }
});

class SessionStore {
  constructor() {
    this.state = { sessions: {} };
    this.ready = this.load();
  }

  async load() {
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
      };
    }
  }

  async save() {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: this.state });
  }

  async getSession(sessionId = DEFAULT_SESSION_ID) {
    await this.ready;
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
    await this.ready;
    return Object.entries(this.state.sessions);
  }
}

const sessionStore = new SessionStore();

const hasTabId = (tab) => tab && typeof tab.id === "number";

const runtimeKeyForTab = (tabId) => `chrome-tab:${tabId}`;

const newAuthorizationId = () => `authorization-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const sendBridgeItem = (item) => {
  if (bridgeSocket?.readyState === WebSocket.OPEN) {
    bridgeSocket.send(JSON.stringify(item));
    return true;
  }
  return false;
};

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
  await sendTabMessageBestEffort(tabId, {
    type: "actions-json:bridge-message",
    item,
  });
};

const decorateReadyItemForReplay = ({ readyItem, tab, claim, bridgeSessionId, reason, attempt, claimedAtMs }) => ({
  ...readyItem,
  runtime_key: readyItem.runtime_key || claim.runtimeKey || runtimeKeyForTab(tab.id),
  authorization_id: readyItem.authorization_id || claim.authorizationId || null,
  extension_version: readyItem.extension_version || chrome.runtime.getManifest().version,
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
    claimed_at_ms: claim.claimedAtMs || null,
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
        const decorated = decorateReadyItemForReplay({
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
      }
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
      if (item?.type === "credential_hydration") {
        handleCredentialHydrationItem(item)
          .catch((error) => rejectCredentialHydrationItem(item, error))
          .then((result) => sendBridgeItem(result));
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
          sendBridgeItem({
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
          sendBridgeItem({
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

const injectContent = async (tabId) => {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content.js"],
  });
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

const serializeClaimedTab = (session, tab, claim) => ({
  tab_id: tab.id,
  runtime_key: claim.runtimeKey || runtimeKeyForTab(tab.id),
  authorization_id: claim.authorizationId || null,
  bridge_url: claim.bridgeUrl || DEFAULT_BRIDGE_URL,
  url: tab.url || claim.url || null,
  title: tab.title || null,
  active: Boolean(session.activeTabId === tab.id || tab.active),
  window_id: typeof tab.windowId === "number" ? tab.windowId : null,
});

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
      reconnect_delay_ms: reconnectDelayMs,
      tab: serializeClaimedTab(session, { ...tab, active: true }, claim),
    };
  }

  throw new Error(`Chrome tab ${tabId} is not claimed by actions.json.`);
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
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
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
    if (attached) {
      try {
        await debuggerDetach(target);
      } catch (_error) {
        // The page may detach itself during navigation; evaluation already has its result.
      }
    }
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
  const stored = await chrome.storage.local.get(AGENT_MEMORY_STORAGE_KEY);
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
  await chrome.storage.local.set({
    [AGENT_MEMORY_STORAGE_KEY]: {
      visitorId: typeof memory.visitorId === "string" ? memory.visitorId : null,
      events: events.slice(-MAX_AGENT_LOG_EVENTS),
    },
  });
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
    sendBridgeItem({
      type: "action_error",
      call_id: callId,
      runtime_id: runtimeId,
      error: { code, message, recoverable: true, ...extra },
    });
  };
  const tabId = resolveBridgeItemTabId(item);
  if (!Number.isInteger(tabId)) {
    fail("no_claimed_tab", "Bridge state projection call could not be routed to a claimed tab.");
    return;
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    fail("no_claimed_tab", "Bridge state projection call routed to a tab that no longer exists.", { tab_id: tabId });
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
    fail("no_claimed_tab", "Bridge site action call could not be routed to a claimed tab.");
    return;
  }
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    fail("no_claimed_tab", "Bridge site action call routed to a tab that no longer exists.", { tab_id: tabId });
    return;
  }
  const result = await executeBridgeSiteActionItem(item, tab);
  if (result.ok === false || result.output?.ok === false) {
    sendBridgeItem({
      type: "action_error",
      call_id: callId,
      runtime_id: runtimeId,
      error: result.error || result.output?.error || {
        code: "site_action_failed",
        message: "Site action execution failed in the extension runtime.",
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

const executeBackgroundHostedToolCall = async (call = {}) => {
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
        const primitiveResult = await executePrimitiveInTab(tab, {
          ...call,
          name: primitiveCall.name,
          arguments: primitiveCall.arguments,
        });
        if (primitiveResult?.ok === false) {
          return primitiveResult;
        }
        return primitiveResult?.output || primitiveResult;
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

const executeHostedToolCall = async (call = {}) => {
  const backgroundResult = await executeBackgroundHostedToolCall(call);
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
  model: "gpt-realtime-2",
  error: null,
  inputMuted: false,
  outputMuted: false,
  textOnly: true,
});

const stoppedAgentSessionState = () => ({
  status: "stopped",
  model: "gpt-realtime-2",
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

const handleAgentSessionEventMessage = async (message = {}) => {
  if (message.event?.type === "actions_json.agent_text_response") {
    await forwardAgentTextResponseToast(message.event);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    connectBackgroundBridge({
      bridgeUrl: message.bridgeUrl || DEFAULT_BRIDGE_URL,
      tabId: sender?.tab?.id,
      readyItem: message.readyItem,
      relayedReadyItems: Array.isArray(message.relayedReadyItems) ? message.relayedReadyItems : [],
    })
      .then(() => sendResponse({ ok: true, transport_owner: "extension_background" }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "actions-json:bridge-state-projection-call") {
    const tab = sender?.tab;
    if (!tab?.id) {
      sendResponse({
        ok: false,
        error: {
          code: "no_claimed_tab",
          message: "Bridge state projection call requires a content-script sender tab.",
          recoverable: true,
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
          code: "no_claimed_tab",
          message: "Bridge site action call requires a content-script sender tab.",
          recoverable: true,
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
    const sent = sendBridgeItem(message.item);
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
