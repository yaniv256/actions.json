import {
  clearOpenAiApiKey,
  getOpenAiCredentialState,
  saveOpenAiApiKey,
} from "./agent/credential-store.mjs";
import { FakeRealtimeTransportFactory } from "./agent/fake-realtime-transport.mjs";
import {
  createChromeHostedToolExecutor,
  fetchBridgeRealtimeToolCatalog,
} from "./agent/hosted-tool-executor.mjs";
import { waitForBridgeRuntime } from "./agent/bridge-runtime-verification.mjs";
import { HostedRealtimeSessionManager } from "./agent/realtime-session-manager.mjs";
import {
  createRuntimeHostedSessionClient,
  createUnavailableHostedSessionClient,
} from "./agent/runtime-session-client.mjs";
import { RealtimeWebRtcTransportFactory } from "./agent/realtime-webrtc-transport.mjs";
import { ProtofaceAvatarController } from "./agent/protoface-avatar-controller.mjs";
import {
  clearProtofaceCredentials,
  getProtofaceCredentialState,
  PROTOFACE_CREDENTIAL_STORAGE_KEY,
  saveProtofaceDirectConfiguration,
} from "./agent/protoface-credential-store.mjs";
import {
  getProtofaceSettings,
  PROTOFACE_SETTINGS_STORAGE_KEY,
  saveProtofaceSettings,
} from "./agent/protoface-settings-store.mjs";
import {
  siteBlockedPrimitiveNamesFromBundle,
} from "./agent/local-actions-catalog.mjs";
import {
  AGENT_MEMORY_STORAGE_KEY,
  clearAgentMemory,
  getAgentMemoryState,
  getAgentSessionLog,
} from "./agent/session-memory-store.mjs";
import {
  createUnreadErrorTracker,
  presentSessionLog,
} from "./agent/debug-log-presentation.mjs";
import {
  OVERLAY_SETTINGS_STORAGE_KEY,
  getOverlaySettings,
} from "./agent/overlay-settings-store.mjs";
import {
  getRealtimeVoice,
  getRealtimeTurnDetectionSettings,
  REALTIME_VOICE_STORAGE_KEY,
  REALTIME_TURN_DETECTION_STORAGE_KEY,
  saveRealtimeVoice,
  saveRealtimeTurnDetectionSettings,
} from "./agent/voice-settings-store.mjs";
import {
  parseStoragePath,
} from "./storage-bundle.mjs";
import {
  buildRealtimeToolCatalog,
  filterRealtimeToolsForBlockedPrimitives,
} from "./agent/realtime-tool-catalog.mjs";
import { VOICE_ICONS } from "./agent/voice-icons.mjs";
import {
  PILL_COLOR_PROPERTIES,
  assertPillState,
  createPillPresenter,
  resolvePillState,
} from "./agent/pill-presentation.mjs";
import { AMPLITUDE_BROADCAST_CHANNEL } from "./agent/amplitude-runtime-message.mjs";
import SiriWave from "./agent/vendor/siriwave.mjs";

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";
const EXTENSION_STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";
const DEFAULT_STORAGE_SCOPE = "private";
const EXTENSION_ACTIONS_URL = "actions/overlay.actions.json";
const TOP_LEVEL_STORAGE_SETTINGS_URL = "agent-surface.html?tab=config&surface=top-level";
const apiKeyEl = document.getElementById("apiKey");
const saveKeyEl = document.getElementById("saveKey");
const clearKeyEl = document.getElementById("clearKey");
const bridgeUrlEl = document.getElementById("bridgeUrl");
const authorizeBridgeEl = document.getElementById("authorizeBridge");
const closeOverlayEl = document.getElementById("closeOverlay");
const keySummaryEl = document.getElementById("keySummary");
const credentialStatusEl = document.getElementById("credentialStatus");
const bridgeStatusEl = document.getElementById("bridgeStatus");
const agentStateEl = document.getElementById("agentState");
const agentTabEl = document.getElementById("agentTab");
const configTabEl = document.getElementById("configTab");
const agentPanelEl = document.getElementById("agentPanel");
const configPanelEl = document.getElementById("configPanel");
const startAgentEl = document.getElementById("startAgent");
const stopAgentEl = document.getElementById("stopAgent");
const muteMicEl = document.getElementById("muteMic");
const muteSpeakerEl = document.getElementById("muteSpeaker");
const voiceLauncherIconEl = document.getElementById("voiceLauncherIcon");
const voiceLauncherLabelEl = document.getElementById("voiceLauncherLabel");
const agentPillEl = document.getElementById("agentPill");
const agentPillToggleEl = document.getElementById("agentPillToggle");
const overlayStartAgentEl = document.getElementById("overlayStartAgent");
const openAgentDetailsEl = document.getElementById("openAgentDetails");
const closeAgentOverlayEl = document.getElementById("closeAgentOverlay");
const agentPillWaveEl = document.getElementById("agentPillWave");
const agentPillActionEl = document.getElementById("agentPillAction");
const targetSummaryEl = document.getElementById("targetSummary");
const clearMemoryEl = document.getElementById("clearMemory");
const memoryStatusEl = document.getElementById("memoryStatus");
const transcriptEl = document.getElementById("transcript");
const agentViewTabsEl = document.getElementById("agentViewTabs");
const transcriptViewTabEl = document.getElementById("transcriptViewTab");
const costViewTabEl = document.getElementById("costViewTab");
const agentCostPanelEl = document.getElementById("agentCostPanel");
const agentConversationEl = document.querySelector(".agent-conversation");
const agentTextFormEl = document.getElementById("agentTextForm");
const agentTextInputEl = document.getElementById("agentTextInput");
const sendAgentTextEl = document.getElementById("sendAgentText");
const voiceSelectEl = document.getElementById("voiceSelect");
const voiceStatusEl = document.getElementById("voiceStatus");
const vadModeEl = document.getElementById("vadMode");
const vadThresholdEl = document.getElementById("vadThreshold");
const vadSilenceDurationEl = document.getElementById("vadSilenceDuration");
const vadEagernessEl = document.getElementById("vadEagerness");
const vadInterruptResponseEl = document.getElementById("vadInterruptResponse");
const vadStatusEl = document.getElementById("vadStatus");
const loadStorageFolderEl = document.getElementById("loadStorageFolder");
const writeStorageFolderEl = document.getElementById("writeStorageFolder");
const storageFolderStatusEl = document.getElementById("storageFolderStatus");
const protofaceStageEl = document.getElementById("protofaceStage");
const protofaceVideoEl = document.getElementById("protofaceVideo");
const protofaceAudioEl = document.getElementById("protofaceAudio");
const protofaceStatusEl = document.getElementById("protofaceStatus");

function renderOverlayStartAction({
  disabled,
  hidden,
  label,
  voiceState,
  ariaLabel = label,
} = {}) {
  if (!overlayStartAgentEl) return;
  if (disabled !== undefined) overlayStartAgentEl.disabled = disabled;
  if (hidden !== undefined) overlayStartAgentEl.hidden = hidden;
  if (label !== undefined) overlayStartAgentEl.textContent = label;
  if (voiceState !== undefined) overlayStartAgentEl.dataset.voiceState = voiceState;
  if (ariaLabel !== undefined) overlayStartAgentEl.setAttribute("aria-label", ariaLabel);
}
const protofaceEnabledEl = document.getElementById("protofaceEnabled");
const protofaceConnectionModeEl = document.getElementById("protofaceConnectionMode");
const protofaceBrokerFieldsEl = document.getElementById("protofaceBrokerFields");
const protofaceBrokerUrlEl = document.getElementById("protofaceBrokerUrl");
const protofaceDirectCredentialFieldsEl = document.getElementById("protofaceDirectCredentialFields");
const protofaceApiKeyEl = document.getElementById("protofaceApiKey");
const livekitUrlEl = document.getElementById("livekitUrl");
const livekitApiKeyEl = document.getElementById("livekitApiKey");
const livekitApiSecretEl = document.getElementById("livekitApiSecret");
const saveProtofaceCredentialsEl = document.getElementById("saveProtofaceCredentials");
const clearProtofaceCredentialsEl = document.getElementById("clearProtofaceCredentials");
const protofaceCredentialStatusEl = document.getElementById("protofaceCredentialStatus");
const protofaceAvatarIdEl = document.getElementById("protofaceAvatarId");
const saveProtofaceSettingsEl = document.getElementById("saveProtofaceSettings");
const protofaceSettingsStatusEl = document.getElementById("protofaceSettingsStatus");
const protofaceAvatarMode = new URLSearchParams(location.search).get("avatar") === "protoface";
const useLocalRealtimeSession = globalThis.__ACTIONS_JSON_USE_FAKE_REALTIME === true
  || globalThis.__ACTIONS_JSON_FORCE_LOCAL_REALTIME === true
  || protofaceAvatarMode;
