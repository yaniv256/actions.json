---
title: "Validate the instrument before trusting the experiment — a measurement that includes the observer, or a probe that cannot reach the code under test, is not evidence"
date: 2026-07-09
last_updated: 2026-07-10
category: best-practices
module: incident-investigation
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - "timing anything by taking a clock reading before and after a tool call"
  - "an experiment ran with predictions committed first, and the result still misled"
  - "a probe returns healthy but the bug reproduces anyway"
  - "successive experiments keep refuting your mechanisms while the symptom stays fixed"
  - "choosing an experiment because your instrument can run it"
tags: [incident-investigation, measurement, instrumentation, observer-effect, isolated-world, main-world, debugging-methodology, experiment-design, falsification, null-experiment]
---

# Validate the instrument before trusting the experiment — a measurement that includes the observer, or a probe that cannot reach the code under test, is not evidence

> Track: knowledge (a debugging-methodology discipline, not a bug fix). This is the *next turn of the screw* on `run-a-real-experiment-before-concluding-root-cause.md`. That doc says: reading is where you look, running is what you know. This one says: **running with an invalid instrument is still not knowing.** `component: development_workflow` and `module: incident-investigation` match the sibling doc — the principle is methodology-wide, not tied to one code component.

## Context

An incident investigation ran the discipline correctly — hypotheses enumerated, maximum-pain pass applied, predictions committed before each run, a plurality-mass "cause not yet listed" row reserved. And it still produced **three wrong mechanisms in a row**, one of which was committed to git as "THE MECHANISM" before it was tested.

The discipline was not the problem. **The instruments were.** Two distinct failures, both invisible from inside the experiment:

**1. The measurement included the observer.** A per-round-trip cost was measured by taking a shell clock reading, issuing one tool call, and taking another:

```
date +%s.%N            ->  t0
locator.wait_for   (target already visible)
date +%s.%N            ->  t1 - t0 = 18.7 s
```

Between those two `date` calls sits an entire model turn: read the previous result, think, emit a tool call, the harness frames it, the response returns, think again. That is ~15-19 seconds. The system's own report for the same call was **`elapsed_ms: 2`**.

On that instrument a headline finding was built — *"a failing workflow takes ~53-68 s to return, so there is ~41 s of unattributed per-round-trip overhead"* — and written into a run of commits and a memory note before anything caught it. Every number was turn latency. A companion "pacing experiment" that appeared to shave 15 seconds mostly measured a shorter think.

The contradiction was visible for hours and went unexamined: **a workflow's steps execute inside the extension with no model in the loop.** If per-step cost were seconds, a 15-step workflow would take minutes. The heaviest workflow in the map returned promptly while a 9-step one timed out.

**2. The probe could not reach the code under test.** A phenomenon was believed isolated — *"a single `text.insert` on a contenteditable hangs and blocks the page's main thread"* — and three mechanisms were proposed for it, each tested with a real, prediction-first experiment.

> **⛔ The phenomenon itself was later refuted.** There was never a hang; see the retraction in Related, below. The three experiments here are preserved because the *instrument* lesson survives its subject: they were unable to reach the isolated world where the extension's code runs, and would have been incapable of reproducing the phenomenon **even if it had been real**. That is the point. An investigation can run three honest, prediction-first refutations against a phantom, through a probe that could never have seen it either way, and feel like it is converging.

| Mechanism | Experiment | Result |
|---|---|---|
| `requestAnimationFrame` starvation on a non-painting tab | reproduce on a painting foreground tab | **refuted** — the symptom persisted |
| a `TreeWalker` loop over the target subtree | replay the walk with an iteration cap | **refuted** — 0 nodes, 0.0 ms |
| cross-world `DataTransfer` reads empty, driving a re-render loop | dispatch the paste with an empty `DataTransfer` | **refuted** — `prevented=false`, 0.2 ms |

Three experiments, three refutations, symptom unchanged. The pattern only became visible when the *set* was examined rather than the members: **every one was a main-world story, run through a main-world probe.** The failing code runs in a Chrome extension's **isolated world**. `debug.run_javascript` evaluates in the page's **main world**. Every experiment reachable with that instrument was, by construction, unable to reproduce the bug — each ran in 1.8 ms or less and proved only that the *main world* is fine.

Experiments were being chosen by what the instrument could do, not by what the hypothesis required.

## Guidance

