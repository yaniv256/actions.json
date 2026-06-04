const SESSION_STATE_KEY = "ACTIONS_JSON_OVERLAY_SESSION_STATE";
const DEFAULT_SESSION_ID = "actions-json-default";
const DEFAULT_SESSION_GROUP_TITLE = "actions.json";
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("bridgeUrl");
  if (!existing.bridgeUrl) {
    await chrome.storage.local.set({ bridgeUrl: DEFAULT_BRIDGE_URL });
  }
});

// Adapted from Open Browser Use's background-owned session/tab group model.
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
    claim.url = tab?.url || claim.url || null;
    session.activeTabId = tabId;
    await sessionStore.save();
    await connectClaimedTab(tabId, claim);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "actions-json:authorize-tab") {
    claimAuthorizedTab(message)
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

  return false;
});
