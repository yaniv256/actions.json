const statusEl = document.getElementById("status");
const bridgeUrlEl = document.getElementById("bridgeUrl");
const voiceStateEl = document.getElementById("voiceState");
const startVoiceEl = document.getElementById("startVoice");
const muteVoiceEl = document.getElementById("muteVoice");
const stopVoiceEl = document.getElementById("stopVoice");

let currentVoiceState = {
  status: "disconnected",
  model: "gpt-realtime-2",
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
  voiceStateEl.textContent = `Voice session: ${label}`;
  startVoiceEl.disabled = status === "connected" || status === "connecting";
  muteVoiceEl.disabled = status !== "connected";
  muteVoiceEl.textContent = muted ? "Unmute" : "Mute";
  stopVoiceEl.disabled = false;
}

async function loadBridgeUrl() {
  const stored = await chrome.storage.local.get("bridgeUrl");
  bridgeUrlEl.value = stored.bridgeUrl || bridgeUrlEl.value || "ws://127.0.0.1:17345/extension";
}

async function authorizeCurrentTab() {
  const tab = await getActiveTab();
  const bridgeUrl = bridgeUrlEl.value.trim() || "ws://127.0.0.1:17345/extension";
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
    throw new Error(response?.error || "Voice session state unavailable");
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
    setStatus("actions.json menu opened.");
    window.close();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.getElementById("openStorageTools").addEventListener("click", async () => {
  try {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("sidepanel.html?tab=config&surface=top-level"),
    });
    setStatus("Storage tools opened.");
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
      throw new Error(response?.error || "Voice session start failed");
    }
    renderVoiceState(response.state);
    setStatus("Voice session started.");
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
      throw new Error(response?.error || "Voice mute control failed");
    }
    renderVoiceState(response.state);
    setStatus(muted ? "Voice input muted." : "Voice input unmuted.");
  } catch (error) {
    setStatus(error.message || String(error), true);
    await refreshVoiceState().catch(() => {});
  }
});

stopVoiceEl.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "actions-json:agent-session-close" });
    if (!response?.ok) {
      throw new Error(response?.error || "Voice session stop failed");
    }
    renderVoiceState(response.state);
    setStatus("Voice session stopped and hidden document closed.");
  } catch (error) {
    setStatus(error.message || String(error), true);
    renderVoiceState({ status: "stopped", inputMuted: false });
  }
});

loadBridgeUrl().catch((error) => setStatus(error.message || String(error), true));
refreshVoiceState().catch((error) => {
  setStatus(error.message || String(error), true);
  renderVoiceState(currentVoiceState);
});
