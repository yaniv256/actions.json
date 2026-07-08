---
title: "Curiosity as a workflow: interrupt current work to repair the world-model when reality contradicts it"
module: development-workflow
date: 2026-07-08
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "An action/tool/map produces a result that contradicts your expectation"
  - "You are mid-task and tempted to work around a surprising failure to keep moving"
  - "A verification passed but you are not sure it measured the real thing"
  - "Authoring actions.json and a workflow silently does nothing or reverts"
  - "Deciding whether a surprise is worth stopping to investigate"
tags:
  - curiosity
  - incident-investigation
  - actions-json
  - world-model
  - work-stack
  - screenshot-ground-truth
  - reveal-experiment
  - workflow
related_components:
  - assistant
  - development_workflow
---

# Curiosity as a workflow: interrupt to repair the world-model

## Context

An agent operating a website through `actions.json` carries a **world-model**: a set of
expectations about what each action does. That model is *literally encoded in the
`actions.json` map*. So when an action produces a result that contradicts expectation —
a rename that doesn't persist, a "verified: true" on an edit that did nothing, a board
read that looks stuck — that mismatch is not noise to route around. **It is the model
being shown to be wrong**, and repairing the model is the highest-value thing to do.

The friction this addresses: the natural pull under momentum is to *work around* a
surprising failure ("the rename is flaky, I'll just recreate the card") and keep pushing
the original task. That treats a wrong world-model as a nuisance instead of the signal it
is. The result is a map that stays wrong and quietly fails the next agent too.

## Guidance

**Curiosity is the quantified willingness to switch tasks to an investigation the moment
your world-model is contradicted.** Operationalize it as a workflow:

### 1. Treat a contradicted expectation as an interrupt
When an action's result violates your prediction, that is the trigger. Do not smooth it
over. In an `actions.json` project the world-model *is the map*, so a surprising action
result means the map is wrong — the single most useful thing to fix.

### 2. Push the current task with full context (don't drop it, don't hold it in your head)
Switching is a **promise about the future** ("I'll come back to what I was doing"). A
memory-less agent cannot keep that promise unaided — back it with a **mechanism**: write a
context-injection card / task with the full state (what you were doing, why you stopped,
where the file is) so the paused work is resumable cold. This is the push of a **work
stack**: push the current frame, switch, pop it back later with context intact.

### 3. Open an investigation (repair the model), don't just patch the symptom
Switch to the formal investigation: hypotheses, evidence, a *reveal* experiment. The goal
is to correct the world-model (the map / the primitive / the mental model), not to make
this one call succeed.

### 4. Verify by ground truth, not by your own projection
The surprise often hides because a check *you authored* lied. Verify a rendered result by
**screenshot**, and a document/edit by the **model read**, not by the DOM/tool-success flag
you wrote — those can be systematically wrong (canvas apps read false-empty; a substring
"present?" check passes after a no-op; a mid-flight board snapshot read between an agent's
multi-second steps looks "stuck"). When a projection and a screenshot disagree, the
screenshot wins.

### 5. Follow the surprise; expect the cause to move
A healthy investigation *keeps* surprising you. Your first-cut hypotheses are usually
wrong and the true cause often lives outside your initial list. When hypotheses die one
after another, that is the signal to get a **different kind of data** (inspect the element,
strip a layer, drive the real thing) — not to try another variation of the same idea. Mark
each surprise (🍾) and mine it rather than explaining it away.

## Why This Matters

The world-model is the thing that makes future work cheap. Every time you route around a
contradiction instead of repairing the model, you (a) leave the map wrong for the next
agent, (b) accumulate a false belief that will mislead later reasoning, and (c) forfeit the
one moment when the bug is cheapest to find — right when it surprised you. Curiosity, run
as this workflow, is how the world-model *converges on reality over time* instead of
drifting from it. It is also what makes "operate the site through the agent to improve the
map" actually improve the map: the surprises are the improvement signal.

The push-with-context step is what makes curiosity *safe* to indulge: you can chase the
surprise without losing the original task, because the stack frame is saved. Without the
mechanism, "I'll investigate later" is a promise that never resolves.

## When to Apply

- Any time an `actions.json` action, primitive, or workflow does something you did not
  predict — silently does nothing, reverts, or reports success you can't independently see.
- When a verification "passed" but you did not confirm it against ground truth.
- When you notice yourself about to *work around* a failure to preserve momentum — that
  urge is the tell that a world-model repair is being skipped.
- Calibration: not every surprise warrants a full 10-phase investigation, but every
  surprise warrants *at least* a ground-truth check and a decision recorded on the card.

## Examples

### The arc that motivated this (Trello `title.set`)
Expectation: `trello.card.title.set` renames a card. Reality: the title never changed, yet
the action reported `verified: true`.

- **Interrupt + push:** paused the board-seeding task; wrote a context-injection card on the
  Investigations board (Investigating list) with the file path, symptom, and status; opened
  a formal investigation. The original task is resumable cold.
- **Ground truth over projection:** six DOM reads all showed the old title; a *screenshot*
  is what proved the field wasn't even editing. The action's `verified:true` was a
  presence-only substring check — a lie I authored.
- **Reveal experiment > more gestures:** four gesture hypotheses (text.insert, trusted type,
  double-click, commit-by-blur) all died. The productive move was to *inspect the element*:
  it was a React **controlled** `<textarea>`; setting `.value`/firing keystrokes never fires
  React's `onChange`, so blur reverts. Fix = native value setter + dispatched `input` event
  (confirmed live, verified by screenshot).
- **The cause kept moving (🍾):** the anti-pattern search then found the runtime *already*
  had the native-setter fix and it was shipped — so the root cause refined again (a narrower
  map/beforeinput/deploy question). Each surprise deepened the model; none was waved away.

### Before / After
- **BEFORE:** rename looks flaky → "I'll just recreate the card with the right title" →
  original task continues, map stays broken, next agent hits the same wall, and the false
  `verified:true` persists as a latent trap.
- **AFTER:** rename surprises → push the task with a context card → open investigation →
  screenshot ground-truth → reveal experiment → correct the map/primitive and the
  verification. The world-model is now closer to reality for everyone.
