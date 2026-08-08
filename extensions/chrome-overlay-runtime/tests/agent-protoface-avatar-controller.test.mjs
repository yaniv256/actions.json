import assert from "node:assert/strict";
import test from "node:test";
import { ProtofaceClient } from "protoface-client";

import { ProtofaceAvatarController } from "../src/agent/protoface-avatar-controller.mjs";

const CONNECTION = {
  livekitUrl: "wss://livekit.example",
  roomName: "room-1",
  participantToken: "viewer-secret",
  sessionId: "session-1",
  avatarId: "av_demo",
  avatarIdentity: "protoface-avatar-agent",
  expiresAt: "2026-07-16T18:10:00.000Z",
};

function response(body = CONNECTION, ok = true) {
  return { ok, status: ok ? 200 : 400, async json() { return body; } };
}

class FakeProtofaceClient {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.status = "idle";
    this.calls = [];
    this.listeners = new Map();
    FakeProtofaceClient.instances.push(this);
  }

  on(name, listener) {
    this.listeners.set(name, listener);
    return () => this.listeners.delete(name);
  }

  async start() {
    this.calls.push("start");
    this.status = "started";
    this.session = await this.options.apiClient.createLiveKitSession();
  }

  async listenToMediaStreamTrack(track) {
    this.calls.push(["listen", track]);
    return () => this.calls.push(["cleanup", track]);
  }

  async clearBuffer() {
    this.calls.push("clearBuffer");
  }

  async stop() {
    this.calls.push("stop");
    this.status = "stopped";
    await this.options.apiClient.endSession(this.session?.id ?? "session-1");
  }
}

function harness({
  brokerBody = CONNECTION,
  brokerOk = true,
  connectionMode = "broker",
  sessionApi,
  now = Date.parse("2026-07-16T18:00:00.000Z"),
} = {}) {
  FakeProtofaceClient.instances = [];
  const fetchCalls = [];
  const events = [];
  const videoListeners = new Map();
  const videoElement = {
    addEventListener(name, listener) { videoListeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (videoListeners.get(name) === listener) videoListeners.delete(name);
    },
    emit(name) { videoListeners.get(name)?.(); },
  };
  const audioElement = { muted: false };
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      connectionMode,
      brokerUrl: "https://broker.example/protoface/session-token",
      avatarId: "av_demo",
    },
    videoElement,
    audioElement,
    ProtofaceClientClass: FakeProtofaceClient,
    sessionApi,
    now: () => now,
    eventObserver: (event) => events.push(event),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return response(brokerBody, brokerOk);
    },
  });
  return { controller, fetchCalls, events, videoElement, audioElement };
}

test("direct mode creates and ends the bounded session through the background API", async () => {
  const sessionCalls = [];
  const sessionApi = {
    async create(options) {
      sessionCalls.push({ operation: "create", ...options });
      return CONNECTION;
    },
    async end(options) {
      sessionCalls.push({ operation: "end", ...options });
      return { ok: true };
    },
  };
  const { controller, fetchCalls } = harness({ connectionMode: "direct", sessionApi });

  assert.deepEqual(await controller.start(), { ready: true });
  await controller.stop();

  assert.equal(fetchCalls.length, 0);
  assert.equal(sessionCalls.length, 2);
  assert.equal(sessionCalls[0].operation, "create");
  assert.equal(sessionCalls[0].avatarId, "av_demo");
  assert.equal(sessionCalls[0].signal instanceof AbortSignal, true);
  assert.deepEqual(sessionCalls[1], { operation: "end", sessionId: "session-1" });
});

