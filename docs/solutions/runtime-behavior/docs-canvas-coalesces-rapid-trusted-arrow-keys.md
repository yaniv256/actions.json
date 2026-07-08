---
title: "Google Docs coalesces rapid trusted arrow keys — space caret walks past the input window"
date: 2026-07-07
category: runtime-behavior
module: chrome-overlay-runtime
problem_type: runtime_error
component: tooling
symptoms:
  - "A trusted caret walk of N ArrowRight presses lands the caret ~2-3 chars in instead of N"
  - "Edits then land at the wrong offset and mangle the document while tools report typed:true"
  - "Short walks (<=25 chars) land exactly; only long walks fail, masking the bug"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [input, cdp, trusted-keystrokes, google-docs, canvas-editor, coalescing, caret, live-harness, verification]
---

# Google Docs coalesces rapid trusted arrow keys — space caret walks past the input window

## Problem

Google Docs (a `<canvas>`-rendered editor) coalesces trusted keyboard events that arrive within its input-throttle window (~<10ms apart) into a single caret advance. A positional caret walk that fires N `ArrowRight` presses back-to-back therefore lands the caret ~2-3 characters in, not N — so every large-offset edit lands at the wrong place and mangles the document, while `keyboard.press` still reports `typed: true`.

## Symptoms

- `docs.cursor_forward {chars: 78}` moves the caret to offset **2** (measured live: `Wi|HERE|ldflower…`).
- The hosted agent's tool sequence is flawless (read → locate → walk → select → overtype → verify) yet the edit lands inside the wrong word.
- A short walk (≤~25 chars) lands exactly; only long walks fail — masking the bug in early tests.
- Tool success flags (`typed:true`, `chars:78`) are all green; only a post-edit `docs.read` reveals the wrong offset.

## What Didn't Work

- **Three fix-forward extension releases (0.1.177, 0.1.178, 0.1.179) + three map walker rewrites** (2×1000, 40×15, 24×25 char chunks). Each guessed at a mitigation and shipped it without an offline reproduction. This is the fix-forward anti-pattern (see memory `live-harness-before-human-roundtrip`).
- **`autoRepeat: true` on the CDP keydowns (0.1.179).** Actively wrong: Docs treats an autoRepeat burst as a *single held key* — one caret move — the opposite of the goal.
- **Chunking the walk into 15/25-char workflow-step segments.** Segments still coalesced across step boundaries; a 24×25 walker reached only ~19 of 85.
- **A 3ms yield between presses.** Too short — 40-char walk still coalesced; even 24-35ms with jitter lost presses against an over-punishing fixture model.
- **The plain-`contenteditable` Playwright harness could not reproduce the bug at all** — a normal contenteditable moves the caret synchronously on every keydown, so it passed while real Docs failed. This is exactly why three releases missed it.

## Solution

Two parts.

1. **Behavior-faithful offline harness** (`extensions/chrome-overlay-runtime/tests/live/caret-walk-coalesce-smoke.mjs`): a fixture whose keydown handler advances a logical caret only when presses are spaced past the coalesce window, dropping rapid ones — modeling Docs' observed behavior. On the buggy code it lands 3 (reproduces); the fix lands exactly 78.

2. **Space the presses in `dispatchTrustedKey`** (`src/background.js`): discrete `keyDown`+`keyUp` per press, spaced 25ms apart (2.5× the ~10ms coalesce window). No `autoRepeat`.

```js
// BEFORE (0.1.179 — wrong): autoRepeat + one keyUp + 3ms yield
const isRepeat = repeat > 1;
for (let i = 0; i < repeat; i += 1) {
  await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: keyDownType,
    ...(isRepeat && i > 0 ? { autoRepeat: true } : {}) });
  if (!isRepeat || i === repeat - 1) await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  if (isRepeat) await new Promise((r) => setTimeout(r, 3));
}

// AFTER (0.1.180 — correct): discrete presses, 25ms apart, no autoRepeat
const FRAME_GAP_MS = 25; // > 2x the ~10ms Docs coalesce window
const isRepeat = repeat > 1;
for (let i = 0; i < repeat; i += 1) {
  await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: keyDownType });
  await debuggerSendCommand(target, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  if (isRepeat && i < repeat - 1) await new Promise((r) => setTimeout(r, FRAME_GAP_MS));
}
```

Cost: ~2s per 78-char walk. Reliability over speed is the whole game for document editing.

## Why This Works

Docs' input handler merges keydowns that fall inside its throttle window into one caret move. Spacing each press 25ms apart guarantees every one lands in a distinct window, so N presses advance the caret exactly N. `autoRepeat` fails because Chrome/Docs interpret an autoRepeat flag as a physically held key — semantically one press-and-hold, which Docs debounces to a single advance.

The deeper win is the **harness**: the bug was invisible to a plain contenteditable and only reproduced once the fixture modeled the *actual consumption behavior* (throttled/coalescing). Reproduce-then-fix collapsed three release cycles of guessing into one correct diagnosis.

## Prevention

1. **When a live tool or fixture cannot reproduce a bug, the fixture is wrong — fix the fixture before the code.** A plain contenteditable is not a model of a canvas editor. Build a fixture that mimics the target's real input-consumption semantics (here: coalesce presses <10ms apart). Memory: `live-harness-before-human-roundtrip` — stop fix-forwarding after the 2nd live failure and build the self-driven reproduction.
2. **Never trust `typed:true` / `chars:N` as proof an edit landed.** Only a post-edit re-read of the actual content is proof (`presence-only-verification-trap`). The eval loop's mechanical `docs.read`-and-diff caught every silent miss.
3. **A short-case pass does not prove the mechanism.** ≤25-char walks passed while 78 failed. Test the *failing scale* (this incident's harness walks 78, not 10).
4. **`autoRepeat` is never the tool for "press a key N times."** It means "hold one key." For N discrete moves, send N discrete spaced press pairs.
5. Regression guard: `caret-walk-coalesce-smoke.mjs` fails red on the pre-fix code and must stay in the release gate alongside `trusted-text-type-smoke.mjs` and `a11y-live-smoke.mjs`.

## Related

- [Live-test the real bundled module past a tool that serializes the code under test](../architecture-patterns/live-harness-past-the-serializing-tool.md) — same anti-fix-forward methodology (build an offline harness that reproduces the bug before releasing); this incident is a second instance where a naive fixture could not reproduce and a behavior-faithful one was the key.
