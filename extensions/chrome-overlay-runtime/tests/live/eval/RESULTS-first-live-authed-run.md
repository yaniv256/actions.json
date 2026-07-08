# First live authed GPT-Realtime Docs eval — hand-scored

**2026-07-08.** The first end-to-end eval run on a REAL authed Google Doc, driven entirely through
the merged Rust chrome-launcher bridge (launch → self-install → claim → trusted-type fill → GPT agent
edits → hand-score). Every earlier wall (Chrome-136 debug block, Google automation login, Docs canvas
write barrier) broken. Model: gpt-realtime-2, text-only.

## Task
One paragraph (coastal-wetlands, from fixtures/error-doc.txt) with 9 seeded errors. Prompt: "fix every
grammar/spelling error you can find, editing the text directly; report how many you fixed and list them."

## Scoring (screenshot = ground truth, NOT the agent's self-report)
| # | Seeded error | Correct fix | Agent result (verified by screenshot) |
|---|---|---|---|
| 1 | anyone **whom** has | who | ✅ FIXED (verified) |
| 2 | balance that **hold** | holds | ✅ FIXED (verified) |
| 3 | better **then** you found | than | ❌ NOT fixed — but agent CLAIMED it fixed this (hallucinated/un-landed) |
| 4 | covers **alot** | a lot | ❌ not fixed |
| 5 | nothing more **then** rainfall | than | ❌ not fixed |
| 6 | above **there** weight | their | ❌ not fixed |
| 7 | the **planets** surface | planet's | ❌ not fixed |
| 8 | carbon in **there** waterlogged | their | ❌ not fixed |
| 9 | more carbon **then** a mature forest | than | ❌ not fixed |

