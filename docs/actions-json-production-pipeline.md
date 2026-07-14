---
title: Production Pipeline
nav_order: 6
---

# actions.json Production Pipeline

The production pipeline is an offline authoring and review aid for durable
site maps. It audits map mechanics, produces readiness score reports, packages
proof artifacts next to the site map, and creates review bundles before any
shared or public promotion.

The v1 pipeline does not copy files to shared or public storage. Promotion
still requires an operator-reviewed file list and explicit approval.

## Command Surface

Run the pipeline from the repo checkout:

```bash
node tools/actions-json-pipeline/bin/actions-json.js audit <map-or-site-folder>
node tools/actions-json-pipeline/bin/actions-json.js score <map-or-site-folder>
node tools/actions-json-pipeline/bin/actions-json.js package <map-or-site-folder>
node tools/actions-json-pipeline/bin/actions-json.js promotion-prep <map-or-site-folder>
```

`<map-or-site-folder>` can be a direct `actions.json` path or the site folder
that contains it.

## Audit

`audit` performs deterministic checks that are safe to run before live browser
testing:

- broad selectors such as generic `button`, `body`, or unscoped modal
  selectors;
- mutating workflows with missing or constant-true state postconditions;
- missing files declared by `x_actions.files`.

The audit report keeps accepted gaps visible. To accept a finding without
hiding it, add an `accepted-gaps.json` file beside the site map:

```json
{
  "accepted_gaps": [
    {
      "finding_id": "missing-file:SKILL.md",
      "rationale": "The map is draft-only and the skill is not ready yet.",
      "accepted_by": "operator",
      "accepted_at": "2026-06-16"
    }
  ]
}
```

Stale ledger entries are reported when their finding no longer exists.

## Score

`score` combines audit findings with explicit semantic readiness fields. It can
run audit itself or consume a saved audit report:

```bash
node tools/actions-json-pipeline/bin/actions-json.js score sites/example.com \
  --audit /tmp/audit.json \
  --before 73 \
  --after 96
```

Mechanical findings produce a numeric score. Semantic dimensions remain
`incomplete` until an agent or operator supplies evidence for task coverage,
persona guidance, proof quality, and accepted-gap reasonableness. A missing
semantic assessment does not pretend the final readiness score is known.

The production target is 95/100 unless named accepted gaps explain why the map
is being reviewed below that threshold.

## Proof Package

`package` writes a site-local proof directory:

```bash
node tools/actions-json-pipeline/bin/actions-json.js package sites/example.com \
  --name 2026-06-16-demo-run \
  --task-list task-list.json \
  --action-log action-log.json \
  --failures failures-fixes.json \
  --screenshots screenshots.json
```

The package includes:

- the tested map copy;
- score report;
- accepted-gap ledger;
- task list, action log, and failure/fix summary when supplied;
- a screenshot manifest when supplied;
- `manifest.json`, listing every packaged file with purpose and source.

Screenshots are not silently swept in. Each screenshot entry must include:

- \`path\`, \`purpose\`, \`source\`, and a valid \`captured_at\` timestamp;
- \`surface_identity: { kind, value, method }\`, identifying what was captured
  and how that identity was established;
- \`freshness.status\`, either \`unverified\` or \`independently_verified\`;
- \`evidence_policy\`, either \`positive_only\` or \`bidirectional\`.

A timestamp is not freshness evidence. An \`unverified\` screenshot must be
\`positive_only\`: visible pixels may support a positive claim, but missing or
unchanged pixels cannot prove absence, failure, or current state. Bidirectional
use requires \`freshness.status: independently_verified\` plus a separate
\`method\`, \`evidence\` reference, and \`verified_at\` timestamp. The
independent evidence must not be the screenshot's own capture timestamp.

Example:

~~~json
{
  "screenshots": [{
    "path": "screenshots/card-open.png",
    "purpose": "Shows the opened card",
    "source": "browser.screenshot",
    "captured_at": "2026-07-12T10:00:00Z",
    "surface_identity": {
      "kind": "url",
      "value": "https://trello.com/c/example",
      "method": "verified active tab"
    },
    "freshness": { "status": "unverified" },
    "evidence_policy": "positive_only"
  }]
}
~~~

## Promotion Prep

`promotion-prep` creates a review bundle manifest and stops there:

```bash
node tools/actions-json-pipeline/bin/actions-json.js promotion-prep sites/example.com \
  --proof sites/example.com/proof/2026-06-16-demo-run \
  --redaction-status incomplete \
  --attribution-status complete
```

The review bundle lists candidate map files, declared skills/references,
proof-package evidence, redaction status, and attribution status. It does not
write to `scopes/shared` or `scopes/public`. Shared or public promotion remains
a separate operator-approved action.

Use `--draft` only when preparing an incomplete review bundle before proof is
available. Without `--draft`, `promotion-prep` requires `--proof`.

## What The Pipeline Does Not Fix

The pipeline audits and packages site-map artifacts. It does not prove the
browser runtime, bridge binary, or hosted-agent tool catalog are healthy. If a
stored action fails because a primitive is missing, the extension is stale, the
bridge launched with an old manifest, or MCP routing is broken, fix that
runtime/bridge contract first. Do not encode website workarounds for runtime
or bridge failures.
