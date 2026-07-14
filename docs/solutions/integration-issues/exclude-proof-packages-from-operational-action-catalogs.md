---
title: Exclude proof packages from operational action catalogs
date: 2026-07-14
category: integration-issues
module: actions.json storage catalogs
problem_type: integration_issue
component: tooling
symptoms:
  - "actions.site fails before listing actions when a proof copy declares a missing relative companion file"
  - "Proof-package actions and projections can duplicate the live site map"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "Rust MCP bridge catalog"
  - "extension-local storage catalog"
  - "proof-package pipeline"
tags:
  - "actions-json-storage"
  - "proof-packages"
  - "catalog-discovery"
  - "evidence-boundary"
---

# Exclude proof packages from operational action catalogs

## Problem

The actions.json pipeline stores immutable validation evidence beneath a live
site folder as `proof/<package>/actions.json`. Both the Rust bridge and the
extension-local catalog used to discover maps recursively, so they classified
that evidence copy as a second executable site map.

For the published Notion map, `actions.site mode=list` failed while resolving a
relative `SKILL.md` declaration from the proof directory:

```text
storage path not found under configured root:
scopes/private/sites/notion.site/page/proof/validated-2026-07-14/SKILL.md
```

## Symptoms

- Catalog listing fails before returning any otherwise valid live actions.
- Relative companion files resolve from an evidence directory instead of the
  live map directory.
- A complete proof copy can silently expose duplicate action and projection
  declarations even when no companion file is missing.

## What Didn't Work

- Copying `SKILL.md` into the proof package only removes the immediate missing
  file error. It leaves two executable maps and ambiguous dispatch.
- Verifying only the live site-root files misses the classification bug because
  both live and proof files are individually valid.
- Rebuilding without checking the running MCP process can make the old failure
  look like a failed code fix. Verify the staged process path after restart.

## Solution

Reserve any exact `proof` path segment below a site directory as evidence-only.
Apply the same rule at every operational catalog boundary:

```rust
if file_type.is_file()
    && path.file_name() == Some(OsStr::new("actions.json"))
    && path_has_sites_component(&path)
    && !path_has_proof_component(&path)
{
    maps.push(path);
}
```

```js
function isOperationalSiteMap(parsed) {
  const parts = String(parsed?.sitePath || "").split("/").filter(Boolean);
  return parts.at(-1) === "actions.json" && !parts.includes("proof");
}
```

Guard both surfaces with regressions:

1. Filesystem discovery returns the live map and ignores a byte-identical proof
   copy.
2. MCP `resources/list` exposes the live declared companion and no `/proof/`
   URI.
3. The extension bundle catalog exposes each live action once when the bundle
   also contains a proof copy.

## Why This Works

Proof packages and operational maps have different ownership contracts even
when they contain byte-identical JSON. The site-root map is executable current
state; the proof copy is immutable evidence about a past validation run.
Classifying by filename alone erases that distinction. Reserving the `proof`
segment restores the boundary before relative files, actions, or projections
are resolved.

The rule belongs in both catalogs because the bridge reads the filesystem while
the extension reads an imported storage bundle. Fixing only one leaves the
other capable of reintroducing duplicate maps.

## Prevention

- Treat evidence, fixtures, archives, and run outputs as non-executable by
  default; catalog inclusion should be explicit about operational ancestry.
- Add a regression at the user-visible discovery surface, not only at a helper
  function. Here that means testing MCP `resources/list` as well as raw map
  discovery.
- When a runtime fix requires restart, verify the actual process command and
  extension version before interpreting a repeated error.
- Validate with a real storage tree containing both live and proof copies.

## Related Issues

- Investigation: `investigations/proof-package-map-shadow-2026-07-14.md`
- Implementation change: exclude proof packages from operational catalogs
- Related delivery lesson:
  `docs/solutions/integration-issues/codex-restart-loaded-stale-actions-json-mcp.md`
