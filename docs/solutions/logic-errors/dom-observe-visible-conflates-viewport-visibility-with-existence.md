---
title: "dom.observe.visible conflates viewport-visibility with existence"
module: extensions/chrome-overlay-runtime
date: 2026-07-10
last_updated: 2026-07-10
problem_type: logic_error
category: logic-errors
component: tooling
severity: high
symptoms:
  - "`trello.card.checklist.read` returned `[]` forever despite 9 rows present in the DOM"
  - "`dom.observe.visible` reported `match_count: 1` while two independent Trello badges showed 8/9 (89%)"
  - "An under-report from a scrolled collection is indistinguishable from genuine absence"
  - "Four map tools built on the same predicate were broken: checklist.read, checklist_item.complete, card.delete, list.archive"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - development_workflow
  - testing_framework
tags:
  - dom-observe
  - viewport-visibility
  - content-script
  - trello
  - enumeration
  - iselementvisible
  - actions-json
---

# dom.observe.visible conflates viewport-visibility with existence

## Problem

In `actions.json`'s Chrome-extension content script (`extensions/chrome-overlay-runtime/src/content.js`), the predicate `isElementVisible` answers **"does this element intersect the current viewport?"** — never **"does this element exist?"** Every caller read it as the latter, and the two questions diverge the moment a collection is longer than the screen.

`dom.observe.visible`, the primitive used to enumerate a collection, ends its pipeline with `.filter(isElementVisible)`:

```js
// content.js — dom.observe.visible
const matches = candidates
  .filter(isElementVisible)   // <-- the entire defect is this one line
  .filter(textFilter)
  .slice(0, maxMatches)
  .map(...);
```

`isElementVisible` bottoms out in `visibilityGeometryFor`, which intersects an element's rect with the viewport and with any ancestors that clip via `overflow`:

```js
const visibilityGeometryFor = (element) => {
  let visibleRect = intersectRects(rect, viewportRect());   // <-- the viewport
  const clippingAncestors = clippingAncestorsFor(element);  // <-- ancestors that clip via `overflow`
  for (const ancestor of clippingAncestors) {
    visibleRect = visibleRect ? intersectRects(visibleRect, ancestor.rect) : null;
  }
  return { visible: Boolean(visibleRect), ... };
};
```

An element scrolled off-screen intersects to nothing, so it is "invisible" — present in the DOM, addressable, inert to the filter. Using `dom.observe.visible` to **enumerate** a scrollable collection under-reports by however much is scrolled away. **An under-report is indistinguishable from absence,** and nobody investigates a tool that quietly returns fewer rows than exist.

Four tools were built on this conflation:

1. `trello.card.checklist.read` — returned `[]` on every call. It shipped a `warning: "BROKEN"` string **in its own output**, and its description told the next agent the fix required an *accessibility* read: *"There is therefore no DOM locator that reaches these rows by name… Blocked on a scoped/enumerating a11y read."* Both claims were false.
2. `trello.card.checklist_item.complete` — four of its steps use `dom.observe.visible`. `clickItemCheckbox` derives coordinates from `steps.findItemRow.output.matches[$contains(text,$t)][0].bounding_box.top`; when the target row is off-screen `matches` never contains it, `$cy` is undefined, the click resolves nowhere. It can only complete an item that happens to be on screen. **Still open.**
3. `trello.card.delete` and 4. `trello.list.archive` — a related but distinct defect: all selector fallbacks scoped inside `[data-testid='popover']`, a container Trello removed (0 live matches). **Both open; `list.archive` is destructive and was unknown until a new audit rule found it.**

## Symptoms

Measured live, on a Trello card modal with **9 checklist rows in the DOM**, four instruments disagree:

| instrument | reports | transport |
|---|---|---|
| `dom.observe.visible` | `match_count: 1` (`bounding_box.top: 930.8`, the viewport edge) | content-script DOM query |
| Trello's own progress badge | `89%` | the app's model |
| the board's `checklist_summary` badge | `8/9` | a different render path |
| `dom.observe.attributes` (the fix) | `item_count: 9, checked_count: 8` | content-script, unfiltered |

