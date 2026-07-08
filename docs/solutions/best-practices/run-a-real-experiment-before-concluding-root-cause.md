---
title: "During debugging, reading logs and source is EVIDENCE, not an EXPERIMENT — run a real experiment before concluding a root cause"
date: 2026-07-07
category: best-practices
module: incident-investigation
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "running an incident investigation or debugging a failure"
  - "about to conclude or report a root cause"
  - "a tidy, elegant causal story has formed in your head"
  - "tempted to blame the environment, a tool, or something pre-existing"
  - "you have read logs and source but run no experiment yet"
tags: [incident-investigation, experiment-first, root-cause, maximum-pain, falsification, predict-then-observe, debugging-methodology, evidence-vs-experiment]
---

# During debugging, reading logs and source is EVIDENCE, not an EXPERIMENT — run a real experiment before concluding a root cause

> Track: knowledge (a debugging-methodology discipline, not a bug fix). The authoritative expansion of the maximum-pain principle lives in `skills/incident-investigation/SKILL.md`; this doc is the incident-grounded capture of the discipline. `component: development_workflow` and `module: incident-investigation` are the closest enums — the principle is methodology-wide, not tied to one code component.

## Context

The friction is a specific, recurring, embarrassing failure mode: reaching "root cause" on a satisfying story and being wrong. In a single debugging session it happened three separate times, and each time a human had to correct it before any wrong fix was acted on. (And once more, later the same session — see the Postscript — when a fresh experiment refuted a *fourth* reasoned conclusion. The lesson keeps proving itself.)

The pattern was always the same. Read the logs. Read the source. A tidy causal narrative assembled itself — coherent, mechanistically plausible, well-cited to line numbers — and it *felt* like a finding. It was a hypothesis wearing a finding's clothes. The three false conclusions, drawn from the worked investigations:

1. **"The error says 'Debugger is not attached' — that's the root cause."** The loud error string scrolling past got seized as the explanation, because it pointed outward at Chrome, not inward at my own tooling. It turned out to belong to a *different* investigation entirely — off the causal path.
2. **"`text.type` loses the selection across two tool calls — that's why the overtype never lands."** A beautiful code-level story with the exact line numbers of the non-atomic select-then-type dance. Refuted the moment it was checked against a docs eval that had *passed 20/20 that same morning* exercising precisely that pattern.
3. **"The live harness fails — must be a pre-existing environment breakage."** The reach for "the platform is broken" when every service-worker hook came back undefined. A `git stash` of my own one-line diff made the harness pass — it was my duplicate `const withTimeout` killing the whole service worker at load.

The recurring failure mode, named plainly: **mistaking a satisfying causal story for a verified finding**, and preferring the story that implicates something other than my own recent work.

## Guidance

The practice, concretely:

**1. A conclusion reached by reading is a HYPOTHESIS, not a finding.**
Reading logs and reading source is *evidence* (Phase 3 of the incident-investigation method). It is not an *experiment* (Phase 5). Evidence tells you where to look; only an experiment tells you what is true. Do not advance to blame assignment or to writing a fix on evidence alone. The decision gate — "no root cause without a confirming experiment" — is only real if you actually run one. Narrating the phase does not satisfy the gate. (auto memory [claude]: reading logs+source is EVIDENCE, not an EXPERIMENT — change ONE var, predict-then-observe.)

**2. An experiment changes ONE variable and predicts BOTH outcomes BEFORE running.**
Write down what you'll see if the hypothesis is true *and* what you'll see if it's false — before you observe anything. This "predict-then-observe" ordering is the entire anti-rationalization mechanism: once the result is in front of you, the mind will retrofit either outcome into a story, so you must commit the prediction first. The three worked experiments from the 504 investigation are the template — each isolates the wedge onto `SessionStore` by changing exactly one variable at the same instant:

