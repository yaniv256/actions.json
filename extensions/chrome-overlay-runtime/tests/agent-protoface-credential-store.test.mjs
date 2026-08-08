import assert from "node:assert/strict";
import test from "node:test";

import {
  PROTOFACE_CREDENTIAL_STORAGE_KEY,
  PROTOFACE_REQUIRED_FIELDS,
  clearProtofaceCredentials,
  getProtofaceCredentialState,
  loadProtofaceCredentials,
  normalizeProtofaceCredentials,
  saveProtofaceCredentials,
  saveProtofaceDirectConfiguration,
} from "../src/agent/protoface-credential-store.mjs";
import { PROTOFACE_SETTINGS_STORAGE_KEY } from "../src/agent/protoface-settings-store.mjs";

const COMPLETE_CREDENTIALS = Object.freeze({
  protofaceApiKey: "pf_secret_1234567890",
  livekitUrl: "wss://demo.livekit.cloud",
  livekitApiKey: "APIabcdef123456",
  livekitApiSecret: "livekit-secret-1234567890",
});

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(update) {
      Object.assign(values, update);
    },
    async remove(key) {
      delete values[key];
    },
  };
}

test("stores a complete set and exposes only redacted state", async () => {
  const storage = memoryStorage();

  const state = await saveProtofaceCredentials(storage, COMPLETE_CREDENTIALS, { source: "manual" });

  assert.deepEqual(state, { configured: true, source: "manual" });
  assert.deepEqual(await getProtofaceCredentialState(storage), state);
  assert.equal(JSON.stringify(state).includes("pf_secret"), false);
  assert.equal(JSON.stringify(state).includes("livekit-secret"), false);
  assert.deepEqual(storage.values[PROTOFACE_CREDENTIAL_STORAGE_KEY], {
    protofaceApiKey: "pf_secret_1234567890",
    livekitUrl: "wss://demo.livekit.cloud/",
    livekitApiKey: "APIabcdef123456",
    livekitApiSecret: "livekit-secret-1234567890",
    source: "manual",
  });
});

test("stores direct credentials and enabled avatar settings in one storage write", async () => {
  const storage = memoryStorage();
  let writes = 0;
  const originalSet = storage.set;
  storage.set = async (update) => {
    writes += 1;
    await originalSet(update);
  };

  const saved = await saveProtofaceDirectConfiguration(storage, {
    credentials: COMPLETE_CREDENTIALS,
    settings: {
      enabled: true,
      connectionMode: "direct",
      avatarId: "av_demo",
    },
  }, { source: "manual" });

  assert.equal(writes, 1);
  assert.deepEqual(saved, {
    credentialState: { configured: true, source: "manual" },
    settings: {
      enabled: true,
      connectionMode: "direct",
      brokerUrl: "http://127.0.0.1:3000/api/protoface/session-token",
      avatarId: "av_demo",
    },
  });
  assert.equal(JSON.stringify(saved).includes("pf_secret"), false);
  assert.equal(JSON.stringify(saved).includes("livekit-secret"), false);
  assert.equal(storage.values[PROTOFACE_CREDENTIAL_STORAGE_KEY].source, "manual");
  assert.deepEqual(storage.values[PROTOFACE_SETTINGS_STORAGE_KEY], saved.settings);
});

test("rejects an invalid direct configuration before writing either record", async () => {
  const storage = memoryStorage({
    [PROTOFACE_CREDENTIAL_STORAGE_KEY]: { preserved: "credentials" },
    [PROTOFACE_SETTINGS_STORAGE_KEY]: { preserved: "settings" },
  });
  let writes = 0;
  storage.set = async () => {
    writes += 1;
  };

  await assert.rejects(
    saveProtofaceDirectConfiguration(storage, {
      credentials: COMPLETE_CREDENTIALS,
      settings: {
        enabled: true,
        connectionMode: "unsupported",
        avatarId: "av_demo",
      },
    }, { source: "manual" }),
    /connection mode must be direct or broker/,
  );

  assert.equal(writes, 0);
  assert.deepEqual(storage.values, {
    [PROTOFACE_CREDENTIAL_STORAGE_KEY]: { preserved: "credentials" },
    [PROTOFACE_SETTINGS_STORAGE_KEY]: { preserved: "settings" },
  });
});

test("reports every missing input together", () => {
  assert.throws(
    () => normalizeProtofaceCredentials({ protofaceApiKey: "pf" }),
    /LiveKit URL, LiveKit API key, LiveKit API secret/,
  );
});

test("normalizes whitespace and accepts secure LiveKit URL protocols", () => {
  for (const livekitUrl of ["wss://demo.livekit.cloud", "https://demo.livekit.cloud"]) {
    assert.deepEqual(
      normalizeProtofaceCredentials({
        protofaceApiKey: "  pf_secret  ",
        livekitUrl: `  ${livekitUrl}  `,
        livekitApiKey: "  livekit-key  ",
        livekitApiSecret: "  livekit-secret  ",
      }),
      {
        protofaceApiKey: "pf_secret",
        livekitUrl: `${livekitUrl}/`,
        livekitApiKey: "livekit-key",
        livekitApiSecret: "livekit-secret",
      },
    );
  }
});

