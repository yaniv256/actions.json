import {
  listSiteActionsFromBundle,
  resolveSiteActionFromBundle,
  siteBlockedPrimitiveNamesFromBundle,
} from "./agent/local-actions-catalog.mjs";
import {
  buildRealtimeToolCatalog,
  filterRealtimeToolsForBlockedPrimitives,
} from "./agent/realtime-tool-catalog.mjs";

const SESSION_STATE_KEY = "ACTIONS_JSON_OVERLAY_SESSION_STATE";
const AGENT_KEY_STORAGE_KEY = "ACTIONS_JSON_OPENAI_API_KEY";
const AGENT_MEMORY_STORAGE_KEY = "ACTIONS_JSON_AGENT_MEMORY_V1";
const EXTENSION_STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";
const MAX_AGENT_LOG_EVENTS = 80;
const DEFAULT_SESSION_ID = "actions-json-default";
const DEFAULT_SESSION_GROUP_TITLE = "actions.json";
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";
const AGENT_OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const AGENT_OFFSCREEN_TARGET = "actions-json-agent-offscreen";
const EXTENSION_ACTIONS_URL = "actions/overlay.actions.json";
const BACKGROUND_BRIDGE_CONNECT_TIMEOUT_MS = 8000;
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

const closeBridgeSocket = () => {
  clearTimeout(bridgeReconnectTimer);
  bridgeReconnectTimer = null;
  const previous = bridgeSocket;
  bridgeSocket = null;
  if (previous && previous.readyState !== WebSocket.CLOSED) {
    previous.close();
  }
};

const scheduleBridgeReconnect = () => {
  if (!bridgeState?.shouldReconnect || !bridgeState.bridgeUrl) return;
  clearTimeout(bridgeReconnectTimer);
  const delay = Math.min(5000, 500 * 2 ** Math.min(bridgeReconnectAttempts, 4));
  bridgeReconnectAttempts += 1;
  bridgeReconnectTimer = setTimeout(() => connectBackgroundBridge(bridgeState).catch(() => {
    scheduleBridgeReconnect();
  }), delay);
};

const connectBackgroundBridge = async (state) => {
  if (!state?.bridgeUrl || !state?.tabId) {
    throw new Error("actions-json:bridge-connect requires bridgeUrl and sender tab.");
  }
  bridgeState = {
    ...state,
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
        shouldReconnect: false,
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
    ws.addEventListener("open", () => {
      if (bridgeSocket !== ws || settled) return;
      opened = true;
      settled = true;
      clearTimeout(connectTimeout);
      bridgeState = {
        ...bridgeState,
        shouldReconnect: true,
      };
      bridgeReconnectAttempts = 0;
      sendBridgeItem(bridgeState.readyItem);
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
      chrome.tabs.sendMessage(bridgeState.tabId, {
        type: "actions-json:bridge-message",
        item,
      }).catch((error) => {
        appendBackgroundDiagnosticEvent({
          type: "transport",
          name: "background.bridge.websocket",
          ok: false,
          summary: "Background bridge failed to forward a message to the content runtime.",
          input: {
            tab_id: bridgeState.tabId,
            message_type: item?.type || null,
            call_id: item?.call_id || null,
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
  try {
    return await response.json();
  } catch (_error) {
    const text = typeof response.text === "function" ? await response.text() : "";
    return text ? { error: text } : {};
  }
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
  if (call.name !== "actions.site") {
    return executePrimitiveInTab(tab, call);
  }

  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const mode = args.mode;
  const targetUrl = args.target_url_contains || tab.url || "";
  const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
  const bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];

  if (mode === "list") {
    return {
      ok: true,
      call_id: call.call_id,
      output: {
        ok: true,
        target_url_contains: targetUrl,
        actions: listSiteActionsFromBundle(bundle, tab.url || "", targetUrl),
      },
      error: null,
    };
  }

  if (mode !== "call") {
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "invalid_input",
        message: "actions.site mode must be list or call.",
      },
    };
  }

  const action = args.action || args.action_name;
  if (typeof action !== "string" || !action) {
    return {
      ok: false,
      call_id: call.call_id,
      error: {
        code: "invalid_input",
        message: "actions.site call mode requires arguments.action.",
      },
    };
  }

  const resolved = resolveSiteActionFromBundle(bundle, tab.url || "", {
    action,
    arguments: args.arguments || {},
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
  return executePrimitiveInTab(tab, {
    ...call,
    name: resolved.resolved.name,
    arguments: resolved.resolved.arguments,
  });
};

const executeHostedToolCall = async (call = {}) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
    requested_target_url_contains: requestedTargetUrlContains,
  };
  try {
    const localResult = await executeLocalHostedToolCall(tab, call);
    if (localResult.ok !== false || localResult.error) {
      await logHostedLocalRouting({ call, routingInput, localResult });
      return localResult;
    }
  } catch (_error) {
    // Fall back to the development bridge when the local content runtime is absent.
  }
  try {
    const bridgeUrl = await loadBridgeUrl();
    const bridgeTargetUrlContains = tab.url || undefined;
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
          bridge_details: body,
        },
      });
      return {
        ok: false,
        call_id: call.call_id,
        error: {
          code: "bridge_tool_call_failed",
          message: `Bridge returned ${response.status}.`,
          details: body,
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
});

const stoppedAgentSessionState = () => ({
  status: "stopped",
  model: "gpt-realtime-2",
  error: null,
  inputMuted: false,
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
