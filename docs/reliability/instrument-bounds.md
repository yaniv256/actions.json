# Instrument bounds

Every claim in this repo rests on an instrument. This file records what we have
actually *measured* about those instruments, and — more importantly — what we have
never asked.

Generated from `~/.reliable-measurement/observations.csv` (76 observations, per
`(tested_tool, testing_tool)` pair). Rebuild with:

```bash
python3 ~/reliable-measurement/ledger/bounds.py
python3 ~/reliable-measurement/ledger/render_html.py --out ledger.html
```

Both scripts carry known-answer self-tests (28/28 and 23/23). **Run them before
believing a single interval either prints** — the estimator is an instrument too.

## The two we shipped on 2026-07-10

### `dom.observe.attributes`

| direction | observations | exact 95% bound |
|---|---|---|
| false positive (returns something that isn't there) | 0 / 4 | **≤ 52.7 %** |
| false negative (omits something that is there) | 0 TP, 0 FN | **structurally not a detector** |

Four independent testers: Trello's own percent badge (the app's model), the board's
`checklist_summary` badge (a different render path), a served 12-row harness, and
Playwright's `$$eval` (a different transport entirely — not our content script).

The last of those asked the direction nobody had asked: **can it MISS an element that
exists?** Forty adversarially-hidden inputs — `display:none`, `visibility:hidden`,
`opacity:0`, zero-size, off-screen, inside `overflow:hidden`. All forty returned;
`visible_count: 0`. It enumerates everything and reports that none is rendered.

> The `extension-v0.1.196` release notes claimed the harness proved it *"both
> directions."* At the time of writing that sentence, the miss-direction had **never
> been tested**. It has now. The claim was true by luck, not by evidence, and the
> difference is the entire point of this file.

### `auditFallbacksShareDeadScope`

| direction | observations | exact 95% bound |
|---|---|---|
| false positive (flags a working selector) | 0 / 2 | **≤ 77.6 %** |
| false negative (misses a dead-scoped fallback list) | 0 / 2 | **≤ 77.6 %** |

> The commit message reads as though it has no false positives. **It has none
> *observed*, in two fires.** That bounds the rate at 77.6 %, not at zero. Treat it as
> a **positive oracle**: when it fires, believe it. Its silence clears nothing.

## The instrument that caused the day

### `dom.observe.visible`, used to *enumerate*

| direction | observations | exact 95% bound |
|---|---|---|
| false positive | 0 TP, 0 FP | **never observed crying wolf** |
| false negative (misses what exists) | 4 / 4 | **≤ 100 %** |

Four independent instruments caught it under-reporting: `dom.observe.attributes`,
Trello's own badge, a served fixture, and Playwright's `$$eval`.

This is §6b's asymmetry in its purest form. `visible` means *intersects the viewport*.
As a **positive** oracle it is sound — what it reports really is on screen. As a
**clearance** it is worthless, and four separate tools were built on its silence:
`checklist.read`, `checklist_item.complete`, and (differently) `card.delete` and
`list.archive`.

> **Nobody investigates a quiet tool.** That sentence is the whole postmortem.

## Rules that were built, measured, and NOT shipped

`auditTestidAbsentFromDomFixture` — flag any `data-testid` in a map that is absent from
the captured card-modal DOM fixture.

Measured on the real corpus: **46 unannotated fires, at most 2–3 real. Precision ≤ 6 %.**
Absence-from-fixture conflates three different things — a genuinely dead testid, an
out-of-scope board control, and the capture's own excluded scope root (`card-back-name`,
the very element the capture is *scoped to*).

For a rule that prompts an edit, a false positive costs more than a false negative: a
missed finding leaves the code alone; a false one makes you break working code,
confidently. It was deleted before it ever ran in anger.

## Hypotheses of mine that an instrument killed, same day

| hypothesis | killed by | cost if it had shipped |
|---|---|---|
| `visibilityGeometryFor` drops `clip:rect(1px,…)` elements | my own sr-only harness | a primitive whose entire rationale was false |
| `text.insert` fails on a ready field | full workflow run after the selector fix | a phantom bug filed against a working primitive |
| a late-step failure implies the mutation landed | reading the card back | reporting a mutation that never happened |

Each was recorded as *confirmed* before it was tested. Each died to one cheap, independent
read. That is a 0-for-3 first-pass hit rate on a day I felt sharp.
