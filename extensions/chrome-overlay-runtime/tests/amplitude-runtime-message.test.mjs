import assert from "node:assert/strict";
import test from "node:test";

import {
  AMPLITUDE_RUNTIME_MESSAGE_TYPE,
  createAmplitudeRuntimeMessage,
} from "../src/agent/amplitude-runtime-message.mjs";

test("runtime routing survives an envelope subtype with its own type field", () => {
  const amplitude = { type: "envelope", input: 0.4, output: 0.2, at: 42 };
  const message = createAmplitudeRuntimeMessage(amplitude);

  assert.equal(message.type, AMPLITUDE_RUNTIME_MESSAGE_TYPE);
  assert.deepEqual(message.amplitude, amplitude);
  assert.equal(message.amplitude.type, "envelope");
});

test("audio-unavailable remains a nested domain message", () => {
  const amplitude = { type: "audio-availability", audioAvailable: false, reason: "text_only" };
  const message = createAmplitudeRuntimeMessage(amplitude);

  assert.equal(message.type, AMPLITUDE_RUNTIME_MESSAGE_TYPE);
  assert.deepEqual(message.amplitude, amplitude);
});
