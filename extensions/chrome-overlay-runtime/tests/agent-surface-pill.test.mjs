// U4 — the overlay resting pill: state contract, colour containment, and the
// live waveform's relationship to the U2 amplitude envelope.
//
// WHAT LIVES HERE vs WHAT LIVES IN PLAYWRIGHT
// -------------------------------------------
// Everything below exercises `src/agent/pill-presentation.mjs`, which is the
// real decision layer: which of the six states a session event resolves to,
// which colour token that state carries, which CSS custom properties the token
// is allowed to reach, and how the envelope drives the wave. That is logic, and
// logic belongs in node.
//
// What is NOT here, deliberately:
//   * that the pill is visually legible, or that the stroke actually paints;
//   * that siriwave's canvas renders anything;
//   * that the pill region appears only when surface=overlay in a real load.
// Those are rendering facts. A node test cannot see a painted pixel, and a node
// test that pretended to would be worse than no test. They are asserted in
// tests/agent-surface.spec.js against a real browser.
//
// The containment rule ("hue reaches stroke/rim only, never a fill") is proved
// HERE rather than in Playwright on purpose: the module is the single place a
// state's colour is decided, so an exhaustive over-every-state assertion is
// possible. A browser test can only sample the states it happens to drive.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_STATES,
  PILL_STATE_TOKENS,
  PILL_COLOR_PROPERTIES,
  PILL_FORBIDDEN_COLOR_PROPERTIES,
  WAVE_STALE_AFTER_MS,
  VOICE_STATE_ALIASES,
  assertPillState,
  resolvePillState,
  createPillPresenter,
  visualizeAudioLevel,
} from "../src/agent/pill-presentation.mjs";

import { VOICE_ICONS } from "../src/agent/voice-icons.mjs";

// ---------------------------------------------------------------------------
// A recording surface. The presenter never touches a real element; it writes
// through this seam, so every assertion below reads exactly what the browser
// would have been told to do.
// ---------------------------------------------------------------------------
function createRecordingSurface() {
  const surface = {
    state: null,
    label: null,
    vars: {},
    audioMode: null,
    writes: 0,
    waveAmplitude: null,
    waveSpeed: null,
    waveRunning: false,
    setState(state) {
      surface.state = state;
      surface.writes += 1;
    },
    setLabel(label) {
      surface.label = label;
      surface.writes += 1;
    },
    setColorVariable(name, value) {
      surface.vars[name] = value;
      surface.writes += 1;
    },
    setAudioMode(mode) {
      surface.audioMode = mode;
      surface.writes += 1;
    },
    setWaveAmplitude(value) {
      surface.waveAmplitude = value;
    },
    setWaveSpeed(value) {
      surface.waveSpeed = value;
    },
    startWave() {
      surface.waveRunning = true;
    },
    stopWave() {
      surface.waveRunning = false;
    },
  };
  return surface;
}

function presenterAt(clock = { now: 0 }) {
  const surface = createRecordingSurface();
  const presenter = createPillPresenter({ surface, now: () => clock.now });
  return { surface, presenter, clock };
}

// ---------------------------------------------------------------------------
// 1. The six-state contract.
// ---------------------------------------------------------------------------

test("the six activity states are exactly the KTD4 contract", () => {
  assert.deepEqual(
    [...ACTIVITY_STATES].sort(),
    ["idle", "listening", "muted", "speaking", "thinking", "working"],
  );
});

test("each of the six states sets a distinct data-state and its documented hue", () => {
  const { surface, presenter } = presenterAt();
  const seenStates = new Set();
  const seenHues = new Set();
  for (const state of ACTIVITY_STATES) {
    presenter.setState(state, `label ${state}`);
    assert.equal(surface.state, state, `${state} must write its own data-state`);
    const hue = surface.vars["--pill-hue"];
    assert.ok(hue, `${state} must set a hue`);
    assert.equal(hue, PILL_STATE_TOKENS[state].hue, `${state} hue must match the token table`);
    assert.ok(!seenStates.has(surface.state), `duplicate data-state for ${state}`);
    assert.ok(!seenHues.has(hue), `duplicate hue for ${state}: ${hue}`);
    seenStates.add(surface.state);
    seenHues.add(hue);
  }
  assert.equal(seenStates.size, ACTIVITY_STATES.length);
  assert.equal(seenHues.size, ACTIVITY_STATES.length);
});