test("direct mode fails open to voice-only without leaking background errors", async () => {
  const secret = "pf-never-emit-this-secret";
  const sessionApi = {
    async create() { throw new Error(`background rejected ${secret}`); },
    async end() { throw new Error("unexpected end"); },
  };
  const { controller, events, fetchCalls } = harness({ connectionMode: "direct", sessionApi });

  assert.deepEqual(await controller.start(), { ready: false, error: "startup_failed" });
  assert.equal(controller.isReady(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(events.at(-1).state, "fallback");
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("stopping during direct startup compensates one late background session", async () => {
  let releaseSession;
  const sessionCalls = [];
  const sessionApi = {
    create(options) {
      sessionCalls.push({ operation: "create", ...options });
      return new Promise((resolve) => { releaseSession = () => resolve(CONNECTION); });
    },
    async end(options) {
      sessionCalls.push({ operation: "end", ...options });
      return { ok: true };
    },
  };
  const { controller } = harness({ connectionMode: "direct", sessionApi });

  const startup = controller.start();
  await Promise.resolve();
  await controller.stop();
  releaseSession();

  assert.deepEqual(await startup, { ready: false, error: "cancelled" });
  assert.equal(controller.isReady(), false);
  assert.equal(sessionCalls.filter((call) => call.operation === "end").length, 1);
  assert.deepEqual(
    sessionCalls.find((call) => call.operation === "end"),
    { operation: "end", sessionId: "session-1" },
  );
});

test("a stale overlapping start cleans its own session without suppressing active-session cleanup", async () => {
  const pendingCreates = [];
  const endedSessionIds = [];
  const sessionApi = {
    create() {
      return new Promise((resolve) => pendingCreates.push(resolve));
    },
    async end({ sessionId }) {
      endedSessionIds.push(sessionId);
      return { ok: true };
    },
  };
  const { controller } = harness({ connectionMode: "direct", sessionApi });
  const session1 = { ...CONNECTION, sessionId: "session-stale", roomName: "room-stale" };
  const session2 = { ...CONNECTION, sessionId: "session-active", roomName: "room-active" };

  const firstStart = controller.start();
  await Promise.resolve();
  const secondStart = controller.start();
  await Promise.resolve();
  pendingCreates[1](session2);
  assert.deepEqual(await secondStart, { ready: true });

  pendingCreates[0](session1);
  assert.deepEqual(await firstStart, { ready: false, error: "cancelled" });
  await controller.stop();

  assert.deepEqual(endedSessionIds.sort(), ["session-active", "session-stale"]);
});

test("failed session cleanup remains retryable within the same stop", async () => {
  let endAttempts = 0;
  const sessionApi = {
    async create() { return CONNECTION; },
    end() {
      endAttempts += 1;
      if (endAttempts === 1) throw new Error("temporary cleanup failure");
      return Promise.resolve({ ok: true });
    },
  };
  const { controller } = harness({ connectionMode: "direct", sessionApi });

  assert.deepEqual(await controller.start(), { ready: true });
  await controller.stop();

  assert.equal(endAttempts, 2);
});

test("concurrent duplicate cleanup calls coalesce by canonical session ID", async () => {
  let releaseEnd;
  let endCalls = 0;
  const sessionApi = {
    async create() { return CONNECTION; },
    end() {
      endCalls += 1;
      return new Promise((resolve) => { releaseEnd = () => resolve({ ok: true }); });
    },
  };
  const { controller } = harness({ connectionMode: "direct", sessionApi });

  const first = controller.endSession(" session-1 ");
  const second = controller.endSession("session-1");
  await Promise.resolve();
  assert.equal(endCalls, 1);
  releaseEnd();

  assert.equal(await first, true);
  assert.equal(await second, true);
});

test("runtime messaging adapter compensates a late create response after caller timeout", async () => {
  const originalChrome = globalThis.chrome;
  const messages = [];
  let resolveCreate;
  let fireTimeout;
  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        messages.push(message);
        if (message.type === "actions-json:protoface-session-create") {
          return new Promise((resolve) => { resolveCreate = resolve; });
        }
        return Promise.resolve({ ok: true });
      },
    },
  };
  try {
    const controller = new ProtofaceAvatarController({
      settings: { enabled: true, connectionMode: "direct", avatarId: "av_demo" },
      videoElement: {},
      audioElement: { muted: false },
      ProtofaceClientClass: FakeProtofaceClient,
      brokerTimeoutMs: 8_000,
      setTimeoutImpl(callback) { fireTimeout = callback; return 61; },
      clearTimeoutImpl() {},
    });

    const startup = controller.start();
    await Promise.resolve();
    fireTimeout();
    assert.deepEqual(await startup, { ready: false, error: "broker_timeout" });

    resolveCreate({ ok: true, connection: { ...CONNECTION, sessionId: "session-late" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages, [
      { type: "actions-json:protoface-session-create", avatarId: "av_demo" },
      { type: "actions-json:protoface-session-end", sessionId: "session-late" },
    ]);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test("a stalled direct session request receives the controller deadline and abort signal", async () => {
  let createOptions;
  let fireTimeout;
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      connectionMode: "direct",
      avatarId: "av_demo",
    },
    videoElement: {},
    audioElement: { muted: false },
    ProtofaceClientClass: FakeProtofaceClient,
    brokerTimeoutMs: 8_000,
    sessionApi: {
      create(options) {
        createOptions = options;
        return new Promise(() => {});
      },
      async end() { return { ok: true }; },
    },
    setTimeoutImpl(callback) { fireTimeout = callback; return 51; },
    clearTimeoutImpl() {},
  });

  const startup = controller.start();
  await Promise.resolve();
  assert.equal(createOptions.timeoutMs, 8_000);
  assert.equal(createOptions.signal.aborted, false);
  fireTimeout();

  assert.deepEqual(await startup, { ready: false, error: "broker_timeout" });
  assert.equal(createOptions.signal.aborted, true);
  assert.equal(controller.isReady(), false);
});

test("starts from a short-lived broker response without exposing service secrets", async () => {
  const { controller, fetchCalls, events, videoElement, audioElement } = harness();

  assert.deepEqual(await controller.start(), { ready: true });
  assert.equal(controller.isReady(), true);
  assert.equal(fetchCalls[0].url, "https://broker.example/protoface/session-token");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
    avatarId: "av_demo",
    maxSessionLength: 600,
    maxIdleTime: 180,
    metadata: { client: "actions-json-extension" },
  });

  const client = FakeProtofaceClient.instances[0];
  assert.equal(client.options.livekitUrl, CONNECTION.livekitUrl);
  assert.equal(client.options.roomName, CONNECTION.roomName);
  assert.equal(client.options.participantToken, CONNECTION.participantToken);
  assert.equal(client.options.workerToken, "server-created");
  assert.equal(client.options.videoElement, videoElement);
  assert.equal(client.options.audioElement, audioElement);
  assert.equal(JSON.stringify(events).includes("viewer-secret"), false);
});

test("satisfies the published protoface-client 0.1.0 browser-session contract", async () => {
  let connected;
  class ContractProtofaceClient extends ProtofaceClient {
    constructor(options) {
      super({
        ...options,
        transportFactory: () => ({
          async connect(value) { connected = value.connection; },
          async disconnect() {},
          async sendAudioData() {},
          async sendControlMessage() {},
        }),
      });
    }
  }
  const { controller } = harness();
  controller.ProtofaceClientClass = ContractProtofaceClient;

  assert.deepEqual(await controller.start(), { ready: true });
  assert.deepEqual(connected, {
    livekitUrl: CONNECTION.livekitUrl,
    roomName: CONNECTION.roomName,
    participantToken: CONNECTION.participantToken,
    sessionId: CONNECTION.sessionId,
    avatarId: CONNECTION.avatarId,
    avatarIdentity: CONNECTION.avatarIdentity,
  });
  await controller.stop();
});

test("records bounded first-frame and response-audio-to-visible-speech latency without raw media", async () => {
  let currentTime = Date.parse("2026-07-16T18:00:00.000Z");
  const { controller, events, videoElement } = harness({ now: currentTime });
  controller.now = () => currentTime;

  await controller.start();
  currentTime += 250;
  videoElement.emit("playing");
  controller.observeRealtimeEvent({ type: "response.output_audio.delta", delta: "private-audio-data" });
  currentTime += 90;
  FakeProtofaceClient.instances[0].listeners.get("speaking")?.();

  assert.equal(
    events.some((event) => event.state === "first_frame" && event.startup_to_first_frame_ms === 250),
    true,
  );
  assert.equal(
    events.some((event) => event.state === "speaking" && event.audio_to_visible_speech_ms === 90),
    true,
  );
  assert.equal(JSON.stringify(events).includes("private-audio-data"), false);
});

test("runtime failure detaches audio capture and mutes the failed avatar before direct fallback", async () => {
  const { controller, audioElement } = harness();
  await controller.start();
  const track = { id: "assistant-audio" };
  await controller.attachTrack(track);

  FakeProtofaceClient.instances[0].listeners.get("error")?.();

  assert.equal(controller.isReady(), false);
  assert.equal(audioElement.muted, true);
  assert.equal(
    FakeProtofaceClient.instances[0].calls.some((call) => Array.isArray(call) && call[0] === "cleanup"),
    true,
  );
});

test("rejects malformed or expired broker responses into voice-only fallback", async () => {
  for (const brokerBody of [
    { ...CONNECTION, participantToken: undefined },
    { ...CONNECTION, expiresAt: "2026-07-16T17:59:59.000Z" },
    { ...CONNECTION, livekitUrl: "javascript:alert(1)" },
  ]) {
    const { controller, events } = harness({ brokerBody });
    const result = await controller.start();
    assert.equal(result.ready, false);
    assert.equal(controller.isReady(), false);
    assert.equal(events.at(-1).state, "fallback");
  }
});

test("rejects a broker response without a cleanup session identifier before constructing a client", async () => {
  const { sessionId: _sessionId, ...brokerBody } = CONNECTION;
  const { controller, events } = harness({ brokerBody });

  assert.deepEqual(await controller.start(), { ready: false, error: "invalid_connection" });
  assert.equal(FakeProtofaceClient.instances.length, 0);
  assert.equal(events.at(-1).state, "fallback");
});

test("attaches one assistant track at a time and cleans up the previous listener", async () => {
  const { controller } = harness();
  await controller.start();
  const first = { id: "track-1" };
  const second = { id: "track-2" };

  assert.equal(await controller.attachTrack(first), true);
  assert.equal(await controller.attachTrack(second), true);
  assert.deepEqual(FakeProtofaceClient.instances[0].calls, [
    "start",
    ["listen", first],
    ["cleanup", first],
    ["listen", second],
  ]);
});

test("mute, interruption, and teardown reach Protoface and the broker once", async () => {
  const { controller, fetchCalls, audioElement } = harness();
  await controller.start();
  await controller.attachTrack({ id: "track-1" });

  controller.setMuted(true);
  assert.equal(audioElement.muted, true);
  assert.equal(await controller.clearBuffer(), true);
  await controller.stop();

  assert.equal(FakeProtofaceClient.instances[0].calls.includes("clearBuffer"), true);
  assert.equal(FakeProtofaceClient.instances[0].calls.includes("stop"), true);
  const deletes = fetchCalls.filter((call) => call.init.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.deepEqual(JSON.parse(deletes[0].init.body), { sessionId: "session-1" });
});

test("buffer-clear and track-attachment failures are best-effort fallback signals", async () => {
  class FailingClient extends FakeProtofaceClient {
    async listenToMediaStreamTrack() { throw new Error("track failed with viewer-secret"); }
    async clearBuffer() { throw new Error("clear failed with viewer-secret"); }
  }
  const { controller, events } = harness();
  controller.ProtofaceClientClass = FailingClient;
  await controller.start();

  assert.equal(await controller.attachTrack({ id: "bad" }), false);
  assert.equal(await controller.clearBuffer(), false);
  assert.equal(JSON.stringify(events).includes("viewer-secret"), false);
  assert.equal(events.some((event) => event.state === "fallback"), true);
});

test("a client-load failure releases the broker session before falling back", async () => {
  const { controller, fetchCalls } = harness();
  controller.ProtofaceClientClass = null;
  controller.loadProtofaceClient = async () => { throw new Error("bundle unavailable"); };

  assert.equal((await controller.start()).ready, false);
  const deletes = fetchCalls.filter((call) => call.init.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.deepEqual(JSON.parse(deletes[0].init.body), { sessionId: "session-1" });
});

test("stopping during broker startup prevents a late avatar session from becoming ready", async () => {
  FakeProtofaceClient.instances = [];
  let releaseBroker;
  const fetchCalls = [];
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      brokerUrl: "https://broker.example/protoface/session-token",
      avatarId: "av_demo",
    },
    videoElement: {},
    audioElement: { muted: false },
    ProtofaceClientClass: FakeProtofaceClient,
    now: () => Date.parse("2026-07-16T18:00:00.000Z"),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (init.method === "DELETE") return response({}, true);
      return new Promise((resolve) => { releaseBroker = () => resolve(response()); });
    },
  });

  const startup = controller.start();
  await Promise.resolve();
  await controller.stop();
  releaseBroker();

  assert.deepEqual(await startup, { ready: false, error: "cancelled" });
  assert.equal(controller.isReady(), false);
  assert.equal(FakeProtofaceClient.instances.length, 0);
  assert.equal(fetchCalls.filter((call) => call.init.method === "DELETE").length, 1);
});

