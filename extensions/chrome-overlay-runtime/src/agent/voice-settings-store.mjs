export const REALTIME_VOICE_STORAGE_KEY = "ACTIONS_JSON_REALTIME_VOICE";
export const REALTIME_TURN_DETECTION_STORAGE_KEY = "ACTIONS_JSON_REALTIME_TURN_DETECTION";
export const DEFAULT_REALTIME_VOICE = "cedar";
export const DEFAULT_REALTIME_TURN_DETECTION_SETTINGS = {
  mode: "server_vad",
  threshold: 0.5,
  silenceDurationMs: 800,
  eagerness: "auto",
  interruptResponse: true,
};
export const SUPPORTED_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

const supportedVoiceSet = new Set(SUPPORTED_REALTIME_VOICES);
const supportedVadModes = new Set(["server_vad", "semantic_vad"]);
const supportedEagerness = new Set(["low", "medium", "high", "auto"]);

function clampNumber(value, { min, max, fallback }) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, { min, max, fallback }) {
  return Math.round(clampNumber(value, { min, max, fallback }));
}

export function normalizeRealtimeVoice(value) {
  const voice = String(value || "").trim().toLowerCase();
  return supportedVoiceSet.has(voice) ? voice : DEFAULT_REALTIME_VOICE;
}

export async function getRealtimeVoice(storage) {
  const stored = await storage.get(REALTIME_VOICE_STORAGE_KEY);
  return normalizeRealtimeVoice(stored?.[REALTIME_VOICE_STORAGE_KEY]);
}

export async function saveRealtimeVoice(storage, voice) {
  const normalized = normalizeRealtimeVoice(voice);
  await storage.set({ [REALTIME_VOICE_STORAGE_KEY]: normalized });
  return normalized;
}

export function normalizeRealtimeTurnDetectionSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const mode = supportedVadModes.has(source.mode) ? source.mode : DEFAULT_REALTIME_TURN_DETECTION_SETTINGS.mode;
  return {
    mode,
    threshold: clampNumber(source.threshold, {
      min: 0,
      max: 1,
      fallback: DEFAULT_REALTIME_TURN_DETECTION_SETTINGS.threshold,
    }),
    silenceDurationMs: clampInteger(source.silenceDurationMs ?? source.silence_duration_ms, {
      min: 100,
      max: 5000,
      fallback: DEFAULT_REALTIME_TURN_DETECTION_SETTINGS.silenceDurationMs,
    }),
    eagerness: supportedEagerness.has(source.eagerness)
      ? source.eagerness
      : DEFAULT_REALTIME_TURN_DETECTION_SETTINGS.eagerness,
    interruptResponse: typeof source.interruptResponse === "boolean"
      ? source.interruptResponse
      : typeof source.interrupt_response === "boolean"
        ? source.interrupt_response
        : DEFAULT_REALTIME_TURN_DETECTION_SETTINGS.interruptResponse,
  };
}

export async function getRealtimeTurnDetectionSettings(storage) {
  const stored = await storage.get(REALTIME_TURN_DETECTION_STORAGE_KEY);
  return normalizeRealtimeTurnDetectionSettings(stored?.[REALTIME_TURN_DETECTION_STORAGE_KEY]);
}

export async function saveRealtimeTurnDetectionSettings(storage, settings) {
  const normalized = normalizeRealtimeTurnDetectionSettings(settings);
  await storage.set({ [REALTIME_TURN_DETECTION_STORAGE_KEY]: normalized });
  return normalized;
}

export function realtimeTurnDetectionConfig(settings = {}) {
  const normalized = normalizeRealtimeTurnDetectionSettings(settings);
  if (normalized.mode === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: normalized.eagerness,
      create_response: true,
      interrupt_response: normalized.interruptResponse,
    };
  }
  return {
    type: "server_vad",
    threshold: normalized.threshold,
    prefix_padding_ms: 300,
    silence_duration_ms: normalized.silenceDurationMs,
    create_response: true,
    interrupt_response: normalized.interruptResponse,
  };
}
