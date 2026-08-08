import { DEFAULT_MODEL } from "./agent/realtime-model.mjs";
import { PILL_COLOR_PROPERTIES } from "./agent/pill-presentation.mjs";
import { resolveSessionPresentation } from "./agent/popup-presentation.mjs";
import { waitForBridgeRuntime } from "./agent/bridge-runtime-verification.mjs";
import {
  getOverlaySettings,
  saveOverlaySettings,
} from "./agent/overlay-settings-store.mjs";

const statusEl = document.getElementById("status");
const stateBlockEl = document.getElementById("stateBlock");
const sessionStateEl = document.getElementById("sessionState");
const sessionDetailEl = document.getElementById("sessionDetail");
const showCostEl = document.getElementById("showCost");
const devModeEl = document.getElementById("devMode");
const allSettingsEl = document.getElementById("allSettings");
const startVoiceEl = document.getElementById("startVoice");
const muteVoiceEl = document.getElementById("muteVoice");
const stopVoiceEl = document.getElementById("stopVoice");
const tabNoticeEl = document.getElementById("tabNotice");
const websiteAgentNoticeEl = document.getElementById("websiteAgentNotice");
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

async function renderWebsiteAgentNotice() {
  const tab = await getActiveTab();
  const response = await chrome.runtime.sendMessage({
    type: "actions-json:delegated-agent-proposals-list",
    tabId: tab.id,
  });
  const proposal = response?.proposals?.[0];
  if (!proposal) {
    websiteAgentNoticeEl.hidden = true;
    websiteAgentNoticeEl.textContent = "";
    return;
  }
  const labels = {
    unapproved: "Website agent available",
    "approved-dormant": "Website agent approved — ready to reactivate",
    live: "Website agent active",
    "changed-bundle": "Website agent changed — review required",
    invalid: "Website agent declaration is invalid",
  };
  websiteAgentNoticeEl.textContent = labels[proposal.state] || "Website agent available";
  websiteAgentNoticeEl.hidden = false;
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

// The state block renders from the PILL's vocabulary, not from a status string
// capitalised in place. `resolveSessionPresentation` returns the pill state name
// and the very token the overlay pill styles itself with, so the popup and the
// pill cannot disagree about what "listening" is called or what colour it is.
function renderVoiceState(state = currentVoiceState) {
  currentVoiceState = { ...currentVoiceState, ...(state || {}) };
  const presentation = resolveSessionPresentation(currentVoiceState);

  sessionStateEl.textContent = presentation.label;
  sessionDetailEl.textContent = presentation.detail;
  stateBlockEl.dataset.state = presentation.state;
  // A live mic is the only thing allowed to animate; see popup.html.
  stateBlockEl.dataset.live = String(presentation.live && !presentation.muted);
  // Containment: the hue reaches only the properties the pill allows it to.
  for (const property of PILL_COLOR_PROPERTIES) {
    stateBlockEl.style.setProperty(property, presentation.token.hue);
  }
  stateBlockEl.style.setProperty("--state-hue", presentation.token.hue);

  startVoiceEl.disabled = presentation.live || presentation.connecting;
  muteVoiceEl.disabled = !presentation.live;
  muteVoiceEl.textContent = presentation.muted ? "Unmute" : "Mute";
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
  await waitForBridgeRuntime({
    bridgeUrl,
    runtimeId: response.runtimeId,
  });
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
    setStatus("Connecting securely and waiting for runtime registration.");
    const { response } = await authorizeCurrentTab();
    setStatus(`Connected and verified. Runtime ${response.runtimeId} is registered.`);
  } catch (error) {
    setStatus(`${error.message || String(error)} Open All settings for the connection log.`, true);
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

// ---------------------------------------------------------------------------
// The two mid-session toggles. Everything else lives behind "All settings".
//
// These write through the shared overlay settings store, which is strict on
// purpose: it throws on a non-boolean rather than coercing one. A checkbox's
// `.checked` is always a real boolean, so the strictness is free here and the
// store stays the single definition of what a valid setting is.
// ---------------------------------------------------------------------------
async function renderOverlaySettings() {
  const settings = await getOverlaySettings(chrome.storage.local);
  showCostEl.checked = settings.showCost;
  devModeEl.checked = settings.devMode;
  return settings;
}

async function persistOverlaySettings() {
  // Read the CURRENT stored settings and overlay only the two fields this
  // surface owns. Writing the whole object from the popup's two checkboxes
  // would silently reset restingCorner and reducedMotion to their defaults.
  const settings = await getOverlaySettings(chrome.storage.local);
  return saveOverlaySettings(chrome.storage.local, {
    ...settings,
    showCost: showCostEl.checked === true,
    devMode: devModeEl.checked === true,
  });
}

for (const [element, label] of [[showCostEl, "Cost meter"], [devModeEl, "Developer mode"]]) {
  element.addEventListener("change", async () => {
    try {
      const settings = await persistOverlaySettings();
      const on = element === showCostEl ? settings.showCost : settings.devMode;
      setStatus(`${label} ${on ? "on" : "off"}.`);
    } catch (error) {
      setStatus(error.message || String(error), true);
      await renderOverlaySettings().catch(() => {});
    }
  });
}

// The full settings page opens as a real options TAB. It must not be an iframe
// and must not be the side panel: Chrome blocks folder pickers outside a
// top-level context, and the storage folder controls live on that page.
allSettingsEl.addEventListener("click", async (event) => {
  event.preventDefault();
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

renderOverlaySettings().catch((error) => {
  setStatus(error.message || String(error), true);
});

refreshVoiceState().catch((error) => {
  setStatus(error.message || String(error), true);
  renderVoiceState(currentVoiceState);
});

renderActiveTabNotice().catch(() => {});
renderWebsiteAgentNotice().catch(() => {});

// A fresh install has no stored bridge URL; authorizing would silently fall
// back to 127.0.0.1, which is wrong for split-machine setups and yields "no
// key, no actions" with no visible cause. Say so up front.
chrome.storage.local.get("bridgeUrl").then((stored) => {
  if (!stored?.bridgeUrl) {
    setStatus(
      "Bridge URL not set - open All settings, expand Bridge, enter your bridge address, and press Connect.",
      true,
    );
  }
}).catch(() => {});
