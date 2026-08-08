const REQUIRED_CONNECTION_FIELDS = ["livekitUrl", "roomName", "participantToken"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_REPORTED_LATENCY_MS = 300_000;

function runtimeSessionError(response, fallback) {
  const error = new Error(response?.error?.message || fallback);
  if (typeof response?.error?.code === "string") error.code = response.error.code;
  return error;
}

function createRuntimeProtofaceSessionApi(runtime = globalThis.chrome?.runtime) {
  const send = async (message) => {
    if (typeof runtime?.sendMessage !== "function") {
      throw new Error("Protoface background session API is unavailable.");
    }
    return runtime.sendMessage(message);
  };
  const end = async ({ sessionId }) => {
    const response = await send({
      type: "actions-json:protoface-session-end",
      sessionId,
    });
    if (response?.ok !== true) {
      throw runtimeSessionError(response, "Failed to end Protoface session.");
    }
    return { ok: true };
  };
  return {
    create({ avatarId, signal } = {}) {
      const operation = send({
        type: "actions-json:protoface-session-create",
        avatarId,
      }).then((response) => {
        if (response?.ok !== true || !response.connection) {
          throw runtimeSessionError(response, "Failed to create Protoface session.");
        }
        return response.connection;
      });
      if (!signal) return operation;
      return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener?.("abort", onAbort);
          reject(new Error("Protoface background session request was aborted."));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener?.("abort", onAbort, { once: true });
        }
        operation.then(
          (connection) => {
            if (settled) {
              void end({ sessionId: connection.sessionId }).catch(() => {});
              return;
            }
            settled = true;
            signal.removeEventListener?.("abort", onAbort);
            resolve(connection);
          },
          (error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener?.("abort", onAbort);
            reject(error);
          },
        );
      });
    },
    end,
  };
}

function brokerHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

function safeReason(error, fallback) {
  if (error?.code === "broker_timeout" || error?.code === "client_start_timeout") {
    return error.code;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("expired")) return "expired_connection";
  if (message.includes("missing")) return "invalid_connection";
  if (message.includes("timed out")) return "broker_timeout";
  if (message.includes("http") || message.includes("broker")) return "broker_unavailable";
  return fallback;
}

function boundedLatencyMs(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(MAX_REPORTED_LATENCY_MS, Math.round(value)));
}

function validateConnection(payload, now) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Protoface broker returned an invalid connection payload.");
  }
  for (const field of REQUIRED_CONNECTION_FIELDS) {
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      throw new Error(`Protoface broker response is missing ${field}.`);
    }
  }
  const rawSessionId = [payload.sessionId, payload.sessionToken]
    .find((value) => typeof value === "string" && value.trim());
  if (!rawSessionId) {
    throw new Error("Protoface broker response is missing sessionId or sessionToken.");
  }
  let livekitUrl;
  try {
    livekitUrl = new URL(payload.livekitUrl);
  } catch {
    throw new Error("Protoface broker response has an invalid LiveKit URL.");
  }
  const secureLivekit = livekitUrl.protocol === "wss:" || livekitUrl.protocol === "https:";
  const localLivekit = (livekitUrl.protocol === "ws:" || livekitUrl.protocol === "http:")
    && LOOPBACK_HOSTS.has(livekitUrl.hostname.toLowerCase());
  if (!secureLivekit && !localLivekit) {
    throw new Error("Protoface broker response has an unsafe LiveKit URL.");
  }
  if (payload.expiresAt) {
    const expiresAt = Date.parse(payload.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("Protoface broker response is expired.");
    }
  }
  return { ...payload, sessionId: rawSessionId.trim() };
}