**SCORE: 2 / 9 verified fixes (22%).** Plus one CLAIMED-but-unlanded fix (#3) — the agent's self-report
said it fixed "then→than" but the canvas still shows "then". Agent was otherwise honest: it admitted the
remaining 6 were not done ("the editing tool call is still in progress").

## Findings (the eval doing its job)
1. **Agent under-completes the pass**: fixed the first 2 errors (both near the paragraph start), then
   stalled — didn't sweep the whole paragraph. The later errors (past ~line 2) went untouched.
2. **Agent self-report ≠ ground truth**: it claimed a 3rd fix ("better than") that did not land — the same
   presence-only trap that bites us, now observed in the hosted agent. SCORING MUST BE BY SCREENSHOT/DIFF,
   never by the agent's claim. (Validates the exact-match scorer approach, EVAL-U4.)
3. This is why the eval exists: a 22% single-pass fix rate on a dense-error paragraph is the baseline to
   drive down. Next: more trials, the full 20-task fixture, per-error scoring automation → Playwright.

## Pipeline proven (the all-night unblock)
Rust bridge: start_extension_session (self-install) + claim_tab + trusted text.type into Docs canvas, on
an authed profile (persistent-login-once trick beat Chrome-136 + Google automation block). All live-green.

## Run 2 — structural edits + word-jump-until demo (2026-07-08, same authed session)
Yaniv: spell-fixes too shallow; wants NORMAL EDITING OPS (move/split/merge/delete/copy-paste/heading) +
WORD-based nav (not char). Built a clean numbered base doc (title + P1-P4, real Enter paragraph breaks —
note: trusted Input.insertText DROPS \n, so paragraph breaks need real Enter KEYSTROKES).

STRUCTURAL TASK 1 (add Heading 1 to "Wetlands Guide" title): PARTIAL. Agent applied Heading-1 style
correctly (big bold title appeared) BUT DUPLICATED the line — inserted a new heading instead of
converting the existing paragraph in place, leaving a plain "Wetlands Guide" copy below. Finding:
"make this a heading" -> agent inserts rather than reformats-in-place. Exactly what the structural
battery is meant to catch. (Full battery in structural-edit-tasks.md.)

WORD-JUMP-UNTIL DEMO (keyboard.press_gated, key=Control+ArrowRight, stop=until, expect="carbon"):
The jump ENGINE works — 40 trusted word-forward jumps fired (word-based, not char). BUT it ran to
max_presses with final_a11y="" and a11y_events_read returned announcements:[] (EMPTY). So the "until"
GATE is BLIND on live Docs: the primitive can jump by word but cannot read where the caret landed, so
it cannot stop at the target word — it runs to the safety cap. ROOT: the a11y read source is dark on the
Docs canvas (task #130 AGK-U6, memory a11y-announcement-silent-drops — CDP drops aria-relevant events and
LocaleOutputHelper is uninitialized). The jump-until MECHANISM is sound; its SENSOR is the fix. This is
THE blocker for gated word-navigation on Docs, and the next thing to build to make word-jump-until real.

### CORRECTION (Yaniv, 2026-07-08): "a11y is dark on Docs" is a WEAK hypothesis — do NOT accept it.
Google Docs unquestionably SUPPORTS accessibility (it has an explicit "Screen reader support" mode; blind
users edit Docs daily with JAWS/NVDA/ChromeVox). So "the a11y layer returns empty on Docs" almost certainly
means WE are reading it wrong, not that Docs lacks a11y. Max-pain: the fault is our read wiring, not Docs.
NEXT (before any code): WEB RESEARCH — how do you actually get accessibility state out of a Google Doc?
Specifics to search: (1) Docs "Screen reader support" mode — must it be ENABLED (Tools > Accessibility)
for the a11y tree/live-regions to populate? Our session likely never turned it on. (2) Where Docs exposes
caret/selection to AT — the offscreen `.a11y-*` live-region divs Docs maintains for screen readers, and
whether ChromeVox reads them vs. the canvas. (3) How ChromeVox/CDP Accessibility.getFullAXTree sees Docs'
editing surface. (4) Whether the a11y announcements need the doc in screen-reader mode + braille/announce
settings on. The gated-until primitive's SENSOR fix starts with this research, not with patching the read.
Do the searches FIRST next session; the empty a11y store is very likely a "we didn't enable/So read the
right source" bug, not a Docs limitation.

### RESEARCH DONE (2026-07-08) — ROOT CAUSE FOUND. Yaniv was right.
Google Docs DOES emit ARIA live-region announcements for caret/navigation — but ONLY after you turn on
**"Screen reader support"**, which is OFF by default (a performance opt-in). Sources: Google support
answer/6282736 + 1632201, Santa Clara OAE, accessibility.com. Verbatim: "You won't be able to use Google
Docs with a screen reader until you specifically enable accessibility support (Tools > Accessibility >
Turn on screen reader support)." Docs then "uses ARIA live regions to announce the document as you navigate."

So our a11y_events_read was empty because the session NEVER enabled screen-reader mode — the live regions
Docs would populate stay silent until then. NOT a Docs limitation; our setup gap. (Max-pain: the fault was ours.)

**THE FIX (one trusted keystroke, no ChromeVox rewrite):**
- Enable screen-reader support: **Ctrl+Alt+Z** (Win/ChromeOS) / Cmd+Option+Z (mac) — turns ON the live-region
  announcements our a11y read source listens for.
- Enable Braille support: **Ctrl+Alt+H** — "faster navigation handling when you navigate by character, better
  announcements of punctuation and whitespace" = crisper per-word/per-char caret announcements, exactly what
  keyboard.press_gated stop=until needs to read.
RECIPE for the Docs map setup: on entering a Doc, dispatch a TRUSTED Ctrl+Alt+Z (and optionally Ctrl+Alt+H),
verify a11y_events_read now returns announcements, THEN gated word-jump-until can gate on the caret word.
This is the sensor fix for task #157 / AGK-U6 (#130). Try it first next session — likely a ~1-line map change.

### TESTED LIVE (2026-07-08, same session) — PARTIALLY CONFIRMED, big unblock + one nuance left.
Dispatched TRUSTED Ctrl+Alt+Z on the live authed Doc. RESULT: a11y_events_read went from [] to POPULATED
🍾 — announcements now flow from region `#docs-aria-speakable` (politeness=assertive), seq climbing on every
keystroke (5,7,9,11). So the research is CONFIRMED: screen-reader mode was simply OFF; Ctrl+Alt+Z turns on
the live-region announcements our read source consumes. The store is ALIVE. Also enabled Braille (Ctrl+Alt+H).

REMAINING NUANCE (next session): every announcement text is still "Application" (the app-role landmark), NOT
the caret's WORD, even after Ctrl+Home into the body + word-jumps. So the region is being read, but it's
surfacing the landmark, not per-word caret text. Hypotheses to test next: (a) focus is on the extension
overlay/iframe container ("Application") not the Docs text surface — need to focus the true editing element
first; (b) Docs echoes the WORD on plain Arrow / character-nav or on SELECTION (Shift+Ctrl+Right), not on
bare Ctrl+Right word-jump; (c) there's a second, correct live region (Docs maintains several offscreen
.a11y-* divs) and we're reading the landmark one. NEXT: with SR-mode ON, try plain ArrowRight and
Shift+Ctrl+ArrowRight and re-read; inspect which #docs-aria-* / .a11y-* div actually carries the caret word.
Then keyboard.press_gated stop=until can gate on it. The store-is-empty blocker is SOLVED; getting the
caret WORD into it is the last mile.

