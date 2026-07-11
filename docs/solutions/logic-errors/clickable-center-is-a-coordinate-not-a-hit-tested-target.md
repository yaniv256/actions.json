---
title: "clickable_center is a coordinate, not a hit-tested target"
module: extensions/chrome-overlay-runtime
date: 2026-07-10
problem_type: logic_error
category: logic-errors
component: tooling
severity: high
symptoms:
  - "`a11y.query` returned `found: true` with `clickable_center {x:37, y:170}` for a row fully inside the viewport"
  - "`document.elementFromPoint(37, 170)` returned the page's sticky header, not the checkbox"
  - "`pointer.click` reported `clicked: true`; `aria-checked` stayed `false`; the progress badge never moved"
  - "Only a postcondition armed with `on_error: stop` caught the silent no-op, four steps later"
  - "The resolved element was a 1x1 input whose centre sat one pixel under the occluder"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - testing_framework
  - development_workflow
tags:
  - a11y-query
  - clickable-center
  - occlusion
  - elementfrompoint
  - hit-testing
  - pointer-click
  - sticky-header
  - trello
  - actions-json
---

# clickable_center is a coordinate, not a hit-tested target

## Problem

A resolver reported an element as found, in the viewport, with a `clickable_center`. The
click landed on a sticky header painted over that exact pixel. Every step in the workflow
returned `ok: true` and nothing happened.

## Symptoms

- `a11y.query {role:'checkbox', name_contains:'…'}` → `found: true`, `clickable_center: {x:37, y:170}`
- The row's `getBoundingClientRect()` → `top: 169`, against `window.innerHeight: 1066` — **fully inside the viewport**
- `document.elementFromPoint(37, 170)` → `<section data-testid="card-back-sticky-header">`, **not** the checkbox
- `pointer.click(37, 170)` → `{clicked: true}`; `aria-checked` stayed `"false"`; the progress badge never moved
- The workflow failed only at `badgeAfter` — a postcondition, four steps later, with `retry_until` and `on_error: "stop"`
- Board read-back confirmed the truth: `0/6, 0%`. The mutation never landed.

## What Didn't Work

**"It's the viewport defect again."** The obvious read, and wrong: the element was *in* the
viewport. This is a sibling of `dom.observe.visible` under-reporting a scrolled-out
collection, not another instance of it. Element scrolled **out** versus element painted
**under** are different failures with different fixes.

**"`locator.element_info`'s auto-scroll dismisses the popover."** Elegant, testable, false.
Scrolling the container and the window both left the menu open. Measured, not assumed.

**"A late-step failure means the mutation landed."** A useful heuristic elsewhere; false
here. The board read-back was the only thing that settled it.

**Following the existing documentation exactly.** The sibling doc prescribes: *"To click an
off-screen element: name it, then hand the name to `locator.element_info`, which scrolls."*
That advice **produces this bug**. `element_info` auto-scrolls its match to the **top edge**
of the scroll container — directly beneath a sticky header.

## Solution

Two changes. The first is the general rule; the second is what it looks like in a map.

**Never hand `pointer.click` a coordinate no instrument has hit-tested.** If geometry is
unavoidable, probe it, and assert both directions in the same run:

```js
const probe = el => {
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const at = document.elementFromPoint(x, y);
  return { x, y, hittable: !!at && (at === el || el.contains(at) || at.contains(el)) };
};
// before: {x:37, y:170, hittable:false}   elementFromPoint -> card-back-sticky-header
el.scrollIntoView({ block: 'center' });
// after:  {x:37, y:517, hittable:true}    elementFromPoint -> clickable-checkbox
```

**Better: bind a real-sized target by identity and skip geometry entirely.** The resolver had
returned the 1×1 `<input>`; the actual click target was a 32×28 sibling with its own testid,
unique inside a row carrying a stable id.

