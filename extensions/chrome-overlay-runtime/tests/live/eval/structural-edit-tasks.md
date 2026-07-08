# Structural-editing eval tasks (beyond spell-fixing)

Yaniv (2026-07-08): the spell-fix tasks are too shallow — a glorified spell-checker. The real eval is
NORMAL EDITING OPERATIONS that exercise structure and movement, where agents actually struggle:
copy/paste, moving paragraphs, deleting, adding titles/headings, splitting a paragraph into two, merging,
reformatting. Each is a discrete, screenshot-scoreable task.

## The base doc (clean, checkable — numbered so moves/splits are verifiable)
A short doc with clearly-labelled paragraphs so structural changes are unambiguous to score:

  Wetlands Guide            <- title line
  P1: Coastal wetlands are among the most productive ecosystems on earth. They filter water and store carbon.
  P2: Salt marshes are dominated by grasses. Cordgrasses trap sediment and build new land over time.
  P3: Birds are the main attraction for most visitors. Wading birds stalk the shallows at dawn.
  P4: Wetlands are disappearing worldwide. Drainage and development are the biggest threats.

## Task battery (run one at a time, screenshot-score each: PASS / PARTIAL / FAIL)
1. ADD HEADING: Add a Heading-1 titled "Introduction" directly above P1.
2. SPLIT PARAGRAPH: Split P2 into two paragraphs — break it after "grasses." so the cordgrass sentence
   becomes its own paragraph.
3. MERGE PARAGRAPHS: Join P3 and P4 into a single paragraph.
4. MOVE PARAGRAPH: Move P4 (the "disappearing/threats" one) so it comes immediately after P1.
5. DELETE: Delete P3 entirely (the birds paragraph).
6. COPY/PASTE (duplicate): Copy P1 and paste a duplicate of it at the very end of the document.
7. REFORMAT to LIST: Turn the four threats/features into a bulleted list (or: bold the first sentence of P1).
8. INSERT SENTENCE: Add a new sentence "Mangroves are a tropical wetland type." to the end of P1.

## Scoring rules
- **PROJECTION-ONLY SCORING — the scorer NEVER relies on a screenshot.** (Yaniv, 2026-07-08.) The automated
  scorer can *take* a screenshot but cannot *evaluate* one (no vision in its loop), so it must not depend on
  screenshots at all — it might as well never take one. Score EXCLUSIVELY by reading the document back through a
  PROJECTION / model read: `docs.read` (page.fetch) and/or a `/mobilebasic` fetch. This also makes the eval
  robust in a world where screenshots aren't available or are unreliable — which they demonstrably are on the
  Docs canvas (see below). [[projections-are-eyes-no-arguments]]
- **WHY (proven 2026-07-08, investigations/browser-screenshot-stale-frame-on-docs-canvas.md):** browser.screenshot
  of the Docs CANVAS served a FROZEN stale frame when the host display wasn't painting (Chrome suspends canvas
  raster) — it silently returned pre-edit frames and corrupted run-1..3 scores. A marker test settled it: a fresh
  "ZZMARKER" showed up in docs.read instantly while the screenshot never updated across 5 captures + scroll +
  tab-activate. So: screenshots are OUT of the scoring path. The agent's self-report also lies (run 1) — verify
  against the MODEL, never the agent, never the screenshot.
- COMPLETION BARRIER before scoring: await runtime.agent.await_event -> response.done + tool-idle (no
  queued_or_running_tool_jobs) BEFORE reading the doc, so a mid-flight edit loop isn't mis-scored as final.
- PASS = the exact structural change happened and nothing else was corrupted.
- PARTIAL = right intent, wrong placement / left artifacts / half-done.
- FAIL = no change or wrong change.
- Watch the nav method: char-by-char arrow crawl vs Ctrl+Arrow word-jump vs selection — note it per task
  (run 1 finding: char-crawl under-completes; word-jump + selection is the fix). [[docs-word-jump-chord]]
- TRUSTED-INPUT PENALTY (Yaniv 2026-07-08): score a task 0 if the agent used TRUSTED (privileged CDP) input
  where UNTRUSTED (synthetic) would have worked. Trusted must be a proven-necessary escalation, never a
  default. Evidence so far: untrusted text.TYPING into Docs canvas genuinely fails (target_not_editable ->
  trusted justified for typing); untrusted NAV may work (inconclusive, needs a reliable caret-seat to A/B).
  So per-op: try untrusted first, escalate to trusted only on a real failure, and record which was needed.

## Why this matters
These operations require the agent to (a) locate structure by position, (b) select a range, (c) cut/move/
format — the caret-nav + selection + trusted-input stack we built. Spell-fixes only test point-edits;
structural edits test the whole map. This battery is the real driver toward the 95% goal (#105/#131).
