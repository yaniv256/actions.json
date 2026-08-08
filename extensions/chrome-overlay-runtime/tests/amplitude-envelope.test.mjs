import assert from "node:assert/strict";
import test from "node:test";

import {
  AmplitudeEnvelopePublisher,
  ENVELOPE_INTERVAL_MS,
  createAmplitudeEnvelopePublisher,
  rmsFromTimeDomain,
} from "../src/agent/amplitude-envelope.mjs";

// ---------------------------------------------------------------------------
// Fakes. The publisher must never reach for a global AudioContext, so every
// seam below is injected. If the module starts touching globals these fakes
// stop constraining it and the suspended/unavailable tests go vacuous — the
// `globalThis.AudioContext` assertion in the unavailable test guards that.
// ---------------------------------------------------------------------------

/**
 * A real AnalyserNode fills the WHOLE destination buffer with `fftSize`
 * samples. `level` is the constant sample value the fake "hears", so a test
 * setting a level gets that exact RMS regardless of the fftSize the module
 * chooses — a fake that only partially filled the buffer would silently scale
 * every expected value down and read as an implementation bug.
 */
function fakeAnalyser() {
  return {
    fftSize: 256,
    smoothingTimeConstant: 0,
    level: 0,
    disconnected: false,
    /** Test helper: make this analyser read a constant sample value. */
    set buffer(source) {
      this.level = source?.length ? source[0] : 0;
    },
    get buffer() {
      return new Float32Array(this.fftSize).fill(this.level);
    },
    getFloatTimeDomainData(target) {
      target.fill(this.level);
    },
    connect() {},
    disconnect() {
      this.disconnected = true;
    },
  };
}

function fakeContext({ state = "running", resumeTo = "running", failResume = false } = {}) {
  const ctx = {
    state,
    sampleRate: 48000,
    analysers: [],
    sources: [],
    closed: false,
    resumeCalls: 0,
    createAnalyser() {
      const node = fakeAnalyser();
      this.analysers.push(node);
      return node;
    },
    createMediaStreamSource(stream) {
      const source = { stream, connect() {}, disconnect() {} };
      this.sources.push(source);
      return source;
    },
    async resume() {
      this.resumeCalls += 1;
      if (failResume) throw new Error("resume rejected: no user gesture");
      this.state = resumeTo;
    },
    async close() {
      this.closed = true;
      this.state = "closed";
    },
  };
  return ctx;
}

function fakeStream(id = "stream") {
  const track = {
    id: `${id}-track`,
    kind: "audio",
    readyState: "live",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    },
    end() {
      this.readyState = "ended";
      for (const fn of this.listeners.ended || []) fn();
    },
  };
  return {
    id,
    track,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

/** Deterministic clock + manual frame pump — no sleeping in tests. */
function fakeClock() {
  let now = 0;
  const frames = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    requestFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    cancelFrame(id) {
      frames[id - 1] = null;
    },
    /** Drive N frames at `stepMs` each, running whatever callback is pending. */
    pump(count, stepMs) {
      for (let i = 0; i < count; i += 1) {
        const pending = frames.splice(0);
        this.advance(stepMs);
        for (const fn of pending) fn?.();
      }
    },
  };
}

function collector() {
  const messages = [];
  return { messages, publish: (m) => messages.push(m) };
}

function buildPublisher(overrides = {}) {
  const clock = overrides.clock || fakeClock();
  const sink = overrides.sink || collector();
  const ctx = "context" in overrides ? overrides.context : fakeContext();
  const logs = [];
  const publisher = createAmplitudeEnvelopePublisher({
    audioContextFactory: overrides.audioContextFactory
      || (ctx === null ? () => null : () => ctx),
    publish: sink.publish,
    now: clock.now,
    requestFrame: clock.requestFrame.bind(clock),
    cancelFrame: clock.cancelFrame.bind(clock),
    logger: { warn: (...args) => logs.push(args) },
    ...(overrides.publisherOptions || {}),
  });
  return { publisher, clock, sink, ctx, logs };
}

