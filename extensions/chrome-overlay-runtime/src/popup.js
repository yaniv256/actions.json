import { DEFAULT_MODEL } from "./agent/realtime-model.mjs";

const statusEl = document.getElementById("status");
const voiceStateEl = document.getElementById("voiceState");
const startVoiceEl = document.getElementById("startVoice");
const muteVoiceEl = document.getElementById("muteVoice");
const stopVoiceEl = document.getElementById("stopVoice");
const tabNoticeEl = document.getElementById("tabNotice");
const authorizeEl = document.getElementById("authorize");
const openMenuEl = document.getElementById("openMenu");

function isControllableUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// "Take control of this tab" on chrome://extensions (right after loading the
// extension) is the most common first-run mistake. Detect it when the popup
// opens, explain it, and disable the controls instead of surfacing a raw
// authorization error.
async function renderActiveTabNotice() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !isControllableUrl(tab.url)) {
      tabNoticeEl.textContent =
        "This is a Chrome internal page, so it cannot be controlled. " +
        "Switch to the website tab you want to operate (for example your Trello board), " +
        "then click the extension icon again.";
      tabNoticeEl.hidden = false;
      authorizeEl.disabled = true;
      openMenuEl.disabled = true;
      return;
    }
  } catch (_error) {
    // If the tab cannot be read, leave the controls enabled; the click path
    // still reports errors through the status line.
  }
  tabNoticeEl.hidden = true;
  authorizeEl.disabled = false;
  openMenuEl.disabled = false;
}

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";

let currentVoiceState = {
  status: "disconnected",
  model: DEFAULT_MODEL,
  error: null,
  inputMuted: false,
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b64040" : "#24744a";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

function renderVoiceState(state = currentVoiceState) {
  currentVoiceState = { ...currentVoiceState, ...(state || {}) };
  const status = currentVoiceState.status || "disconnected";
  const muted = Boolean(currentVoiceState.inputMuted);
  const label = status === "connected"
    ? `Live${muted ? " (muted)" : ""}`
    : status.charAt(0).toUpperCase() + status.slice(1);
  voiceStateEl.textContent = `Session: ${label}`;
  startVoiceEl.disabled = status === "connected" || status === "connecting";
  muteVoiceEl.disabled = status !== "connected";
  muteVoiceEl.textContent = muted ? "Unmute" : "Mute";
  stopVoiceEl.disabled = false;
}

async function storedBridgeUrl() {
  const stored = await chrome.storage.local.get("bridgeUrl");
  return stored.bridgeUrl || DEFAULT_BRIDGE_URL;
}

async function authorizeCurrentTab() {
  const tab = await getActiveTab();
  if (!isControllableUrl(tab.url)) {
    throw new Error(
      "This is a Chrome internal page. Switch to the website tab you want to control, then try again.",
    );
  }
  const bridgeUrl = await storedBridgeUrl();
  await chrome.storage.local.set({ bridgeUrl });
  const response = await chrome.runtime.sendMessage({
    type: "actions-json:authorize-tab",
    tabId: tab.id,
    bridgeUrl,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Authorization failed");
  }
  return { tab, bridgeUrl, response };
}

async function refreshVoiceState() {
  const response = await chrome.runtime.sendMessage({ type: "actions-json:agent-session-state" });
  if (!response?.ok) {
    throw new Error(response?.error || "Session state unavailable");
  }
  renderVoiceState(response.state);
  return response.state;
}

async function requestVisibleMicrophoneGrant() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

document.getElementById("authorize").addEventListener("click", async () => {
  try {
    await authorizeCurrentTab();
    setStatus("Tab is under actions.json control.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.getElementById("openMenu").addEventListener("click", async () => {
  try {
    const { tab } = await authorizeCurrentTab();
    await chrome.tabs.sendMessage(tab.id, { type: "actions-json:open-menu-overlay" });
    setStatus("Agent overlay opened.");
    window.close();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

startVoiceEl.addEventListener("click", async () => {
  try {
    startVoiceEl.disabled = true;
    await requestVisibleMicrophoneGrant();
    const response = await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-start",
      textOnly: false,
      tools: [],
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Session start failed");
    }
    renderVoiceState(response.state);
    setStatus("Session started.");
  } catch (error) {
    setStatus(error.message || String(error), true);
    await refreshVoiceState().catch(() => renderVoiceState(currentVoiceState));
  }
});

muteVoiceEl.addEventListener("click", async () => {
  try {
    const muted = !currentVoiceState.inputMuted;
    const response = await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-mute",
      muted,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Mute control failed");
    }
    renderVoiceState(response.state);
    setStatus(muted ? "Microphone muted." : "Microphone unmuted.");
  } catch (error) {
    setStatus(error.message || String(error), true);
    await refreshVoiceState().catch(() => {});
  }
});

stopVoiceEl.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "actions-json:agent-session-close" });
    if (!response?.ok) {
      throw new Error(response?.error || "Session stop failed");
    }
    renderVoiceState(response.state);
    setStatus("Session stopped.");
  } catch (error) {
    setStatus(error.message || String(error), true);
    renderVoiceState({ status: "stopped", inputMuted: false });
  }
});

refreshVoiceState().catch((error) => {
  setStatus(error.message || String(error), true);
  renderVoiceState(currentVoiceState);
});

renderActiveTabNotice().catch(() => {});

// A fresh install has no stored bridge URL; authorizing would silently fall
// back to 127.0.0.1, which is wrong for split-machine setups and yields "no
// key, no actions" with no visible cause. Say so up front.
chrome.storage.local.get("bridgeUrl").then((stored) => {
  if (!stored?.bridgeUrl) {
    setStatus(
      "Bridge URL not set - expand Settings > Bridge below, enter your bridge address, and press Connect.",
      true,
    );
  }
}).catch(() => {});