test("a stalled broker request times out into voice-only fallback", async () => {
  let fireTimeout;
  let clearedTimer = null;
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      brokerUrl: "https://broker.example/protoface/session-token",
      avatarId: "av_demo",
    },
    videoElement: {},
    audioElement: { muted: false },
    ProtofaceClientClass: FakeProtofaceClient,
    brokerTimeoutMs: 8_000,
    setTimeoutImpl(callback) { fireTimeout = callback; return 41; },
    clearTimeoutImpl(timer) { clearedTimer = timer; },
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });

  const startup = controller.start();
  await Promise.resolve();
  fireTimeout();

  assert.deepEqual(await startup, { ready: false, error: "broker_timeout" });
  assert.equal(clearedTimer, 41);
  assert.equal(controller.isReady(), false);
});

test("a stalled broker response body remains covered by the broker timeout", async () => {
  let fireTimeout;
  let requestSignal;
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      brokerUrl: "https://broker.example/protoface/session-token",
      avatarId: "av_demo",
    },
    videoElement: {},
    audioElement: { muted: false },
    ProtofaceClientClass: FakeProtofaceClient,
    brokerTimeoutMs: 8_000,
    setTimeoutImpl(callback) { fireTimeout = callback; return 42; },
    clearTimeoutImpl() {},
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return { ok: true, status: 200, json: async () => new Promise(() => {}) };
    },
  });

  const startup = controller.start();
  await Promise.resolve();
  await Promise.resolve();
  fireTimeout();
  const result = await Promise.race([
    startup,
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);

  assert.deepEqual(result, { ready: false, error: "broker_timeout" });
  assert.equal(requestSignal.aborted, true);
  assert.equal(controller.isReady(), false);
});