// --- RMS -------------------------------------------------------------------

test("RMS of a known buffer matches the analytic value", () => {
  // Full-cycle sine at amplitude 0.5 → RMS = 0.5/sqrt(2) ≈ 0.35355
  const n = 1024;
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = 0.5 * Math.sin((2 * Math.PI * i) / n);
  assert.ok(Math.abs(rmsFromTimeDomain(buf) - 0.5 / Math.SQRT2) < 1e-4);

  // DC at 0.25 → RMS exactly 0.25
  assert.ok(Math.abs(rmsFromTimeDomain(new Float32Array(64).fill(0.25)) - 0.25) < 1e-6);
});

test("silence reads 0 and full scale reads 1", () => {
  assert.equal(rmsFromTimeDomain(new Float32Array(64)), 0);
  assert.equal(rmsFromTimeDomain(new Float32Array(64).fill(1)), 1);
  assert.equal(rmsFromTimeDomain(new Float32Array(64).fill(-1)), 1);
});

test("out-of-range samples clamp into [0,1]", () => {
  // A clipping/overdriven buffer must not publish >1.
  assert.equal(rmsFromTimeDomain(new Float32Array(64).fill(4.5)), 1);
  assert.equal(rmsFromTimeDomain(new Float32Array(64).fill(-9)), 1);
  const mixed = Float32Array.from([3, -3, 3, -3]);
  assert.equal(rmsFromTimeDomain(mixed), 1);
  assert.equal(rmsFromTimeDomain(Float32Array.from([Number.NaN, Number.NaN])), 0);
  assert.equal(rmsFromTimeDomain(new Float32Array(0)), 0);
});

// --- Throttle --------------------------------------------------------------

test("a 60fps drive loop publishes at most ~15 envelopes per second", () => {
  const { publisher, clock, sink, ctx } = buildPublisher();
  publisher.attachInput(fakeStream("mic"));
  for (const a of ctx.analysers) a.buffer = new Float32Array(128).fill(0.5);

  clock.pump(60, 1000 / 60); // one second of frames

  const envelopes = sink.messages.filter((m) => m.type === "envelope");
  assert.ok(envelopes.length <= 16, `expected <=16 envelopes, got ${envelopes.length}`);
  assert.ok(envelopes.length >= 12, `expected >=12 envelopes, got ${envelopes.length}`);

  // The throttle must be interval-based, not "every Nth frame": consecutive
  // publishes are separated by at least the configured interval.
  for (let i = 1; i < envelopes.length; i += 1) {
    assert.ok(
      envelopes[i].at - envelopes[i - 1].at >= ENVELOPE_INTERVAL_MS - 1e-9,
      `publish gap ${envelopes[i].at - envelopes[i - 1].at}ms < ${ENVELOPE_INTERVAL_MS}ms`,
    );
  }

  // Ten seconds of frames must scale linearly, not burst.
  const before = envelopes.length;
  clock.pump(600, 1000 / 60);
  const total = sink.messages.filter((m) => m.type === "envelope").length;
  assert.ok(total - before <= 160, `10s produced ${total - before} envelopes`);
});

test("published envelopes carry input and output floats in [0,1]", () => {
  const { publisher, clock, sink, ctx } = buildPublisher();
  publisher.attachInput(fakeStream("mic"));
  publisher.attachOutput(fakeStream("agent"));
  ctx.analysers[0].buffer = new Float32Array(128).fill(0.5);
  ctx.analysers[1].buffer = new Float32Array(128).fill(1);

  clock.pump(10, 1000 / 60);
  const envelope = sink.messages.find((m) => m.type === "envelope");
  assert.ok(envelope, "expected an envelope message");
  assert.ok(Math.abs(envelope.input - 0.5) < 1e-4);
  assert.equal(envelope.output, 1);
  assert.equal(envelope.audioAvailable, true);
});

// --- Stream end ------------------------------------------------------------

