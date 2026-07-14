---
title: "Score Google Docs edits by the document model, not a canvas screenshot"
module: "Google Docs eval scorer (actions.json Chrome extension + eval harness)"
date: 2026-07-08
problem_type: best_practice
component: testing_framework
severity: high
applies_when:
  - "Scoring or verifying edits to a Google Docs document (or any <canvas>-rendered surface) in an automated eval"
  - "browser.screenshot / captureVisibleTab is a candidate source of ground truth for a canvas surface"
  - "The host's physical display may be dormant or not actively painting during automation"
  - "Two instruments disagree about whether an edit landed and you must decide which one is lying"
  - "Scoring a hosted agent whose edit is a multi-second, multi-step tool loop"
symptoms:
  - "Three Docs edit tasks scored PARTIAL/failing even though the edits had actually landed"
  - "browser.screenshot returned ok:true with a frozen, stale pre-edit frame; no staleness signal"
  - "Screenshot stayed stale across 5 captures, a nudge-scroll, and a tab-activate"
  - "Screenshot and document-model reads (docs.read, /mobilebasic export) disagreed about doc contents"
root_cause: wrong_api
resolution_type: workflow_improvement
related_components:
  - "extensions/chrome-overlay-runtime"
  - "browser.screenshot primitive (background_capture / captureVisibleTab transport)"
  - "docs.read (page.fetch of the doc model)"
  - "/mobilebasic authenticated export path"
  - "Docs eval scorer / completion barrier"
tags:
  - google-docs
  - canvas
  - screenshot
  - eval
  - verification
  - chrome-extension
  - tooling
---

## Context

While running a live eval of a hosted GPT-Realtime agent editing a Google Doc through the actions.json Chrome extension bridge, three edit tasks — spell-fix, add-heading, and delete-paragraph — were scored PARTIAL/failing. Every score was derived by taking a `browser.screenshot` of the Google Docs canvas and reading the pixels. From the pixels, the agent appeared to under-complete edits, duplicate content, or leave structural artifacts (e.g., an orphan empty paragraph).

The failures were not real. All three edits had actually landed cleanly. The scoring instrument was lying.

Root cause: `browser.screenshot` uses the `background_capture` transport (Chrome `captureVisibleTab`). Google Docs renders text to a `<canvas>` element via `requestAnimationFrame`. Chrome **suspends canvas rasterization when the host's physical display is not painting** — and in this run the Windows host's monitor was dormant/asleep. So `captureVisibleTab` returned a **frozen, last-painted frame** of the canvas: it showed a pre-edit state even though the document had already been edited. Critically, the capture returned `ok:true` with **no staleness signal**, and it stayed stale across five separate captures, a nudge-scroll (`window.scrollBy`), and a programmatic tab-activate. Nothing about the response indicated the pixels were old.

This inverts the usual rule of thumb for these surfaces. The normal guidance is "screenshot = ground truth; the DOM lies on a canvas surface." Here the opposite held: on a canvas surface whose host display may be idle, **the pixels can be stale while the document model is correct**.

## Guidance

When verifying or **scoring** edits to a canvas-rendered surface (Google Docs, Sheets, Slides), read back the **document model** — not a screenshot.

For Google Docs the reliable instruments are:

- `docs.read` — a `page.fetch` of the document model, which returns the true paragraph/structure array.
- A live authenticated fetch of the doc's `/mobilebasic` export — the real DOM HTML of the document.

For Google Sheets, the same principle applies at a stricter identity boundary:

- select the requested A1 identity through the Name Box without a later grid
  coordinate click that can replace the selection;
- read authenticated `/htmlview/sheet` before and after the mutation;
- compare the exact requested cell or rectangle, not merely the presence of a
  token somewhere in the workbook;
- use a separately keyed confirmation fetch because the first post-commit HTML
  view may be stale;
- independently confirm with `sheets.read` before claiming success.

This pattern was live accepted for `sheets.cell.set` and
`sheets.range.paste_tsv_at_anchor` in public-storage PR #6. Clipboard acceptance
or a green keyboard event is transport evidence, not proof that the named cell
received the write.

Rules of practice:

1. **Score from the model, never from pixels.** Treat the canvas screenshot as a secondary human artifact only. When the screenshot disagrees with the model, **trust the model** and flag the screenshot as stale.

2. **For an automated (non-vision) scorer, remove screenshots from the verification path entirely.** If the loop consuming the verification cannot evaluate an image, a screenshot contributes nothing but a chance to be misled by a frozen frame — it might as well never take one.