- **X1 — content-path vs lifecycle, same moment.** Predict if whole-bridge latency: both fail. Predict if background-specific: `page.fetch` OK, `claimed_tabs.list` 504. Ran it: `page.fetch` OK, list 504. → whole-bridge latency **refuted**; failure is specific to the tab-lifecycle path.
- **X2 — `background_capture` vs `claimed_tabs`, same moment.** Predict if the whole service worker is dead: the screenshot (which also needs the SW) fails too. Predict if only the store-handler hangs: screenshot OK, list 504. Ran it: screenshot OK, list 504. → dead-service-worker **refuted**; the SW is alive but the `SessionStore`-backed handler specifically hangs.
- **X3 — bridge-native resource vs `claimed_tabs.list`.** The Rust `actions-json://bridge/runtimes` resource enumerates runtimes *without* calling the extension's `SessionStore`. Predict if the wedge is on the store path: the resource returns instantly, list still 504s. Ran it: resource OK instantly (all four runtimes), list still 504. → confirmed the wedge is on the `SessionStore` path, not tab enumeration in general.

Three variables, three predictions committed first, three refutations. That is what moved a hypothesis to CONFIRMED. Reading never did.

**3. Check the tidy story against the case that already WORKS.**
A theory that predicts failure for an operation you can watch succeed is falsified, however elegant it reads. This single move killed the second false conclusion outright: the "selection lost across calls" story predicted that the two-call select-then-type recipe could not work — but the morning's eval had passed 20/20 using that exact recipe. The passing case is a free, already-run negative control. Before you conclude, ask: *does my story also predict the failure of something I know works?* If yes, the story is wrong.

**4. Suspect the operationally-embarrassing explanation first (maximum-pain, turned inward).**
The boring, humiliating causes are the most likely *and* the most suppressed: a background tab silently dropping trusted input; a one-shot init promise stuck pending forever; your own duplicate top-level `const`. The mind routes around the explanation that implicates its own recent work, so that explanation is under-represented in your head and over-represented in reality. The flinch away from "did I check the boring thing? did I check my own diff?" is the compass — it points *at* the answer. Practically: `git stash` your own change to separate "my diff" from "the environment," and reach for the mundane operational cause before the elegant platform-bug cause. (auto memory [claude]: the most PAINFUL is likeliest; test it first; truth and pain correlate.)

## Why This Matters

The cost was three wasted conclusions. Each one, if acted on, would have driven a *wrong fix*: patching CDP attach lifecycle for a problem that was actually elsewhere; making `text.type` atomic across calls for a recipe that already worked; filing a platform bug for a `SyntaxError` in my own one-line edit. A human had to intervene three times to stop the wrong fix from shipping. Debugging that concludes on passive reasoning doesn't just waste the investigation — it spends real effort building the wrong thing.

The deeper point is about decision gates. When a plan or a skill says "no blame assignment until an experiment confirms," the gate is only load-bearing if you run real work at it. It is trivially easy to *narrate* the experiment phase — to write "X confirms H1" as a plausibility argument read out of the log — and feel you've cleared the gate. You haven't. A gate you can pass by writing prose is not a gate.

And the maximum-pain principle is why the inward suspicion is not just humility theater but a genuine probability update: **truth and pain correlate.** The mind actively routes around the explanation that implicates its own recent work, which means that explanation is systematically *under*-weighted in your priors and therefore *over*-represented among the true causes you haven't considered. Correcting for that bias — deliberately raising the probability of "it was my diff / the tab wasn't in front / my init promise hung" — is a calibration fix, not a mood.

## When to Apply

- Running an incident-investigation or any debugging session.
- **Any moment a satisfying root-cause story has formed and you feel the pull to conclude.** That feeling of "this must be it" is exactly the trigger to demand an experiment, not to write the postmortem.
- Building a fix and about to call it verified: make the reproduction go red→green with a *proven negative control*. Run the test against the old code and watch it fail; that red→green transition IS the confirming experiment. A test that only ever went green proves nothing.
- Whenever you catch yourself reaching for "the environment / pre-existing / the platform's fault." That reach is the tell. Stop and isolate your own change first (`git stash`).