- `trello.card.checklist.read` returns `[]` on a card that visibly has 9 items, and self-describes as `warning: "BROKEN"`.
- `trello.card.checklist_item.complete` fails at its final `badgeAfter` step whenever the target row is below the fold; reading the card back shows `checked: false`, `89%` unchanged — nothing mutated.
- `trello.card.delete` / `trello.list.archive` find 0 matches for every selector because they all scope inside `[data-testid='popover']`, a container that no longer exists in the live DOM.

## What Didn't Work

Each of these is a real, dated dead end. Every one died to a single cheap independent read.

**(a) The clip-aware-predicate story. REFUTED by my own harness within minutes of writing it.** I claimed `visibilityGeometryFor` drops `clip: rect(1px,1px,1px,1px)` screen-reader-only elements, wrote it into an investigation file AND into the new primitive's own code comments. Built a fixture of genuine sr-only inputs. Expected `match_count: 0`:

```
dom.observe.visible (clipped rows): {"match_count": 3}     <- EXPECTED 0
each clipped row reports visible:false                      <- FAIL
```

`visibilityGeometryFor` intersects with the **viewport** and with ancestors that clip via **`overflow`**. It never reads an element's *own* `clip`/`clip-path`. A 1×1 sr-only input comes back `visible: true`. The harness killed the mechanism before it shipped.

**(b) "The names are unreachable."** The map's own note said no visible element carries the item name, so a DOM read cannot find it. But `content.js:2435` already does `element.textContent || element.getAttribute("aria-label")`, and an `<input>`'s `textContent` is `""` — falsy — so it falls through to `aria-label` unaided. The name was never the problem.

**(c) "Blocked on an enumerating a11y read."** `a11y.query`/`a11y.tree` are `capability_class: "privileged"` (they run in the background over `chrome.debugger`) and appear **nowhere** in the content-script dispatch. A workflow step cannot call them at all. Confirmed by grep, not recall.

**(d) `browser.extract_elements` as the fix.** It *is* dispatched in the content script (line 4190) and reads arbitrary attributes. Two disqualifications, either fatal: it is **absent from `primitive_dictionary`** (the workflow gate rejects it), and `content.js:2328` does `itemRoots = […].filter(isElementVisible)` — the very predicate that drops the rows.

**(e) An audit rule keyed on "testid absent from the captured DOM fixture."** Built, measured, **not shipped**. 46 unannotated fires on the real corpus; at most 2–3 real. Absence-from-fixture conflates a dead testid, an out-of-scope board control, and the capture's own excluded scope root (`card-back-name` — the element the capture is *scoped to*). Precision ≤6%, on a rule that prompts edits.

**(f) A phantom defect recorded as CONFIRMED LIVE.** I recorded "`text.insert` does not change the title of a ready field." No such defect. I had hand-opened a popover to isolate the step; the workflow's own earlier step then fired against a dead selector and reset it before `insertTitle` ran. **A hand-staged precondition is not the precondition the workflow will find** — the earlier steps still run, and may unstage what you staged.

**(g) "A late-step failure means the mutation landed."** Usually true, false here. `checklist_item.complete` failed at `badgeAfter` (the last step); reading the card back showed `checked: false`, `89%` unchanged. Nothing mutated.

## Solution

A new portable, read-only content-script primitive, `dom.observe.attributes` — `dom.observe.visible` minus one `.filter(isElementVisible)`, plus named attribute reads:

```js
// enumerate WITHOUT the viewport filter; report `visible` per match so
// "what is on screen" and "what exists" stay separable.
const matches = candidates
  .filter(textFilter)                  // no isElementVisible here
  .slice(0, maxMatches)
  .map((element) => ({
    tag_name: element.tagName.toLowerCase(),
    attributes: Object.fromEntries(requested.map(n =>
      [n, n === "text" ? normalizeText(element.textContent) : element.getAttribute(n)])),
    visible: isElementVisible(element),
  }));
return primitiveSuccess("dom.observe.attributes", {
  matches, match_count: matches.length,
  visible_count: matches.filter(m => m.visible).length,
});
```

