/**
 * The overlay resting pill: [state dot] [live waveform] [current action in words].
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN agent-surface.js
 * ---------------------------------------------------
 * agent-surface.js is browser code that reaches for `document` at import time, so
 * nothing in it can be unit-tested. The pill's decisions — which state an event
 * resolves to, which colour that state carries, which CSS properties the colour
 * is allowed to reach, whether the wave has gone stale — are exactly the parts
 * that fail invisibly. They live here, behind an injected `surface`, so a node
 * test exercises the real decision rather than a re-implementation of it.
 *
 * WHY THE PILL RENDERS IN THE EXTENSION IFRAME
 * --------------------------------------------
 * docs/chrome-extension.md:78-80 — the trusted menu embeds extension UI in an
 * iframe so it can request microphone permission from a visible extension
 * surface. Page-world shadow DOM cannot request a microphone. Do not "simplify"
 * this by moving the pill into content.js's shadow host: that would silently
 * cost the product its ability to hear the user.
 *
 * THREE CONSTRAINTS, IN THE PRODUCT OWNER'S PRIORITY ORDER
 * -------------------------------------------------------
 *   1. Keep the user informed of current state. This is why the action is named
 *      in WORDS and not merely coloured — this agent acts on the user's page,
 *      and an unnamed action is a different risk class than in a chat product.
 *   2. Friendly, not overwhelming. One line. The transcript is a thing you open.
 *   3. Graphically appealing — but never at the cost of 1 or 2.
 */

/**
 * The six activity states (KTD4). `error` is deliberately NOT one of them: it
 * is orthogonal to activity, pre-existed this unit, and is retained as-is.
 */
export const ACTIVITY_STATES = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "working",
  "muted",
]);

/**
 * Legacy shipped token -> six-state vocabulary.
 *
 * The rename happens at the CALL SITES in agent-surface.js; this table exists so a
 * test can prove the shipped icon set is fully covered. `muted` has no entry
 * because no VOICE_ICONS token ever meant "muted" — it is driven by mute state,
 * not by a session event.
 */
export const VOICE_STATE_ALIASES = Object.freeze({
  idle: "idle",
  connecting: "thinking",
  listening: "listening",
  busy: "working",
  live: "speaking",
  error: "error",
});

/**
 * Per-state hue, CONTAINED TO STROKE.
 *
 * The pill sits on someone else's website. A coloured FILL fights the host
 * site's own palette and reads as page chrome; a coloured stroke on a neutral
 * surface reads as ours. So the hue reaches the waveform and a thin rim, and
 * nothing else — enforced by PILL_COLOR_PROPERTIES below.
 *
 * RED IS EXCLUSIVE TO MUTED. Amber for `working` is fine — it is far enough
 * around the wheel to be distinguishable — but no other state may drift toward
 * red. "My mic is hot and I didn't notice" is the worst failure this UI can
 * produce, and red only keeps its alarm value if it is never diluted. The
 * `alarm` flag and the hue-angle assertion in the test both police this.
 */
export const PILL_STATE_TOKENS = Object.freeze({
  idle: Object.freeze({ hue: "#8b96a5", label: "Ready", alarm: false }),
  listening: Object.freeze({ hue: "#3b82f6", label: "Listening", alarm: false }),
  thinking: Object.freeze({ hue: "#22b8cf", label: "Thinking", alarm: false }),
  speaking: Object.freeze({ hue: "#12b886", label: "Speaking", alarm: false }),
  working: Object.freeze({ hue: "#f08c00", label: "Working", alarm: false }),
  muted: Object.freeze({ hue: "#e03131", label: "Microphone muted", alarm: true }),
});

/**
 * The ONLY custom properties a state's hue may be written to. Every one of
 * these is consumed by a stroke, a border, or a canvas line in agent-surface.html.
 */
export const PILL_COLOR_PROPERTIES = Object.freeze([
  "--pill-hue",
  "--pill-rim",
]);

/**
 * Properties the containment rule forbids. Naming them explicitly (rather than
 * only allow-listing) means a future edit that adds `--pill-fill` to the state
 * table fails loudly instead of quietly tinting the pill's body.
 */
export const PILL_FORBIDDEN_COLOR_PROPERTIES = Object.freeze([
  "--pill-background",
  "--pill-fill",
  "--pill-surface-fill",
  "background",
  "background-color",
]);

