/**
 * Amplitude envelope measurement for the hosted Realtime voice session.
 *
 * Measures mic (input) and agent (output) audio where the MediaStreams actually
 * live — the offscreen document — and publishes a bounded envelope the UI can
 * render a live waveform from.
 *
 * Three properties this module exists to hold:
 *
 *   1. Bounded publish rate. RMS is computed per animation frame (~60Hz) but
 *      published on a ~15Hz interval. The extension message bus carries event-
 *      rate traffic; a 60fps stream on it would be a new and unwelcome load.
 *
 *   2. "No audio expected" is distinct from "no signal". Text-only sessions
 *      never build an audio graph at all, and a suspended AudioContext reads
 *      all zeros through a perfectly healthy AnalyserNode. Both would render as
 *      a flat line identical to real silence, which is the exact question this
 *      feature exists to answer. Those states publish an `audio-availability`
 *      marker instead of a fake measurement.
 *
 *   3. It never throws into the session path. A voice session must not break
 *      because a visualizer could not start.
 */

/** Publish interval: ~15Hz. */
export const ENVELOPE_INTERVAL_MS = 1000 / 15;

/** Analyser window. 1024 samples @48kHz ≈ 21ms — comfortably under a frame. */
const FFT_SIZE = 1024;

export const AUDIO_UNAVAILABLE_TEXT_ONLY = "text_only";
export const AUDIO_UNAVAILABLE_CONTEXT_SUSPENDED = "context_suspended";
export const AUDIO_UNAVAILABLE_NO_AUDIO_CONTEXT = "no_audio_context";

/**
 * Root-mean-square of a time-domain buffer, clamped to [0,1].
 *
 * Web Audio time-domain floats are nominally [-1,1], but a clipping or
 * mis-scaled source can exceed that, and a detached/garbage buffer can carry
 * NaN. Non-finite samples are dropped rather than poisoning the whole frame to
 * NaN — one bad sample must not blank the waveform.
 */
export function rmsFromTimeDomain(buffer) {
  if (!buffer || typeof buffer.length !== "number" || buffer.length === 0) {
    return 0;
  }
  let sum = 0;
  let counted = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    if (!Number.isFinite(sample)) continue;
    sum += sample * sample;
    counted += 1;
  }
  if (counted === 0) return 0;
  const rms = Math.sqrt(sum / counted);
  if (!Number.isFinite(rms)) return 0;
  if (rms <= 0) return 0;
  return rms >= 1 ? 1 : rms;
}

function defaultAudioContextFactory() {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  return typeof Ctor === "function" ? new Ctor() : null;
}

function defaultRequestFrame(fn) {
  // This publisher runs in a chrome.offscreen document. Hidden documents can
  // expose requestAnimationFrame while never delivering a paint frame, so the
  // existence of rAF is not evidence that it is a viable scheduler. Sampling
  // microphone state is background work, not painting; keep it timer-driven.
  return setTimeout(() => fn(Date.now()), 16);
}

function defaultCancelFrame(handle) {
  clearTimeout(handle);
}

export class AmplitudeEnvelopePublisher {
  constructor({
    audioContextFactory = defaultAudioContextFactory,
    publish = () => {},
    now = () => Date.now(),
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    intervalMs = ENVELOPE_INTERVAL_MS,
    logger = console,
  } = {}) {
    this.audioContextFactory = typeof audioContextFactory === "function" ? audioContextFactory : null;
    this.publishSink = typeof publish === "function" ? publish : () => {};
    this.now = typeof now === "function" ? now : () => Date.now();
    this.requestFrame = typeof requestFrame === "function" ? requestFrame : defaultRequestFrame;
    this.cancelFrame = typeof cancelFrame === "function" ? cancelFrame : defaultCancelFrame;
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : ENVELOPE_INTERVAL_MS;
    this.logger = logger || console;

    this.context = null;
    this.contextFailed = false;
    this.stopped = false;
    this.frameHandle = null;
    this.lastPublishAt = -Infinity;
    this.statsPeerConnection = null;
    this.statsInputTrack = null;
    this.statsInFlight = false;
    /** Reasons already reported, so a per-frame condition reports once. */
    this.reportedUnavailable = new Set();
    /** Resolves once any in-flight resume() settles — lets tests await setup. */
    this.pending = Promise.resolve();

    this.channels = {
      input: this.#emptyChannel(),
      output: this.#emptyChannel(),
    };
  }