3. **Add a completion barrier before reading back to score.** Await the agent's `response.done` **and** tool-idle (no queued or running tool jobs) before you read the model. Each structural edit op is a multi-second trusted-keystroke loop; a mid-flight read mis-scores a correct-but-in-progress edit as incomplete.

### The marker test (key diagnostic technique)

To detect *which* of two instruments is stale, write a unique token at a known position and see which instrument reflects it.

In this incident: a unique token `ZZMARKER ` was typed at the start of the document via a trusted keystroke. `docs.read` (a `page.fetch` of the document model) read it back **instantly**. The screenshot **never** showed it — it kept showing an old frame. Two additional model read-backs confirmed the true state: a second `docs.read`, and the authenticated `/mobilebasic` fetch, both agreeing the edits had landed.

The principle generalizes: **a token that exists in one instrument and not the other unambiguously identifies the stale instrument — it is the one *without* the fresh token.**

## Why This Matters

A frozen screenshot is **worse than no screenshot** — it is a confident lie. It returns `ok:true`, carries no staleness signal, and looks exactly like a fresh, authoritative capture.

In this run that single failure mode silently corrupted an entire eval. Three "failures" were actually clean edits. The delete-paragraph task, when re-run with a completion barrier and verified by model read-back, was a **clean PASS**. Every one of the original PARTIAL/failing scores was an artifact of the scoring instrument, not of the agent under test.

The deeper lesson: on canvas-rendered surfaces where the host display may be idle, the reliable "eyes" of a blind agent are the **projection / model read-back**, not the rendered image. The pixels are a rendering of the model that can lag arbitrarily far behind it; the model is the source of truth.

## When to Apply

- Any verification or automated scoring of edits on a **canvas-rendered web app** (Google Docs, Sheets, Slides).
- **Especially** in headless, remote-desktop, or dormant-display environments where the compositor may not be painting — the exact condition that produces frozen `captureVisibleTab` frames.
- Whenever the **consumer of the verification is an automated (non-vision) agent** — it cannot sanity-check a screenshot, so a stale one becomes an undetectable false negative.

## Examples

**BEFORE (fragile):**
1. Take `browser.screenshot`.
2. Read the pixels.
3. Conclude "agent left an orphan empty paragraph."
4. Score **PARTIAL**.

Failure: the pixels were a frozen pre-edit frame; the orphan paragraph did not exist in the document.

**AFTER (reliable):**
1. Await `response.done` **and** tool-idle (no queued/running tool jobs).
2. Call `docs.read` (a `page.fetch`) → returns the paragraph array / document model.
3. Assert the exact structural change against the model.
4. Score **PASS/FAIL** from the model. Screenshot is **not used** for scoring.

**DIAGNOSTIC (marker test to detect a stale instrument):**
1. Write a unique token (e.g. `ZZMARKER `) at a known position via a trusted keystroke.
2. Read both instruments.
3. If instrument A reflects the token and instrument B does not, **B is stale** — trust A.

## Related

- Origin investigation: `investigations/browser-screenshot-stale-frame-on-docs-canvas.md` (same event; full root-cause analysis, blame, and remediation plan).
- `investigations/google-sheets-workflow-postconditions-2026-07-12.md` — exact-A1 Sheets mutation and server-model verification closure.
- `investigations/agent-spellfix-undercomplete-and-hallucinated-claim.md` — the hallucinated "edit landed" claim that motivated model-read-back scoring + the completion barrier.
- `docs/solutions/runtime-behavior/docs-canvas-coalesces-rapid-trusted-arrow-keys.md` — a sibling Docs-canvas verification learning; shares the rule "never trust a green tool signal; only a document read-back proves an edit landed," but its problem (rapid trusted arrow keys coalesce → caret under-travel) and fix differ.
- `docs/solutions/best-practices/run-a-real-experiment-before-concluding-root-cause.md` — the marker test here is an instance of "run a real experiment before concluding."

## Follow-up (not required by this practice)

Waking a dormant host display is a *separate* nice-to-have (screenshots aren't on the scoring path, so this is not a blocker). WSL-spawned input can't reach the interactive desktop; the promising path is a Rust capability in the chrome-launcher (which already runs in the interactive session via `schtasks /IT`) that issues a wake command, or capturing via CDP `Page.captureScreenshot {fromSurface: true}` which rasterizes from the renderer independent of the OS display.
