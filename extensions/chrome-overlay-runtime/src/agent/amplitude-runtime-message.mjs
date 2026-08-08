export const AMPLITUDE_RUNTIME_MESSAGE_TYPE = "actions-json:agent-audio-amplitude";
export const AMPLITUDE_BROADCAST_CHANNEL = "actions-json-agent-amplitude-v1";

export function createAmplitudeRuntimeMessage(amplitude) {
  return {
    type: AMPLITUDE_RUNTIME_MESSAGE_TYPE,
    amplitude,
  };
}