/** A wave with no fresh envelope for this long flattens rather than freezing. */
export const WAVE_STALE_AFTER_MS = 1000;

/** Live Activities: no animation may exceed 2s. Exported so CSS can be checked. */
export const MAX_ANIMATION_MS = 2000;

/**
 * Map a raw Web Audio RMS reading onto a perceptually useful visual range.
 *
 * Ordinary microphone speech commonly lands around 0.01–0.05 RMS. Passing
 * that straight to a 0–1 visualizer makes a healthy microphone look flat while
 * tests using an artificial 0.65 signal look excellent.
 */
export function visualizeAudioLevel(level) {
  const raw = clamp01(level);
  const noiseFloor = 0.006;
  // Real microphone RMS routinely exceeds 0.12 during ordinary close-mic
  // speech. Saturating there made the waveform behave like a binary VAD lamp.
  // Preserve enough headroom for soft, normal, raised, and loud speech to
  // occupy visibly different portions of the capsule.
  const speechCeiling = 0.35;
  if (raw <= noiseFloor) return 0;
  const normalized = clamp01((raw - noiseFloor) / (speechCeiling - noiseFloor));
  return normalized ** 0.7;
}

/**
 * Throw on an unknown state.
 *
 * This function is the whole point of the rename. The shipped code did
 * `VOICE_ICONS[state] || VOICE_ICONS.idle`, so a call site that was missed
 * during a rename produced a completely plausible idle pill and no error
 * anywhere — the failure was invisible by construction. Every state entering
 * the pill goes through here first.
 */
export function assertPillState(state) {
  if (!ACTIVITY_STATES.includes(state)) {
    throw new Error(
      `unknown pill state: ${String(state)} (expected one of ${ACTIVITY_STATES.join(", ")})`,
    );
  }
  return state;
}