test("a stream ending publishes a final 0 rather than freezing", () => {
  const { publisher, clock, sink, ctx } = buildPublisher();
  const stream = fakeStream("mic");
  publisher.attachInput(stream);
  ctx.analysers[0].buffer = new Float32Array(128).fill(0.8);

  clock.pump(10, 1000 / 60);
  const before = sink.messages.filter((m) => m.type === "envelope");
  assert.ok(before.length > 0);
  assert.ok(before.at(-1).input > 0.5, "precondition: was publishing a live level");

  stream.track.end();

  const after = sink.messages.filter((m) => m.type === "envelope");
  assert.ok(after.length > before.length, "ending a track must publish a final frame");
  assert.equal(after.at(-1).input, 0, "final published input must be 0, not the last level");
});

test("stop() publishes a final zero envelope and releases the context", async () => {
  const { publisher, clock, sink, ctx } = buildPublisher();
  publisher.attachInput(fakeStream("mic"));
  ctx.analysers[0].buffer = new Float32Array(128).fill(0.7);
  clock.pump(10, 1000 / 60);

  await publisher.stop();

  const envelopes = sink.messages.filter((m) => m.type === "envelope");
  assert.equal(envelopes.at(-1).input, 0);
  assert.equal(envelopes.at(-1).output, 0);
  assert.equal(ctx.closed, true);

  // After stop, further frames must not resurrect the loop.
  const count = sink.messages.length;
  clock.pump(30, 1000 / 60);
  assert.equal(sink.messages.length, count);
});

// --- Degradation -----------------------------------------------------------

test("an unavailable AudioContext publishes nothing and throws nothing", () => {
  const sink = collector();
  const clock = fakeClock();
  const publisher = createAmplitudeEnvelopePublisher({
    audioContextFactory: null,
    publish: sink.publish,
    now: clock.now,
    requestFrame: clock.requestFrame.bind(clock),
    cancelFrame: clock.cancelFrame.bind(clock),
    logger: { warn() {} },
  });

  assert.doesNotThrow(() => publisher.attachInput(fakeStream("mic")));
  clock.pump(30, 1000 / 60);
  assert.equal(sink.messages.filter((m) => m.type === "envelope").length, 0);
  assert.doesNotThrow(() => publisher.stop());

  // Guard against the module silently falling back to a real global.
  assert.equal(typeof globalThis.AudioContext, "undefined");

  // attachInput() wraps #attach in a defensive catch, so `doesNotThrow` above
  // passes even if the missing-factory path throws internally. Drive the
  // private path directly through a public caller that has NO outer catch, so
  // this test fails if the inner guard is removed rather than only when the
  // redundant outer layer is.
  const bare = createAmplitudeEnvelopePublisher({
    audioContextFactory: null,
    publish: sink.publish,
    now: clock.now,
    requestFrame: clock.requestFrame.bind(clock),
    cancelFrame: clock.cancelFrame.bind(clock),
    logger: { warn() {} },
  });
  // markAudioUnavailable has no try/catch of its own; it reaches the same
  // degradation path and must stay silent.
  assert.doesNotThrow(() => bare.markAudioUnavailable("text_only"));
  // A degraded publisher must report unavailability rather than nothing at all.
  const reasons = sink.messages
    .filter((m) => m.type === "audio-availability")
    .map((m) => m.reason);
  assert.ok(
    reasons.includes("no_audio_context"),
    `expected a no_audio_context marker, got ${JSON.stringify(reasons)}`,
  );
});

test("a throwing AudioContext constructor degrades instead of breaking the session", () => {
  const sink = collector();
  const clock = fakeClock();
  const logs = [];
  const publisher = createAmplitudeEnvelopePublisher({
    audioContextFactory: () => {
      throw new Error("AudioContext construction failed");
    },
    publish: sink.publish,
    now: clock.now,
    requestFrame: clock.requestFrame.bind(clock),
    cancelFrame: clock.cancelFrame.bind(clock),
    logger: { warn: (...a) => logs.push(a) },
  });

  assert.doesNotThrow(() => publisher.attachInput(fakeStream("mic")));
  clock.pump(30, 1000 / 60);
  assert.equal(sink.messages.filter((m) => m.type === "envelope").length, 0);
  assert.ok(logs.length > 0, "a degraded visualizer must leave a log trail");
});

