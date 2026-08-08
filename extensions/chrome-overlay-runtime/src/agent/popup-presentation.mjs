/**
 * Popup session presentation — the popup's half of the pill's vocabulary.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The popup and the overlay pill answer the same question ("what is the agent
 * doing right now?") on two different surfaces. Before U7 the popup answered it
 * with its OWN strings — `Session: Live`, `Session: Disconnected` — built by
 * capitalising a transport status. So the two surfaces could disagree about the
 * same session, and a rename in one never reached the other.
 *
 * This module does NOT define a second vocabulary. It maps the transport status
 * onto the pill's existing six activity states and then reads the hue and the
 * label straight out of PILL_STATE_TOKENS. There is exactly one place in the
 * codebase where "listening is blue and says Listening" is written down, and it
 * is pill-presentation.mjs. A test asserts the shared token rather than a
 * duplicated string, so a change to the pill's table moves the popup with it.
 *
 * It lives beside the pill (not inline in popup.js) for the same reason the
 * pill's own decisions do: popup.js touches `document` at import time and
 * cannot be unit-tested, and this mapping is exactly the part that fails
 * invisibly.
 */

import { PILL_STATE_TOKENS, assertPillState } from "./pill-presentation.mjs";

/**
 * Transport status -> pill activity state.
 *
 * `connected` is deliberately absent: it resolves at runtime to `muted` or
 * `listening` depending on the mute flag, which is a fact about the microphone
 * and not about the transport. Muting is the one state the user must never
 * misread, so it wins over everything the transport reports.
 */
export const SESSION_STATUS_TO_PILL_STATE = Object.freeze({
  disconnected: "idle",
  stopped: "idle",
  error: "idle",
  connecting: "thinking",
  connected: "listening",
});

/**
 * A one-line explanation under the state name. This is the popup's own copy —
 * the pill has no room for it — but it never restates the state NAME, so the
 * two surfaces cannot drift on the vocabulary itself.
 *
 * Priority 1 in the product owner's order is "keep the user informed of current
 * state"; on a 360px surface that means saying what the state MEANS for the
 * user's microphone, not merely naming it.
 */
export const SESSION_DETAIL_COPY = Object.freeze({
  idle: "No session running. Start one to talk to this page.",
  thinking: "Connecting to the voice session…",
  listening: "Microphone is live and the agent can hear you.",
  muted: "Session is running, but the agent cannot hear you.",
});

/**
 * Resolve a session state object onto the pill vocabulary.
 *
 * Returns the pill STATE NAME plus the token it resolved to, so callers style
 * from `token.hue` rather than hard-coding a colour. Throws through
 * assertPillState on anything the pill does not know — the same failure the
 * pill's own rename guard exists to make loud.
 */
export function resolveSessionPresentation(state = {}) {
  const status = typeof state.status === "string" ? state.status : "disconnected";
  const muted = state.inputMuted === true;
  // Mute is an OVERRIDE, exactly as it is in the pill presenter: a muted live
  // session must never render as "Listening".
  const resolved = status === "connected" && muted
    ? "muted"
    : SESSION_STATUS_TO_PILL_STATE[status] || "idle";
  const pillState = assertPillState(resolved);
  return {
    state: pillState,
    token: PILL_STATE_TOKENS[pillState],
    label: PILL_STATE_TOKENS[pillState].label,
    detail: SESSION_DETAIL_COPY[pillState],
    live: status === "connected",
    connecting: status === "connecting",
    muted,
  };
}