It reads **attributes rather than text**, because accessible names often live only on an attribute: Trello's row name is the `aria-label` of a 1×1 `<input>` whose `textContent` is `""`. It is declared once in `primitive_dictionary` — the bridge derives its MCP tool from it and workflow steps gate on the same dictionary shipped inside the extension zip.

The consumer, `trello.card.checklist.read`, was rewired to use it:

```
- readUnchecked + readAllVisible   dom.observe.visible     -> on-screen rows only
+ readItems                        dom.observe.attributes  -> every row, + aria-checked
```

Shipped in `extension-v0.1.196`.

## Why This Works

The fix separates two questions the old primitive fused. `dom.observe.attributes` never filters candidates by viewport intersection, so it enumerates **what exists**; it still computes `isElementVisible(element)` per match and reports it as a boolean, so **what is on screen** remains available. `visible_count` reconciles *exactly* with what the old primitive returned — the new read **contains** the old one rather than contradicting it — which is what makes it a safe drop-in.

The counterpart insight completes the model. `locator.element_info` shares the same viewport predicate but **auto-scrolls its match into view first**. Trace, on a row 200px below the fold:

```
initial_visibility: { top: 1178.7, visible: false, state: "requires_scroll", clipped_by: 6 ancestors }
scroll_operations_performed: 2
final visibility:   { visible: true, visible_ratio: 1.0 }
```

One **cures** the invisibility; the other **reports it as absence**. That asymmetry is why `checklist_unchecked_items.read` (which uses `element_info`) works on a long checklist and `checklist.read` (which used `observe.visible`) did not.

The rule that falls out:

> **To READ a thing you must not require it to be rendered. To CLICK it, you must.**

`visible` is a **rendering** predicate, not an **existence** one. Any tool that enumerates a scrollable collection through it will silently under-report. To enumerate: `dom.observe.attributes`. To click an off-screen element: name it, then hand the name to `locator.element_info`, which scrolls. Judge completion by the app's own aggregate — Trello computes its percent badge from a model that sees rows no DOM read can.

> ### ⚠️ The clicking half of that rule is necessary and **not sufficient** (added 2026-07-10)
>
> Rendering an element does not make it clickable. `element_info`'s auto-scroll **top-aligns**
> its match in the scroll container — which on a page with a sticky header parks the row
> directly underneath it. The resolver then returns a `clickable_center` that is pure geometry:
> the midpoint of a bounding rectangle, never hit-tested against the paint order.
>
> Measured on this same Trello card, an hour after this doc was first written: a row at
> `top: 169` with `innerHeight: 1066` — comfortably inside the viewport, `visible: true` —
> where `document.elementFromPoint(37, 170)` returned the **sticky header**, not the checkbox.
> `pointer.click` reported `clicked: true`. Nothing happened. The 1×1 input the resolver had
> picked has no margin: its centre sat one pixel under the occluder.
>
> So the maxim extends: **to click a thing it must be rendered *and hittable*.** Hit-test the
> point (`elementFromPoint`), or — better — bind a rendered, appreciably-sized control by
> identity and never touch geometry at all.
>
> Full analysis: [`clickable_center` is a coordinate, not a hit-tested target](./clickable-center-is-a-coordinate-not-a-hit-tested-target.md).

## Prevention

**1. A live harness, both directions, on the shipped code.** `npm run test:dom-observe-attributes-live` serves 12 rows, most below the fold. The fixture asserts its own invariants *first* — rows in the DOM, some on screen, some not — so a vacuous pass fails loudly:

```
in DOM 12, on screen 2
dom.observe.visible     ->  2                      the red
dom.observe.attributes  -> 12,  visible_count 2    the green
last row: {"aria-label":"item 12","aria-checked":"false"}, visible:false
```

