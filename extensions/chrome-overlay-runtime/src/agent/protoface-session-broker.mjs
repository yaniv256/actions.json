import { SignJWT } from "jose";
import { ProtofaceApiClient } from "protoface-client";

import { normalizeProtofaceCredentials } from "./protoface-credential-store.mjs";

const TOKEN_LIFETIME_SECONDS = 600;
const CREATE_TIMEOUT_MS = 7_000;
const END_TIMEOUT_MS = 1_500;
const ACTIVE_SESSION_STATUSES = new Set(["created", "queued", "starting", "running"]);

class CallerAbortError extends Error {}

function requiredText(value, message) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(message);
  return text;
}

async function mintLiveKitToken({
  apiKey,
  apiSecret,
  identity,
  roomName,
  canPublish,
  now,
  SignJWTClass,
}) {
  return new SignJWTClass({
    video: {
      room: roomName,
      roomJoin: true,
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(apiKey)
    .setSubject(identity)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(new TextEncoder().encode(apiSecret));
}

function boundedTimeout(value, maximum) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

function createBoundedFetch({
  fetchImpl,
  signal,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Protoface network access is unavailable.");
  }

  return async (url, init = {}) => {
    const abortController = new AbortController();
    const sourceSignals = [...new Set([signal, init.signal].filter(Boolean))];
    const listeners = [];
    let timer = null;
    let finished = false;
    let rejectAbort;
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeoutImpl(timer);
      for (const [sourceSignal, listener] of listeners) {
        sourceSignal.removeEventListener?.("abort", listener);
      }
    };
    const abort = (message) => {
      if (finished) return;
      abortController.abort();
      rejectAbort(new Error(message));
      cleanup();
    };

    for (const sourceSignal of sourceSignals) {
      if (sourceSignal.aborted) {
        abort("Protoface API request was aborted.");
        break;
      }
      const listener = () => abort("Protoface API request was aborted.");
      sourceSignal.addEventListener?.("abort", listener, { once: true });
      listeners.push([sourceSignal, listener]);
    }
    if (!finished) {
      timer = setTimeoutImpl(
        () => abort("Protoface API request timed out."),
        timeoutMs,
      );
    }
    if (finished) return abortPromise;

    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(url, { ...init, signal: abortController.signal })),
        abortPromise,
      ]);
    } catch (error) {
      cleanup();
      throw error;
    }

    if (response?.status === 204) {
      cleanup();
      return response;
    }
    if (!response || typeof response !== "object") {
      cleanup();
      throw new Error("Protoface API returned an invalid response.");
    }

    const consume = (method) => async (...args) => {
      try {
        return await Promise.race([
          Promise.resolve().then(() => method.apply(response, args)),
          abortPromise,
        ]);
      } finally {
        cleanup();
      }
    };
    return new Proxy(response, {
      get(target, property) {
        if ((property === "text" || property === "json") && typeof target[property] === "function") {
          return consume(target[property]);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

function createApiClient(ProtofaceApiClientClass, protofaceApiKey, fetch) {
  return new ProtofaceApiClientClass({ apiKey: protofaceApiKey, fetch });
}

function canonicalLivekitUrl(value) {
  const rawUrl = requiredText(value, "Protoface session returned an invalid LiveKit URL.");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Protoface session returned an invalid LiveKit URL.");
  }
  if (!["wss:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Protoface session returned an invalid LiveKit URL.");
  }
  return url.toString();
}

function sessionIdFrom(value) {
  return typeof value?.id === "string" && value.id.trim() ? value.id.trim() : null;
}

function validateCreatedSession(session, expected) {
  const sessionId = requiredText(session?.id, "Protoface session did not return an ID.");
  if (!ACTIVE_SESSION_STATUSES.has(session?.status)) {
    throw new Error("Protoface session returned an invalid status.");
  }
  if (session?.transport?.type !== "livekit") {
    throw new Error("Protoface session returned an invalid transport.");
  }
  const livekitUrl = canonicalLivekitUrl(session.transport.url);
  const roomName = requiredText(session.transport.room_name, "Protoface session returned an invalid room.");
  const workerIdentity = requiredText(
    session.transport.worker_identity,
    "Protoface session returned an invalid worker identity.",
  );
  const avatarId = requiredText(session.avatar_id, "Protoface session returned an invalid avatar ID.");
  if (
    livekitUrl !== expected.livekitUrl
    || roomName !== expected.roomName
    || workerIdentity !== expected.workerIdentity
    || avatarId !== expected.avatarId
  ) {
    throw new Error("Protoface session transport did not match the request.");
  }
  return { sessionId, livekitUrl, roomName, workerIdentity, avatarId };
}

async function endSessionBestEffort({
  credentials,
  sessionId,
  ProtofaceApiClientClass,
  fetchImpl,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  try {
    const fetch = createBoundedFetch({
      fetchImpl,
      timeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    const protoface = createApiClient(ProtofaceApiClientClass, credentials.protofaceApiKey, fetch);
    await protoface.endSession(sessionId);
  } catch {
    // The create failure remains primary; cleanup is bounded and best-effort.
  }
}

function waitForCreateOrCallerAbort(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new CallerAbortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new CallerAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function compensateLateCreatedSession({
  operation,
  credentials,
  ProtofaceApiClientClass,
  fetchImpl,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  try {
    const session = await operation;
    const sessionId = sessionIdFrom(session);
    if (!sessionId) return;
    await endSessionBestEffort({
      credentials,
      sessionId,
      ProtofaceApiClientClass,
      fetchImpl,
      timeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
    });
  } catch {
    // Compensation is possible only for a bounded late response carrying an ID.
    // A provider commit that never returns an ID is not observable to this client.
  }
}

function assertNoLongLivedSecrets(connection, credentials) {
  const serialized = JSON.stringify(connection);
  if (
    serialized.includes(credentials.protofaceApiKey)
    || serialized.includes(credentials.livekitApiSecret)
  ) {
    throw new Error("Failed to create Protoface session.");
  }
}

export async function createDirectProtofaceSession({
  credentials,
  avatarId,
  maxSessionLength = 600,
  maxIdleTime = 180,
  metadata = {},
  now = () => Math.floor(Date.now() / 1_000),
  randomUUID = () => globalThis.crypto.randomUUID(),
  SignJWTClass = SignJWT,
  ProtofaceApiClientClass = ProtofaceApiClient,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  signal,
  createTimeoutMs = CREATE_TIMEOUT_MS,
  cleanupTimeoutMs = END_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  const normalized = normalizeProtofaceCredentials(credentials);
  const normalizedAvatarId = requiredText(avatarId, "Protoface avatar ID is required.");
  const issuedAt = now();
  const roomName = `protoface-${randomUUID()}`;
  const viewerIdentity = `viewer-${randomUUID()}`;
  const workerIdentity = `protoface-avatar-${randomUUID()}`;

  try {
    const [participantToken, workerToken] = await Promise.all([
      mintLiveKitToken({
        apiKey: normalized.livekitApiKey,
        apiSecret: normalized.livekitApiSecret,
        identity: viewerIdentity,
        roomName,
        canPublish: false,
        now: issuedAt,
        SignJWTClass,
      }),
      mintLiveKitToken({
        apiKey: normalized.livekitApiKey,
        apiSecret: normalized.livekitApiSecret,
        identity: workerIdentity,
        roomName,
        canPublish: true,
        now: issuedAt,
        SignJWTClass,
      }),
    ]);
    const fetch = createBoundedFetch({
      fetchImpl,
      timeoutMs: boundedTimeout(createTimeoutMs, CREATE_TIMEOUT_MS),
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    const protoface = createApiClient(ProtofaceApiClientClass, normalized.protofaceApiKey, fetch);
    if (signal?.aborted) throw new CallerAbortError();
    const createOperation = protoface.createLiveKitSession({
      avatarId: normalizedAvatarId,
      livekitUrl: normalized.livekitUrl,
      roomName,
      workerToken,
      workerIdentity,
      maxDurationSeconds: maxSessionLength,
      idleTimeoutSeconds: maxIdleTime,
      metadata,
    });
    let session;
    try {
      session = await waitForCreateOrCallerAbort(createOperation, signal);
    } catch (error) {
      if (error instanceof CallerAbortError) {
        void compensateLateCreatedSession({
          operation: createOperation,
          credentials: normalized,
          ProtofaceApiClientClass,
          fetchImpl,
          timeoutMs: boundedTimeout(cleanupTimeoutMs, END_TIMEOUT_MS),
          setTimeoutImpl,
          clearTimeoutImpl,
        });
      }
      throw error;
    }
    try {
      const validated = validateCreatedSession(session, {
        livekitUrl: normalized.livekitUrl,
        roomName,
        workerIdentity,
        avatarId: normalizedAvatarId,
      });
      const connection = {
        sessionId: validated.sessionId,
        livekitUrl: validated.livekitUrl,
        roomName: validated.roomName,
        participantToken,
        avatarId: validated.avatarId,
        avatarIdentity: validated.workerIdentity,
        expiresAt: new Date((issuedAt + TOKEN_LIFETIME_SECONDS) * 1_000).toISOString(),
      };
      assertNoLongLivedSecrets(connection, normalized);
      return connection;
    } catch {
      const allocatedSessionId = sessionIdFrom(session);
      if (allocatedSessionId) {
        await endSessionBestEffort({
          credentials: normalized,
          sessionId: allocatedSessionId,
          ProtofaceApiClientClass,
          fetchImpl,
          timeoutMs: boundedTimeout(cleanupTimeoutMs, END_TIMEOUT_MS),
          setTimeoutImpl,
          clearTimeoutImpl,
        });
      }
      throw new Error("Failed to create Protoface session.");
    }
  } catch {
    throw new Error("Failed to create Protoface session.");
  }
}

export async function endDirectProtofaceSession({
  credentials,
  sessionId,
  ProtofaceApiClientClass = ProtofaceApiClient,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  signal,
  endTimeoutMs = END_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  const normalized = normalizeProtofaceCredentials(credentials);
  const normalizedSessionId = requiredText(sessionId, "Protoface session ID is required.");

  try {
    const fetch = createBoundedFetch({
      fetchImpl,
      signal,
      timeoutMs: boundedTimeout(endTimeoutMs, END_TIMEOUT_MS),
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    const protoface = createApiClient(ProtofaceApiClientClass, normalized.protofaceApiKey, fetch);
    await protoface.endSession(normalizedSessionId);
    return { ok: true };
  } catch {
    throw new Error("Failed to end Protoface session.");
  }
}