### LAST-MILE DEBUG (2026-07-08, live) — 3 solid facts + 1 crisp open question.
SOLID (via debug.run_javascript on the live Doc):
1. `Ctrl+Alt+Z` turns SR mode ON: `.kix-appview-editor` present, srMode=true. Ctrl+Alt+H = Braille on.
2. The caret/nav live region is `#docs-aria-speakable` (aria-live=assertive, role=region). Enumerated all
   10 live regions — the rest are banners/chat/sharing/tooltip. This is THE region to read.
3. It DOES echo real events: right after Ctrl+Alt+H its text became "Braille support enabled". And
   document.activeElement = `docs-texteventtarget-iframe docs-offscreen-z-index` (the Docs input surface).
OPEN QUESTION (the actual last mile): neither Ctrl+ArrowRight (word) NOR plain ArrowRight (char) updated
#docs-aria-speakable — it stayed "Braille support enabled", and the URL hash sat at #heading=h.lpppx1dwjvc8.
=> the caret navigation isn't ECHOING a word/char. Likely cause: focus/caret is NOT actually inside the
editable body text (keystrokes reach the iframe as activeElement but the caret may be parked on a heading
anchor / not seated in a text run), OR Docs only echoes after a real user gesture / with a settle delay, OR
the echo goes to a per-navigation announcement that our reader coalesces. NEXT: (a) click into a known word
in the body (pointer.click on a visible word) to seat the caret in text, THEN char/word-nav and re-read
#docs-aria-speakable; (b) try Home/End and Down (line nav) which Docs definitely announces; (c) add a small
delay between keypress and region read. Once ANY nav echoes the caret text, keyboard.press_gated stop=until
gates on it and word-jump-until works. Everything up to the echo is proven.

### CORRECTION #2 (2026-07-08) — I fell into the false-empty DOM trap. Screenshot corrected me.
While debugging the echo I checked "did my typed char land?" via `.kix-appview-editor.innerText` and got
"" TWICE, and concluded "trusted keystrokes stopped reaching the editor." WRONG. Docs renders to <canvas>,
so `.innerText` is ALWAYS "" ([[docs-canvas-render-no-dom-text]]). A SCREENSHOT showed BOTH test chars (X
and Z) had landed in P3 ("maiZXfor"). So typing works, navigation works — my "input broken" conclusion was a
DOM-read lie. Cleaned up with 2x Ctrl+Z. Lesson (Original Shame, live): I acted as if I could read the Docs
canvas via DOM; I am blind there without a screenshot — and the memory says so explicitly. Verify canvas
state by SCREENSHOT, never innerText.
CORRECTED STATE: editing ✓, trusted nav ✓, a11y store populates on Ctrl+Alt+Z ✓, region=#docs-aria-speakable ✓.
The ONLY real open item: that region shows the app landmark ("Application") rather than the caret WORD on
nav — a narrow a11y-echo detail (which Docs event/region carries the per-word caret text), NOT input breakage.

### TRUSTED vs UNTRUSTED A/B (Yaniv, 2026-07-08) + a SCORING RULE.
Yaniv: "there's no reason to do trusted when untrusted works — and if the agent uses trusted when untrusted
would have worked, SCORE IT ZERO." (Trusted = privileged/expensive CDP path; defaulting to it is the
exculpatory-attractor failure the incident skill warns about — never reach for privileged input before an
A/B proves you need it.) Findings on live Docs:
- **UNTRUSTED text.type FAILS**: returns `target_not_editable` (the Docs surface is a canvas + hidden iframe,
  no real editable DOM node). So for TYPING into the Docs canvas, trusted IS genuinely required — evidence-backed.