`visible_count` reconciles **exactly** with the old primitive: the new read *contains* it rather than contradicting it.

**2. The never-asked direction, later closed.** The release notes claimed "both directions." The false-negative direction — *can it MISS an element that exists?* — had never been tested. Tested afterwards against Playwright's `$$eval` (a different transport, not our content script): 40 adversarially-hidden inputs (`display:none`, `visibility:hidden`, `opacity:0`, zero-size, off-screen, inside `overflow:hidden`). All 40 returned, `visible_count: 0`, 0 missed.

**3. A guard, not a scan.** New audit rule `auditFallbacksShareDeadScope` in `tools/actions-json-pipeline/src/audit.mjs`: a comma-separated fallback list whose branches all share one ancestor scope is **one selector, not three** — it fails as a unit. Derived from a principle, not a pattern. Known-answer both directions on the real corpus: fires on `card.delete.findDeleteButton` (proved dead by an independent live DOM read) and on `list.archive.clickArchiveList` (a **destructive action nobody knew was broken**); silent on all ten live `[role='dialog']` scopes. The test carries a fault injection (swap the dead scope for a live one → must go silent) and a reachability assertion (the rule must be reachable from `runAudit`, not merely exported).

**4. Honest bounds, stated.** 0 false positives in 2 fires bounds the FPR at **77.6%** (exact Clopper–Pearson, 95%), not at zero. It is a **positive oracle**: when it fires, believe it; **its silence clears nothing.** Recorded in `docs/reliability/instrument-bounds.md`.

**5. A written rule is not a guard.** The memory note `candidate-count-is-viewport-dependent` (dated **2026-07-09**, indexed, loaded) already stated this exact rule the day before — *"`visible` means intersects the viewport, not exists; scrolled-off rows are addressable but invisible; prefer the app's own computed badge."* **The rule existed, was in context, and was walked past.** Prose in a memory file does not stop the next author; only an executable guard on the shipped code does. *(auto memory [claude])*

**6. First-pass hypotheses die cheap — test before recording.** Measured first-pass hypothesis hit-rate is ≈40% (`incident-investigation-run-real-experiments`, `exculpatory-explanation-bias`). On this problem the rate was **0-for-3**: the clip story, the phantom `text.insert` defect, and "a late-step failure means the mutation landed" were all recorded as conclusions *before* being tested, and all three died to one cheap independent read each. The habit that would have saved the day: run the disproof before writing the finding down. *(auto memory [claude])*

## Related Issues

- [`validate-the-instrument-before-trusting-the-experiment`](../best-practices/validate-the-instrument-before-trusting-the-experiment.md) — sibling principle. Shares this doc's *epistemic* prevention rules (a probe that cannot reach the code under test is not evidence; a clean null discriminates nothing) but a different problem, root cause, and fix. Overlap assessed as **moderate**: 1 of 5 dimensions.
- [`live-harness-past-the-serializing-tool`](../architecture-patterns/live-harness-past-the-serializing-tool.md) — shared technique. The self-asserting fixture with a negative control, used here so a vacuous pass fails loudly.
- [`run-a-real-experiment-before-concluding-root-cause`](../best-practices/run-a-real-experiment-before-concluding-root-cause.md) — upstream methodology. *Reading is where you look; running is what you know.* On this problem the first-pass hypothesis was wrong three times.
- [`docs-canvas-coalesces-rapid-trusted-arrow-keys`](../runtime-behavior/docs-canvas-coalesces-rapid-trusted-arrow-keys.md) — sibling in the same `chrome-overlay-runtime` content script, and the same shape of trap: a green flag reported while the tool measured the wrong thing.
- [`docs/reliability/instrument-bounds.md`](../../reliability/instrument-bounds.md) — the exact Clopper–Pearson bounds for every instrument named in Prevention, including the two shipped here.

GitHub issue search ran (`gh issue list --search "viewport OR isElementVisible OR dom.observe" --state all`) and returned no matching issues.