test("an unknown state throws instead of silently resolving to idle", () => {
  const { presenter } = presenterAt();
  // The shipped bug this guards: VOICE_ICONS[state] || VOICE_ICONS.idle meant a
  // renamed-but-missed call site produced a plausible idle pill and no error.
  assert.throws(() => presenter.setState("busy", "Using tool"), /unknown pill state: busy/i);
  assert.throws(() => assertPillState("live"), /unknown pill state: live/i);
  assert.throws(() => assertPillState(undefined), /unknown pill state/i);
});

test("every shipped VOICE_ICONS token maps to an activity state — nothing falls through", () => {
  const iconTokens = Object.keys(VOICE_ICONS);
  assert.ok(iconTokens.length >= 6, "expected the shipped icon set to still exist");
  for (const token of iconTokens) {
    const mapped = VOICE_STATE_ALIASES[token];
    assert.ok(mapped, `shipped voice token ${token} has no mapping`);
    if (token === "error") {
      // error is orthogonal to the six activity states and is retained as-is.
      assert.equal(mapped, "error");
      continue;
    }
    assert.ok(
      ACTIVITY_STATES.includes(mapped),
      `shipped voice token ${token} maps to ${mapped}, which is not an activity state`,
    );
  }
  assert.deepEqual(
    {
      idle: VOICE_STATE_ALIASES.idle,
      connecting: VOICE_STATE_ALIASES.connecting,
      listening: VOICE_STATE_ALIASES.listening,
      busy: VOICE_STATE_ALIASES.busy,
      live: VOICE_STATE_ALIASES.live,
    },
    {
      idle: "idle",
      connecting: "thinking",
      listening: "listening",
      busy: "working",
      live: "speaking",
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Colour containment and red exclusivity.
// ---------------------------------------------------------------------------

test("hue reaches stroke/rim properties only — no state writes a filled background", () => {
  const { surface, presenter } = presenterAt();
  for (const state of ACTIVITY_STATES) {
    surface.vars = {};
    presenter.setState(state, "x");
    const written = Object.keys(surface.vars);
    assert.ok(written.length > 0, `${state} wrote no colour variables at all`);
    for (const name of written) {
      assert.ok(
        PILL_COLOR_PROPERTIES.includes(name),
        `${state} wrote colour variable ${name}, which is not in the stroke-only allow list`,
      );
      assert.ok(
        !PILL_FORBIDDEN_COLOR_PROPERTIES.includes(name),
        `${state} wrote ${name}, a fill property the containment rule forbids`,
      );
    }
  }
});

test("the allow list and the forbidden list do not overlap", () => {
  // A containment assertion is vacuous if a property can be on both lists.
  for (const name of PILL_COLOR_PROPERTIES) {
    assert.ok(
      !PILL_FORBIDDEN_COLOR_PROPERTIES.includes(name),
      `${name} is both allowed and forbidden; the containment test proves nothing`,
    );
  }
  assert.ok(PILL_FORBIDDEN_COLOR_PROPERTIES.length > 0, "forbidden list must not be empty");
  // And the forbidden list must actually name fills, or it constrains nothing.
  assert.ok(PILL_FORBIDDEN_COLOR_PROPERTIES.some((name) => /background|fill/.test(name)));
});

test("muted is the only state carrying the red token", () => {
  const red = PILL_STATE_TOKENS.muted.hue;
  assert.equal(PILL_STATE_TOKENS.muted.alarm, true, "muted must be flagged as the alarm state");
  for (const state of ACTIVITY_STATES) {
    if (state === "muted") continue;
    const token = PILL_STATE_TOKENS[state];
    assert.notEqual(token.hue, red, `${state} reuses the muted red token`);
    assert.notEqual(token.alarm, true, `${state} claims the alarm flag reserved for muted`);
  }
});

test("no non-muted state drifts into the red band of hue space", () => {
  // Distinctness alone is not enough: amber is allowed, but a "warning" state
  // creeping to #e03131 would still read as a hot mic. Assert the hue angle.
  for (const state of ACTIVITY_STATES) {
    const { hue } = PILL_STATE_TOKENS[state];
    const angle = hueAngle(hue);
    assert.ok(Number.isFinite(angle), `${state} hue ${hue} is not parseable as a colour`);
    if (state === "muted") {
      assert.ok(angle <= 20 || angle >= 340, `muted must be red, got hue angle ${angle}`);
      continue;
    }
    assert.ok(
      angle > 20 && angle < 340,
      `${state} hue ${hue} (angle ${angle}) sits in the red band reserved for muted`,
    );
  }
});

/** Hue angle in degrees from a #rrggbb string. */
function hueAngle(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex));
  if (!match) return NaN;
  const int = Number.parseInt(match[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let angle;
  if (max === r) angle = 60 * (((g - b) / delta) % 6);
  else if (max === g) angle = 60 * ((b - r) / delta + 2);
  else angle = 60 * ((r - g) / delta + 4);
  return (angle + 360) % 360;
}

test("the hue-angle helper actually discriminates (known-answer both ways)", () => {
  // If hueAngle silently returned 0 for everything the red-band test above
  // would pass for the wrong reason. Pin it against known colours.
  assert.equal(Math.round(hueAngle("#ff0000")), 0);
  assert.equal(Math.round(hueAngle("#00ff00")), 120);
  assert.equal(Math.round(hueAngle("#0000ff")), 240);
  assert.ok(Number.isNaN(hueAngle("not-a-colour")));
});

// ---------------------------------------------------------------------------
// 3. Event → state resolution.
// ---------------------------------------------------------------------------

test("session events resolve to the six-state vocabulary with an action in words", () => {
  assert.deepEqual(resolvePillState({ type: "input_audio_buffer.speech_started" }), {
    state: "listening",
    label: "Listening",
  });
  assert.deepEqual(resolvePillState({ type: "response.created" }), {
    state: "thinking",
    label: "Thinking",
  });
  assert.deepEqual(resolvePillState({ type: "response.audio_transcript.delta", delta: "hi" }), {
    state: "speaking",
    label: "Speaking",
  });
  assert.deepEqual(resolvePillState({ type: "response.done" }), {
    state: "idle",
    label: "Ready",
  });
  assert.equal(resolvePillState({ type: "conversation.item.created" }), null);
});

test("tool.started names the tool; tool.completed yields to the real session state", () => {
  const started = resolvePillState({ type: "actions_json.tool.started", name: "browser.navigate" });
  assert.equal(started.state, "working");
  // The tool must be NAMED — this agent acts on the user's page, so an
  // anonymous "Working" is the thing this pill exists to avoid. Punctuation is
  // humanized (see the readability test below); the identity must survive it.
  assert.match(started.label, /browser navigate/i);
  assert.ok(!/^working$/i.test(started.label), "a bare 'Working' hides which tool is running");

  // completed must NOT pin a state — the session's own next event decides.
  assert.equal(resolvePillState({ type: "actions_json.tool.completed", name: "browser.navigate", ok: true }), null);
});

test("a tool name is rendered readably rather than dumped raw", () => {
  const started = resolvePillState({ type: "actions_json.tool.started", name: "pointer_click" });
  assert.equal(started.state, "working");
  assert.match(started.label, /pointer click/i);
});

test("mute overrides the activity state and says so in words", () => {
  const { surface, presenter } = presenterAt();
  presenter.setState("listening", "Listening");
  presenter.setMuted(true);
  assert.equal(surface.state, "muted");
  assert.match(surface.label, /muted/i);
  // and unmuting restores the underlying activity rather than dropping to idle.
  presenter.setMuted(false);
  assert.equal(surface.state, "listening");
  assert.equal(surface.label, "Listening");
});

test("a state arriving while muted is remembered, not shown", () => {
  const { surface, presenter } = presenterAt();
  presenter.setMuted(true);
  presenter.setState("speaking", "Speaking");
  assert.equal(surface.state, "muted", "muted must not be overwritten by an activity state");
  presenter.setMuted(false);
  assert.equal(surface.state, "speaking");
});

// ---------------------------------------------------------------------------
// 4. The waveform and the U2 envelope.
// ---------------------------------------------------------------------------

test("an envelope drives the wave from input while listening and output while speaking", () => {
  const clock = { now: 1000 };
  const { surface, presenter } = presenterAt(clock);

  presenter.setState("listening", "Listening");
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.08, output: 0.02, at: clock.now });
  const whileListening = surface.waveAmplitude;
  assert.ok(whileListening > 0.25, `expected input 0.08 to drive the wave, got ${whileListening}`);

  presenter.setState("speaking", "Speaking");
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.08, output: 0.02, at: clock.now });
  const whileSpeaking = surface.waveAmplitude;
  assert.ok(
    whileSpeaking < whileListening,
    `speaking must read output (0.02) not input (0.08); got ${whileSpeaking} vs ${whileListening}`,
  );

  // And the converse, so this cannot pass by always reading one channel.
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.02, output: 0.1, at: clock.now });
  assert.ok(surface.waveAmplitude > whileListening, "speaking must rise with output");
});