**1. Validate the instrument against a call whose true cost you already know.**
Before trusting any timing, measure something whose answer is not in doubt. A `wait_for` on an element that is already visible must return in ~0 ms. If your clock says 18 seconds, your clock is measuring you. One call, five seconds, and the whole false finding dies before it is written down.

**2. Never time a system with a clock that has you in the loop.**
Two shell timestamps around one tool call measure the *observer*. Prefer, in order:

- **the system's own numbers** — `elapsed_ms`, `rate_limit_wait_ms`, server-reported durations, log timestamps. They are recorded where the work happens.
- **a loop with the model removed** — a node harness driving the real engine, or one batched script that runs N iterations and prints the total.

Never extrapolate a per-step budget from your own wall-clock.

**3. A measurement that disagrees with the system's own report by orders of magnitude is an instrument error, not a discovery.**
`elapsed_ms: 2` versus a wall-clock of 18.7 s is not a finding about round-trip overhead. Reconcile the two numbers before theorizing about either.

**4. Before running an experiment, ask what world / process / thread it executes in — and whether that is where the bug lives.**
State it explicitly in the experiment design, next to the predictions:

> *Tests:* H7 (cross-world `DataTransfer`).
> *Runs in:* the page's **main world**, via `debug.run_javascript`.
> *The bug lives in:* the content script's **isolated world**.
> → **This experiment cannot reproduce the bug.** Do not run it.

That one line, written before X4, would have saved three experiments. Boundaries that hide this: main world vs isolated world; page thread vs browser process; unit test vs live harness; a tool that serializes concurrency away.

**5. When successive experiments refute their mechanisms but the symptom never moves, suspect the instrument, not the hypothesis space.**
This is a distinct signal from the three-strike category check. Three strikes says *pivot the category*. This says *pivot the instrument* — the experiments may have been converging honestly and still been incapable of touching the phenomenon. Read them as a **set**: if every member shares a probe, and every member came back fast and clean, the probe is the common factor.

**6. A hypothesis you cannot currently test is a reason to build an instrument, not a reason to test a nearby hypothesis you can.**
Substituting the reachable question for the real one is how an investigation stays busy while going nowhere. Name the instrument the hypothesis requires (here: `console.warn` checkpoints in a locally loaded unpacked extension, which is the only thing that sees the isolated world), and either build it or record that the mechanism is unnamed. Do not fill the gap with an experiment that answers a different question.

## Why This Matters

The cost is worse than a wasted experiment, because a bad instrument produces a *confident* wrong answer that then propagates into durable state. The false overhead finding reached a run of commits and a memory note; a downstream memory now carries a retraction. The three refuted mechanisms each felt like a finding — one was elegant enough that it was committed before it was tested. Its supporting research was real (a clipboard-spec clause about `DataTransfer` outside its handler; a published engineering post describing an unrelated infinite loop in the same product) and it corroborated only that *such a mechanism is possible*, never that it was *this* mechanism. **Plausibility is not corroboration**, and a well-cited hypothesis is still a hypothesis.

There is a structural reason instrument errors survive longer than reasoning errors. A wrong *conclusion* can be caught by anyone who re-reads the argument. A wrong *instrument* corrupts the evidence itself, so every subsequent conclusion drawn from it is internally consistent and mutually reinforcing. The discipline of predict-then-observe does not protect you here: the predictions were committed, the observations were honest, and the answer was still wrong — because the observation could not have come out any other way.

It is also the exculpatory attractor wearing measurement clothing. "There is ~41 s of per-round-trip overhead" locates the fault in the platform. "My clock includes my own thinking" locates it in the operator. Per the maximum-pain principle the second is the one to check first, and it takes one call to check.

## When to Apply

- **Before the first timing measurement of any session.** Calibrate against a known-cost call.
- **When designing any experiment**, alongside the predictions: write down which world/process/thread the probe executes in, and whether the bug lives there.
- **When an experiment comes back fast and clean and the bug persists.** Speed and cleanliness are what a null experiment looks like from the inside.
- **When three experiments have refuted three mechanisms.** Read the set, not the members. Ask what they share.
- **Whenever you catch yourself picking an experiment because it is easy to run.** That is instrument-driven investigation, and it will keep answering questions nobody asked.

## Examples

- **BEFORE:** `date` → one tool call → `date` = 18.7 s. Conclusion: *"~41 s of per-round-trip overhead lives in `resolveSiteActionFromBundle`."* Five commits, one memory note.
  **AFTER:** the same call reports `elapsed_ms: 2` in-page. The 18.7 s was model turn latency. Finding retracted; the memory note now carries a partial retraction. **The instrument, not the system, was slow.**

