---
title: "Done is a claim: audit investigation remediation before closure"
date: 2026-07-13
category: workflow-issues
module: agent-kanban
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Auditing investigation or incident cards already placed in Done"
  - "An investigation declares implementation, release, deployment, migration, or live-verification phases"
  - "Checked analysis or source changes may be mistaken for complete remediation"
  - "Durable queue state must be reconciled from repository and live-system evidence"
tags: [agent-kanban, investigation-closure, remediation-audit, evidence-gate, false-done, live-verification, blocked-dependencies, workflow]
---

# Done is a claim: audit investigation remediation before closure

## Context

`Done` is not a narrative summary of effort. It certifies the implementation that
exists now. Agent Kanban therefore allows an investigation to enter Done only after
every remediation phase it declared applicable has direct proof. Analysis,
documentation, a checked checklist, an accepted limitation, or a follow-up card
cannot substitute for implementation
([closure contract](../../../skills/agent-kanban/SKILL.md#46-investigation-closure-requires-full-remediation)).

A completed-investigation audit tested that claim against implementation reality.
It compared 36 investigation-like Done cards with canonical artifacts, git branches
and worktrees, dirty state, commits and merged PRs, tests, releases, deployments,
live-verification statements, and the structured Trello projection. Nine cards
failed; 27 retained scope-matched completion evidence
([audit](../../../investigations/completed-investigation-remediation-audit-2026-07-13.md)).
The audit record landed in actions.json.dev PR #171.

## Guidance

Audit Done as a proof obligation:

1. **Derive the claim from the artifact.** Read the remediation plan and closure
   criteria. Enumerate every applicable immediate, structural, systemic,
   documentation, test, release, migration, and live-verification phase.
2. **Demand evidence at the boundary each phase changes.** Code requires committed
   changes; tests require passing results; distribution requires the released or
   deployed artifact; a user-facing phase requires live proof at the affected
   boundary.
3. **Treat contradictory repository state as disproof.** A dedicated dirty
   worktree, modified or untracked remediation files, an uncommitted regression,
   a deferred phase, an accepted limitation, a missing release, or a source-only
   resolution contradicts Done until newer evidence proves closure.
4. **Reclassify the parent instead of weakening Done.** When concrete remaining
   work must finish first, move the investigation to Blocked, name and link the
   active blocker, and write the evidence-specific unblock condition.
5. **Make remediation executable.** Related missing work may share one
   Agent-runnable remediation card when every parent links to it and every
   remediation is separately checkable.
6. **Re-certify after the blocker finishes.** The final blocker entering Done
   returns the parent to Next; it does not silently restore the parent to Done.
   The parent must pass its own remediation proof and CE Compound gates again.

Evidence order matters:

1. canonical investigation artifact and final closure section;
2. current branches, worktrees, dirty state, commits, and merge state;
3. focused tests and packaged or released artifacts required by the plan;
4. deployment and live boundary verification when declared; and
5. independent structured board read after lifecycle mutations.

## Why This Matters

A Done card is durable input to a memory-less agent. A false Done does more than
misreport progress: it removes executable remediation from the control plane, so a
later session inherits unfinished work as historical fact and never schedules it.

Proxy evidence cannot provide clearance. Fully checked analysis can coexist with a
live defect. Source changes can coexist with an unreleased product. `RESOLVED IN
SOURCE` can coexist with an absent deployment. Card position likewise never proves
implementation; implementation reality determines whether the position is truthful.

Scope still controls the proof obligation. Classification, evaluation, quarantine,
or external-environment investigations may close without a code fix when that is
their declared deliverable and its evidence is complete. The rule is not “every
investigation ships code”; it is “Done certifies every deliverable the investigation
declared.”

## When to Apply

- before an investigation, incident, or remediation card enters Done;
- when inheriting a historical Done column from another agent or session;
- when an artifact says `CURRENT`, `OPEN`, `deferred`, `awaiting remediation`, or
  `RESOLVED IN SOURCE`;
- when worktrees, branches, or untracked files suggest work outside merged history;
- when the plan reaches beyond source into packaging, release, deployment,
  migration, or live verification; or
- when a checklist or follow-up card is the strongest available closure evidence.

## Examples

Source-only closure is insufficient when the plan includes release and live proof:

```text
Artifact: RESOLVED IN SOURCE
Repository: fix exists
Release: absent
Live verification: absent
Board: Done -> disproved
```

An honest reconciliation keeps the useful investigation while restoring executable
work:

```text
Parent investigation: Blocked
Direct blocker: Complete the remaining remediation
Unblock condition:
  - implementation committed and merged
  - focused tests pass
  - required release/deployment completes
  - affected boundary is live-verified
Next transition:
  final blocker Done -> parent Next -> re-verify -> CE Compound -> Done
```

## Related

- [The Agent Task-Management Operating System](../best-practices/trello-agent-task-management-operating-system.md)
- [“I'm blocked” is a hypothesis-space attractor](blocked-is-an-attractor-run-the-cheapest-disproof.md)
- [Validate the instrument before trusting the experiment](../best-practices/validate-the-instrument-before-trusting-the-experiment.md)