- **UNTRUSTED keyboard.press (nav) does NOT error** (returns fidelity=synthetic, pressed=true) — a different
  path from text.type. Whether it actually MOVES the caret is INCONCLUSIVE here: the confound is that
  pointer.click isn't reliably seating the caret in the body text (it emits "Application" landmark, not a text
  position), so the A/B couldn't isolate the nav effect. NEXT: get a reliable caret-seat first (a Docs-native
  "click into text" that lands in a run), THEN A/B untrusted vs trusted nav cleanly.
NEW EVAL SCORING DIMENSION to add to the battery: penalize (score 0) any task the agent completes with
trusted input where untrusted would have sufficed. Requires the map/agent to try untrusted first and only
escalate on a proven failure (like the text.type target_not_editable above). Add to structural-edit-tasks.md
scoring.

### CARET-PLACEMENT ROOT CAUSE (converged, 2026-07-08): DPR coordinate scale.
pointer.click DOES place the caret but at the WRONG position — a coordinate-scale (DPR) mismatch, not a
broken click. Click at displayed (265,436) seated the caret in P3; click at DPR-corrected (~340,558 =
displayed x1.28) moved it to P4, and the pointer affordance rendered at y~700 (below the text). So caret
placement RESPONDS to click Y but is offset by the DPR/display-scale factor. FIX: use the screenshot tool's
reported scale (it prints "original WxH, displayed at wxh, multiply by K") to map on-screen word position to
click coords, or read devicePixelRatio + canvas bounding rect via debug.run_javascript; verify with a marker
+ screenshot. Once pixel-accurate, the nav A/B + a11y echo + word-jump-until unblock. See task #158.
[[screenshot-dpr-and-ack-stall]]. Confirmed working (not this bug): trusted text.type + keystrokes land;
untrusted text.type fails on the Docs canvas (target_not_editable).

CALIBRATION (converged): devicePixelRatio=1.25, innerW=996, innerH=986, editorRect x0/y129/w996/h857.
Screenshot is captured at PHYSICAL px (Read tool shows ~2560 orig at 2000); pointer.click takes CSS px
(0..996). X transform that WORKED: CSS_x = image_display_x * (innerW/image_display_width) ~= image_x*0.5
(affordance moved into the right column). Y is close but overshoots ~1 line (image_y436 -> CSS414 -> caret
at doc-y~509) => Y needs a constant top-chrome OFFSET on top of the scale. Solve with 2 known-word clicks
(slope+intercept) OR image_y*innerH/image_h minus fixed offset. Bounded 2-number fix; then all unblocks.

### CARET-PLACEMENT SOLVED (task #158 DONE). Verified DPR transform.
Two-point calibration: click CSS y300 -> heading line (doc top); click CSS y414 -> "time." line. slope
(image->click) = 146/114 ~= 1.28 = the 2560/2000 device-scale. VERIFIED transform, screenshot-displayed px
-> pointer.click CSS px:
  click_x = image_x * (innerW / img_display_w) ~= image_x * 996/2000 ~= image_x * 0.5
  click_y = image_y * (innerH / img_display_h) / dpr ~= image_y * 986/1039 / 1.25
With this, a ☆ marker landed EXACTLY at the "Wetlands Guide" heading start (toolbar showed Heading 1). Caret
can now be placed at any on-screen word. Bake into the Docs click helper so pointer.click(word) is pixel-accurate.
This unblocks the reliable caret-seat that the nav A/B, the #docs-aria-speakable echo, and word-jump-until need.

