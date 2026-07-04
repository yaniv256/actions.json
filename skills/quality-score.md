# write-actions-json Skill — Adversarial Quality Score

Scored 2026-06-12 by replaying the Trello date-reschedule session's failures
against the skill text and asking, per failure: **would an agent following this
skill, as written, have avoided or quickly diagnosed it?** Target: 90/100.

## Failure Inventory (evidence from live sessions)

| # | Failure | What actually happened |
|---|---------|------------------------|
| F1 | Invented primitive | Authored `locator.scroll_into_view` into a workflow; no such primitive exists. Caught only by a post-hoc grep. |
| F2 | Unsupported step field | Authored `finally` on a workflow step; the engine has no such field. |
| F3 | Symptom-first fixing | Bumped `waitForCardBack` timeout 6s→12s for what was actually overlay occlusion. Two wrong fixes encoded before the root cause was found. |
| F4 | False success trusted | `by_title.open` returned ok:true while the card never opened — postcondition checked an always-valid projection; then a stale prior card-back satisfied a generic selector. |
| F5 | Overlay occlusion | The actions.json menu overlay (max z-index) covered cards; clicks landed on it and silently no-op'd. Root cause of 7/16 batch failures. |
| F6 | Single-axis discovery | `findCard` paged the board horizontally only; cards below a long list's fold never produced a `clickable_center`. |
| F7 | Time-budget blowout | A verification retry loop (5 attempts with waits, after a 12s settle) exceeded the 40s dispatch budget — the call timed out *after the card had already opened*. |
| F8 | Misleading cascade | `on_error: "continue"` on the keystone `waitForCardBack` step let the workflow march on; the real failure surfaced as a confusing downstream "could not open popover". |
| F9 | No symptom routing | ~1,160 lines of skill; nothing maps "click succeeded but nothing happened" to the right section under time pressure. |
| F10 | Batch stamina | The hosted agent planned 17 card edits, did 1, and declared the run complete — twice. Fixed by the task queue (`task.add/next/complete`), which the skill never mentions. |
| F11 | JSONata null trap | `steps.x.output.path = null` is **false** when the path is missing, so a fallback branch was wrongly skipped; `$exists()` was required. |
| F12 | Lying successful read | A modal-text read with a `body` fallback "succeeded" by scraping hidden noscript boilerplate when no modal was open, sending the agent to a wrong conclusion. |

## Criteria & Scores (as written before this revision)

| # | Criterion | Failures tested | Score /10 | Verdict |
|---|-----------|-----------------|-----------|---------|
| C1 | Contract grounding — primitive names and step fields verified to exist before encoding | F1, F2 | 6 | Facts present (engine-contract list) but prose-only; no encode-time gate, no checklist item. F1 happened *despite* "do not invent primitives" existing. |
| C2 | Click-path failure coverage — occlusion, identity-bound postconditions, two-axis scroll | F4, F5, F6 | 8 | Covered by the three patterns added 2026-06-12. Strong. |
| C3 | Symptom→guidance routing | F9 | 2 | No index. An agent mid-failure must already know which of 20+ sections applies. |
| C4 | Ground-truth & root-cause discipline | F3, F4 | 5 | "Green result is not proof" exists as one closing paragraph; no named procedure, no checklist enforcement. |
| C5 | Workflow time-budget hygiene | F7 | 1 | Absent. Nothing relates settle/retry budgets to the dispatch timeout. |
| C6 | Honest failure surfacing — on_error placement, scoped reads | F8, F12 | 3 | Implied in one parenthetical; not stated as policy. Text-read section covers zero-result reads, not wrong-scope "successful" reads. |
| C7 | Batch stamina — external task queue for multi-item jobs | F10 | 0 | Absent. The task.* primitives do not appear in the skill at all. |
| C8 | Expression-language pitfalls | F11 | 5 | Array-shape guidance is good; the missing-path `= null` trap and `$exists()` guard are not mentioned. |

**Total: 30/80 → 38/100.** (Before the 2026-06-12 failure-pattern commit it would
have scored ≈24/100; that commit fixed C2 but left five criteria untouched.)

## Gap → Edit Mapping (this revision)

| Gap | Edit |
|-----|------|
| C3 routing | Symptom→pattern routing table at the top of "Website Mapping Failure Patterns". |
| C7 batch | New pattern: "Batch Jobs Stall Without An External Queue" — task.add/next/complete loop, stale-not-skipped, grounded summary, re-seed failed items after fixing the underlying action. |
| C5 budget | New pattern: "Budget The Workflow's Worst Case" — sum of settle/retry waits must fit the dispatch timeout; post-settle verification must be cheap. |
| C6 surfacing | New pattern: "Keystone Preconditions Fail Fast" — `on_error:continue` only for optional steps; scoped reads so a missing target returns not-found, not boilerplate. |
| C1 gate | "Before encoding any step" 3-point gate appended to the engine-contract facts in Compound Workflow Actions. |
| C4 procedure | Root-cause naming requirement added to the live-DOM proof paragraph; enforcement moved into the checklist. |
| C8 JSONata | Missing-path `= null` trap and `$exists()` guard added beside the array-shape guidance, and to the engine-contract facts (`when` guards). |
| C1/C4/C5 enforcement | Five new Verification Checklist items (primitive names verified; step fields recognized; worst-case duration budgeted; postconditions bind identity; fixes proven on live DOM). |

## Post-Revision Self-Score

| # | Criterion | Score /10 | Residual gap |
|---|-----------|-----------|--------------|
| C1 | Contract grounding | 10 | Mechanical now (spec-030): validateWorkflow rejects unknown workflow/step fields, and rejects primitives not in the manifest dictionary (wired in background.js, fail-open). |
| C2 | Click-path coverage | 9 | Drag/keyboard occlusion variants untested. |
| C3 | Symptom routing | 9 | Table covers known symptoms only; must be maintained as patterns grow. |
| C4 | Ground-truth discipline | 10 | Run-evidence format mandated: skills/references/run-evidence-template.md (evidence per claim, failures link to patterns, untested mandatory). |
| C5 | Time-budget hygiene | 9 | Budget numbers (30s default) may drift with engine changes. |
| C6 | Honest surfacing | 9 | — |
| C7 | Batch stamina | 9 | Queue is session-scoped v1; cross-reload guidance deferred. |
| C8 | Expression pitfalls | 8 | JSONata has more traps than the two documented; grow as found. |

**Total: 73/80 → 91/100**, target 90 — met. The two residuals that were
"code, not prose" shipped as spec-030 (strict workflow validation, 23 validator
tests, 119 suite green, 19 live workflows / 11 maps validated with zero
regressions) and the run-evidence template. Remaining points are incremental
hardening, not missing coverage.

## Production Pipeline Follow-Up

For durable site maps, use the offline production pipeline before claiming
demo/shared/public readiness:

```bash
node tools/actions-json-pipeline/bin/actions-json.js audit <map-or-site-folder>
node tools/actions-json-pipeline/bin/actions-json.js score <map-or-site-folder>
node tools/actions-json-pipeline/bin/actions-json.js package <map-or-site-folder>
node tools/actions-json-pipeline/bin/actions-json.js promotion-prep <map-or-site-folder>
```

The pipeline converts several score criteria into repeatable artifacts:

- broad selector, weak postcondition, and missing declared-file findings;
- accepted-gap visibility with stale-ledger detection;
- hybrid readiness scores that stay incomplete until semantic evidence is
  supplied;
- site-local proof packages;
- review bundles that surface redaction and attribution status before any
  shared or public promotion.