- **BEFORE:** *"`requestAnimationFrame` starvation — `waitForEditableHandlers` awaits a bare rAF with no timeout, so on a non-painting tab the promise never resolves."* Elegant, one line, explained the apparent flakiness, unified with a separate open bug about stale frames on a dormant display. Committed as "THE MECHANISM."
  **AFTER:** the symptom reappeared on a **freshly reloaded, foreground, actively painting** tab. rAF fires when the tab paints. **Refuted by the experiment that its own prediction demanded.** (The bare rAF remains a real latent hazard — worth fixing — but it was never the cause.) *Later still:* the "symptom" that reappeared was the false-failing postcondition, not a hang — the same lying instrument, read a second time as evidence for a phenomenon it had invented.

- **BEFORE:** three main-world replays of the failing branch — selection, `selectionchange`, synthetic paste — all complete in ≤ 1.8 ms with the text correctly inserted. Read individually: three clean refutations.
  **AFTER:** read as a set: *every probe ran in the main world; the code runs in the isolated world.* The replays proved the branch's logic is fine and said **nothing** about the failing path. `debug.run_javascript` cannot construct an isolated-world `DataTransfer`, so the actual failing configuration was never once tested.

- **The negative-control framing, restated for instruments:** a probe that returns healthy in a state where the bug cannot manifest is a **null experiment**. It discriminates nothing, regardless of which way it comes out. Before reading a clean result, ask whether the probe was in a position to come back dirty.

## Related

- **The doc this sharpens:** `docs/solutions/best-practices/run-a-real-experiment-before-concluding-root-cause.md` — "reading is where you look; running is what you know." This doc adds the next clause: *and running with an invalid instrument is still not knowing.* **Moderate overlap** (same area, different root cause and remedy) — a consolidation review of the two is reasonable, but they carry distinct theses and both are load-bearing.
- **The same failure one layer up, at the testing layer:** `docs/solutions/architecture-patterns/live-harness-past-the-serializing-tool.md` — a live verification that came back "green-for-the-wrong-reason" because the driving tool serialized the concurrency away and the branches under test were never entered. Same shape: an instrument that cannot reach the code under test.
- **Canonical methodology home:** `skills/incident-investigation/SKILL.md` — the maximum-pain principle, predict-then-observe, the three-strike category pivot. This doc adds the *instrument* pivot as a sibling to the category pivot.
- **Worked example:** `investigations/trello-card-create-slow-dispatch-2026-07-09.md` — E0 (the retracted measurement), X4/X6/X7 (three refuted mechanisms), and the Phase-6 gate refused rather than passed with a fourth guess.
- **⛔ RETRACTED — the bug this doc said "exposed it" never existed.** This bullet formerly read: *"a single `text.insert` on Trello's card-composer contenteditable hangs deterministically and blocks the page's main thread… root cause unnamed."* **There is no wedge.** `text.insert` completes; the composer does not hang; `trello.card.create` and `trello.card.delete` both work and always did. The live disproof (X20, on the real board): counters armed on every sink (MutationObserver, selectionchange, ResizeObserver, rAF, input), one `text.insert` fired — rAF ticking normally at **2.3 ms** latency, `debug.run_javascript` answering throughout, board **46 → 47** (card created) **→ 46** (card deleted), and *both tools reported `ok:false`*. The instrument — a `settle_after` postcondition that asserted the workflow's **goal** through a viewport-filtered locator — false-failed every success, and the phantom "wedge" was invented to explain its red. See `investigations/trello-card-create-slow-dispatch-2026-07-09.md`, which now opens with the retraction.

  This doc's own thesis, demonstrated on this doc: **an unvalidated instrument does not fail to find bugs — it invents them.** The retracted bullet stood here for a day as the doc's headline evidence.

- **The same predicate, one layer down:** [`dom-observe-visible-conflates-viewport-visibility-with-existence`](../logic-errors/dom-observe-visible-conflates-viewport-visibility-with-existence.md) — the viewport filter that false-failed the postcondition above is the same filter that made four map tools under-report a scrolled collection as absent. **Moderate overlap** (1 of 5 dimensions: prevention rules only) — that doc shares this one's epistemic rules (a self-asserting fixture; test the direction you never asked; state honest bounds) but has a different problem, root cause, and fix. Both are load-bearing.