test("a throwing publish sink never propagates into the session path", () => {
  const clock = fakeClock();
  const ctx = fakeContext();
  const publisher = createAmplitudeEnvelopePublisher({
    audioContextFactory: () => ctx,
    publish: () => {
      throw new Error("message bus closed");
    },
    now: clock.now,
    requestFrame: clock.requestFrame.bind(clock),
    cancelFrame: clock.cancelFrame.bind(clock),
    logger: { warn() {} },
  });
  publisher.attachInput(fakeStream("mic"));
  assert.doesNotThrow(() => clock.pump(30, 1000 / 60));

  // The frame loop has its own catch, so pumping frames alone would still pass
  // if #emit stopped guarding. markAudioUnavailable() emits with no try/catch
  // between it and the sink, so it fails if the guard inside #emit is removed.
  assert.doesNotThrow(() => publisher.markAudioUnavailable("text_only"));
});

// --- Text-only -------------------------------------------------------------

test("text-only emits audioAvailable:false exactly once and no envelopes", () => {
  const sink = collector();
  const clock = fakeClock();
  let constructed = 0;
  const publisher = createAmplitudeEnvelopePublisher({
    audioContextFactory: () => {
      constructed += 1;
      return fakeContext();
    },
    publish: sink.publish,
    now: clock.now,
    requestFrame: clock.requestFrame.bind(clock),
    cancelFrame: clock.cancelFrame.bind(clock),
    logger: { warn() {} },
  });

  publisher.markAudioUnavailable("text_only");
  publisher.markAudioUnavailable("text_only");
  publisher.markAudioUnavailable("text_only");
  clock.pump(30, 1000 / 60);

  assert.equal(constructed, 0, "text-only must never construct an AudioContext");
  const markers = sink.messages.filter((m) => m.type === "audio-availability");
  assert.equal(markers.length, 1, `expected exactly 1 marker, got ${markers.length}`);
  assert.equal(markers[0].audioAvailable, false);
  assert.equal(markers[0].reason, "text_only");
  assert.equal(sink.messages.filter((m) => m.type === "envelope").length, 0);
});

test("audio mode with no signal is distinguishable from text-only", () => {
  const { publisher, clock, sink } = buildPublisher();
  publisher.attachInput(fakeStream("mic")); // analyser buffers stay all-zero
  clock.pump(30, 1000 / 60);

  const envelopes = sink.messages.filter((m) => m.type === "envelope");
  assert.ok(envelopes.length > 0, "audio mode with silence still publishes measured zeros");
  assert.equal(envelopes[0].input, 0);
  assert.equal(envelopes[0].audioAvailable, true);
  assert.equal(sink.messages.some((m) => m.type === "audio-availability" && m.audioAvailable === false), false);
});

// --- Suspended context -----------------------------------------------------

test("a suspended context that cannot resume is reported, not published as zeros", async () => {
  const ctx = fakeContext({ state: "suspended", resumeTo: "suspended", failResume: true });
  const { publisher, clock, sink } = buildPublisher({ context: ctx });

  publisher.attachInput(fakeStream("mic"));
  await publisher.whenSettled();
  clock.pump(60, 1000 / 60);

  assert.ok(ctx.resumeCalls > 0, "a suspended context must be resumed, not just observed");
  assert.equal(
    sink.messages.filter((m) => m.type === "envelope").length,
    0,
    "a suspended context must publish no envelopes — zeros would read as silence",
  );
  const markers = sink.messages.filter((m) => m.type === "audio-availability");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].audioAvailable, false);
  assert.equal(markers[0].reason, "context_suspended");
});

