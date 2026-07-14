---
title: Keep workflow outputs single-authority and bounded
date: 2026-07-13
category: runtime-errors
module: actions.json workflow evaluation
problem_type: runtime_error
component: tooling
symptoms:
  - "JSONata expression output exceeded the configured limit."
  - Long Trello checklists could not be read through the task-management projection.
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - Trello public site map
  - workflow expression evaluator
tags:
  - jsonata
  - workflow-output
  - trello
  - bounded-collections
  - single-authority
---

# Keep workflow outputs single-authority and bounded

## Problem

`trello.card.checklist.read` failed with `expression_output_too_large` on a real 59-item checklist. The failure prevented the agent task OS from reading the checklist it must verify before changing task state.

## Symptoms

- The same action worked on small cards but failed deterministically on the 59-item backlog-review card.
- Increasing the caller's `max_bytes` to 50,000 changed nothing.
- The board model still proved the card contained 59 items, isolating the failure to the checklist workflow output path.

## What Didn't Work

- Raising the caller response budget did not help because the 16,000-byte guard runs while evaluating the JSONata expression, before bridge response sizing.
- Raising the global expression or spill limit would have hidden a wasteful output contract and increased every workflow's memory exposure.
- A broad regex audit for duplicate projections produced false positives on legitimate array indexing such as `$beforeRows[$row]`; it was not precise enough to become a release gate.

## Solution

Emit each logical checklist row once. The former output duplicated every unchecked title:

```jsonata
{
  'items': [$rows.{
    'text': $.attributes.`aria-label`,
    'checked': $.attributes.`aria-checked` = 'true'
  }],
  'unchecked_items': [
    $rows[attributes.`aria-checked` = 'false'].attributes.`aria-label`
  ]
}
```

The fixed contract keeps `items` as the single authority:

```jsonata
{
  'items': [$rows.{
    'text': $.attributes.`aria-label`,
    'checked': $.attributes.`aria-checked` = 'true'
  }]
}
```

Consumers derive unfinished work by filtering `items` where `checked=false`.

The regression executes the stored action through the real workflow engine with 59 long unchecked rows and asserts all three boundary properties:

```javascript
assert.equal(value.item_count, 59);
assert.equal(value.items.length, 59);
assert.equal("unchecked_items" in value, false);
assert(Buffer.byteLength(JSON.stringify(value), "utf8") < 16_000);
```

## Why This Works

JSONata materializes every constructed array before returning the semantic value. With all 59 rows unchecked, `items` and `unchecked_items` copied the same long titles twice and crossed the evaluator's fixed 16 KB guard. Removing the derived duplicate preserves every fact while reducing output size at its source.

The fix was verified at two boundaries: the controlled engine test and the exact live card after the merged public map was synced. Both returned all 59 rows without increasing any global limit.

## Prevention

- Treat one row collection as the authority; make consumers derive subsets from it.
- Add adversarial cardinality tests at the evaluator's actual byte boundary, not only small happy-path fixtures.
- Distinguish evaluator limits from caller/transport budgets by locating the exact error constructor before tuning a response setting.
- Prefer executable boundary regressions over noisy static heuristics that cannot distinguish projection duplication from ordinary indexing.
- Live-verify the exact previously failing object after the authoritative map or runtime artifact is merged and synced.

## Related Issues

- [Trello checklist.read output-limit investigation](../../../investigations/trello-checklist-read-output-limit-2026-07-13.md)
- [Earlier rich unchecked-items output-limit investigation](../../../investigations/trello-unchecked-checklist-jsonata-output-limit-2026-07-11.md)
- [Public map remediation PR](https://github.com/yaniv256/actions.json.storage.public/pull/18)
- Regression and incident change