```jsonc
// BEFORE — a11y.query resolves the 1x1 input; pointer.click takes its raw centre
{ "id": "findItem", "primitive": "a11y.query",
  "args": { "role": "checkbox", "name_contains": "{% input.item_text %}" } },
{ "id": "clickItem", "primitive": "pointer.click",
  "args": { "x": "{% steps.findItem.output.clickable_center.x %}",
            "y": "{% steps.findItem.output.clickable_center.y %}" } }

// AFTER — read the row's stable id, then resolve the real target under it.
// locator.element_info auto-scrolls AND reports visibility.
{ "id": "findRowId", "primitive": "dom.observe.attributes",
  "args": { "selector": "[data-testid='check-item-container']",
            "attributes": ["data-checklist-item-id", "text"],
            "text_contains": "{% input.item_text %}" },
  "retry_until": "{% steps.findRowId.output.match_count = 1 %}", "on_error": "stop" },
{ "id": "findItem", "primitive": "locator.element_info",
  "args": { "locator": { "selector":
    "{% ($id := steps.findRowId.output.matches[0].attributes.`data-checklist-item-id`; $id ? '[data-checklist-item-id=\"' & $id & '\"] [data-testid=\"clickable-checkbox\"]' : undefined) %}" } },
  "retry_until": "{% $exists(steps.findItem.output.clickable_center) %}", "on_error": "stop" }
```

The selector is built by string concatenation, so it must **fail closed**. With zero matches
the first version produced `[data-checklist-item-id=""] …` — a *syntactically valid* selector
that could click the wrong row of a toggle. The `$id ? … : undefined` guard is not decoration.

## Why This Works

`clickable_center` is the midpoint of a bounding rectangle. Nothing hit-tests it. A resolver
answers *"where is this element?"*, never *"will a click here reach it?"* — and those diverge
the moment anything is painted on top: a sticky header, a toolbar, a banner, a cookie bar,
or your own overlay.

The 1×1 input is what made it bite. A one-pixel target has no margin: its centre sat a single
pixel under the header. The 32×28 sibling was never occluded at all. **A 1×1 element is a
warning**, not a target.

This is the same lie as `visible`, one layer down:

| the name promises | it actually means |
|---|---|
| `visible` | intersects the viewport |
| `clickable_center` | the midpoint of a rectangle |
| `found: true` | a node matched, in some state |

None of them means *"a click here will reach this element."* Rendering is **necessary and not
sufficient** for clicking. The older maxim — *to read, do not require rendering; to click, you
must* — stops one step short.

## Prevention

**Make the postcondition a real check.** Four steps reported success. The only instrument that
caught the no-op was `badgeAfter`, armed with `retry_until` + `on_error: "stop"` an hour
earlier. Under `on_error: "continue"` it would have shipped as a silent no-op — the fifth
member of a documented family of exactly that failure.

> A step that cannot fail is not a check.

**Known-answer test any selector you build by concatenation, before the live run.**

```js
// RED: one match -> the exact selector that was hit-tested live
await expr.evaluate({steps:{findRowId:{output:{matches:[{attributes:{'data-checklist-item-id':'6a50…'}}]}}}});
//   -> [data-checklist-item-id="6a50…"] [data-testid="clickable-checkbox"]

// GREEN: zero matches, and empty id -> MUST be undefined, never a valid selector
await expr.evaluate({steps:{findRowId:{output:{matches:[]}}}});                            // undefined
await expr.evaluate({steps:{findRowId:{output:{matches:[{attributes:{'data-checklist-item-id':''}}]}}}}); // undefined
```

The green control caught the wrong-row hazard. A live run would have silently unchecked
someone else's item.

**Fix the resolver, not just the caller.** `a11y.query` should hit-test its own
`clickable_center` and either scroll until the point is hittable or return `occluded_by`.
Until it does, every caller must compensate — and most will not know to.

**`hideOverlay` does not help.** The classic occlusion cure (hide-operate-unhide) is for *our*
overlay. When the occluder is the site's own chrome, it is still there with our overlay hidden.
Same disease, different host, and mistaking the two sends you to the wrong fix.

## Related

- [`dom.observe.visible` conflates viewport-visibility with existence](../logic-errors/dom-observe-visible-conflates-viewport-visibility-with-existence.md)
  — the sibling lie, one rung up. **Its prescription for clicking is now known-incomplete**:
  it says to hand an off-screen element to `locator.element_info`, "which scrolls." That
  auto-scroll top-aligns the match under a sticky header. Rendering is necessary, not sufficient.
- [Validate the instrument before trusting the experiment](../best-practices/validate-the-instrument-before-trusting-the-experiment.md)
  — the postcondition that caught this was calibrated before it was believed.
- [Run a real experiment before concluding root cause](../best-practices/run-a-real-experiment-before-concluding-root-cause.md)
  — three hypotheses died to measurement here, including the most self-implicating one.

Internal: #210 (this), #191 (`a11y.query` must hit-test or report `occluded_by`),
#208 (the fold fix — correct, and incomplete), #170.
