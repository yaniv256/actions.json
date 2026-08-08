export const PROTOFACE_SETTINGS_STORAGE_KEY = "ACTIONS_JSON_PROTOFACE_SETTINGS_V1";

export const DEFAULT_PROTOFACE_SETTINGS = Object.freeze({
  enabled: false,
  connectionMode: "broker",
  brokerUrl: "http://127.0.0.1:3000/api/protoface/session-token",
  avatarId: "av_stock_001",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function normalizeBrokerUrl(value) {
  const candidate = String(value || DEFAULT_PROTOFACE_SETTINGS.brokerUrl).trim();
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Protoface broker URL must be a valid HTTPS URL or a loopback HTTP URL.");
  }

  const secure = url.protocol === "https:";
  const localDevelopment = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (!secure && !localDevelopment) {
    throw new Error("Protoface broker URL must use HTTPS; HTTP is allowed only for a loopback development server.");
  }
  return url.toString().replace(/\/$/, "");
}

export function normalizeProtofaceSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const enabled = source.enabled === true;
  const connectionMode = source.connectionMode == null
    ? DEFAULT_PROTOFACE_SETTINGS.connectionMode
    : String(source.connectionMode).trim();
  if (!new Set(["direct", "broker"]).has(connectionMode)) {
    throw new Error("Protoface connection mode must be direct or broker.");
  }
  const avatarId = String(source.avatarId || DEFAULT_PROTOFACE_SETTINGS.avatarId).trim();
  if (enabled && !avatarId) {
    throw new Error("Protoface avatar ID is required when the experimental avatar is enabled.");
  }
  return {
    enabled,
    connectionMode,
    brokerUrl: normalizeBrokerUrl(source.brokerUrl),
    avatarId: avatarId || DEFAULT_PROTOFACE_SETTINGS.avatarId,
  };
}

export async function getProtofaceSettings(storage) {
  const stored = await storage.get(PROTOFACE_SETTINGS_STORAGE_KEY);
  return normalizeProtofaceSettings(stored?.[PROTOFACE_SETTINGS_STORAGE_KEY]);
}

export async function saveProtofaceSettings(storage, settings) {
  const normalized = normalizeProtofaceSettings(settings);
  await storage.set({ [PROTOFACE_SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
}
