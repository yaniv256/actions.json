import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { ProtofaceApiClient } from "protoface-client";

import {
  createDirectProtofaceSession,
  endDirectProtofaceSession,
} from "../src/agent/protoface-session-broker.mjs";

const FIXTURE_CREDENTIALS = Object.freeze({
  protofaceApiKey: "pf_test_long_lived_api_key",
  livekitUrl: "wss://demo.livekit.cloud/",
  livekitApiKey: "APIabcdef123456",
  livekitApiSecret: "livekit-test-long-lived-secret",
});
const NOW_SECONDS = 1_784_200_000;

function apiHarness({ createError, endError, session } = {}) {
  const constructorCalls = [];
  const createCalls = [];
  const endCalls = [];

  class FakeProtofaceApiClient {
    constructor(options) {
      constructorCalls.push(options);
    }

    async createLiveKitSession(request) {
      createCalls.push(request);
      if (createError) throw createError;
      return session ?? {
        id: "canonical-session-id",
        status: "running",
        avatar_id: request.avatarId,
        transport: {
          type: "livekit",
          url: request.livekitUrl,
          room_name: request.roomName,
          audio_source: "data_stream",
          worker_identity: request.workerIdentity,
        },
        quality: "standard",
        max_duration_seconds: request.maxDurationSeconds,
        idle_timeout_seconds: request.idleTimeoutSeconds,
        metadata: request.metadata,
        created_at: new Date(NOW_SECONDS * 1_000).toISOString(),
      };
    }

    async endSession(sessionId) {
      endCalls.push(sessionId);
      if (endError) throw endError;
    }
  }

  return {
    ProtofaceApiClientClass: FakeProtofaceApiClient,
    constructorCalls,
    createCalls,
    endCalls,
  };
}

function sessionOptions(api = apiHarness()) {
  const uuids = ["room-uuid", "viewer-uuid", "worker-uuid"];
  return {
    api,
    options: {
      credentials: FIXTURE_CREDENTIALS,
      avatarId: "av_stock_001",
      maxSessionLength: 600,
      maxIdleTime: 180,
      metadata: { client: "actions-json-extension" },
      now: () => NOW_SECONDS,
      randomUUID: () => uuids.shift(),
      ProtofaceApiClientClass: api.ProtofaceApiClientClass,
    },
  };
}

function directOptions(overrides = {}) {
  const uuids = ["room-uuid", "viewer-uuid", "worker-uuid"];
  return {
    credentials: FIXTURE_CREDENTIALS,
    avatarId: "av_stock_001",
    maxSessionLength: 600,
    maxIdleTime: 180,
    metadata: { client: "actions-json-extension" },
    now: () => NOW_SECONDS,
    randomUUID: () => uuids.shift(),
    ...overrides,
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return body === undefined ? "" : JSON.stringify(body); },
  };
}

function successfulSession(overrides = {}) {
  return {
    id: "canonical-session-id",
    status: "running",
    avatar_id: "av_stock_001",
    transport: {
      type: "livekit",
      url: FIXTURE_CREDENTIALS.livekitUrl,
      room_name: "protoface-room-uuid",
      audio_source: "data_stream",
      worker_identity: "protoface-avatar-worker-uuid",
    },
    quality: "standard",
    max_duration_seconds: 600,
    idle_timeout_seconds: 180,
    metadata: { client: "actions-json-extension" },
    created_at: new Date(NOW_SECONDS * 1_000).toISOString(),
    ...overrides,
  };
}

function realApiClientClass(constructorCalls = []) {
  return class TestProtofaceApiClient extends ProtofaceApiClient {
    constructor(options) {
      constructorCalls.push(options);
      assert.equal(typeof options.fetch, "function", "broker must inject its bounded fetch seam");
      super(options);
    }
  };
}

