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
import { HostedRealtimeSessionManager } from "./agent/realtime-session-manager.mjs";
import {
  createRuntimeHostedSessionClient,
  createUnavailableHostedSessionClient,
} from "./agent/runtime-session-client.mjs";
import { RealtimeWebRtcTransportFactory } from "./agent/realtime-webrtc-transport.mjs";
import {
  siteBlockedPrimitiveNamesFromBundle,
} from "./agent/local-actions-catalog.mjs";
import {
  clearAgentMemory,
  getAgentMemoryState,
} from "./agent/session-memory-store.mjs";
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

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";
const EXTENSION_STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";
const DEFAULT_STORAGE_SCOPE = "private";
const EXTENSION_ACTIONS_URL = "actions/overlay.actions.json";
const TOP_LEVEL_STORAGE_SETTINGS_URL = "sidepanel.html?tab=config&surface=top-level";
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
const targetSummaryEl = document.getElementById("targetSummary");
const clearMemoryEl = document.getElementById("clearMemory");
const memoryStatusEl = document.getElementById("memoryStatus");
const transcriptEl = document.getElementById("transcript");
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
const useLocalRealtimeSession = globalThis.__ACTIONS_JSON_USE_FAKE_REALTIME === true
  || globalThis.__ACTIONS_JSON_FORCE_LOCAL_REALTIME === true;
const needsVisibleMicrophoneGrant = !useLocalRealtimeSession;
const transportFactory = useLocalRealtimeSession
  ? (globalThis.__ACTIONS_JSON_USE_FAKE_REALTIME === true
      ? new FakeRealtimeTransportFactory()
      : new RealtimeWebRtcTransportFactory())
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

const VOICE_ICONS = {
  idle: `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5 3.5l6.25 4.5L5 12.5z" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="0.6"></path></svg>`,
  connecting: `<svg aria-hidden="true" viewBox="0 0 16 16"><circle class="voice-launcher-dot" cx="3" cy="8" fill="currentColor" r="1.25"></circle><circle class="voice-launcher-dot" cx="8" cy="8" fill="currentColor" r="1.25"></circle><circle class="voice-launcher-dot" cx="13" cy="8" fill="currentColor" r="1.25"></circle></svg>`,
  live: `<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" fill="currentColor" r="3.25"></circle><circle cx="8" cy="8" fill="none" r="5.25" stroke="currentColor" stroke-opacity="0.24" stroke-width="1.5"></circle></svg>`,
  listening: `<svg aria-hidden="true" viewBox="0 0 16 16"><rect fill="none" height="6.5" rx="2.75" stroke="currentColor" stroke-width="1.5" width="5.5" x="5.25" y="2.25"></rect><path d="M3.75 7.75a4.25 4.25 0 0 0 8.5 0M8 12v1.75M5.5 13.75h5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path></svg>`,
  busy: `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.25 5.5h11.5M4 8h8M5.75 10.5h4.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"></path></svg>`,
  error: `<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="11.75" fill="currentColor" r="1"></circle><path d="M8 3.25v5.75" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"></path></svg>`,
};

function createSessionManager() {
  if (useLocalRealtimeSession) {
    return new HostedRealtimeSessionManager({
      storage: chrome.storage.local,
      transportFactory,
      toolExecutor: createChromeHostedToolExecutor({ chromeApi: chrome }),
      eventObserver: handleRealtimeUiEvent,
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
    const tools = await applyCurrentSiteToolPolicy(await fetchBridgeRealtimeToolCatalog({ chromeApi: chrome }));
    sessionManager.setTools(tools);
    const count = tools.filter((tool) => tool?.name).length;
    appendTranscriptLine(`Bridge tools loaded: ${count}.`);
    return tools;
  } catch (error) {
    const tools = await applyCurrentSiteToolPolicy(await loadLocalRealtimeTools());
    sessionManager.setTools(tools);
    const count = tools.filter((tool) => tool?.name).length;
    appendTranscriptLine(
      `Using ${count} extension-local tools; bridge tool catalog was not reachable.`,
    );
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

function setVoiceLauncherState(state, label) {
  startAgentEl.dataset.voiceState = state;
  voiceLauncherIconEl.innerHTML = VOICE_ICONS[state] || VOICE_ICONS.idle;
  voiceLauncherLabelEl.textContent = label;
  startAgentEl.setAttribute("aria-label", label);
}

function renderAudioControlState(state = sessionManager.getState()) {
  const connected = state.status === "connected";
  const textOnly = state.textOnly === true;
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
    setVoiceLauncherState("busy", "Using tool");
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
    setVoiceLauncherState("busy", "Thinking");
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
    setVoiceLauncherState("live", "Speaking");
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
    setVoiceLauncherState("live", "Session live");
    finalizeLiveTranscript("assistant", finalText);
    return;
  }
  if ((event?.type === "response.output_text.done" || event?.type === "response.text.done") && finalText) {
    finalizeLiveTranscript("assistant", finalText);
    return;
  }
  if (event?.type === "response.done") {
    setVoiceLauncherState("live", "Session live");
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
    stopAgentEl.disabled = false;
    setVoiceLauncherState("live", "Session live");
    targetSummaryEl.textContent = `${state.model} voice session connected.`;
    return;
  }
  if (state.status === "stopped") {
    agentStateEl.textContent = "Stopped";
    agentStateEl.dataset.state = "blocked";
    startAgentEl.disabled = false;
    stopAgentEl.disabled = true;
    setVoiceLauncherState("idle", "Start voice");
    targetSummaryEl.textContent = "Session stopped.";
    return;
  }
  if (state.status === "error") {
    agentStateEl.textContent = "Error";
    agentStateEl.dataset.state = "blocked";
    stopAgentEl.disabled = true;
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
    const response = await chrome.runtime.sendMessage({
      type: "actions-json:authorize-tab",
      tabId: tab.id,
      bridgeUrl,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Authorization failed");
    }
    setBridgeStatus("Authorized and connecting.");
  } catch (error) {
    setBridgeStatus(error.message || String(error), true);
  }
});

closeOverlayEl.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    await chrome.tabs.sendMessage(tab.id, { type: "actions-json:close-overlay" });
    setBridgeStatus("Close request sent.");
  } catch (error) {
    setBridgeStatus(error.message || String(error), true);
  }
});

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

startAgentEl.addEventListener("click", async () => {
  try {
    agentStateEl.textContent = "Connecting";
    agentStateEl.dataset.state = "blocked";
    setVoiceLauncherState("connecting", "Connecting");
    startAgentEl.disabled = true;
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
    await loadHostedRealtimeTools();
    const state = await sessionManager.start({ textOnly: false });
    renderSessionState(state);
    appendTranscriptLine("Voice session started.");
    await refreshMemoryState();
  } catch (error) {
    const message = await renderRetryableSessionError(error);
    setStatus(message, true);
  }
});

stopAgentEl.addEventListener("click", async () => {
  try {
    const state = await sessionManager.stop();
    renderSessionState(state);
    appendTranscriptLine("Voice session stopped.");
    await refreshMemoryState();
  } catch (error) {
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

chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local") {
    return;
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
});

setVoiceLauncherState("idle", "Add key first");
selectPanel(selectedPanelFromUrl());

// Settings accordions collapse only in the constrained popup surface; the
// full-page settings view (and tests) keep every section expanded.
if (new URLSearchParams(location.search).get("surface") !== "popup") {
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
