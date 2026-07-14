---
title: "Codex restart loaded a stale actions.json MCP package"
date: 2026-07-13
category: integration-issues
module: actions-json-dev-cycle
problem_type: integration_issue
component: development_workflow
severity: high
symptoms:
  - "A Codex restart continued launching the old staged actions.json MCP package."
  - "The live bridge launch manifest still reported the previous staged directory after restart."
  - "Updating the Claude launcher configuration had no effect on the active Codex launcher."
root_cause: config_error
resolution_type: workflow_improvement
related_components: [tooling, documentation, testing_framework]
tags: [actions-json, mcp, codex, claude-code, launcher-config, restart, release-workflow, stale-artifact]
---

# Codex restart loaded a stale actions.json MCP package

## Problem

A Codex session restarted with a stale actions.json MCP package because the release workflow treated Claude Code's `~/.claude.json` as the universal launcher configuration. Codex actually launched the bridge from `~/.codex/config.toml`; the two files pointed to different staged packages, so updating only the Claude configuration could not affect the Codex restart.

This was a recurrence. The same split had been diagnosed three days earlier, but that investigation's structural remediation—harness-complete guidance and a pre-restart contract checker—was planned rather than implemented.

## Symptoms

- `actions-json://bridge/launch` still reported the old staged manifest after the requested restart.
- The restart round-trip was wasted and dependent work remained blocked until the Codex launcher entry was corrected and another restart occurred.
- The dev-cycle guidance named `.claude.json` without an equivalent Codex path, even though both configurations coexisted.

## What Didn't Work

- Updating `~/.claude.json` did not change a bridge launched by Codex. File existence does not establish which harness owns the current session.
- Building or staging a new bridge was insufficient by itself. The running bridge still came from the active launcher's configured `command` and loaded its configured `--actions` manifest at process start.
- The existing post-restart contract check detected the stale package, but only after consuming the human restart. Post-restart verification cannot replace a pre-restart launcher check.
- The July 10 investigation recorded the correct systemic remediation but stopped after an immediate local configuration change. A remediation plan is not remediation until its durable changes are implemented, verified, and merged.

## Solution

The immediate recovery repointed both `command` and `--actions` in the Codex launcher entry to the intended staged directory. A second restart then loaded the expected manifest.

The durable remediation in development PR #184 adds a mandatory pre-restart check:

```bash
node scripts/verify-actions-json-launcher-config.mjs \
  --harness codex \
  --stage-dir "$STAGE"
# Use --harness claude for Claude Code.
```

The checker:

- uses the selected harness's configuration surface;
- rejects a harness choice that conflicts with unambiguous current-session signals;
- requires the configured bridge command and `--actions` manifest to match the staged package exactly;
- requires a readable JSON-object manifest; and
- probes the executable with `--help` and requires it to identify itself as the actions.json MCP bridge.

It emits structured JSON and exits nonzero on any failure. The mandatory checker gate now appears in the dev-cycle skill and development-cycle reference; the actions.json authoring skill now includes harness-aware launcher guidance.

## Why This Works

The defect was in delivery configuration rather than bridge implementation. A restart can load the intended package only when the configuration used by that specific harness already points to it. Verifying the selected harness, exact launcher entry, staged paths, manifest structure, and bridge identity moves detection before the human action.

The post-restart bridge checks remain a second line of defense: verify the live manifest, advertised tools, and connected runtime before functional testing. Preflight proves the next launch is configured correctly; live contract checks prove that launch actually occurred.

## Prevention

Before requesting any actions.json MCP restart:

1. Identify the harness that owns the current session.
2. Update both `command` and `--actions` in that harness's launcher entry.
3. Run `scripts/verify-actions-json-launcher-config.mjs` against the exact staged directory.
4. Require `ok: true` before creating a human restart blocker.
5. After restart, verify the live bridge manifest and tool catalog before site testing.

Regression coverage includes valid Codex and Claude configurations, stale paths, wrong-harness selection, malformed and non-object manifests, broken and unrelated executables, and representative multiline TOML.

## Related Issues

- [Current investigation](../../../investigations/actions-json-dev-cycle-codex-config-path-misdirected-restart-2026-07-13.md)
- [Prior recurrence diagnosis](../../../investigations/codex-stale-actions-json-bridge-2026-07-10.md)
- [Historical release-cycle investigation](../../../investigations/clunky-release-test-cycle.md)
- ["I'm blocked" is a hypothesis-space attractor](../workflow-issues/blocked-is-an-attractor-run-the-cheapest-disproof.md)
- [Validate the instrument before trusting the experiment](../best-practices/validate-the-instrument-before-trusting-the-experiment.md)