const needsVisibleMicrophoneGrant = !useLocalRealtimeSession;
let protofaceController = null;
let protofaceFallbackHandler = null;
const protofaceOutputAdapter = {
  isReady: () => protofaceController?.isReady?.() === true,
  attachTrack: (track) => protofaceController?.attachTrack?.(track) ?? false,
  setMuted: (muted) => protofaceController?.setMuted?.(muted),
  clearBuffer: () => protofaceController?.clearBuffer?.() ?? false,
  observeRealtimeEvent: (event) => protofaceController?.observeRealtimeEvent?.(event),
  detach: () => protofaceController?.detach?.(),
  setFallbackHandler: (handler) => { protofaceFallbackHandler = handler; },
};
const transportFactory = useLocalRealtimeSession
  ? (globalThis.__ACTIONS_JSON_USE_FAKE_REALTIME === true
      ? new FakeRealtimeTransportFactory()
      : new RealtimeWebRtcTransportFactory({ remoteOutputAdapter: protofaceOutputAdapter }))
  : null;
if (transportFactory && globalThis.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY === true) {
  globalThis.__ACTIONS_JSON_FAKE_REALTIME_FACTORY = transportFactory;
}
const liveTranscriptTurns = {
  assistant: { lineEl: null, text: "" },
  user: { lineEl: null, text: "" },
};
const TRANSCRIPT_LABELS = {
  assistant: "Agent",
  user: "User",
};
let storageDirectoryHandle = null;


function createSessionManager() {
  if (useLocalRealtimeSession) {
    return new HostedRealtimeSessionManager({
      storage: chrome.storage.local,
      transportFactory,
      toolExecutor: createChromeHostedToolExecutor({ chromeApi: chrome }),
      eventObserver: handleRealtimeUiEvent,
      responseOutputController: protofaceAvatarMode ? protofaceOutputAdapter : null,
    });
  }
  if (chrome?.runtime?.sendMessage) {
    return createRuntimeHostedSessionClient({
      chromeApi: chrome,
      eventObserver: handleRealtimeUiEvent,
    });
  }
  return createUnavailableHostedSessionClient();
}

const sessionManager = createSessionManager();
agentPanelEl.dataset.avatarMode = String(protofaceAvatarMode);
protofaceStageEl.hidden = !protofaceAvatarMode;

const PROTOFACE_STATUS_LABELS = {
  disabled: "Avatar disabled",
  starting: "Starting avatar",
  ready: "Avatar ready",
  speaking: "Avatar speaking",
  first_frame: "Avatar ready",
  track_attached: "Avatar ready",
  buffer_cleared: "Avatar ready",
  buffer_clear_failed: "Avatar control degraded",
  broker_cleanup_failed: "Avatar cleanup pending",
  client_cleanup_failed: "Avatar cleanup pending",
  fallback: "Voice-only fallback",
  stopped: "Avatar stopped",
};

function handleProtofaceUiEvent(event) {
  if (!protofaceAvatarMode || event?.type !== "protoface.avatar.state") return;
  let status = PROTOFACE_STATUS_LABELS[event.state] || "Avatar status changed";
  if (Number.isFinite(event.startup_to_first_frame_ms)) {
    status = `Avatar ready (${event.startup_to_first_frame_ms} ms to first frame)`;
    appendTranscriptLine(`Avatar startup latency: ${event.startup_to_first_frame_ms} ms.`);
  } else if (Number.isFinite(event.audio_to_visible_speech_ms)) {
    status = `Avatar speaking (${event.audio_to_visible_speech_ms} ms lip-sync latency)`;
    appendTranscriptLine(`Avatar lip-sync latency: ${event.audio_to_visible_speech_ms} ms.`);
  }
  protofaceStatusEl.textContent = status;
  protofaceStageEl.dataset.state = event.state;
  if (event.state === "fallback") {
    protofaceFallbackHandler?.();
  }
}

function selectPanel(panelName) {
  const isAgent = panelName === "agent";
  agentTabEl?.setAttribute("aria-selected", String(isAgent));
  configTabEl?.setAttribute("aria-selected", String(!isAgent));
  agentPanelEl.hidden = !isAgent;
  configPanelEl.hidden = isAgent;
}

function selectedPanelFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get("tab") === "config" ? "config" : "agent";
}

async function loadHostedRealtimeTools() {
  try {
    const tools = await applyCurrentSiteToolPolicy(
      await fetchBridgeRealtimeToolCatalog({ chromeApi: chrome }),
    );
    sessionManager.setTools(tools);
    const count = tools.filter((tool) => tool?.name).length;
    appendTranscriptLine(`Tools ready: ${count} bridge actions.`);
    return tools;
  } catch (error) {
    // Current secured bridges intentionally omit the legacy HTTP catalog
    // route. The hosted agent still owns a complete extension-local catalog
    // and routes bridge-backed calls over the authenticated runtime socket.
    console.info("[agent-surface] bridge catalog unavailable; using local catalog", error);
    const tools = await applyCurrentSiteToolPolicy(await loadLocalRealtimeTools());
    sessionManager.setTools(tools);
    const count = tools.filter((tool) => tool?.name).length;
    appendTranscriptLine(`Tools ready: ${count} extension-local actions.`);
    return tools;
  }
}