test("rejects invalid and insecure LiveKit URLs", () => {
  for (const livekitUrl of [
    "not a url",
    "https:example.com",
    "ws://demo.livekit.cloud",
    "http://demo.livekit.cloud",
    "wss://user:password@demo.livekit.cloud",
  ]) {
    assert.throws(
      () => normalizeProtofaceCredentials({ ...COMPLETE_CREDENTIALS, livekitUrl }),
      /LiveKit URL.*wss:\/\/ or https:\/\//,
    );
  }
});

test("loads the complete stored credentials for internal use", async () => {
  const storage = memoryStorage();
  await saveProtofaceCredentials(storage, {
    protofaceApiKey: "  pf_secret_1234567890  ",
    livekitUrl: "  wss://demo.livekit.cloud  ",
    livekitApiKey: "  APIabcdef123456  ",
    livekitApiSecret: "  livekit-secret-1234567890  ",
  }, { source: "manual" });

  assert.deepEqual(await loadProtofaceCredentials(storage), {
    ...COMPLETE_CREDENTIALS,
    livekitUrl: "wss://demo.livekit.cloud/",
    source: "manual",
  });
});

test("unknown source metadata is neither persisted nor returned", async () => {
  const storage = memoryStorage();
  const secretLikeSource = "metadata-secret-do-not-echo";

  const saved = await saveProtofaceCredentials(storage, COMPLETE_CREDENTIALS, {
    source: secretLikeSource,
  });

  assert.deepEqual(saved, { configured: true, source: null });
  assert.deepEqual(await getProtofaceCredentialState(storage), saved);
  assert.equal(storage.values[PROTOFACE_CREDENTIAL_STORAGE_KEY].source, null);
  assert.equal(JSON.stringify(storage.values).includes(secretLikeSource), false);
  assert.equal(JSON.stringify(saved).includes(secretLikeSource), false);
});

test("accepts only the opaque sources used by manual and sidecar delivery", async () => {
  for (const source of ["manual", "sidecar"]) {
    const storage = memoryStorage();
    assert.deepEqual(
      await saveProtofaceCredentials(storage, COMPLETE_CREDENTIALS, { source }),
      { configured: true, source },
    );
  }
});

test("reports unconfigured state when credentials do not exist", async () => {
  const storage = memoryStorage();

  assert.deepEqual(await getProtofaceCredentialState(storage), {
    configured: false,
    source: null,
  });
  await assert.rejects(() => loadProtofaceCredentials(storage), /Protoface credentials are required/);
});

test("treats malformed persisted credentials as unconfigured", async () => {
  const storage = memoryStorage({
    [PROTOFACE_CREDENTIAL_STORAGE_KEY]: {
      ...COMPLETE_CREDENTIALS,
      livekitUrl: "https:example.com",
      source: "metadata-secret-do-not-echo",
    },
  });

  assert.deepEqual(await getProtofaceCredentialState(storage), {
    configured: false,
    source: null,
  });
  await assert.rejects(() => loadProtofaceCredentials(storage), /LiveKit URL/);
});

test("clears credentials without exposing the removed secrets", async () => {
  const storage = memoryStorage({
    [PROTOFACE_CREDENTIAL_STORAGE_KEY]: {
      ...COMPLETE_CREDENTIALS,
      source: "manual",
    },
  });

  const state = await clearProtofaceCredentials(storage);

  assert.deepEqual(state, { configured: false, source: null });
  assert.equal(storage.values[PROTOFACE_CREDENTIAL_STORAGE_KEY], undefined);
  assert.equal(JSON.stringify(state).includes("secret"), false);
});

test("propagates storage get, set, and remove failures", async () => {
  await assert.rejects(
    () => getProtofaceCredentialState({
      async get() {
        throw new Error("storage get failed");
      },
    }),
    /storage get failed/,
  );
  await assert.rejects(
    () => saveProtofaceCredentials({
      async set() {
        throw new Error("storage set failed");
      },
    }, COMPLETE_CREDENTIALS, { source: "manual" }),
    /storage set failed/,
  );
  await assert.rejects(
    () => clearProtofaceCredentials({
      async remove() {
        throw new Error("storage remove failed");
      },
    }),
    /storage remove failed/,
  );
});

test("required credential field metadata is deeply immutable", () => {
  assert.equal(Object.isFrozen(PROTOFACE_REQUIRED_FIELDS), true);
  for (const field of PROTOFACE_REQUIRED_FIELDS) {
    assert.equal(Object.isFrozen(field), true);
  }
});