### A11Y ECHO — still the open crux (task #157), 3+ nav variants tried, needs a category pivot.
With SR-mode on + caret reliably seated at "Coastal", #docs-aria-speakable echoes APP events (it showed "Undo",
"Braille support enabled") but has NOT echoed the CARET WORD on: Ctrl+Right (word), plain ArrowRight (char),
Shift+Ctrl+Right (select). window.getSelection() = "" (Docs selections are on the CANVAS, not DOM — false-empty,
don't trust). So the precise question: which Docs action, SR-mode on, makes #docs-aria-speakable speak the
word/char AT the caret? Likely: Docs SR-mode assumes an ASSISTIVE TECH is issuing ChromeVox reading commands
(Search/Insert + arrows), not bare caret nav — bare nav moves silently. NEXT (pivot the category): (a) test
VERTICAL line nav (Down/Up — Docs announces the whole line); (b) issue actual ChromeVox reading commands;
(c) do a known-announced action and diff what fills the region; (d) poll the region on a short delay after the key.

REFUTED (4 variants, incident-method category pivot done): bare caret navigation does NOT echo the caret text.
Tested word (Ctrl+Right), char (ArrowRight), select (Shift+Ctrl+Right), AND line (ArrowDown) — #docs-aria-speakable
stayed on app events ("Undo") every time. CONCLUSION: Docs SR-mode does not volunteer the caret word on arrow keys;
the announcements come from an ASSISTIVE TECH issuing ChromeVox READING COMMANDS (Search/Insert + arrows / read-
current-word), not from bare nav. So the gate's read source needs to ISSUE a reading command (or our a11y layer
must request the caret text), not just move + read. That's the real task-#157 work — extension-level, past live poking.
This is a clean, ledgered boundary: caret placement SOLVED (#158), a11y store LIVE via Ctrl+Alt+Z, and the exact
remaining piece named (issue ChromeVox reading commands to get the caret word). Everything up to that is proven.

## Run 3 — STRUCTURAL task through the GPT agent (2026-07-08).
Task 5 (structural-edit-tasks.md): "DELETE the 'Birds are the main attraction...' paragraph." SCORE: PARTIAL.
The agent DELETED the paragraph's TEXT (both sentences gone ✓ — real structural manipulation, and it took two
response turns) BUT left an EMPTY PARAGRAPH/blank line where it was (didn't remove the trailing newline). So:
"delete paragraph" -> deletes the text, leaves the paragraph break. Better than the earlier heading task
(which DUPLICATED the line) — the caret-placement fix (#158) clearly helped the agent target the right paragraph.
Characteristic structural-edit failure the battery is meant to catch. Score-by-screenshot (agent still mid-turn
when first checked -> would have mis-scored FAIL; waited for the active response to finish, then re-scored PARTIAL).
Running tally of hosted-agent Docs edits: spell-fix 2/9, heading PARTIAL(dupe), delete-para PARTIAL(empty line).

## ⚠️ SCORES INVALIDATED — the SCREENSHOT was stale (2026-07-08). See investigations/browser-screenshot-stale-frame-on-docs-canvas.md
CRITICAL CORRECTION: every score above was read from a browser.screenshot of the Docs CANVAS. That screenshot
was serving a FROZEN pre-edit frame because the Windows host's physical display was dormant (Chrome suspends
canvas raster when the display isn't painting). Proven by a marker test: I typed "ZZMARKER" at doc start;
docs.read (page.fetch) caught it instantly, the screenshot NEVER showed it and kept showing an old frame across
5 captures, a scroll, and a tab-activate. Yaniv confirmed his physical screen was dormant/not re-rendering.
CONSEQUENCE:
- Delete-paragraph, re-run WITH a completion barrier + verified by docs.read/mobilebasic = **CLEAN PASS** (Birds
  gone, NO orphan line; 3 model-reads agree). The "PARTIAL orphan line" was a stale-frame misread.
- The heading "duplication" and the spell-fix "2/9 + hallucination" are now SUSPECT for the same reason — they
  were screenshot-scored and must be RE-SCORED by document model before being trusted.
NEW SCORING RULE (mandatory): score Docs edits by the DOCUMENT MODEL — docs.read (page.fetch) and/or a
/mobilebasic fetch — NEVER by canvas screenshot. Use the screenshot only as a secondary human artifact, and when
model and screenshot disagree, TRUST THE MODEL. The agent's editing stack (docs.locate -> cursor_to_paragraph ->
select_forward -> text.type/keyboard.press, positional, with read-back) is sound; it was my instrument that lied.
Also add a completion barrier: await runtime.agent.await_event -> response.done + tool-idle BEFORE scoring, so a
mid-flight doc is never mistaken for a final one.
