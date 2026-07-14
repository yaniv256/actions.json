---
title: Keep first activation ahead of optional diagnostics
date: 2026-07-13
category: developer-experience
module: getting-started
problem_type: developer_experience
component: documentation
severity: high
applies_when:
  - "A new user is installing the actions.json extension and bridge"
  - "A diagnostic or security check is being added to Getting Started"
  - "An extension surface defines a default bridge address"
tags: [onboarding, activation, bridge, extension, checksums, defaults]
---

# Keep first activation ahead of optional diagnostics

## Context

The actions.json clean-install path accumulated safeguards that were useful for
debugging releases but expensive for a first-time user. Checksum verification
sat before extension installation, version comparison sat before bridge use,
and some extension surfaces still carried an operator-specific cross-machine
bridge default even though the popup and public documentation used localhost.

Each instruction was defensible in isolation. Together, they obscured the goal:
connect the extension and bridge, claim a normal signed-in browser tab, and
complete one verified action as quickly as possible.

## Guidance

### Put one complete success path before diagnostics

Getting Started should present the shortest supported sequence near the top:

1. Download and load the extension ZIP.
2. Register `@actions-json/bridge@latest` with the coding agent.
3. Claim a tab in the user's regular Chrome profile.
4. Start the hosted voice agent when desired.
5. Define success in observable terms.

The reader should encounter this path before checksum commands, version
comparison, troubleshooting, cross-machine networking, or storage details.

### Keep integrity checks available without making them mandatory

Checksum verification is valuable when a download is incomplete, corrupted, or
being inspected under a stricter security policy. It is not required to learn
whether the product works. Label it optional and place it after the normal
extension installation steps.

Be explicit about asset roles: the browser extension is the
`actions-json-overlay-runtime-*.zip`; platform bridge binaries are
`actions-json-mcp-*.tar.gz`. A checksum command for the extension must select the
ZIP and fail clearly when that ZIP is absent.

### Use one public default across every extension entry point

The normal same-machine bridge address is:

```text
ws://127.0.0.1:17345/extension
```

Keep that default aligned in the popup, side panel, background service worker,
and hosted tool executor. Cross-machine addresses are explicit advanced
configuration and must never become packaged defaults.

`scripts/tests/bridge-defaults.test.mjs` enforces this as a repository-wide
contract. Do not test only the visible popup; stale defaults in background or
hosted-agent code can still route a new user away from their local bridge.

### Treat packaged guidance as product code

The public page and the copy vendored into the `write-actions-json` skill are
required to remain byte-identical. Edit both together and retain the contract in
`scripts/tests/getting-started-docs.test.mjs`. Update
`scripts/validate-skills.mjs` whenever a required heading changes meaning; do not
restore an outdated heading merely to satisfy the validator.

## Why This Matters

The first useful action is the moment a visitor learns that actions.json works.
Every mandatory step before it is a chance to abandon the product without ever
experiencing its value. Diagnostics should reduce the time to understand a
failure, not increase the time to reach success when nothing is wrong.

Consistent localhost defaults also separate product behavior from an operator's
development topology. A private network address can work perfectly for the
developer who introduced it and fail for every new user.

## When to Apply

- Before adding any command or verification step to Getting Started.
- Whenever the bridge bind address or extension connection behavior changes.
- Before packaging an extension release or publishing the writing skill.
- After a user reports that an installation command selected the wrong asset.

## Examples

Preferred document order:

```text
Fastest path -> observable success -> detailed paths -> optional verification -> diagnostics
```

Avoid:

```text
Prerequisites -> checksums -> version inventory -> network configuration -> first product action
```

Validation for this pattern includes:

```bash
npm run test:release-scripts
node scripts/validate-skills.mjs
XDG_CONFIG_HOME=/tmp/actions-json-playwright-config npm run test:a11y-live
```

A clean public bridge check should also run with an empty temporary home and npm
cache so an existing staged binary cannot make the test pass.

## Related

- `docs/getting-started.md`
- `skills/write-actions-json/references/getting-started.md`
- `scripts/tests/getting-started-docs.test.mjs`
- `scripts/tests/bridge-defaults.test.mjs`
- `docs/solutions/best-practices/trello-agent-task-management-operating-system.md`