test("microphone RMS preserves a visible quiet-to-loud gradient above the noise floor", () => {
  assert.equal(visualizeAudioLevel(0), 0);
  assert.equal(visualizeAudioLevel(0.004), 0);
  const soft = visualizeAudioLevel(0.02);
  const normal = visualizeAudioLevel(0.05);
  const raised = visualizeAudioLevel(0.12);
  const loud = visualizeAudioLevel(0.22);
  assert.ok(soft > 0.07 && soft < 0.15, `soft voice should stay small, got ${soft}`);
  assert.ok(normal > 0.2 && normal < 0.3, `normal voice should be clearly visible, got ${normal}`);
  assert.ok(raised > 0.4 && raised < 0.55, `raised voice should stay mid-range, got ${raised}`);
  assert.ok(loud > 0.65 && loud < 0.8, `loud voice should approach full scale, got ${loud}`);
  assert.ok(soft < normal && normal < raised && raised < loud);
  assert.equal(visualizeAudioLevel(0.35), 1);
  assert.equal(visualizeAudioLevel(1), 1);
});

test("no envelope for over a second flattens the wave rather than freezing it", () => {
  const clock = { now: 0 };
  const { surface, presenter } = presenterAt(clock);
  presenter.setState("listening", "Listening");
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.9, output: 0, at: 0 });
  assert.ok(surface.waveAmplitude > 0.5);

  clock.now = WAVE_STALE_AFTER_MS - 1;
  presenter.tick();
  assert.ok(surface.waveAmplitude > 0.5, "must not flatten before the staleness window elapses");

  clock.now = WAVE_STALE_AFTER_MS + 1;
  presenter.tick();
  assert.equal(surface.waveAmplitude, 0, "a stale envelope must flatten the wave");
});