  #emptyChannel() {
    return { analyser: null, source: null, buffer: null, stream: null, track: null, onEnded: null, level: 0 };
  }

  // -- publishing -----------------------------------------------------------

  /** Every outbound message goes through here. The bus must never throw in. */
  #emit(message) {
    try {
      this.publishSink(message);
    } catch (error) {
      this.logger?.warn?.("[amplitude-envelope] publish failed", error);
    }
  }

  #publishEnvelope(at, { force = false } = {}) {
    this.lastPublishAt = at;
    this.#emit({
      type: "envelope",
      audioAvailable: true,
      input: this.channels.input.level,
      output: this.channels.output.level,
      at,
      final: force === true,
    });
  }

  /**
   * Report a state where no honest measurement exists. Reported at most once
   * per reason: a suspended context is evaluated every frame, and repeating the
   * marker at frame rate would recreate exactly the message-bus load the
   * throttle exists to prevent.
   */
  #reportUnavailable(reason) {
    if (this.reportedUnavailable.has(reason)) return;
    this.reportedUnavailable.add(reason);
    this.#emit({
      type: "audio-availability",
      audioAvailable: false,
      reason,
      at: this.now(),
    });
  }

  /**
   * Text-only sessions have no audio graph at all. Called instead of attach*,
   * so a consumer can tell "text mode, no audio expected" from "audio mode, no
   * signal" — without this marker both render as an identical flat line.
   */
  markAudioUnavailable(reason = AUDIO_UNAVAILABLE_TEXT_ONLY) {
    if (this.stopped) return;
    this.#reportUnavailable(reason);
  }

  // -- graph ----------------------------------------------------------------

  /**
   * Lazily build the AudioContext. Returns null when audio measurement is not
   * possible; callers degrade to publishing nothing. Construction is attempted
   * once — a browser that refused an AudioContext will refuse it every frame.
   */
  #ensureContext() {
    if (this.context || this.contextFailed) return this.context;
    if (!this.audioContextFactory) {
      this.contextFailed = true;
      this.logger?.warn?.("[amplitude-envelope] no AudioContext factory; amplitude disabled");
      this.#reportUnavailable(AUDIO_UNAVAILABLE_NO_AUDIO_CONTEXT);
      return null;
    }
    let context = null;
    try {
      context = this.audioContextFactory();
    } catch (error) {
      context = null;
      this.logger?.warn?.("[amplitude-envelope] AudioContext construction failed", error);
    }
    if (!context || typeof context.createAnalyser !== "function") {
      this.contextFailed = true;
      this.logger?.warn?.("[amplitude-envelope] AudioContext unavailable; amplitude disabled");
      this.#reportUnavailable(AUDIO_UNAVAILABLE_NO_AUDIO_CONTEXT);
      return null;
    }
    this.context = context;
    this.#resumeIfSuspended();
    return context;
  }

  /**
   * A context created without a user gesture starts `suspended`, and a
   * suspended AnalyserNode reads all zeros through a healthy graph — the exact
   * shape of real silence. Try to resume; the frame loop refuses to publish
   * while the state is still not "running".
   */
  #resumeIfSuspended() {
    const context = this.context;
    if (!context || context.state !== "suspended" || typeof context.resume !== "function") return;
    this.pending = this.pending
      .then(() => context.resume())
      .catch((error) => {
        this.logger?.warn?.("[amplitude-envelope] AudioContext resume rejected", error);
      });
  }

  /** Resolves once construction/resume settles. Test seam; no production use. */
  async whenSettled() {
    await this.pending;
    return this;
  }

  #attach(channelName, stream) {
    if (this.stopped || !stream) return;
    const context = this.#ensureContext();
    if (!context) return;

    this.#detachChannel(channelName);
    const channel = this.channels[channelName];
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      // Deliberately NOT connected to context.destination: the remote track is
      // already played by the <audio> element (or the avatar adapter), and
      // routing it again here would double the agent's voice.
      channel.analyser = analyser;
      channel.source = source;
      channel.stream = stream;
      channel.buffer = new Float32Array(FFT_SIZE);
      channel.level = 0;
    } catch (error) {
      this.logger?.warn?.(`[amplitude-envelope] failed to attach ${channelName}`, error);
      this.#detachChannel(channelName);
      return;
    }

    const track = stream.getAudioTracks?.()?.[0] || stream.getTracks?.()?.[0] || null;
    if (track?.addEventListener) {
      // A frozen waveform reads as "still listening". When the track ends,
      // force a final 0 through immediately, bypassing the throttle.
      const onEnded = () => this.#handleTrackEnded(channelName);
      track.addEventListener("ended", onEnded);
      channel.track = track;
      channel.onEnded = onEnded;
    }

    this.#startLoop();
  }

  /** Attach the user's microphone stream. */
  attachInput(stream, peerConnection = null) {
    try {
      const track = stream?.getAudioTracks?.()?.[0] || stream?.getTracks?.()?.[0] || null;
      if (track && typeof peerConnection?.getStats === "function") {
        this.statsPeerConnection = peerConnection;
        this.statsInputTrack = track;
      }
      this.#attach("input", stream);
      // Hidden/offscreen AudioContexts can remain suspended even while WebRTC
      // capture is healthy. Keep measuring via getStats(), which is independent
      // of Web Audio autoplay state.
      if (this.statsPeerConnection) this.#startLoop();
    } catch (error) {
      this.logger?.warn?.("[amplitude-envelope] attachInput failed", error);
    }
  }

  /** Attach the agent's remote audio stream. */
  attachOutput(stream) {
    try {
      this.#attach("output", stream);
    } catch (error) {
      this.logger?.warn?.("[amplitude-envelope] attachOutput failed", error);
    }
  }

  #handleTrackEnded(channelName) {
    if (channelName === "input") {
      this.statsPeerConnection = null;
      this.statsInputTrack = null;
    }
    this.#detachChannel(channelName);
    this.channels[channelName].level = 0;
    if (this.stopped) return;
    this.#publishEnvelope(this.now(), { force: true });
    if (!this.channels.input.analyser && !this.channels.output.analyser) {
      this.#stopLoop();
    }
  }

  #detachChannel(channelName) {
    const channel = this.channels[channelName];
    if (channel.track && channel.onEnded) {
      try {
        channel.track.removeEventListener?.("ended", channel.onEnded);
      } catch {
        // A dead track cannot leak a listener that matters.
      }
    }
    try {
      channel.source?.disconnect?.();
    } catch {
      // Disconnect races teardown; the node is discarded either way.
    }
    try {
      channel.analyser?.disconnect?.();
    } catch {
      // Same.
    }
    this.channels[channelName] = this.#emptyChannel();
    this.channels[channelName].level = 0;
  }

  // -- frame loop -----------------------------------------------------------

  #startLoop() {
    if (this.frameHandle !== null || this.stopped) return;
    const tick = () => {
      this.frameHandle = null;
      if (this.stopped) return;
      try {
        this.#measureFrame();
      } catch (error) {
        this.logger?.warn?.("[amplitude-envelope] measurement frame failed", error);
      }
      if (!this.stopped) {
        this.frameHandle = this.requestFrame(tick);
      }
    };
    this.frameHandle = this.requestFrame(tick);
  }

  #stopLoop() {
    if (this.frameHandle === null) return;
    try {
      this.cancelFrame(this.frameHandle);
    } catch {
      // Cancelling an already-fired frame is harmless.
    }
    this.frameHandle = null;
  }

  #measureFrame() {
    const context = this.context;

    // Suspended reads zeros through a healthy graph. Report it; never publish
    // it as a measurement — "your mic is dead" is a far worse answer than
    // "audio never started" when the truth is the latter.
    if (!context || context.state !== "running") {
      this.#resumeIfSuspended();
      if (this.statsPeerConnection && this.statsInputTrack) {
        this.#measureInputFromWebRtcStats();
        return;
      }
      if (context?.state !== "running") {
        this.#reportUnavailable(AUDIO_UNAVAILABLE_CONTEXT_SUSPENDED);
        return;
      }
    }

    for (const name of ["input", "output"]) {
      const channel = this.channels[name];
      if (!channel.analyser || !channel.buffer) {
        channel.level = 0;
        continue;
      }
      channel.analyser.getFloatTimeDomainData(channel.buffer);
      channel.level = rmsFromTimeDomain(channel.buffer);
    }

    const at = this.now();
    if (at - this.lastPublishAt < this.intervalMs) return;
    this.#publishEnvelope(at);
  }

  #measureInputFromWebRtcStats() {
    const at = this.now();
    if (this.statsInFlight || at - this.lastPublishAt < this.intervalMs) return;
    this.statsInFlight = true;
    const peerConnection = this.statsPeerConnection;
    const track = this.statsInputTrack;
    this.pending = this.pending
      .then(async () => {
        const report = await peerConnection.getStats(track);
        let level = null;
        report?.forEach?.((entry) => {
          if (
            level === null
            && entry?.type === "media-source"
            && entry?.kind === "audio"
            && Number.isFinite(entry.audioLevel)
          ) {
            level = Math.max(0, Math.min(1, entry.audioLevel));
          }
        });
        if (level === null || this.stopped) return;
        this.channels.input.level = level;
        this.#publishEnvelope(this.now());
      })
      .catch((error) => {
        this.logger?.warn?.("[amplitude-envelope] WebRTC audio stats unavailable", error);
      })
      .finally(() => {
        this.statsInFlight = false;
      });
  }

  // -- teardown -------------------------------------------------------------

  /**
   * Tear the graph down and leave the waveform at 0. Safe to call repeatedly
   * and safe to call when nothing was ever attached.
   */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.#stopLoop();
    this.#detachChannel("input");
    this.#detachChannel("output");
    this.statsPeerConnection = null;
    this.statsInputTrack = null;

    if (this.context) {
      // Only a graph that actually published can leave a stuck waveform.
      if (Number.isFinite(this.lastPublishAt)) {
        this.#emit({
          type: "envelope",
          audioAvailable: true,
          input: 0,
          output: 0,
          at: this.now(),
          final: true,
        });
      }
      const context = this.context;
      this.context = null;
      try {
        await context.close?.();
      } catch (error) {
        this.logger?.warn?.("[amplitude-envelope] AudioContext close failed", error);
      }
    }
  }
}

/**
 * Construct a publisher. Every environment dependency is injected so the
 * measurement logic is unit-testable without a real AudioContext.
 */
export function createAmplitudeEnvelopePublisher(options = {}) {
  return new AmplitudeEnvelopePublisher(options);
}
