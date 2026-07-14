---
title: "Release assets need product roles and zero-match guards"
date: 2026-07-13
category: documentation-gaps
module: docs/getting-started.md
problem_type: documentation_gap
component: documentation
severity: high
applies_when:
  - "A release publishes several similarly named artifacts for different products or platforms"
  - "Installation instructions discover an artifact with a glob before verifying its checksum"
tags:
  - release-assets
  - onboarding
  - checksums
  - powershell
  - documentation-testing
---

# Release assets need product roles and zero-match guards

## Context

The actions.json release page publishes two different products next to each other:

- `actions-json-overlay-runtime-<version>.zip` is the Chrome extension.
- `actions-json-mcp-*.tar.gz` files are platform-specific MCP bridge binaries.

The Getting Started guide told users to download the ZIP, but it did not explain why the
adjacent tarballs were different. Its checksum snippets also assumed the ZIP was already
present. When an early user downloaded only a bridge tarball, the PowerShell and Unix
commands continued with an empty match and produced null-path and checksum errors. Those
secondary failures concealed the actual problem: the required extension artifact was absent.

## Guidance

Treat release artifacts as typed products, not as interchangeable archives.

1. Name the artifact and its role together. Do not rely on file extensions or repository
   context to communicate which product a user needs.
2. Validate discovery before validation. A checksum command may run only after the script has
   proved that a matching required artifact and checksum entry exist.
3. Make the failure message corrective. It should name the expected file and distinguish the
   commonly confused alternative.
4. Execute published snippets in CI. Static tests can preserve wording, but only execution
   catches shell expansion, null dereferences, and platform-specific behavior.

For example, PowerShell must stop before reading `.Name` when no extension ZIP is present:

```powershell
$archive = Get-ChildItem actions-json-overlay-runtime-*.zip | Select-Object -First 1
if (-not $archive) {
  throw "No actions-json-overlay-runtime-*.zip found. Download the Chrome extension ZIP, not an actions-json-mcp-*.tar.gz bridge archive."
}
```

Unix instructions need the same precondition rather than passing an empty glob result into
checksum processing.

## Why This Matters

Installation documentation is executable product surface. If discovery is implicit, users
must reverse-engineer release packaging before they can install the product. If a missing
input becomes a checksum error, the guide sends them toward integrity or platform debugging
when the real issue is simply artifact selection.

Clear roles remove that inference. Zero-match guards preserve the first useful failure, and
real-platform CI keeps the documentation honest as release packaging changes.

## When to Apply

- A GitHub release contains a client, server, bridge, helper, or platform binary in one asset list.
- A setup command uses `ls`, `Get-ChildItem`, a glob, or command substitution to find an artifact.
- Documentation supports several shells or operating systems.
- A user reports null values, empty checksum rows, or "file not found" errors after following a published command.

## Examples

The repaired actions.json onboarding flow now:

- explicitly distinguishes the extension ZIP from bridge tarballs;
- stops with an actionable message when the ZIP or checksum entry is missing;
- was manually verified against release `0.1.204` on Linux and macOS; and
- runs the published PowerShell block, including its missing-ZIP path, on Windows CI.

The original customer report, hypotheses, command reproductions, and closure evidence are in
[Release archive verification instructions mismatch](../../../investigations/release-archive-verification-instructions-mismatch-2026-07-12.md).

## Related

- [Getting Started](../../getting-started.md)
- [Public fix PR #35](https://github.com/yaniv256/actions.json/pull/35)