export class ProtofaceAvatarController {
  constructor({
    settings,
    videoElement,
    audioElement,
    ProtofaceClientClass,
    sessionApi = createRuntimeProtofaceSessionApi(),
    loadProtofaceClient = async () => (await import("../../dist/protoface-client-bundle.mjs")).ProtofaceClient,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    now = () => Date.now(),
    eventObserver = () => {},
    brokerTimeoutMs = 8_000,
    clientStartTimeoutMs = 12_000,
    cleanupTimeoutMs = 2_000,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
  } = {}) {
    this.settings = settings;
    this.videoElement = videoElement;
    this.audioElement = audioElement;
    this.ProtofaceClientClass = ProtofaceClientClass;
    this.sessionApi = sessionApi;
    this.loadProtofaceClient = loadProtofaceClient;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.eventObserver = eventObserver;
    this.brokerTimeoutMs = brokerTimeoutMs;
    this.clientStartTimeoutMs = clientStartTimeoutMs;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.client = null;
    this.connection = null;
    this.trackCleanup = null;
    this.ready = false;
    this.sessionCleanupInFlight = new Map();
    this.completedSessionCleanups = new Set();
    this.unsubscribers = [];
    this.videoTelemetryCleanup = null;
    this.startupStartedAtMs = null;
    this.responseAudioStartedAtMs = null;
    this.lifecycleGeneration = 0;
  }

  isReady() {
    return this.ready && this.client?.status === "started";
  }

  emit(state, detail = {}) {
    this.eventObserver({
      type: "protoface.avatar.state",
      state,
      broker_host: brokerHost(this.settings?.brokerUrl),
      ...detail,
    });
  }

