import {
  normalizeProtofaceSettings,
  PROTOFACE_SETTINGS_STORAGE_KEY,
} from "./protoface-settings-store.mjs";

export const PROTOFACE_CREDENTIAL_STORAGE_KEY = "ACTIONS_JSON_PROTOFACE_CREDENTIALS_V1";

export const PROTOFACE_REQUIRED_FIELDS = Object.freeze([
  Object.freeze(["protofaceApiKey", "Protoface API key"]),
  Object.freeze(["livekitUrl", "LiveKit URL"]),
  Object.freeze(["livekitApiKey", "LiveKit API key"]),
  Object.freeze(["livekitApiSecret", "LiveKit API secret"]),
]);

const PROTOFACE_CREDENTIAL_SOURCES = Object.freeze(["manual", "sidecar"]);

function sourceFrom(value) {
  const source = typeof value === "string" ? value.trim() : "";
  return PROTOFACE_CREDENTIAL_SOURCES.includes(source) ? source : null;
}

export function normalizeProtofaceCredentials(value = {}) {
  const normalized = Object.fromEntries(
    PROTOFACE_REQUIRED_FIELDS.map(([field]) => [field, String(value?.[field] || "").trim()]),
  );
  const missing = PROTOFACE_REQUIRED_FIELDS
    .filter(([field]) => !normalized[field])
    .map(([, label]) => label);
  if (missing.length > 0) {
    throw new Error(`Missing Protoface credentials: ${missing.join(", ")}.`);
  }

  const invalidLivekitUrl = "LiveKit URL must use wss:// or https:// without user credentials.";
  if (!/^(?:wss|https):\/\//i.test(normalized.livekitUrl)) {
    throw new Error(invalidLivekitUrl);
  }

  let livekitUrl;
  try {
    livekitUrl = new URL(normalized.livekitUrl);
  } catch {
    throw new Error(invalidLivekitUrl);
  }
  if (!["wss:", "https:"].includes(livekitUrl.protocol) || livekitUrl.username || livekitUrl.password) {
    throw new Error(invalidLivekitUrl);
  }
  normalized.livekitUrl = livekitUrl.toString();
  return normalized;
}

async function getStoredCredentials(storage) {
  const stored = await storage.get(PROTOFACE_CREDENTIAL_STORAGE_KEY);
  const value = stored?.[PROTOFACE_CREDENTIAL_STORAGE_KEY];
  return value && typeof value === "object" ? value : null;
}

function buildCredentialRecord(value, options = {}) {
  const credentials = normalizeProtofaceCredentials(value);
  const source = sourceFrom(options.source);
  return { source, record: { ...credentials, source } };
}

export async function saveProtofaceCredentials(storage, value, options = {}) {
  const { source, record } = buildCredentialRecord(value, options);
  await storage.set({
    [PROTOFACE_CREDENTIAL_STORAGE_KEY]: record,
  });
  return { configured: true, source };
}

export async function saveProtofaceDirectConfiguration(storage, value, options = {}) {
  const { source, record } = buildCredentialRecord(value?.credentials, options);
  const settings = normalizeProtofaceSettings(value?.settings);
  await storage.set({
    [PROTOFACE_CREDENTIAL_STORAGE_KEY]: record,
    [PROTOFACE_SETTINGS_STORAGE_KEY]: settings,
  });
  return {
    credentialState: { configured: true, source },
    settings,
  };
}

export async function loadProtofaceCredentials(storage) {
  const stored = await getStoredCredentials(storage);
  if (!stored) {
    throw new Error("Protoface credentials are required.");
  }
  return {
    ...normalizeProtofaceCredentials(stored),
    source: sourceFrom(stored.source),
  };
}

export async function getProtofaceCredentialState(storage) {
  const stored = await getStoredCredentials(storage);
  if (!stored) {
    return { configured: false, source: null };
  }
  try {
    normalizeProtofaceCredentials(stored);
  } catch {
    return { configured: false, source: null };
  }
  return {
    configured: true,
    source: sourceFrom(stored.source),
  };
}

export async function clearProtofaceCredentials(storage) {
  await storage.remove(PROTOFACE_CREDENTIAL_STORAGE_KEY);
  return { configured: false, source: null };
}