async function loadLocalRealtimeTools() {
  const manifestUrl = chrome.runtime?.getURL ? chrome.runtime.getURL(EXTENSION_ACTIONS_URL) : EXTENSION_ACTIONS_URL;
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to load ${EXTENSION_ACTIONS_URL}: ${response.status}`);
  }
  const manifest = await response.json();
  const dictionary = manifest.primitive_dictionary;
  if (!dictionary) {
    throw new Error("Extension actions manifest does not declare a primitive dictionary.");
  }
  return buildRealtimeToolCatalog({ dictionary, host: "extension" });
}

async function applyCurrentSiteToolPolicy(tools) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    return tools;
  }
  const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
  const bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];
  const blockedPrimitives = siteBlockedPrimitiveNamesFromBundle(bundle, tab.url);
  return filterRealtimeToolsForBlockedPrimitives(tools, blockedPrimitives);
}

function setStatus(message, isError = false) {
  credentialStatusEl.textContent = message;
  credentialStatusEl.dataset.error = String(isError);
}

function setBridgeStatus(message, isError = false) {
  bridgeStatusEl.textContent = message;
  bridgeStatusEl.dataset.error = String(isError);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab found");
  }
  return tab;
}

async function readDirectoryEntries(directoryHandle, prefix = "") {
  const entries = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      entries.push(...(await readDirectoryEntries(handle, path)));
      continue;
    }
    if (handle.kind !== "file") {
      continue;
    }
    const file = await handle.getFile();
    entries.push({
      path,
      text: await file.text(),
      size: file.size,
      lastModified: file.lastModified,
    });
  }
  return entries;
}

function storageBundleFromFolderEntries(entries, { defaultScope = DEFAULT_STORAGE_SCOPE } = {}) {
  return {
    protocol: "actions.json.storage.bundle",
    version: "0.1.0",
    synced_at_ms: Date.now(),
    source: "extension-folder-picker",
    entries: entries.map((entry) => {
      const parsed = parseStoragePath(entry.path, { defaultScope });
      const path = parsed?.canonicalPath || entry.path;
      return {
        path,
        content: String(entry.text ?? ""),
        bytes: Number.isFinite(entry.size) ? entry.size : String(entry.text ?? "").length,
        content_type: path.endsWith(".json") ? "application/json" : "text/plain",
        last_modified: entry.lastModified ?? null,
      };
    }),
  };
}

function isFilePickerAllowedContext() {
  if (globalThis.__ACTIONS_JSON_FORCE_FILE_PICKER_SUBFRAME === true) {
    return false;
  }
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

async function openTopLevelStorageSettings() {
  // The options page IS the full settings surface now, and openOptionsPage
  // opens it in a real tab (options_ui.open_in_tab), which is the whole point:
  // Chrome blocks folder pickers anywhere but a top-level context.
  if (chrome.runtime?.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  const url = chrome.runtime.getURL(TOP_LEVEL_STORAGE_SETTINGS_URL);
  if (chrome.tabs?.create) {
    await chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function ensureFilePickerAllowedContext() {
  if (isFilePickerAllowedContext()) {
    return true;
  }
  await openTopLevelStorageSettings();
  setStorageFolderStatus("Opened top-level Settings for folder access. Chrome blocks folder pickers inside page overlay frames.");
  return false;
}

async function chooseStorageDirectoryHandle() {
  if (!(await ensureFilePickerAllowedContext())) {
    return null;
  }
  if (!("showDirectoryPicker" in window)) {
    setStorageFolderStatus("Folder access is not supported in this browser.", true);
    return null;
  }
  storageDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  return storageDirectoryHandle;
}

async function getStorageDirectoryHandleForOperation() {
  return storageDirectoryHandle || await chooseStorageDirectoryHandle();
}

function setStorageFolderStatus(message, isError = false) {
  if (!storageFolderStatusEl) {
    return;
  }
  storageFolderStatusEl.textContent = message;
  storageFolderStatusEl.dataset.error = String(isError);
}

function selectedRepoScopePrefix(folderName) {
  if (folderName === "actions.json.storage.private") {
    return "scopes/private";
  }
  if (folderName === "actions.json.storage.public") {
    return "scopes/public";
  }
  const sharedPrefix = "actions.json.storage.shared.";
  if (folderName?.startsWith(sharedPrefix)) {
    return `scopes/shared/${folderName.slice(sharedPrefix.length)}`;
  }
  return null;
}

function defaultScopeForSelectedFolder(folderName) {
  const scopePrefix = selectedRepoScopePrefix(folderName);
  if (!scopePrefix) {
    return DEFAULT_STORAGE_SCOPE;
  }
  if (scopePrefix === "scopes/private") {
    return "private";
  }
  if (scopePrefix === "scopes/public") {
    return "public";
  }
  const sharedPrefix = "scopes/shared/";
  if (scopePrefix.startsWith(sharedPrefix)) {
    return `shared:${scopePrefix.slice(sharedPrefix.length)}`;
  }
  return DEFAULT_STORAGE_SCOPE;
}

function writePartsForSelectedFolder(target, handle) {
  const repoScopePrefix = selectedRepoScopePrefix(handle.name);
  if (repoScopePrefix) {
    const prefix = repoScopePrefix.split("/");
    const matchesPrefix = prefix.every((part, index) => target.parts[index] === part);
    if (matchesPrefix) {
      const relativeParts = target.parts.slice(prefix.length);
      if (relativeParts.length > 0) {
        return relativeParts;
      }
    }
  }

  const parsed = parseStoragePath(target.path);
  if (parsed?.siteHost === handle.name) {
    const relativeParts = parsed.sitePath.split("/").filter(Boolean);
    if (relativeParts.length === 0) {
      throw new Error(`Unsafe storage path: ${target.path}`);
    }
    return relativeParts;
  }
  return target.parts;
}

async function writeTextAtPath(rootHandle, parts, text) {
  const fileName = parts.at(-1);
  const directoryParts = parts.slice(0, -1);
  let directory = rootHandle;
  for (const part of directoryParts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

async function getMicrophonePermissionState() {
  if (typeof globalThis.__ACTIONS_JSON_MICROPHONE_PERMISSION_STATE === "string") {
    return globalThis.__ACTIONS_JSON_MICROPHONE_PERMISSION_STATE;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "unavailable";
  }
  if (!navigator.permissions?.query) {
    return "unknown";
  }
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state || "unknown";
  } catch {
    return "unknown";
  }
}

async function requestVisibleMicrophoneGrant() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this browser context");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function renderCredentialState(state) {
  const sessionState = sessionManager.getState();
  renderAudioControlState(sessionState);
  if (state.configured) {
    keySummaryEl.textContent = `OpenAI key configured: ${state.redacted}`;
    if (sessionState.status !== "connected" && sessionState.status !== "connecting") {
      agentStateEl.textContent = "Ready";
      agentStateEl.dataset.state = "ready";
      startAgentEl.disabled = false;
      renderOverlayStartAction({ disabled: false, hidden: false });
      setVoiceLauncherState("idle", "Start voice");
    }
    return;
  }

  keySummaryEl.textContent = "No OpenAI key configured.";
  if (sessionState.status !== "connected" && sessionState.status !== "connecting") {
    agentStateEl.textContent = "Blocked";
    agentStateEl.dataset.state = "blocked";
    startAgentEl.disabled = true;
    setVoiceLauncherState("idle", "Add key first");
    renderOverlayStartAction({
      disabled: false,
      hidden: false,
      label: "Open settings",
      ariaLabel: "Open settings to add an OpenAI API key",
    });
  }
}

function clearTranscriptEmptyState() {
  if (transcriptEl.querySelector(".empty")) {
    transcriptEl.textContent = "";
  }
}

function isTranscriptPinnedToBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 24;
}

function preserveTranscriptScrollPosition(mutate) {
  const wasPinned = isTranscriptPinnedToBottom();
  const beforeTop = transcriptEl.scrollTop;
  mutate();
  if (wasPinned) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else {
    transcriptEl.scrollTop = beforeTop;
  }
}

function appendTranscriptLine(text, role = "status") {
  let line;
  preserveTranscriptScrollPosition(() => {
    clearTranscriptEmptyState();
    line = document.createElement("div");
    line.className = `transcript-line transcript-line-${role}`;
    line.dataset.transcriptRole = role;
    line.textContent = text;
    transcriptEl.append(line);
  });
  return line;
}

function beginLiveTranscriptTurn(role, placeholder = "") {
  const turn = liveTranscriptTurns[role];
  const label = TRANSCRIPT_LABELS[role];
  if (!turn || !label) {
    return null;
  }
  if (!turn.lineEl || !turn.lineEl.isConnected) {
    preserveTranscriptScrollPosition(() => {
      clearTranscriptEmptyState();
      turn.lineEl = document.createElement("div");
      turn.lineEl.className = `transcript-line transcript-line-${role} is-live${placeholder ? " is-pending" : ""}`;
      turn.lineEl.dataset.transcriptRole = role;
      turn.lineEl.dataset.liveTranscript = role;
      transcriptEl.append(turn.lineEl);
      turn.text = "";
      turn.lineEl.textContent = `${label}: ${placeholder}`;
    });
  }
  return turn.lineEl;
}

function upsertLiveTranscriptDelta(role, delta) {
  const turn = liveTranscriptTurns[role];
  const label = TRANSCRIPT_LABELS[role];
  if (!turn || !label || !delta) {
    return;
  }
  beginLiveTranscriptTurn(role);
  turn.text += delta;
  preserveTranscriptScrollPosition(() => {
    turn.lineEl.classList.remove("is-pending");
    turn.lineEl.textContent = `${label}: ${turn.text}`;
  });
}

function finalizeLiveTranscript(role, text) {
  const turn = liveTranscriptTurns[role];
  const label = TRANSCRIPT_LABELS[role];
  if (!turn || !label) {
    return;
  }
  const finalText = text || turn.text;
  if (!finalText) {
    return;
  }
  preserveTranscriptScrollPosition(() => {
    const expectedText = `${label}: ${finalText}`;
    const lastFinalLine = Array.from(transcriptEl.querySelectorAll(".transcript-line"))
      .filter((line) => !line.dataset.liveTranscript)
      .at(-1);
    if (lastFinalLine?.dataset.transcriptRole === role && lastFinalLine.textContent === expectedText) {
      return;
    }
    if (turn.lineEl?.isConnected) {
      turn.lineEl.textContent = expectedText;
      turn.lineEl.classList.remove("is-live", "is-pending");
      delete turn.lineEl.dataset.liveTranscript;
    } else {
      const line = document.createElement("div");
      line.className = `transcript-line transcript-line-${role}`;
      line.dataset.transcriptRole = role;
      line.textContent = expectedText;
      clearTranscriptEmptyState();
      transcriptEl.append(line);
    }
  });
  turn.lineEl = null;
  turn.text = "";
}

function clearLiveTranscript(role) {
  const turn = liveTranscriptTurns[role];
  if (!turn) {
    return;
  }
  turn.lineEl = null;
  turn.text = "";
}

function realtimeContentPartsText(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => part?.transcript || part?.text || "")
    .filter(Boolean)
    .join("")
    .trim();
}

function realtimeFinalText(event) {
  for (const value of [event?.transcript, event?.text]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const partText = realtimeContentPartsText(event?.part ? [event.part] : null);
  if (partText) {
    return partText;
  }
  const itemText = realtimeContentPartsText(event?.item?.content);
  if (itemText) {
    return itemText;
  }
  const responseOutputText = (Array.isArray(event?.response?.output) ? event.response.output : [])
    .map((item) => realtimeContentPartsText(item?.content))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (responseOutputText) {
    return responseOutputText;
  }
  return "";
}

/**
 * The pill's DOM/canvas surface. Every element touch the presenter makes goes
 * through here, which is what keeps pill-presentation.mjs unit-testable.
 *
 * The waveform is lazily constructed: SiriWave measures its container with
 * getComputedStyle at construction time, so building it while the pill is
 * `display:none` would size the canvas to 0 and render nothing forever.
 */
let pillWave = null;
let pillWaveFailed = false;

function ensurePillWave() {
  if (pillWave || pillWaveFailed || !agentPillWaveEl) return pillWave;
  try {
    pillWave = new SiriWave({
      container: agentPillWaveEl,
      width: 56,
      height: 38,
      style: "ios",
      speed: 0.06,
      amplitude: 0,
      autostart: false,
      cover: true,
      color: readPillHue(),
    });
  } catch (error) {
    // A visualizer must never take the voice session down with it.
    pillWaveFailed = true;
    console.warn("[agent-surface] pill waveform unavailable", error);
  }
  return pillWave;
}

function readPillHue() {
  const value = agentPillEl?.style.getPropertyValue("--pill-hue")?.trim();
  return value || "#8b96a5";
}

const pillSurface = {
  setState(state) {
    if (!agentPillEl) return;
    agentPillEl.dataset.state = state;
  },
  setLabel(label) {
    if (agentPillActionEl) agentPillActionEl.textContent = label;
    agentPillToggleEl?.setAttribute("aria-label", `Open agent details. Agent status: ${label}`);
  },
  setColorVariable(property, value) {
    // Containment is enforced upstream in pill-presentation.mjs, but this
    // surface is the last hop before the DOM: refuse anything not on the
    // stroke-only allow list rather than trusting the caller.
    if (!PILL_COLOR_PROPERTIES.includes(property)) {
      throw new Error(`pill colour property ${property} is not stroke-contained`);
    }
    agentPillEl?.style.setProperty(property, value);
    if (property === "--pill-hue" && pillWave) {
      pillWave.color = `rgb(${pillWave.hex2rgb(value)})`;
    }
  },
  setAudioMode(mode) {
    if (agentPillEl) agentPillEl.dataset.audio = mode;
  },
  setWaveAmplitude(value) {
    ensurePillWave()?.setAmplitude(value);
  },
  setWaveSpeed(value) {
    ensurePillWave()?.setSpeed(value);
  },
  startWave() {
    ensurePillWave()?.start();
  },
  stopWave() {
    pillWave?.stop();
  },
};

const pillPresenter = createPillPresenter({ surface: pillSurface });
let pillAmplitudeChannel = null;

function handlePillAmplitude(payload) {
  pillPresenter.handleEnvelope(payload);
}

/**
 * Six-state -> legacy glyph token.
 *
 * The launcher button is the NON-overlay surface's control. Its CSS rules and
 * its existing Playwright coverage both key off the legacy token names, and
 * this unit inverts the PILL, not the launcher — so the old vocabulary survives
 * on exactly one element and the translation stops here.
 *
 * `listening` maps to the `live` glyph because the launcher's "listening" token
 * predates the six-state contract and meant something narrower (mid-utterance);
 * a connected session with an open mic is `listening` in the new vocabulary and
 * `live` on the button. `muted` had no legacy token at all — the button shows a
 * mic while the PILL carries the red that actually communicates it.
 */
const PILL_STATE_TO_ICON = Object.freeze({
  idle: "idle",
  thinking: "connecting",
  listening: "live",
  working: "busy",
  speaking: "live",
  muted: "listening",
});

/**
 * Set the current activity state.
 *
 * `state` is one of the SIX activity states (idle/listening/thinking/speaking/
 * working/muted) or the orthogonal, pre-existing `error`. Every call site was
 * renamed rather than wrapped in a translation layer, so one vocabulary
 * survives in the code that reasons about state.
 *
 * assertPillState throws on an unmapped name. The shipped code did
 * `VOICE_ICONS[state] || VOICE_ICONS.idle`, so a call site missed during the
 * rename rendered a perfectly plausible idle pill and reported nothing at all.
 * This line is what turns that invisible failure into a loud one.
 */
function setVoiceLauncherState(state, label) {
  if (state === "error") {
    startAgentEl.dataset.voiceState = "error";
    voiceLauncherIconEl.innerHTML = VOICE_ICONS.error;
    voiceLauncherLabelEl.textContent = label;
    startAgentEl.setAttribute("aria-label", label);
    renderOverlayStartAction({ label, voiceState: "error" });
    if (agentPillEl) {
      agentPillEl.dataset.state = "error";
    }
    if (agentPillActionEl) {
      agentPillActionEl.textContent = "Voice error";
    }
    agentPillToggleEl?.setAttribute("aria-label", "Open agent details. Agent status: Voice error");
    return;
  }
  assertPillState(state);
  const iconToken = PILL_STATE_TO_ICON[state];
  startAgentEl.dataset.voiceState = iconToken;
  voiceLauncherIconEl.innerHTML = VOICE_ICONS[iconToken];
  voiceLauncherLabelEl.textContent = label;
  startAgentEl.setAttribute("aria-label", label);
  renderOverlayStartAction({ label, voiceState: iconToken });
  pillPresenter.setState(state, state === "idle" ? "Ready" : label);
}

function renderAudioControlState(state = sessionManager.getState()) {
  const connected = state.status === "connected";
  const textOnly = state.textOnly === true;
  // Mute is the one pill state no session event can produce, so it is driven
  // from the session's own mute flag. It overrides the activity state and is
  // the sole owner of the red token — "my mic is hot and I didn't notice" is
  // the worst outcome this UI can produce, so the alarm colour is never spent
  // on anything else.
  pillPresenter.setMuted(connected && state.inputMuted === true);
  if (muteMicEl) {
    muteMicEl.disabled = !connected || textOnly;
    muteMicEl.setAttribute("aria-pressed", String(Boolean(state.inputMuted)));
    muteMicEl.classList.toggle("is-muted", Boolean(state.inputMuted));
    muteMicEl.title = state.inputMuted ? "Microphone muted" : "Mute microphone";
    muteMicEl.setAttribute("aria-label", state.inputMuted ? "Microphone muted" : "Mute microphone");
  }
  if (muteSpeakerEl) {
    muteSpeakerEl.disabled = !connected || textOnly;
    muteSpeakerEl.setAttribute("aria-pressed", String(Boolean(state.outputMuted)));
    muteSpeakerEl.classList.toggle("is-muted", Boolean(state.outputMuted));
    muteSpeakerEl.title = state.outputMuted ? "Speaker muted" : "Mute speaker";
    muteSpeakerEl.setAttribute("aria-label", state.outputMuted ? "Speaker muted" : "Mute speaker");
  }
  if (sendAgentTextEl) {
    sendAgentTextEl.disabled = !connected;
  }
  if (agentTextInputEl) {
    agentTextInputEl.disabled = !connected;
  }
}

function userFacingSessionError(error) {
  const message = error?.message || String(error);
  if (error?.name === "NotAllowedError" || /permission dismissed|permission denied/i.test(message)) {
    return "Microphone permission dismissed or blocked. Click the mic again and choose Allow. If no prompt appears, open Chrome microphone settings and allow this extension.";
  }
  return message;
}

async function renderRetryableSessionError(error) {
  const message = userFacingSessionError(error);
  agentStateEl.textContent = "Error";
  agentStateEl.dataset.state = "blocked";
  stopAgentEl.disabled = true;
  targetSummaryEl.textContent = message;
  setVoiceLauncherState("error", "Retry voice");
  appendTranscriptLine(`Error: ${message}`);
  const credential = await getOpenAiCredentialState(chrome.storage.local);
  startAgentEl.disabled = !credential.configured;
  renderOverlayStartAction({ disabled: !credential.configured, hidden: false });
  renderAudioControlState(sessionManager.getState());
  return message;
}

async function handleRealtimeUiEvent(event) {
  const finalText = realtimeFinalText(event);
  if (event?.type === "error") {
    const message = event.error?.message || JSON.stringify(event.error || event);
    setVoiceLauncherState("error", "Voice error");
    appendTranscriptLine(`Error: ${message}`);
    return;
  }
  if (event?.type === "actions_json.tool.started") {
    // Name the tool. This agent acts on the user's page, so "Using tool" hides
    // exactly the thing the user most needs to see; resolvePillState turns
    // `browser.navigate` into "Using browser navigate".
    const resolved = resolvePillState(event);
    setVoiceLauncherState(resolved.state, resolved.label);
    return;
  }
  if (event?.type === "actions_json.tool.completed") {
    if (event.ok === false) {
      const errorMessage = event.error?.message ? `: ${event.error.message}` : "";
      appendTranscriptLine(`Tool ${event.name} failed${errorMessage}.`);
    }
    return;
  }
  if (event?.type === "actions_json.transcript" && finalText) {
    finalizeLiveTranscript(event.role === "assistant" ? "assistant" : "user", finalText);
    return;
  }
  if (event?.type === "actions_json.agent_text_response" && finalText) {
    finalizeLiveTranscript("assistant", finalText);
    return;
  }
  if (event?.type === "input_audio_buffer.speech_started") {
    setVoiceLauncherState("listening", "Listening");
    targetSummaryEl.textContent = "Listening...";
    beginLiveTranscriptTurn("user", "Listening...");
    return;
  }
  if (event?.type === "response.created") {
    setVoiceLauncherState("thinking", "Thinking");
    clearLiveTranscript("assistant");
    return;
  }
  if (event?.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
    upsertLiveTranscriptDelta("user", event.delta);
    return;
  }
  if (
    (event?.type === "response.audio_transcript.delta" ||
      event?.type === "response.output_audio_transcript.delta") &&
    event.delta
  ) {
    setVoiceLauncherState("speaking", "Speaking");
    upsertLiveTranscriptDelta("assistant", event.delta);
    return;
  }
  if (event?.type === "conversation.item.input_audio_transcription.completed" && finalText) {
    finalizeLiveTranscript("user", finalText);
    return;
  }
  if (
    (event?.type === "response.audio_transcript.done" ||
      event?.type === "response.output_audio_transcript.done") &&
    finalText
  ) {
    setVoiceLauncherState("listening", "Session live");
    finalizeLiveTranscript("assistant", finalText);
    return;
  }
  if ((event?.type === "response.output_text.done" || event?.type === "response.text.done") && finalText) {
    finalizeLiveTranscript("assistant", finalText);
    return;
  }
  if (event?.type === "response.done") {
    setVoiceLauncherState("listening", "Session live");
  }
}

function renderMemoryState(state) {
  if (!state.configured) {
    memoryStatusEl.textContent = "No local memory stored.";
    return;
  }
  const suffix = state.eventCount === 1 ? "event" : "events";
  memoryStatusEl.textContent = `Memory: ${state.eventCount} ${suffix}.`;
}

function renderSessionState(state) {
  renderAudioControlState(state);
  if (state.status === "connected") {
    agentStateEl.textContent = "Live";
    agentStateEl.dataset.state = "ready";
    startAgentEl.disabled = true;
    renderOverlayStartAction({ disabled: true, hidden: true });
    stopAgentEl.disabled = false;
    setVoiceLauncherState("listening", "Session live");
    targetSummaryEl.textContent = `${state.model} voice session connected.`;
    return;
  }
  if (state.status === "stopped") {
    agentStateEl.textContent = "Stopped";
    agentStateEl.dataset.state = "blocked";
    startAgentEl.disabled = false;
    renderOverlayStartAction({ disabled: false, hidden: false });
    stopAgentEl.disabled = true;
    setVoiceLauncherState("idle", "Start voice");
    targetSummaryEl.textContent = "Session stopped.";
    return;
  }
  if (state.status === "connecting") {
    agentStateEl.textContent = "Connecting";
    agentStateEl.dataset.state = "blocked";
    startAgentEl.disabled = true;
    renderOverlayStartAction({ disabled: true, hidden: false });
    stopAgentEl.disabled = true;
    setVoiceLauncherState("thinking", "Connecting");
    targetSummaryEl.textContent = "Starting voice session.";
    return;
  }
  if (state.status === "error") {
    agentStateEl.textContent = "Error";
    agentStateEl.dataset.state = "blocked";
    stopAgentEl.disabled = true;
    renderOverlayStartAction({ disabled: false, hidden: false });
    setVoiceLauncherState("error", "Voice error");
    targetSummaryEl.textContent = state.error || "Session error.";
  }
}

async function refreshCredentialState() {
  renderCredentialState(await getOpenAiCredentialState(chrome.storage.local));
}

async function refreshBridgeUrl() {
  const stored = await chrome.storage.local.get("bridgeUrl");
  bridgeUrlEl.value = stored.bridgeUrl || DEFAULT_BRIDGE_URL;
}

async function refreshMemoryState() {
  renderMemoryState(await getAgentMemoryState(chrome.storage.local));
}

async function refreshSessionState() {
  if (typeof sessionManager.refreshState !== "function") {
    renderSessionState(sessionManager.getState());
    return;
  }
  renderSessionState(await sessionManager.refreshState());
}

async function refreshRealtimeVoice() {
  const voice = await getRealtimeVoice(chrome.storage.local);
  if (voiceSelectEl) {
    voiceSelectEl.value = voice;
  }
  return voice;
}

function currentTurnDetectionFormValue() {
  return {
    mode: vadModeEl?.value,
    threshold: Number(vadThresholdEl?.value),
    silenceDurationMs: Number(vadSilenceDurationEl?.value),
    eagerness: vadEagernessEl?.value,
    interruptResponse: Boolean(vadInterruptResponseEl?.checked),
  };
}

function renderTurnDetectionSettings(settings) {
  if (vadModeEl) vadModeEl.value = settings.mode;
  if (vadThresholdEl) vadThresholdEl.value = String(settings.threshold);
  if (vadSilenceDurationEl) vadSilenceDurationEl.value = String(settings.silenceDurationMs);
  if (vadEagernessEl) vadEagernessEl.value = settings.eagerness;
  if (vadInterruptResponseEl) vadInterruptResponseEl.checked = settings.interruptResponse;
}

async function refreshTurnDetectionSettings() {
  const settings = await getRealtimeTurnDetectionSettings(chrome.storage.local);
  renderTurnDetectionSettings(settings);
  return settings;
}

function renderProtofaceSettings(settings) {
  if (protofaceEnabledEl) protofaceEnabledEl.checked = settings.enabled;
  if (protofaceConnectionModeEl) protofaceConnectionModeEl.value = settings.connectionMode;
  if (protofaceBrokerFieldsEl) protofaceBrokerFieldsEl.hidden = settings.connectionMode !== "broker";
  if (protofaceDirectCredentialFieldsEl) protofaceDirectCredentialFieldsEl.hidden = settings.connectionMode !== "direct";
  if (protofaceBrokerUrlEl) protofaceBrokerUrlEl.value = settings.brokerUrl;
  if (protofaceAvatarIdEl) protofaceAvatarIdEl.value = settings.avatarId;
}

function renderProtofaceCredentialState(state) {
  if (!protofaceCredentialStatusEl) return;
  protofaceCredentialStatusEl.textContent = state.configured
    ? `Protoface credentials configured from ${state.source || "unknown source"}. Secret fields stay blank.`
    : "Protoface credentials not configured.";
  protofaceCredentialStatusEl.dataset.error = "false";
}

async function refreshProtofaceCredentialState() {
  const state = await getProtofaceCredentialState(chrome.storage.local);
  renderProtofaceCredentialState(state);
  return state;
}

async function refreshProtofaceSettings() {
  const settings = await getProtofaceSettings(chrome.storage.local);
  renderProtofaceSettings(settings);
  return settings;
}

function currentProtofaceSettingsFormValue() {
  return {
    enabled: Boolean(protofaceEnabledEl?.checked),
    connectionMode: protofaceConnectionModeEl?.value,
    brokerUrl: protofaceBrokerUrlEl?.value,
    avatarId: protofaceAvatarIdEl?.value,
  };
}

let protofaceMutationInFlight = false;

function setProtofaceMutationBusy(busy) {
  protofaceMutationInFlight = busy;
  for (const control of [
    protofaceEnabledEl,
    protofaceConnectionModeEl,
    protofaceBrokerUrlEl,
    protofaceAvatarIdEl,
    protofaceApiKeyEl,
    livekitUrlEl,
    livekitApiKeyEl,
    livekitApiSecretEl,
    saveProtofaceSettingsEl,
    saveProtofaceCredentialsEl,
    clearProtofaceCredentialsEl,
  ]) {
    if (control) control.disabled = busy;
  }
}

async function persistProtofaceSettings() {
  if (protofaceMutationInFlight) return;
  setProtofaceMutationBusy(true);
  try {
    const settings = await saveProtofaceSettings(chrome.storage.local, currentProtofaceSettingsFormValue());
    renderProtofaceSettings(settings);
    if (!settings.enabled && protofaceAvatarMode && protofaceController) {
      await protofaceController.stop();
      handleProtofaceUiEvent({ type: "protoface.avatar.state", state: "fallback", reason: "disabled" });
    }
    protofaceSettingsStatusEl.textContent = settings.enabled
      ? "Avatar enabled. Reopen the actions.json overlay to apply it."
      : "Avatar disabled. Reopen the actions.json overlay to return to the standard agent.";
    protofaceSettingsStatusEl.dataset.error = "false";
  } catch (error) {
    protofaceSettingsStatusEl.textContent = error.message || String(error);
    protofaceSettingsStatusEl.dataset.error = "true";
  } finally {
    setProtofaceMutationBusy(false);
  }
}

async function persistProtofaceCredentials() {
  if (protofaceMutationInFlight) return;
  setProtofaceMutationBusy(true);
  try {
    const saved = await saveProtofaceDirectConfiguration(chrome.storage.local, {
      credentials: {
        protofaceApiKey: protofaceApiKeyEl?.value,
        livekitUrl: livekitUrlEl?.value,
        livekitApiKey: livekitApiKeyEl?.value,
        livekitApiSecret: livekitApiSecretEl?.value,
      },
      settings: currentProtofaceSettingsFormValue(),
    }, { source: "manual" });
    if (protofaceApiKeyEl) protofaceApiKeyEl.value = "";
    if (livekitUrlEl) livekitUrlEl.value = "";
    if (livekitApiKeyEl) livekitApiKeyEl.value = "";
    if (livekitApiSecretEl) livekitApiSecretEl.value = "";
    renderProtofaceCredentialState(saved.credentialState);
    renderProtofaceSettings(saved.settings);
    protofaceSettingsStatusEl.textContent = saved.settings.enabled
      ? "Credentials and avatar settings saved. Reopen the actions.json overlay to use Protoface."
      : "Credentials and avatar settings saved. Enable Protoface before reopening the overlay.";
    protofaceSettingsStatusEl.dataset.error = "false";
  } catch (error) {
    const message = error.message || String(error);
    protofaceCredentialStatusEl.textContent = message;
    protofaceCredentialStatusEl.dataset.error = "true";
    protofaceSettingsStatusEl.textContent = `Credentials and avatar settings were not saved. ${message}`;
    protofaceSettingsStatusEl.dataset.error = "true";
  } finally {
    setProtofaceMutationBusy(false);
  }
}

async function removeProtofaceCredentials() {
  if (protofaceMutationInFlight) return;
  setProtofaceMutationBusy(true);
  try {
    renderProtofaceCredentialState(await clearProtofaceCredentials(chrome.storage.local));
  } catch (error) {
    protofaceCredentialStatusEl.textContent = error.message || String(error);
    protofaceCredentialStatusEl.dataset.error = "true";
  } finally {
    setProtofaceMutationBusy(false);
  }
}

async function persistTurnDetectionSettings() {
  try {
    const settings = await saveRealtimeTurnDetectionSettings(chrome.storage.local, currentTurnDetectionFormValue());
    renderTurnDetectionSettings(settings);
    vadStatusEl.textContent = `Turn detection saved: ${settings.mode}.`;
    vadStatusEl.dataset.error = "false";
  } catch (error) {
    vadStatusEl.textContent = error.message || String(error);
    vadStatusEl.dataset.error = "true";
  }
}

saveKeyEl.addEventListener("click", async () => {
  try {
    const state = await saveOpenAiApiKey(chrome.storage.local, apiKeyEl.value);
    apiKeyEl.value = "";
    renderCredentialState(state);
    setStatus("OpenAI key saved.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

clearKeyEl.addEventListener("click", async () => {
  try {
    const state = await clearOpenAiApiKey(chrome.storage.local);
    renderCredentialState(state);
    setStatus("OpenAI key removed.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

authorizeBridgeEl.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    const bridgeUrl = bridgeUrlEl.value.trim() || DEFAULT_BRIDGE_URL;
    await chrome.storage.local.set({ bridgeUrl });
    setBridgeStatus("Connecting securely and waiting for runtime registration.");
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
    await refreshCredentialState();
    setBridgeStatus(`Connected and verified. Runtime ${response.runtimeId} is registered.`);
  } catch (error) {
    setBridgeStatus(error.message || String(error), true);
  }
});

async function requestOverlayClose() {
  try {
    const tab = await getActiveTab();
    await chrome.tabs.sendMessage(tab.id, { type: "actions-json:close-overlay" });
    setBridgeStatus("Close request sent.");
  } catch (error) {
    setBridgeStatus(error.message || String(error), true);
  }
}

closeOverlayEl.addEventListener("click", requestOverlayClose);
closeAgentOverlayEl?.addEventListener("click", requestOverlayClose);

loadStorageFolderEl?.addEventListener("click", async () => {
  try {
    const handle = await getStorageDirectoryHandleForOperation();
    if (!handle) {
      return;
    }
    const entries = await readDirectoryEntries(handle);
    const bundle = storageBundleFromFolderEntries(entries, {
      defaultScope: defaultScopeForSelectedFolder(handle.name),
    });
    await chrome.storage.local.set({ [EXTENSION_STORAGE_BUNDLE_KEY]: bundle });
    setStorageFolderStatus(`Uploaded ${bundle.entries.length} file(s) from ${handle.name}.`);
  } catch (error) {
    setStorageFolderStatus(`Upload failed: ${error.message || String(error)}`, true);
  }
});

writeStorageFolderEl?.addEventListener("click", async () => {
  try {
    const handle = await getStorageDirectoryHandleForOperation();
    if (!handle) {
      return;
    }
    const stored = await chrome.storage.local.get(EXTENSION_STORAGE_BUNDLE_KEY);
    const bundle = stored?.[EXTENSION_STORAGE_BUNDLE_KEY];
    const targets = Array.isArray(bundle?.entries)
      ? bundle.entries.map((entry) => ({
          path: entry.path,
          parts: String(entry.path || "").split("/").filter(Boolean),
          text: String(entry.content ?? ""),
        }))
      : [];
    if (targets.length === 0) {
      setStorageFolderStatus("No browser-local storage files are available to write.", true);
      return;
    }
    const written = [];
    for (const target of targets) {
      await writeTextAtPath(handle, writePartsForSelectedFolder(target, handle), target.text);
      written.push(target.path);
    }
    setStorageFolderStatus(`Downloaded ${written.length} file(s) to ${handle.name}. Review with git diff before committing.`);
  } catch (error) {
    setStorageFolderStatus(`Download failed: ${error.message || String(error)}`, true);
  }
});

async function startProtofaceAvatar() {
  if (!protofaceAvatarMode) return { ready: false, error: "disabled" };
  try {
    await protofaceController?.stop?.();
    const settings = await getProtofaceSettings(chrome.storage.local);
    protofaceController = new ProtofaceAvatarController({
      settings,
      videoElement: protofaceVideoEl,
      audioElement: protofaceAudioEl,
      ProtofaceClientClass: globalThis.__ACTIONS_JSON_PROTOFACE_CLIENT_CLASS,
      eventObserver: handleProtofaceUiEvent,
    });
    return await protofaceController.start();
  } catch {
    handleProtofaceUiEvent({
      type: "protoface.avatar.state",
      state: "fallback",
      reason: "settings_unavailable",
    });
    return { ready: false, error: "settings_unavailable" };
  }
}

let voiceStartPending = false;

async function startVoiceSession() {
  if (voiceStartPending) {
    return;
  }
  voiceStartPending = true;
  try {
    const credential = await getOpenAiCredentialState(chrome.storage.local);
    if (!credential.configured) {
      setOverlayDisclosure("opened");
      selectPanel("config");
      setStatus("Add an OpenAI API key, then choose Start voice.");
      apiKeyEl.focus();
      return;
    }
    agentStateEl.textContent = "Connecting";
    agentStateEl.dataset.state = "blocked";
    setVoiceLauncherState("thinking", "Connecting");
    startAgentEl.disabled = true;
    renderOverlayStartAction({ disabled: true, hidden: false });
    const microphonePermission = await getMicrophonePermissionState();
    appendTranscriptLine(`Microphone permission: ${microphonePermission}.`);
    if (microphonePermission === "denied") {
      const error = new Error(
        "Microphone permission is blocked. Open Chrome microphone settings and allow this extension, then retry.",
      );
      error.name = "NotAllowedError";
      throw error;
    }
    if (needsVisibleMicrophoneGrant) {
      await requestVisibleMicrophoneGrant();
    }
    await startProtofaceAvatar();
    await loadHostedRealtimeTools();
    const state = await sessionManager.start({ textOnly: false });
    renderSessionState(state);
    appendTranscriptLine("Voice session started.");
    await refreshMemoryState();
  } catch (error) {
    try {
      await protofaceController?.stop?.();
    } catch {
      // Preserve the Realtime startup error shown to the user.
    }
    const message = await renderRetryableSessionError(error);
    setStatus(message, true);
  } finally {
    voiceStartPending = false;
  }
}

startAgentEl.addEventListener("click", startVoiceSession);
overlayStartAgentEl?.addEventListener("click", startVoiceSession);

stopAgentEl.addEventListener("click", async () => {
  try {
    const state = await sessionManager.stop();
    await protofaceController?.stop?.();
    renderSessionState(state);
    appendTranscriptLine("Voice session stopped.");
    await refreshMemoryState();
  } catch (error) {
    try {
      await protofaceController?.stop?.();
    } catch {
      // Preserve the primary session-stop error.
    }
    setStatus(error.message || String(error), true);
  }
});

muteMicEl?.addEventListener("click", async () => {
  try {
    const state = sessionManager.getState();
    renderSessionState(await sessionManager.setInputMuted(!state.inputMuted));
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

muteSpeakerEl?.addEventListener("click", async () => {
  try {
    const state = sessionManager.getState();
    renderSessionState(await sessionManager.setOutputMuted(!state.outputMuted));
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

agentTextFormEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = agentTextInputEl?.value?.trim() || "";
  if (!text) {
    return;
  }
  sendAgentTextEl.disabled = true;
  agentTextInputEl.disabled = true;
  try {
    await sessionManager.sendUserMessage({ text });
    agentTextInputEl.value = "";
    renderAudioControlState(sessionManager.getState());
  } catch (error) {
    appendTranscriptLine(`Error: ${error.message || String(error)}`);
    renderAudioControlState(sessionManager.getState());
  }
});

clearMemoryEl.addEventListener("click", async () => {
  try {
    await clearAgentMemory(chrome.storage.local);
    memoryStatusEl.textContent = "Memory cleared.";
  } catch (error) {
    memoryStatusEl.textContent = error.message || String(error);
  }
});

voiceSelectEl?.addEventListener("change", async () => {
  try {
    const voice = await saveRealtimeVoice(chrome.storage.local, voiceSelectEl.value);
    voiceSelectEl.value = voice;
    voiceStatusEl.textContent = `Voice saved: ${voice}.`;
    voiceStatusEl.dataset.error = "false";
  } catch (error) {
    voiceStatusEl.textContent = error.message || String(error);
    voiceStatusEl.dataset.error = "true";
  }
});

saveProtofaceSettingsEl?.addEventListener("click", persistProtofaceSettings);
saveProtofaceCredentialsEl?.addEventListener("click", persistProtofaceCredentials);
clearProtofaceCredentialsEl?.addEventListener("click", removeProtofaceCredentials);
protofaceConnectionModeEl?.addEventListener("change", () => {
  const direct = protofaceConnectionModeEl.value === "direct";
  if (protofaceDirectCredentialFieldsEl) protofaceDirectCredentialFieldsEl.hidden = !direct;
  if (protofaceBrokerFieldsEl) protofaceBrokerFieldsEl.hidden = direct;
});

for (const element of [
  vadModeEl,
  vadThresholdEl,
  vadSilenceDurationEl,
  vadEagernessEl,
  vadInterruptResponseEl,
]) {
  element?.addEventListener("change", persistTurnDetectionSettings);
}

agentTabEl?.addEventListener("click", () => {
  selectPanel("agent");
});

configTabEl?.addEventListener("click", () => {
  selectPanel("config");
});

transcriptViewTabEl?.addEventListener("click", () => selectAgentView("transcript"));
costViewTabEl?.addEventListener("click", () => selectAgentView("cost"));

refreshCredentialState().catch((error) => {
  setStatus(error.message || String(error), true);
});

refreshBridgeUrl().catch((error) => {
  setBridgeStatus(error.message || String(error), true);
});

refreshMemoryState().catch((error) => {
  memoryStatusEl.textContent = error.message || String(error);
});

refreshSessionState().catch((error) => {
  targetSummaryEl.textContent = error.message || String(error);
});

refreshRealtimeVoice().catch((error) => {
  voiceStatusEl.textContent = error.message || String(error);
  voiceStatusEl.dataset.error = "true";
});

refreshTurnDetectionSettings().catch((error) => {
  vadStatusEl.textContent = error.message || String(error);
  vadStatusEl.dataset.error = "true";
});

refreshProtofaceSettings().catch((error) => {
  protofaceSettingsStatusEl.textContent = error.message || String(error);
  protofaceSettingsStatusEl.dataset.error = "true";
});

refreshProtofaceCredentialState().catch((error) => {
  protofaceCredentialStatusEl.textContent = error.message || String(error);
  protofaceCredentialStatusEl.dataset.error = "true";
});

// ---------------------------------------------------------------------------
// U9 — the Debug tab.
//
// WHY THIS READS THE STORE DIRECTLY, NOT THE runtime.session.log PRIMITIVE
// ------------------------------------------------------------------------
// content.js exposes a `runtime.session.log` primitive that proxies to the
// background worker via sendRuntimeMessage. That path exists because content.js
// runs in the PAGE world, where chrome.storage.local is unreachable — it has to
// ask someone else.
//
// This document is different: agent-surface.html is an EXTENSION-ORIGIN page, so it
// holds chrome.storage.local directly. `getAgentSessionLog(chrome.storage.local)`
// is the same read the background worker would perform on our behalf, minus a
// message hop, minus a worker that may be asleep, minus a serialization round
// trip that can quietly drop a field — which is exactly the failure mode this
// whole unit exists to stop happening again. Fewer hops, fewer places to lose
// `status_details`.
//
// WHY THE TAB IS BUILT RATHER THAN HIDDEN
// ---------------------------------------
// Everything below is created with createElement and appended only when devMode
// is on. With devMode off nothing is appended and the previously-built nodes
// are REMOVED, so #debugTab and #debugLog are absent from the document rather
// than present-with-display-none. A debug surface that is merely hidden is
// still in the tree for anything that walks it.
// ---------------------------------------------------------------------------
const DEBUG_LOG_LIMIT = 200;

const unreadErrorTracker = createUnreadErrorTracker();

let debugNodes = null;
let selectedAgentView = "transcript";

function debugViewIsMounted() {
  return debugNodes !== null;
}

function setDebugUnreadIndicator(hasUnread) {
  if (!debugNodes) return;
  debugNodes.tabButton.dataset.unread = String(Boolean(hasUnread));
}

function renderDebugEntry(entry) {
  const article = document.createElement("article");
  article.className = "debug-entry";
  article.dataset.entryType = entry.type;
  // The outcome is a DATA ATTRIBUTE as well as a colour so a test can assert
  // the decision rather than inspecting a computed style, and so
  // success/failure/indeterminate stay three distinguishable values.
  article.dataset.outcome = entry.outcome;
  article.style.setProperty("--debug-hue", entry.token.hue);
  article.style.setProperty("--debug-background", entry.token.background);

  const head = document.createElement("div");
  head.className = "debug-entry-head";

  const typeEl = document.createElement("span");
  typeEl.className = "debug-entry-type";
  typeEl.textContent = entry.typeLabel;
  head.append(typeEl);

  if (entry.token.label) {
    const outcomeEl = document.createElement("span");
    outcomeEl.className = "debug-entry-outcome";
    outcomeEl.dataset.outcome = entry.outcome;
    // The word, not only the hue: the state must survive greyscale.
    outcomeEl.textContent = entry.token.label;
    head.append(outcomeEl);
  }

  if (entry.timestamp) {
    const timeEl = document.createElement("time");
    timeEl.className = "debug-entry-time";
    timeEl.dateTime = entry.timestamp;
    timeEl.textContent = entry.timestamp;
    head.append(timeEl);
  }

  article.append(head);

  if (entry.summary) {
    const summaryEl = document.createElement("div");
    summaryEl.className = "debug-entry-summary";
    summaryEl.textContent = entry.summary;
    article.append(summaryEl);
  }

  if (entry.failureClass) {
    const classEl = document.createElement("div");
    classEl.className = "debug-entry-field";
    classEl.dataset.field = "failure_class";
    classEl.textContent = `failure_class: ${entry.failureClass}`;
    article.append(classEl);
  }

  for (const field of entry.fields) {
    const fieldEl = document.createElement("div");
    fieldEl.className = "debug-entry-field";
    fieldEl.dataset.field = field.label;
    const labelEl = document.createElement("span");
    labelEl.className = "debug-field-label";
    labelEl.textContent = `${field.label}: `;
    fieldEl.append(labelEl, document.createTextNode(field.value));
    article.append(fieldEl);
  }

  // status_details — the field whose absence made Greg's failure
  // undiagnosable. Error type, code, and the BEGINNING of the message, because
  // the cause lives at the front of the string.
  if (entry.statusDetails) {
    const details = document.createElement("div");
    details.className = "debug-status-details";
    details.dataset.statusDetails = "true";
    for (const [key, value] of [
      ["type", entry.statusDetails.type],
      ["reason", entry.statusDetails.reason],
      ["error.type", entry.statusDetails.errorType],
      ["error.code", entry.statusDetails.code],
      ["error.param", entry.statusDetails.param],
    ]) {
      if (!value) continue;
      const row = document.createElement("div");
      row.dataset.detail = key;
      row.textContent = `${key}: ${value}`;
      details.append(row);
    }
    if (entry.statusDetails.message) {
      const message = document.createElement("div");
      message.className = "debug-status-message";
      message.dataset.detail = "error.message";
      message.textContent = `error.message: ${entry.statusDetails.message}`;
      details.append(message);
    }
    article.append(details);
  }

  return article;
}

function renderDebugLog(presentation) {
  if (!debugNodes) return;
  const { logEl } = debugNodes;
  logEl.textContent = "";

  // An empty log is an EMPTY STATE, never an error. A fresh session having no
  // events is the ordinary condition; painting it red trains the user to
  // ignore red.
  if (presentation.isEmpty) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.dataset.debugEmpty = "true";
    empty.textContent = presentation.emptyMessage;
    logEl.append(empty);
    return;
  }

  for (const entry of presentation.entries) {
    logEl.append(renderDebugEntry(entry));
  }
}

async function refreshDebugLog() {
  if (!debugNodes) return null;
  const log = await getAgentSessionLog(chrome.storage.local, { limit: DEBUG_LOG_LIMIT });
  const presentation = presentSessionLog(log);
  renderDebugLog(presentation);
  const hasUnread = unreadErrorTracker.observe(presentation);
  // Viewing the tab IS the read. If the user is looking at it right now, a
  // freshly-arrived error is already seen and the dot must not light.
  setDebugUnreadIndicator(
    selectedAgentView === "debug" ? unreadErrorTracker.markRead() : hasUnread,
  );
  return presentation;
}

function selectAgentView(viewName) {
  const allowed = viewName === "cost" || (viewName === "debug" && debugNodes)
    ? viewName
    : "transcript";
  selectedAgentView = allowed;
  const debugViewActive = allowed === "debug";
  transcriptViewTabEl?.setAttribute("aria-selected", String(allowed === "transcript"));
  costViewTabEl?.setAttribute("aria-selected", String(allowed === "cost"));
  debugNodes?.tabButton.setAttribute("aria-selected", String(debugViewActive));
  if (agentConversationEl) agentConversationEl.hidden = allowed !== "transcript";
  if (agentCostPanelEl) agentCostPanelEl.hidden = allowed !== "cost";
  if (debugNodes) debugNodes.logEl.hidden = !debugViewActive;
  if (debugViewActive) {
    // The dot clears on VIEW, not on fetch: fetching happens on a storage
    // change the user never sees.
    setDebugUnreadIndicator(unreadErrorTracker.markRead());
    refreshDebugLog().catch(() => {});
  }
}

function selectDebugView(active) {
  selectAgentView(active ? "debug" : "transcript");
}

function mountDebugView() {
  if (debugNodes) return;
  if (!agentViewTabsEl || !agentConversationEl) return;

  const tabButton = document.createElement("button");
  tabButton.type = "button";
  tabButton.id = "debugTab";
  tabButton.className = "agent-view-tab";
  tabButton.setAttribute("role", "tab");
  tabButton.setAttribute("aria-selected", "false");
  tabButton.dataset.unread = "false";
  tabButton.append(document.createTextNode("Debug"));

  const dot = document.createElement("span");
  dot.className = "unread-dot";
  dot.id = "debugUnreadDot";
  dot.setAttribute("aria-hidden", "true");
  tabButton.append(dot);

  const logEl = document.createElement("div");
  logEl.id = "debugLog";
  logEl.className = "debug-log";
  logEl.setAttribute("role", "tabpanel");
  logEl.setAttribute("aria-label", "Session debug log");
  logEl.hidden = true;

  agentViewTabsEl.append(tabButton);
  agentConversationEl.parentNode.insertBefore(logEl, agentConversationEl.nextSibling);

  tabButton.addEventListener("click", () => selectDebugView(true));

  debugNodes = { tabButton, logEl, dot };
  selectAgentView(selectedAgentView);
  refreshDebugLog().catch(() => {});
}

function unmountDebugView() {
  if (!debugNodes) return;
  // REMOVE, do not hide. With devMode off these ids must not resolve at all.
  debugNodes.tabButton.remove();
  debugNodes.logEl.remove();
  debugNodes = null;
  if (selectedAgentView === "debug") {
    selectAgentView("transcript");
  }
}

async function refreshDebugView() {
  const settings = await getOverlaySettings(chrome.storage.local);
  if (settings.devMode) {
    mountDebugView();
  } else {
    unmountDebugView();
  }
  return settings;
}

refreshDebugView().catch(() => {});

chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  // The popup writes devMode through the shared overlay settings store; this
  // is how the tab appears and disappears without a reload.
  if (Object.prototype.hasOwnProperty.call(changes, OVERLAY_SETTINGS_STORAGE_KEY)) {
    refreshDebugView().catch(() => {});
  }
  // A new event landing in memory is what lights the unread dot.
  if (
    Object.prototype.hasOwnProperty.call(changes, AGENT_MEMORY_STORAGE_KEY) &&
    debugViewIsMounted()
  ) {
    refreshDebugLog().catch(() => {});
  }
  if (Object.prototype.hasOwnProperty.call(changes, "ACTIONS_JSON_OPENAI_API_KEY")) {
    refreshCredentialState().catch((error) => {
      setStatus(error.message || String(error), true);
    });
  }
  if (Object.prototype.hasOwnProperty.call(changes, "bridgeUrl")) {
    refreshBridgeUrl().catch((error) => {
      setBridgeStatus(error.message || String(error), true);
    });
  }
  if (Object.prototype.hasOwnProperty.call(changes, "ACTIONS_JSON_AGENT_MEMORY_V1")) {
    refreshMemoryState().catch((error) => {
      memoryStatusEl.textContent = error.message || String(error);
    });
  }
  if (Object.prototype.hasOwnProperty.call(changes, REALTIME_VOICE_STORAGE_KEY)) {
    refreshRealtimeVoice().catch((error) => {
      voiceStatusEl.textContent = error.message || String(error);
      voiceStatusEl.dataset.error = "true";
    });
  }
  if (Object.prototype.hasOwnProperty.call(changes, REALTIME_TURN_DETECTION_STORAGE_KEY)) {
    refreshTurnDetectionSettings().catch((error) => {
      vadStatusEl.textContent = error.message || String(error);
      vadStatusEl.dataset.error = "true";
    });
  }
  if (Object.prototype.hasOwnProperty.call(changes, PROTOFACE_SETTINGS_STORAGE_KEY)) {
    refreshProtofaceSettings().catch((error) => {
      protofaceSettingsStatusEl.textContent = error.message || String(error);
      protofaceSettingsStatusEl.dataset.error = "true";
    });
  }
  if (Object.prototype.hasOwnProperty.call(changes, PROTOFACE_CREDENTIAL_STORAGE_KEY)) {
    refreshProtofaceCredentialState().catch((error) => {
      protofaceCredentialStatusEl.textContent = error.message || String(error);
      protofaceCredentialStatusEl.dataset.error = "true";
    });
  }
});

globalThis.addEventListener?.("pagehide", () => {
  void protofaceController?.stop?.();
  pillWave?.dispose?.();
  pillAmplitudeChannel?.close?.();
});

// ---------------------------------------------------------------------------
// The resting pill. Rendered only on the overlay surface — the side panel and
// the popup keep the full transcript view. Read the same way the tab param is
// read above.
//
// The pill lives in THIS document, the extension iframe, and not in content.js's
// shadow host: only a visible extension surface can request microphone
// permission (docs/chrome-extension.md:78-80). The iframe is why a voice
// product can hear the user, so the pill's content belongs here and the shadow
// host stays position-and-size only.
// ---------------------------------------------------------------------------
const surfaceParams = new URLSearchParams(location.search);
const isOverlaySurface = surfaceParams.get("surface") === "overlay";
const DISCLOSURE_STATES = new Set(["resting", "controls", "opened"]);

function validatedParentOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const overlayParentOrigin = validatedParentOrigin(surfaceParams.get("parentOrigin"));
const requestedOverlayDisclosure = surfaceParams.get("disclosure");
const initialOverlayDisclosure = DISCLOSURE_STATES.has(requestedOverlayDisclosure)
  ? requestedOverlayDisclosure
  : "resting";
let overlayDisclosure = null;
let pillPointerInside = false;

function notifyOverlayDisclosure(state) {
  if (!overlayParentOrigin || !isOverlaySurface || protofaceAvatarMode) {
    return;
  }
  window.parent.postMessage({
    type: "actions-json:overlay-disclosure",
    version: 1,
    state,
  }, overlayParentOrigin);
}

function setOverlayDisclosure(state) {
  if (!DISCLOSURE_STATES.has(state) || !isOverlaySurface || protofaceAvatarMode) {
    return;
  }
  if (
    overlayDisclosure === state
    && agentPanelEl.dataset.disclosure === state
  ) {
    return;
  }
  overlayDisclosure = state;
  agentPanelEl.dataset.disclosure = state;
  agentPillToggleEl?.setAttribute("aria-expanded", String(state === "opened"));
  if (state === "opened") {
    selectAgentView(selectedAgentView);
  }
  notifyOverlayDisclosure(state);
}

if (isOverlaySurface) {
  document.body.classList.add("agent-surface-overlay");

  if (!protofaceAvatarMode) {
    setOverlayDisclosure(initialOverlayDisclosure);
    agentPillEl?.addEventListener("pointerenter", () => {
      pillPointerInside = true;
      if (overlayDisclosure === "resting") {
        setOverlayDisclosure("controls");
      }
    });
    agentPanelEl?.addEventListener("pointerleave", () => {
      pillPointerInside = false;
      if (
        overlayDisclosure === "controls"
        && !agentPanelEl.contains(document.activeElement)
      ) {
        setOverlayDisclosure("resting");
      }
    });
    agentPanelEl?.addEventListener("focusin", () => {
      if (overlayDisclosure === "resting") {
        setOverlayDisclosure("controls");
      }
    });
    agentPanelEl?.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (
          overlayDisclosure === "controls"
          && !pillPointerInside
          && !agentPanelEl.contains(document.activeElement)
        ) {
          setOverlayDisclosure("resting");
        }
      });
    });
    agentPillToggleEl?.addEventListener("click", () => {
      setOverlayDisclosure("opened");
    });
    openAgentDetailsEl?.addEventListener("click", () => {
      setOverlayDisclosure("opened");
      transcriptViewTabEl?.focus();
    });
    globalThis.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || overlayDisclosure === "resting") {
        return;
      }
      event.preventDefault();
      agentPillToggleEl?.focus();
      setOverlayDisclosure("resting");
    });
  }

  // Amplitude envelopes ride their own message type (U2). They arrive at ~15Hz
  // and are the only thing on that channel, so the listener stays cheap.
  chrome.runtime?.onMessage?.addListener?.((message) => {
    if (message?.type !== "actions-json:agent-audio-amplitude") return;
    handlePillAmplitude(message.amplitude);
  });
  if (typeof globalThis.BroadcastChannel === "function") {
    pillAmplitudeChannel = new globalThis.BroadcastChannel(AMPLITUDE_BROADCAST_CHANNEL);
    pillAmplitudeChannel.addEventListener("message", (event) => {
      handlePillAmplitude(event.data);
    });
  }

  // A wave frozen mid-amplitude reads as "still listening" long after the audio
  // stopped, which is precisely the lie this pill exists to prevent. The
  // envelope stream simply ends when a track dies, so nothing else would ever
  // flatten it. Poll well below the 15Hz publish rate; the presenter's own
  // change-gate means a steady state costs no DOM writes.
  setInterval(() => pillPresenter.tick(), 250);
}

setVoiceLauncherState("idle", "Add key first");
selectPanel(selectedPanelFromUrl());

// Settings accordions collapse only in the constrained popup surface; the
// full-page settings view (and tests) keep every section expanded.
if (surfaceParams.get("surface") !== "popup") {
  for (const group of document.querySelectorAll("details.settings-group")) {
    group.open = true;
  }
} else {
  // In the popup, open the Bridge section automatically when no bridge URL is
  // stored yet (fresh install) so the unconfigured connection is visible.
  chrome.storage?.local?.get?.("bridgeUrl").then((stored) => {
    if (stored?.bridgeUrl) {
      return;
    }
    for (const group of document.querySelectorAll("details.settings-group")) {
      if (group.querySelector("#bridgeUrl")) {
        group.open = true;
      }
    }
  }).catch(() => {});
}
