// The hosted Realtime model id, and the ONLY place it is written as a literal.
//
// This is a leaf module on purpose: it imports nothing. Every surface that needs
// the model id — the session manager that sends it to OpenAI, and the popup /
// background / session-client placeholder states that DISPLAY it before a session
// exists — can import this without dragging in credential-store, session-memory-store,
// or chrome.storage. Putting the constant in realtime-session-manager.mjs (where it
// used to live) meant a popup that needs one string would transitively pull in the
// whole session machinery, which is why five files copied the string instead.
//
// Found 2026-07-09: six files hardcoded "gpt-realtime-2", and NOTHING related them.
// Rewriting DEFAULT_MODEL to a nonsense value left the entire node suite green
// (371 pass / 4 fail — the established baseline) because the one test that reads it
// imports it and asserts against itself. So a bump that missed a file would ship a
// popup permanently announcing a model the session does not use — the extension's own
// version of the accessibility sin the authoring skill names: announcing a state you
// never verified. See tests/agent-realtime-model.test.mjs for the guard.
//
// gpt-realtime-2.1 released 2026-07-06. gpt-realtime-2 is NOT deprecated, so this is
// an opt-in bump. Pricing is identical on every line to gpt-realtime-2 — if you bump
// this, the price table in realtime-cost.mjs may still need NO numeric change. Verify
// against the model page, not secondary write-ups (they quote the old numbers "for
// comparison").
export const DEFAULT_MODEL = "gpt-realtime-2.1";