/** `pointer_click` / `browser.navigate` -> "pointer click" / "browser navigate". */
function humanizeToolName(name) {
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return "a tool";
  return raw.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Map a hosted-session event onto {state, label}, or null when the event says
 * nothing about the current activity.
 *
 * Returning null for `tool.completed` is deliberate: a completed tool does not
 * know what the session is doing next. Pinning a state there would show
 * "Ready" over an agent that is still mid-response. The session's own next
 * event decides.
 */
export function resolvePillState(event) {
  const type = event?.type;
  if (!type) return null;

  if (type === "actions_json.tool.started") {
    return { state: "working", label: `Using ${humanizeToolName(event.name)}` };
  }
  if (type === "actions_json.tool.completed") {
    return null;
  }
  if (type === "input_audio_buffer.speech_started") {
    return { state: "listening", label: PILL_STATE_TOKENS.listening.label };
  }
  if (type === "response.created") {
    return { state: "thinking", label: PILL_STATE_TOKENS.thinking.label };
  }
  if (
    type === "response.audio_transcript.delta" ||
    type === "response.output_audio_transcript.delta"
  ) {
    return event.delta ? { state: "speaking", label: PILL_STATE_TOKENS.speaking.label } : null;
  }
  if (
    type === "response.done" ||
    type === "response.audio_transcript.done" ||
    type === "response.output_audio_transcript.done"
  ) {
    return { state: "idle", label: PILL_STATE_TOKENS.idle.label };
  }
  return null;
}

const AUDIO_UNAVAILABLE_LABELS = Object.freeze({
  text_only: "Text only — no microphone",
  context_suspended: "Text only — audio not started",
  no_audio_context: "Text only — audio unavailable",
});

/**
 * The pill presenter.
 *
 * `surface` is every DOM/canvas touch, injected so this module stays testable
 * and so agent-surface.js owns the one place that knows about elements. `now` is
 * injected for the staleness clock.
 */
export function createPillPresenter({ surface, now = () => Date.now() } = {}) {
  if (!surface) throw new Error("createPillPresenter requires a surface");

  let activityState = "idle";
  let activityLabel = PILL_STATE_TOKENS.idle.label;
  let muted = false;
  let audioMode = null;
  let unavailableReason = null;

  // Last values actually written. Live Activities discipline: the surface is
  // touched only when one of these changes, so an event storm that says the
  // same thing costs nothing and the pill never flickers.
  let renderedState = null;
  let renderedLabel = null;
  let renderedAmplitude = null;
  let renderedWaveRunning = null;

  let lastEnvelopeAt = -Infinity;
  let lastLevel = 0;

  function effectiveState() {
    return muted ? "muted" : activityState;
  }

  function effectiveLabel() {
    if (muted) return PILL_STATE_TOKENS.muted.label;
    if (audioMode === "unavailable") {
      return AUDIO_UNAVAILABLE_LABELS[unavailableReason] || AUDIO_UNAVAILABLE_LABELS.text_only;
    }
    return activityLabel;
  }

  function render() {
    const state = assertPillState(effectiveState());
    const label = effectiveLabel();

    if (state !== renderedState) {
      renderedState = state;
      surface.setState(state);
      const token = PILL_STATE_TOKENS[state];
      // Containment: only PILL_COLOR_PROPERTIES ever receive the hue.
      for (const property of PILL_COLOR_PROPERTIES) {
        surface.setColorVariable(property, token.hue);
      }
    }
    if (label !== renderedLabel) {
      renderedLabel = label;
      surface.setLabel(label);
    }
  }

  function renderWave() {
    // A wave that keeps animating while the mic is unavailable is a lie about
    // a live microphone; stop it and let the non-audio presentation speak.
    const shouldRun = audioMode === "measuring";
    if (shouldRun !== renderedWaveRunning) {
      renderedWaveRunning = shouldRun;
      if (shouldRun) surface.startWave();
      else surface.stopWave();
    }
    if (!shouldRun) {
      if (renderedAmplitude !== 0) {
        renderedAmplitude = 0;
        surface.setWaveAmplitude(0);
      }
      return;
    }
    const stale = now() - lastEnvelopeAt > WAVE_STALE_AFTER_MS;
    const amplitude = stale ? 0 : lastLevel;
    if (amplitude === renderedAmplitude) return;
    renderedAmplitude = amplitude;
    surface.setWaveAmplitude(amplitude);
    // Speed tracks amplitude gently so a loud moment reads as energy rather
    // than as a different animation. Bounded well under the 2s ceiling.
    surface.setWaveSpeed?.(0.06 + amplitude * 0.14);
  }

  function setAudioMode(mode, reason = null) {
    if (audioMode === mode && unavailableReason === reason) return;
    audioMode = mode;
    unavailableReason = reason;
    surface.setAudioMode(mode);
    render();
    renderWave();
  }

  return {
    /** Set the current activity. Throws on an unmapped state name. */
    setState(state, label) {
      assertPillState(state);
      activityState = state;
      activityLabel = typeof label === "string" && label ? label : PILL_STATE_TOKENS[state].label;
      render();
    },

    /** Apply a resolved session event, if it says anything about activity. */
    applyEvent(event) {
      const resolved = resolvePillState(event);
      if (!resolved) return false;
      this.setState(resolved.state, resolved.label);
      return true;
    },

    /**
     * Mute is an OVERRIDE, not a state transition: the underlying activity is
     * remembered so unmuting restores it rather than dropping to idle, which
     * would misreport a live session as finished.
     */
    setMuted(value) {
      const next = value === true;
      if (next === muted) return;
      muted = next;
      render();
      renderWave();
    },

    /** Consume a U2 amplitude envelope or availability marker. */
    handleEnvelope(message) {
      if (message?.type === "audio-availability" && message.audioAvailable === false) {
        lastLevel = 0;
        setAudioMode("unavailable", message.reason || "text_only");
        return;
      }
      if (message?.type !== "envelope") return;
      // Which channel is honest depends on who is talking. Reading input while
      // the agent speaks would render the agent's own voice bleeding into the
      // mic as if the user were talking.
      const level = effectiveState() === "speaking"
        ? clamp01(message.output)
        : clamp01(message.input);
      lastEnvelopeAt = Number.isFinite(message.at) ? message.at : now();
      lastLevel = visualizeAudioLevel(level);
      setAudioMode("measuring");
      renderWave();
    },

    /** Drive the staleness check. Called from the pill's own animation timer. */
    tick() {
      renderWave();
    },

    /** Test/diagnostic read-out. Never used to make a rendering decision. */
    inspect() {
      return { state: effectiveState(), label: effectiveLabel(), audioMode, muted, level: lastLevel };
    },
  };
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number >= 1 ? 1 : number;
}