test("a suspended offscreen AudioContext falls back to WebRTC microphone audioLevel", async () => {
  const ctx = fakeContext({ state: "suspended", resumeTo: "suspended", failResume: true });
  const { publisher, clock, sink } = buildPublisher({ context: ctx });
  const stream = fakeStream("mic");
  const peerConnection = {
    async getStats(track) {
      assert.equal(track, stream.track);
      return new Map([
        ["mic-source", {
          type: "media-source",
          kind: "audio",
          audioLevel: 0.42,
        }],
      ]);
    },
  };

  publisher.attachInput(stream, peerConnection);
  await publisher.whenSettled();
  clock.pump(1, ENVELOPE_INTERVAL_MS);
  await publisher.whenSettled();

  const envelopes = sink.messages.filter((message) => message.type === "envelope");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].input, 0.42);
  assert.equal(envelopes[0].audioAvailable, true);
  assert.equal(
    sink.messages.some((message) => message.reason === "context_suspended"),
    false,
    "healthy WebRTC stats must prevent a false unavailable marker",
  );
});

test("a suspended context that resumes measures normally", async () => {
  const ctx = fakeContext({ state: "suspended", resumeTo: "running" });
  const { publisher, clock, sink } = buildPublisher({ context: ctx });

  publisher.attachInput(fakeStream("mic"));
  await publisher.whenSettled();
  for (const a of ctx.analysers) a.buffer = new Float32Array(128).fill(0.5);
  clock.pump(10, 1000 / 60);

  assert.equal(ctx.resumeCalls, 1);
  const envelopes = sink.messages.filter((m) => m.type === "envelope");
  assert.ok(envelopes.length > 0);
  assert.ok(Math.abs(envelopes[0].input - 0.5) < 1e-4);
  assert.equal(
    sink.messages.some((m) => m.type === "audio-availability" && m.audioAvailable === false),
    false,
    "a context that resumed must not leave a stale unavailable marker",
  );
});

test("a context suspending mid-run stops publishing and reports once", async () => {
  const ctx = fakeContext();
  const { publisher, clock, sink } = buildPublisher({ context: ctx });
  publisher.attachInput(fakeStream("mic"));
  ctx.analysers[0].buffer = new Float32Array(128).fill(0.6);
  clock.pump(10, 1000 / 60);
  assert.ok(sink.messages.filter((m) => m.type === "envelope").length > 0);

  ctx.state = "suspended";
  ctx.resumeTo = "suspended";
  const before = sink.messages.filter((m) => m.type === "envelope").length;
  clock.pump(60, 1000 / 60);

  assert.equal(
    sink.messages.filter((m) => m.type === "envelope").length,
    before,
    "no envelopes may be published while the context reads suspended",
  );
  const markers = sink.messages.filter(
    (m) => m.type === "audio-availability" && m.reason === "context_suspended",
  );
  assert.equal(markers.length, 1, "the suspended report must not repeat every frame");
});

test("the production scheduler measures in an offscreen document where rAF never fires", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let rafRequests = 0;
  globalThis.requestAnimationFrame = () => {
    rafRequests += 1;
    return 99;
  };
  globalThis.cancelAnimationFrame = () => {};

  const ctx = fakeContext();
  const sink = collector();
  const publisher = createAmplitudeEnvelopePublisher({
    audioContextFactory: () => ctx,
    publish: sink.publish,
    intervalMs: 20,
    logger: { warn() {} },
  });

  try {
    publisher.attachInput(fakeStream("offscreen-mic"));
    ctx.analysers[0].buffer = new Float32Array(128).fill(0.4);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const envelopes = sink.messages.filter((message) => message.type === "envelope");
    assert.ok(envelopes.length > 0, "hidden/offscreen measurement must not depend on a paint frame");
    assert.ok(Math.abs(envelopes[0].input - 0.4) < 1e-4);
    assert.equal(rafRequests, 0, "the offscreen measurement scheduler must not request a paint frame");
  } finally {
    await publisher.stop();
    if (originalRequestAnimationFrame === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame === undefined) {
      delete globalThis.cancelAnimationFrame;
    } else {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  }
});

// --- Class surface ---------------------------------------------------------

test("the publisher class is exported and the factory returns one", () => {
  const { publisher } = buildPublisher();
  assert.ok(publisher instanceof AmplitudeEnvelopePublisher);
});