  async start() {
    const generation = ++this.lifecycleGeneration;
    let connection = null;
    let client = null;
    if (!this.settings?.enabled) {
      this.emit("disabled");
      return { ready: false, error: "disabled" };
    }
    const directMode = this.settings.connectionMode === "direct";
    if (directMode ? typeof this.sessionApi?.create !== "function" : !this.fetchImpl) {
      this.emit("fallback", { reason: "client_unavailable" });
      return { ready: false, error: "client_unavailable" };
    }

    this.startupStartedAtMs = this.now();
    this.bindVideoTelemetry();
    this.emit("starting");
    try {
      let payload;
      if (directMode) {
        const caller = new AbortController();
        payload = await this.promiseWithTimeout(
          this.sessionApi.create({
            avatarId: this.settings.avatarId,
            signal: caller.signal,
            timeoutMs: this.brokerTimeoutMs,
          }),
          this.brokerTimeoutMs,
          "Protoface background session request timed out.",
          "broker_timeout",
          () => caller.abort(),
        );
      } else {
        payload = await this.fetchWithTimeout(this.settings.brokerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            avatarId: this.settings.avatarId,
            maxSessionLength: 600,
            maxIdleTime: 180,
            metadata: { client: "actions-json-extension" },
          }),
        }, this.brokerTimeoutMs, "Protoface broker request timed out.", "broker_timeout", async (response) => {
          if (!response?.ok) {
            throw new Error(`Protoface broker HTTP ${response?.status ?? "error"}.`);
          }
          return response.json();
        });
      }
      connection = validateConnection(payload, this.now());
      this.completedSessionCleanups.delete(connection.sessionId);
      if (generation !== this.lifecycleGeneration) {
        await this.endSession(connection.sessionId);
        this.releaseVideoTelemetry();
        return { ready: false, error: "cancelled" };
      }
      this.connection = connection;
      if (typeof this.ProtofaceClientClass !== "function") {
        this.ProtofaceClientClass = await this.loadProtofaceClient();
      }
      if (generation !== this.lifecycleGeneration) {
        await this.endSession(connection.sessionId);
        this.releaseVideoTelemetry();
        return { ready: false, error: "cancelled" };
      }
      if (typeof this.ProtofaceClientClass !== "function") {
        throw new Error("Protoface client is unavailable.");
      }

      const apiClient = {
        createLiveKitSession: async () => ({
          id: connection.sessionId,
          status: "running",
          avatar_id: connection.avatarId ?? this.settings.avatarId,
          transport: {
            type: "livekit",
            url: connection.livekitUrl,
            room_name: connection.roomName,
            audio_source: "data_stream",
            worker_identity: connection.avatarIdentity,
          },
          quality: "standard",
          max_duration_seconds: 600,
          idle_timeout_seconds: 180,
          metadata: {},
          created_at: new Date(this.now()).toISOString(),
        }),
        endSession: async (sessionId) => this.endSession(sessionId),
      };

      client = new this.ProtofaceClientClass({
        avatarId: connection.avatarId ?? this.settings.avatarId,
        livekitUrl: connection.livekitUrl,
        roomName: connection.roomName,
        participantToken: connection.participantToken,
        // The broker already created the Protoface worker session. The SDK
        // still requires a truthy workerToken before delegating to apiClient;
        // the official starter uses this non-secret sentinel for that path.
        workerToken: "server-created",
        workerIdentity: connection.avatarIdentity,
        videoElement: this.videoElement,
        audioElement: this.audioElement,
        apiClient,
      });
      this.client = client;
      this.bindClientEvents();
      await this.promiseWithTimeout(
        client.start(),
        this.clientStartTimeoutMs,
        "Protoface client startup timed out.",
        "client_start_timeout",
      );
      if (generation !== this.lifecycleGeneration) {
        await this.releasePartialClient(client);
        await this.endSession(connection.sessionId);
        this.releaseVideoTelemetry();
        return { ready: false, error: "cancelled" };
      }
      this.ready = true;
      this.emit("ready");
      return { ready: true };
    } catch (error) {
      const sessionId = connection?.sessionId;
      await this.releasePartialClient(client);
      if (sessionId) {
        await this.endSession(sessionId);
      }
      if (generation !== this.lifecycleGeneration) {
        this.releaseVideoTelemetry();
        return { ready: false, error: "cancelled" };
      }
      this.ready = false;
      this.releaseVideoTelemetry();
      const reason = safeReason(error, "startup_failed");
      this.emit("fallback", { reason });
      return { ready: false, error: reason };
    }
  }

  bindClientEvents() {
    if (!this.client?.on) return;
    this.unsubscribers.push(
      this.client.on("speaking", () => {
        const latency = this.responseAudioStartedAtMs === null
          ? null
          : boundedLatencyMs(this.now() - this.responseAudioStartedAtMs);
        this.responseAudioStartedAtMs = null;
        this.emit("speaking", latency === null ? {} : { audio_to_visible_speech_ms: latency });
      }),
      this.client.on("silent", () => this.emit("ready")),
      this.client.on("error", () => {
        this.releaseTrack();
        this.setMuted(true);
        this.ready = false;
        this.emit("fallback", { reason: "runtime_failed" });
      }),
    );
  }

  async attachTrack(track) {
    if (!this.isReady() || !track) return false;
    try {
      this.releaseTrack();
      this.trackCleanup = await this.client.listenToMediaStreamTrack(track);
      this.emit("track_attached");
      return true;
    } catch {
      this.releaseTrack();
      this.setMuted(true);
      this.ready = false;
      this.emit("fallback", { reason: "track_attachment_failed" });
      return false;
    }
  }

  setMuted(muted) {
    if (this.audioElement) {
      this.audioElement.muted = Boolean(muted);
    }
  }

  async detach() {
    this.releaseTrack();
  }

  observeRealtimeEvent(event) {
    if (event?.type === "response.created") {
      this.responseAudioStartedAtMs = null;
      return;
    }
    if (
      this.responseAudioStartedAtMs === null
      && (event?.type === "response.output_audio.delta" || event?.type === "response.audio.delta")
    ) {
      this.responseAudioStartedAtMs = this.now();
      return;
    }
    if (
      event?.type === "response.done"
      || event?.type === "response.cancelled"
      || event?.type === "error"
    ) {
      this.responseAudioStartedAtMs = null;
    }
  }

  async clearBuffer() {
    if (!this.isReady()) return false;
    try {
      await this.client.clearBuffer();
      this.emit("buffer_cleared");
      return true;
    } catch {
      this.emit("buffer_clear_failed", { reason: "control_failed" });
      return false;
    }
  }

  async stop() {
    this.lifecycleGeneration += 1;
    this.releaseTrack();
    this.releaseVideoTelemetry();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe?.();
    }
    const sessionId = this.connection?.sessionId;
    try {
      await this.stopClientSafely(this.client);
    } finally {
      if (sessionId) {
        await this.endSession(sessionId);
      }
      this.client = null;
      this.connection = null;
      this.ready = false;
      this.startupStartedAtMs = null;
      this.responseAudioStartedAtMs = null;
      this.emit("stopped");
    }
  }

  async releasePartialClient(client = this.client) {
    await this.stopClientSafely(client);
    if (this.client === client) {
      this.client = null;
    }
  }

  async stopClientSafely(client) {
    if (typeof client?.stop !== "function") return;
    try {
      await this.promiseWithTimeout(
        client.stop(),
        this.cleanupTimeoutMs,
        "Protoface client cleanup timed out.",
        "client_stop_timeout",
      );
    } catch {
      this.emit("client_cleanup_failed", { reason: "control_failed" });
    }
  }

  releaseTrack() {
    try {
      this.trackCleanup?.();
    } catch {
      // A failed optional listener cleanup must not block direct-audio fallback.
    }
    this.trackCleanup = null;
  }

  bindVideoTelemetry() {
    this.releaseVideoTelemetry();
    if (typeof this.videoElement?.addEventListener !== "function") return;
    const onFirstFrame = () => {
      const latency = this.startupStartedAtMs === null
        ? null
        : boundedLatencyMs(this.now() - this.startupStartedAtMs);
      this.releaseVideoTelemetry();
      if (latency !== null) {
        this.emit("first_frame", { startup_to_first_frame_ms: latency });
      }
    };
    this.videoElement.addEventListener("playing", onFirstFrame, { once: true });
    this.videoTelemetryCleanup = () => {
      this.videoElement?.removeEventListener?.("playing", onFirstFrame);
    };
  }

  releaseVideoTelemetry() {
    this.videoTelemetryCleanup?.();
    this.videoTelemetryCleanup = null;
  }

  async endSession(sessionId) {
    const canonicalSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!canonicalSessionId || this.completedSessionCleanups.has(canonicalSessionId)) return true;
    const existing = this.sessionCleanupInFlight.get(canonicalSessionId);
    if (existing) return existing;

    let cleanup;
    cleanup = Promise.resolve().then(async () => {
      try {
        if (this.settings.connectionMode === "direct") {
          await this.promiseWithTimeout(
            this.sessionApi.end({ sessionId: canonicalSessionId }),
            this.cleanupTimeoutMs,
            "Protoface background session cleanup timed out.",
            "session_cleanup_timeout",
          );
        } else {
          const response = await this.fetchWithTimeout(this.settings.brokerUrl, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: canonicalSessionId }),
          }, this.cleanupTimeoutMs, "Protoface broker cleanup timed out.", "broker_timeout");
          if (!response?.ok) {
            throw new Error(`Protoface broker cleanup HTTP ${response?.status ?? "error"}.`);
          }
        }
        this.completedSessionCleanups.add(canonicalSessionId);
        return true;
      } catch {
        this.emit("broker_cleanup_failed", { reason: "broker_unavailable" });
        return false;
      } finally {
        if (this.sessionCleanupInFlight.get(canonicalSessionId) === cleanup) {
          this.sessionCleanupInFlight.delete(canonicalSessionId);
        }
      }
    });
    this.sessionCleanupInFlight.set(canonicalSessionId, cleanup);
    return cleanup;
  }

  async fetchWithTimeout(
    url,
    init,
    timeoutMs,
    timeoutMessage,
    timeoutCode = "timeout",
    consumeResponse = (response) => response,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof this.setTimeoutImpl !== "function") {
      return consumeResponse(await this.fetchImpl(url, init));
    }
    const abortController = new AbortController();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this.setTimeoutImpl(() => {
        abortController.abort();
        const error = new Error(timeoutMessage);
        error.code = timeoutCode;
        reject(error);
      }, timeoutMs);
    });
    try {
      const request = (async () => {
        const response = await this.fetchImpl(url, { ...init, signal: abortController.signal });
        return consumeResponse(response);
      })();
      return await Promise.race([
        request,
        timeout,
      ]);
    } finally {
      if (timer !== null) {
        this.clearTimeoutImpl?.(timer);
      }
    }
  }

  async promiseWithTimeout(
    promise,
    timeoutMs,
    timeoutMessage,
    timeoutCode = "timeout",
    onTimeout = () => {},
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof this.setTimeoutImpl !== "function") {
      return promise;
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this.setTimeoutImpl(() => {
        const error = new Error(timeoutMessage);
        error.code = timeoutCode;
        reject(error);
        try {
          onTimeout();
        } catch {
          // Timeout remains primary even if optional cancellation fails.
        }
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== null) {
        this.clearTimeoutImpl?.(timer);
      }
    }
  }
}