function timerHarness() {
  let nextId = 0;
  const timers = new Map();
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeoutImpl(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      cleared.push(id);
      timers.delete(id);
    },
    fireDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected an active ${delay}ms timer`);
      entry[1].callback();
    },
  };
}

function signalHarness() {
  const listeners = new Set();
  return {
    signal: {
      aborted: false,
      addEventListener(name, listener) {
        if (name === "abort") listeners.add(listener);
      },
      removeEventListener(name, listener) {
        if (name === "abort") listeners.delete(listener);
      },
    },
    abort() {
      this.signal.aborted = true;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() { return listeners.size; },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("mints ten-minute viewer and worker tokens with bounded LiveKit grants", async () => {
  const { api, options } = sessionOptions();

  const connection = await createDirectProtofaceSession(options);

  assert.equal(api.constructorCalls.length, 1);
  assert.equal(api.constructorCalls[0].apiKey, FIXTURE_CREDENTIALS.protofaceApiKey);
  assert.equal(typeof api.constructorCalls[0].fetch, "function");
  assert.equal(api.createCalls.length, 1);
  const request = api.createCalls[0];
  const viewer = decodeJwt(connection.participantToken);
  const worker = decodeJwt(request.workerToken);

  for (const token of [connection.participantToken, request.workerToken]) {
    assert.deepEqual(decodeProtectedHeader(token), { alg: "HS256", typ: "JWT" });
    await jwtVerify(token, new TextEncoder().encode(FIXTURE_CREDENTIALS.livekitApiSecret), {
      algorithms: ["HS256"],
      issuer: FIXTURE_CREDENTIALS.livekitApiKey,
      currentDate: new Date(NOW_SECONDS * 1_000),
    });
  }
  assert.equal(viewer.iss, FIXTURE_CREDENTIALS.livekitApiKey);
  assert.equal(viewer.exp - viewer.iat, 600);
  assert.equal(viewer.iat, NOW_SECONDS);
  assert.equal(viewer.nbf, NOW_SECONDS);
  assert.deepEqual(viewer.video, {
    room: request.roomName,
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: true,
  });
  assert.equal(worker.iss, FIXTURE_CREDENTIALS.livekitApiKey);
  assert.equal(worker.exp - worker.iat, 600);
  assert.deepEqual(worker.video, {
    room: request.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  assert.equal(viewer.sub, "viewer-viewer-uuid");
  assert.equal(worker.sub, "protoface-avatar-worker-uuid");
  assert.equal(request.roomName, "protoface-room-uuid");
  assert.equal(request.workerIdentity, worker.sub);
  assert.equal(new Set([request.roomName, viewer.sub, worker.sub]).size, 3);
});

test("creates the Protoface worker session and returns only the bounded viewer connection", async () => {
  const { api, options } = sessionOptions();

  const connection = await createDirectProtofaceSession(options);

  assert.deepEqual(Object.keys(connection).sort(), [
    "avatarId",
    "avatarIdentity",
    "expiresAt",
    "livekitUrl",
    "participantToken",
    "roomName",
    "sessionId",
  ]);
  assert.deepEqual(connection, {
    sessionId: "canonical-session-id",
    livekitUrl: FIXTURE_CREDENTIALS.livekitUrl,
    roomName: "protoface-room-uuid",
    participantToken: connection.participantToken,
    avatarId: "av_stock_001",
    avatarIdentity: "protoface-avatar-worker-uuid",
    expiresAt: new Date((NOW_SECONDS + 600) * 1_000).toISOString(),
  });
  assert.deepEqual(api.createCalls[0], {
    avatarId: "av_stock_001",
    livekitUrl: FIXTURE_CREDENTIALS.livekitUrl,
    roomName: "protoface-room-uuid",
    workerToken: api.createCalls[0].workerToken,
    workerIdentity: "protoface-avatar-worker-uuid",
    maxDurationSeconds: 600,
    idleTimeoutSeconds: 180,
    metadata: { client: "actions-json-extension" },
  });
  const serialized = JSON.stringify(connection);
  assert.equal(serialized.includes(FIXTURE_CREDENTIALS.protofaceApiKey), false);
  assert.equal(serialized.includes(FIXTURE_CREDENTIALS.livekitApiSecret), false);
  assert.equal(serialized.includes(api.createCalls[0].workerToken), false);
});

test("validates credentials and avatar ID without echoing submitted values", async () => {
  const { options } = sessionOptions();

  await assert.rejects(
    createDirectProtofaceSession({
      ...options,
      credentials: { protofaceApiKey: FIXTURE_CREDENTIALS.protofaceApiKey },
    }),
    (error) => {
      assert.match(error.message, /LiveKit URL, LiveKit API key, LiveKit API secret/);
      assert.equal(error.message.includes(FIXTURE_CREDENTIALS.protofaceApiKey), false);
      return true;
    },
  );
  await assert.rejects(
    createDirectProtofaceSession({ ...options, avatarId: "  " }),
    /Protoface avatar ID is required/,
  );
});

test("redacts upstream secrets from create and end errors", async () => {
  const createApi = apiHarness({
    createError: new Error(`upstream rejected ${FIXTURE_CREDENTIALS.protofaceApiKey}`),
  });
  const { options } = sessionOptions(createApi);

  await assert.rejects(
    createDirectProtofaceSession(options),
    (error) => {
      assert.equal(error.message, "Failed to create Protoface session.");
      assert.equal(error.message.includes(FIXTURE_CREDENTIALS.protofaceApiKey), false);
      return true;
    },
  );

  const endApi = apiHarness({
    endError: new Error(`upstream rejected ${FIXTURE_CREDENTIALS.protofaceApiKey}`),
  });
  await assert.rejects(
    endDirectProtofaceSession({
      credentials: FIXTURE_CREDENTIALS,
      sessionId: "canonical-session-id",
      ProtofaceApiClientClass: endApi.ProtofaceApiClientClass,
    }),
    (error) => {
      assert.equal(error.message, "Failed to end Protoface session.");
      assert.equal(error.message.includes(FIXTURE_CREDENTIALS.protofaceApiKey), false);
      return true;
    },
  );
});

test("ends the canonical session through ProtofaceApiClient", async () => {
  const api = apiHarness();

  const result = await endDirectProtofaceSession({
    credentials: FIXTURE_CREDENTIALS,
    sessionId: " canonical-session-id ",
    ProtofaceApiClientClass: api.ProtofaceApiClientClass,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(api.constructorCalls[0].apiKey, FIXTURE_CREDENTIALS.protofaceApiKey);
  assert.equal(typeof api.constructorCalls[0].fetch, "function");
  assert.deepEqual(api.endCalls, ["canonical-session-id"]);
});

test("uses the published ProtofaceApiClient endpoint, auth, and wire format", async () => {
  const fetchCalls = [];
  const constructorCalls = [];
  const timers = timerHarness();
  const connection = await createDirectProtofaceSession(directOptions({
    ProtofaceApiClientClass: realApiClientClass(constructorCalls),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return response(successfulSession());
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }));

  assert.equal(constructorCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.protoface.com/v1/sessions");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].init.headers.authorization, `Bearer ${FIXTURE_CREDENTIALS.protofaceApiKey}`);
  assert.equal(fetchCalls[0].init.headers["content-type"], "application/json");
  assert.equal(fetchCalls[0].init.signal instanceof AbortSignal, true);
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(body, {
    avatar_id: "av_stock_001",
    transport: {
      type: "livekit",
      url: FIXTURE_CREDENTIALS.livekitUrl,
      room_name: "protoface-room-uuid",
      worker_token: body.transport.worker_token,
      worker_identity: "protoface-avatar-worker-uuid",
      audio_source: "data_stream",
    },
    max_duration_seconds: 600,
    idle_timeout_seconds: 180,
    metadata: { client: "actions-json-extension" },
  });
  assert.equal(decodeJwt(body.transport.worker_token).video.canPublish, true);
  assert.equal(connection.sessionId, "canonical-session-id");
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(timers.cleared, [1]);
});

test("aborts a hanging create request at the internal seven-second deadline and clears its timer", async () => {
  const timers = timerHarness();
  let requestSignal;
  const creation = createDirectProtofaceSession(directOptions({
    ProtofaceApiClientClass: realApiClientClass(),
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }));
  const rejected = assert.rejects(creation, /Failed to create Protoface session/);
  await waitFor(() => requestSignal, "create fetch was not invoked");

  timers.fireDelay(7_000);

  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(timers.cleared, [1]);
});

test("caller abort rejects promptly and compensates an observable late created session exactly once", async () => {
  const timers = timerHarness();
  const caller = signalHarness();
  const fetchCalls = [];
  let resolveFetch;
  const creation = createDirectProtofaceSession(directOptions({
    signal: caller.signal,
    ProtofaceApiClientClass: realApiClientClass(),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (fetchCalls.length > 1) return response(undefined, 204);
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }));
  const rejected = assert.rejects(creation, /Failed to create Protoface session/);
  await waitFor(() => resolveFetch, "create fetch was not invoked");

  caller.abort();
  await rejected;
  assert.equal(fetchCalls[0].init.signal.aborted, false);
  assert.equal(caller.listenerCount, 0);

  resolveFetch(response(successfulSession()));
  await waitFor(() => fetchCalls.length === 2, "late session was not compensated");

  assert.equal(fetchCalls[1].url, "https://api.protoface.com/v1/sessions/canonical-session-id/end");
  assert.equal(fetchCalls.filter((call) => call.url.endsWith("/end")).length, 1);
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(timers.cleared, [1, 2]);
});

test("caller-aborted create with no response stops at the hard transport deadline and cleans timers", async () => {
  const timers = timerHarness();
  const caller = signalHarness();
  const fetchCalls = [];
  const creation = createDirectProtofaceSession(directOptions({
    signal: caller.signal,
    ProtofaceApiClientClass: realApiClientClass(),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return new Promise(() => {});
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }));
  const rejected = assert.rejects(creation, /Failed to create Protoface session/);
  await waitFor(() => fetchCalls.length === 1, "create fetch was not invoked");

  caller.abort();
  await rejected;
  assert.equal(fetchCalls[0].init.signal.aborted, false);
  assert.equal(timers.timers.size, 1);

  timers.fireDelay(7_000);
  await waitFor(() => fetchCalls[0].init.signal.aborted, "transport deadline did not abort fetch");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1);
  assert.equal(caller.listenerCount, 0);
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(timers.cleared, [1]);
});

test("aborts a hanging end request before the controller cleanup deadline", async () => {
  const timers = timerHarness();
  let requestSignal;
  const ending = endDirectProtofaceSession({
    credentials: FIXTURE_CREDENTIALS,
    sessionId: "canonical-session-id",
    ProtofaceApiClientClass: realApiClientClass(),
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const rejected = assert.rejects(ending, /Failed to end Protoface session/);
  await waitFor(() => requestSignal, "end fetch was not invoked");

  timers.fireDelay(1_500);

  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(timers.cleared, [1]);
});

test("rejects terminal or mismatched create responses and ends any allocated session", async () => {
  const invalidSessions = [
    { id: "canonical-session-id" },
    successfulSession({ status: "failed" }),
    successfulSession({ transport: { ...successfulSession().transport, type: "websocket" } }),
    successfulSession({ transport: { ...successfulSession().transport, url: "ws://unsafe.example" } }),
    successfulSession({ transport: { ...successfulSession().transport, url: "wss://other.livekit.cloud/" } }),
    successfulSession({ transport: { ...successfulSession().transport, room_name: "other-room" } }),
    successfulSession({ transport: { ...successfulSession().transport, worker_identity: "other-worker" } }),
    successfulSession({ avatar_id: "other-avatar" }),
  ];

  for (const session of invalidSessions) {
    const api = apiHarness({ session });
    await assert.rejects(
      createDirectProtofaceSession({
        ...directOptions(),
        ProtofaceApiClientClass: api.ProtofaceApiClientClass,
      }),
      (error) => {
        assert.equal(error.message, "Failed to create Protoface session.");
        assert.equal(JSON.stringify(error).includes(FIXTURE_CREDENTIALS.livekitApiSecret), false);
        return true;
      },
    );
    assert.deepEqual(api.endCalls, ["canonical-session-id"]);
  }
});

test("returns the validated canonical transport supplied by Protoface", async () => {
  const api = apiHarness({
    session: successfulSession({
      transport: { ...successfulSession().transport, url: "wss://demo.livekit.cloud" },
    }),
  });

  const connection = await createDirectProtofaceSession({
    ...directOptions(),
    ProtofaceApiClientClass: api.ProtofaceApiClientClass,
  });

  assert.equal(connection.livekitUrl, "wss://demo.livekit.cloud/");
  assert.equal(connection.roomName, "protoface-room-uuid");
  assert.equal(connection.avatarIdentity, "protoface-avatar-worker-uuid");
});

test("bounds best-effort cleanup when invalid create response allocated a session", async () => {
  const timers = timerHarness();
  const fetchCalls = [];
  const creation = createDirectProtofaceSession(directOptions({
    ProtofaceApiClientClass: realApiClientClass(),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (fetchCalls.length === 1) {
        return response(successfulSession({ status: "failed" }));
      }
      return new Promise(() => {});
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  }));
  const rejected = assert.rejects(creation, /Failed to create Protoface session/);
  await waitFor(() => fetchCalls.length === 2, "invalid session cleanup was not attempted");

  assert.equal(fetchCalls[1].url, "https://api.protoface.com/v1/sessions/canonical-session-id/end");
  timers.fireDelay(1_500);

  await rejected;
  assert.equal(fetchCalls[1].init.signal.aborted, true);
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(timers.cleared, [1, 2]);
});