test("a stalled Protoface client startup times out into voice-only fallback and cleans the broker session", async () => {
  class StalledClient extends FakeProtofaceClient {
    async start() {
      this.calls.push("start");
      return new Promise(() => {});
    }
  }
  const timers = new Map();
  const fetchCalls = [];
  let nextTimer = 0;
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      brokerUrl: "https://broker.example/protoface/session-token",
      avatarId: "av_demo",
    },
    videoElement: {},
    audioElement: { muted: false },
    ProtofaceClientClass: StalledClient,
    clientStartTimeoutMs: 12_000,
    setTimeoutImpl(callback) {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimeoutImpl(timer) { timers.delete(timer); },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return response();
    },
  });

  const startup = controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  timers.values().next().value();

  assert.deepEqual(await startup, { ready: false, error: "client_start_timeout" });
  assert.equal(fetchCalls.filter((call) => call.init.method === "DELETE").length, 1);
  assert.equal(controller.isReady(), false);
});

test("a stalled Protoface client stop cannot block broker cleanup or overlay teardown", async () => {
  class StalledStopClient extends FakeProtofaceClient {
    async stop() {
      this.calls.push("stop");
      return new Promise(() => {});
    }
  }
  const timers = new Map();
  const fetchCalls = [];
  const events = [];
  let nextTimer = 0;
  const controller = new ProtofaceAvatarController({
    settings: {
      enabled: true,
      brokerUrl: "https://broker.example/protoface/session-token",
      avatarId: "av_demo",
    },
    videoElement: {},
    audioElement: { muted: false },
    ProtofaceClientClass: StalledStopClient,
    cleanupTimeoutMs: 2_000,
    eventObserver: (event) => events.push(event),
    setTimeoutImpl(callback) {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimeoutImpl(timer) { timers.delete(timer); },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return response();
    },
  });

  await controller.start();
  const stopping = controller.stop();
  await Promise.resolve();
  assert.equal(timers.size, 1);
  timers.values().next().value();

  await stopping;
  assert.equal(fetchCalls.filter((call) => call.init.method === "DELETE").length, 1);
  assert.equal(events.some((event) => event.state === "client_cleanup_failed"), true);
  assert.equal(controller.isReady(), false);
});
