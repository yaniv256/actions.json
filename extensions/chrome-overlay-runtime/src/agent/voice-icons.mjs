/**
 * The shipped voice-launcher glyph set.
 *
 * Extracted from agent-surface.js so the pill's state contract can be tested
 * against the ACTUAL shipped token names rather than a copy that drifts. The
 * keys here are the legacy vocabulary (idle/connecting/live/listening/busy/
 * error); `VOICE_STATE_ALIASES` in pill-presentation.mjs is the one place that
 * translates them into the six-state activity vocabulary.
 *
 * Keep this export in sync with the launcher markup: a token added here without
 * a mapping there fails `agent-surface-pill.test.mjs` rather than rendering a
 * plausible-looking idle pill.
 */
export const VOICE_ICONS = Object.freeze({
  idle: `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5 3.5l6.25 4.5L5 12.5z" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="0.6"></path></svg>`,
  connecting: `<svg aria-hidden="true" viewBox="0 0 16 16"><circle class="voice-launcher-dot" cx="3" cy="8" fill="currentColor" r="1.25"></circle><circle class="voice-launcher-dot" cx="8" cy="8" fill="currentColor" r="1.25"></circle><circle class="voice-launcher-dot" cx="13" cy="8" fill="currentColor" r="1.25"></circle></svg>`,
  live: `<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" fill="currentColor" r="3.25"></circle><circle cx="8" cy="8" fill="none" r="5.25" stroke="currentColor" stroke-opacity="0.24" stroke-width="1.5"></circle></svg>`,
  listening: `<svg aria-hidden="true" viewBox="0 0 16 16"><rect fill="none" height="6.5" rx="2.75" stroke="currentColor" stroke-width="1.5" width="5.5" x="5.25" y="2.25"></rect><path d="M3.75 7.75a4.25 4.25 0 0 0 8.5 0M8 12v1.75M5.5 13.75h5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path></svg>`,
  busy: `<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.25 5.5h11.5M4 8h8M5.75 10.5h4.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"></path></svg>`,
  error: `<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="11.75" fill="currentColor" r="1"></circle><path d="M8 3.25v5.75" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"></path></svg>`,
});