test("audioAvailable:false renders a presentation distinct from measured silence", () => {
  const clock = { now: 0 };
  const silent = presenterAt(clock);
  silent.presenter.setState("listening", "Listening");
  silent.presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0, output: 0, at: 0 });

  const unavailable = presenterAt(clock);
  unavailable.presenter.setState("listening", "Listening");
  unavailable.presenter.handleEnvelope({
    type: "audio-availability",
    audioAvailable: false,
    reason: "text_only",
    at: 0,
  });

  assert.equal(silent.surface.audioMode, "measuring");
  assert.equal(unavailable.surface.audioMode, "unavailable");
  assert.notEqual(
    unavailable.surface.audioMode,
    silent.surface.audioMode,
    "a text-only session must not look like a dead mic",
  );
  assert.equal(unavailable.surface.waveRunning, false, "an unavailable mic must not animate a live wave");
  assert.match(unavailable.surface.label, /text/i, "the reason must be named in words");
});

test("a later envelope recovers from the unavailable presentation", () => {
  const clock = { now: 0 };
  const { surface, presenter } = presenterAt(clock);
  presenter.setState("listening", "Listening");
  presenter.handleEnvelope({ type: "audio-availability", audioAvailable: false, reason: "context_suspended", at: 0 });
  assert.equal(surface.audioMode, "unavailable");
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.4, output: 0, at: 10 });
  assert.equal(surface.audioMode, "measuring");
  assert.equal(surface.waveRunning, true);
});

// ---------------------------------------------------------------------------
// 5. Live Activities discipline: update only when content changes.
// ---------------------------------------------------------------------------

test("re-setting the same state and label writes nothing to the surface", () => {
  const { surface, presenter } = presenterAt();
  presenter.setState("working", "Using browser navigate");
  const writesAfterFirst = surface.writes;
  assert.ok(writesAfterFirst > 0, "the first set must actually write");

  presenter.setState("working", "Using browser navigate");
  assert.equal(surface.writes, writesAfterFirst, "an identical state must not re-render");

  presenter.setState("working", "Using browser click");
  assert.ok(surface.writes > writesAfterFirst, "a changed label must render");
});

test("an unchanged envelope amplitude does not re-issue a wave write", () => {
  const clock = { now: 0 };
  const { surface, presenter } = presenterAt(clock);
  presenter.setState("listening", "Listening");
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.5, output: 0, at: 0 });
  const writes = surface.writes;
  clock.now = 60;
  presenter.handleEnvelope({ type: "envelope", audioAvailable: true, input: 0.5, output: 0, at: 60 });
  assert.equal(surface.writes, writes, "an identical amplitude must not touch the surface");
});
