export const AGENT_KEY_STORAGE_KEY = "ACTIONS_JSON_OPENAI_API_KEY";

export function redactedOpenAiKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 16 || !trimmed.startsWith("sk-")) {
    return "configured";
  }
  const prefix = trimmed.startsWith("sk-proj-") ? "sk-proj" : "sk";
  return `${prefix}...${trimmed.slice(-4)}`;
}

async function getStoredKey(storage) {
  const stored = await storage.get(AGENT_KEY_STORAGE_KEY);
  const value = stored?.[AGENT_KEY_STORAGE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function loadOpenAiApiKey(storage) {
  const key = await getStoredKey(storage);
  if (!key) {
    throw new Error("OpenAI API key is required");
  }
  return key;
}

export async function getOpenAiCredentialState(storage) {
  const key = await getStoredKey(storage);
  return {
    configured: Boolean(key),
    redacted: redactedOpenAiKey(key),
  };
}

export async function saveOpenAiApiKey(storage, rawKey) {
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key) {
    throw new Error("OpenAI API key is required");
  }
  await storage.set({ [AGENT_KEY_STORAGE_KEY]: key });
  return getOpenAiCredentialState(storage);
}

export async function clearOpenAiApiKey(storage) {
  await storage.remove(AGENT_KEY_STORAGE_KEY);
  return { configured: false, redacted: null };
}

export const AGENT_CREDENTIAL_STATE_MESSAGE = {
  type: "actions-json:agent-credential-state",
  async handle({ storage }) {
    return {
      ok: true,
      credential: await getOpenAiCredentialState(storage),
    };
  },
};
