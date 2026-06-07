import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CREDENTIAL_STATE_MESSAGE,
  AGENT_KEY_STORAGE_KEY,
  clearOpenAiApiKey,
  getOpenAiCredentialState,
  redactedOpenAiKey,
  saveOpenAiApiKey,
} from "../src/agent/credential-store.mjs";

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (typeof key === "string") {
        return { [key]: data[key] };
      }
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((item) => [item, data[item]]));
      }
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

test("credential store saves and reports only a redacted OpenAI key", async () => {
  const storage = createStorage();

  const saved = await saveOpenAiApiKey(storage, "  sk-proj-abcdefghijklmnopqrstuvwxyz1234567890  ");

  assert.equal(saved.configured, true);
  assert.equal(saved.redacted, "sk-proj...7890");
  assert.equal(storage.data[AGENT_KEY_STORAGE_KEY], "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890");

  const state = await getOpenAiCredentialState(storage);
  assert.deepEqual(state, {
    configured: true,
    redacted: "sk-proj...7890",
  });
  assert.equal(JSON.stringify(state).includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("credential store rejects empty keys and clears stored keys", async () => {
  const storage = createStorage({ [AGENT_KEY_STORAGE_KEY]: "sk-proj-existing1234" });

  await assert.rejects(() => saveOpenAiApiKey(storage, "   "), /OpenAI API key is required/);

  const cleared = await clearOpenAiApiKey(storage);
  assert.deepEqual(cleared, { configured: false, redacted: null });
  assert.equal(storage.data[AGENT_KEY_STORAGE_KEY], undefined);
});

test("redacted OpenAI keys keep only enough information for user recognition", () => {
  assert.equal(redactedOpenAiKey("sk-proj-1234567890abcdef"), "sk-proj...cdef");
  assert.equal(redactedOpenAiKey("short-key"), "configured");
  assert.equal(redactedOpenAiKey(null), null);
});

test("public credential state message never includes the raw key", async () => {
  const storage = createStorage({ [AGENT_KEY_STORAGE_KEY]: "sk-proj-secret-value-123456" });

  const response = await AGENT_CREDENTIAL_STATE_MESSAGE.handle({ storage });

  assert.deepEqual(response, {
    ok: true,
    credential: {
      configured: true,
      redacted: "sk-proj...3456",
    },
  });
  assert.equal(JSON.stringify(response).includes("secret-value"), false);
});