## Examples

Concrete before/after, all drawn from this session's investigation files:

- **BEFORE:** "The error says 'Debugger is not attached' → that's the root cause." **AFTER:** X1 — `page.fetch` returns OK at the same instant `claimed_tabs.*` 504s — showed the debugger error was off the causal path; it belonged to a different investigation. A discriminating experiment beat pattern-matching on the loudest error text.

- **BEFORE:** "`text.type` loses the selection across calls, so edits don't land." **AFTER:** the morning's docs eval *passed 20/20* using that exact two-call pattern → the story is falsified. The case that already works refuted the tidy code narrative before it could become a wrong fix.

- **BEFORE:** "The live harness fails — must be a pre-existing environment breakage." **AFTER:** `git stash` of my own `background.js` diff → the a11y-live smoke *passes* without it → it was my change all along. A duplicate `const withTimeout` (I declared it at ~L166; the module already declared it at ~L1407) threw `Identifier already declared` at module eval, so the *entire* service worker failed to load and every hook vanished — invisible to a `node --check` of the fragment. The `git stash` forced the embarrassing, correct answer.

- **Negative-control discipline as its own example:** every green test in the `SessionStore` fix was run against the *old* code and observed to hang. The node behavioral test degrades to `[]` in ~3s where the old one-shot store hung past a 4s ceiling; the Playwright live smoke settles the real `listClaimedTabs()` in 3.0s inside a real MV3 service worker where the reverted old code hangs to the 8s ceiling. Both provably go RED on the old code and GREEN on the fix — so they catch the real bug rather than tautologically passing. The red→green loop across a proven negative control is the experiment that confirms the root cause; a green test with no red baseline is a decoration, not a proof.

## Postscript — the lesson demonstrated once more, live

The docs-edit investigation (`investigations/hosted-agent-debugger-not-attached-new-tab.md`) had a *reasoned* root cause written into it: "trusted keystrokes are silently dropped because the editing tab is backgrounded." It was well-argued and cross-checked against the passing eval — it *felt* confirmed. But it had never been through a confirming experiment; the experiment was blocked at the time by an unrelated 504.

Later the same session, with the 504 fixed, I finally ran that experiment (single runtime, tab confirmed `active:true` foreground, a real edit, prediction committed first: "if the background-tab story is true, the edit lands now"). **It failed anyway** — with a *different* error (`"Cannot access a chrome-extension:// URL of different extension"`, a CDP debugger-attach conflict). The background-tab story predicted success and got failure: **falsified.** The reasoned conclusion I would have shipped as the root cause was wrong, and only the experiment caught it.

That is the whole doc in one beat: a conclusion reached by reading — however carefully argued — is a hypothesis, not a finding. Run the experiment. **Reading is where you look; running is what you know.**

## Related

- **Canonical methodology home:** `skills/incident-investigation/SKILL.md` — the maximum-pain principle, the Original Shame (maximum-pain applied inward), one-variable-at-a-time, and the mandatory maximum-pain pass. This doc is the incident-grounded capture; the skill is the authoritative expansion.
- **Worked examples:** `investigations/bridge-504-timeouts.md` (experiments X1–X6, red/green negative controls, three-level blame) and `investigations/hosted-agent-debugger-not-attached-new-tab.md` (the debugger-error red herring; the reopened root cause in the Postscript).
- **The bug this discipline uncovered:** `docs/solutions/runtime-errors/session-store-ready-promise-mv3-wedge.md` — its "What Didn't Work" section is the concrete case study for beats 1–4.
- **Sibling knowledge-track learning:** `docs/solutions/architecture-patterns/live-harness-past-the-serializing-tool.md` — the negative-control / unit-green-is-not-works-live discipline, the same epistemic spine at the testing layer.
