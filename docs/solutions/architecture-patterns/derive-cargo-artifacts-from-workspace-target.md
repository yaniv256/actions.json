---
title: "Resolve Cargo artifacts from the workspace target directory, not the member manifest path"
date: 2026-07-13
problem_type: architecture_pattern
track: knowledge
category: architecture-patterns
module: bridge packaging and deployment
component: tooling
severity: high
applies_when:
  - "packaging, staging, launching, or testing a Rust binary whose crate belongs to a Cargo workspace"
  - "a command passes a member Cargo.toml and later constructs the output binary path"
  - "both workspace-level and crate-local target directories exist on a developer machine"
tags: [cargo, rust, workspace, target-directory, packaging, release-integrity, stale-binary, anti-drift]
---

# Resolve Cargo artifacts from the workspace target directory, not the member manifest path

## Context

The actions.json Rust bridge is a member of the Cargo workspace rooted at `mcp/Cargo.toml`. Building with the member manifest does not make the member directory own the artifacts:

```bash
cargo build --release --manifest-path mcp/actions-json-mcp/Cargo.toml
```

Unless a command explicitly overrides `--target-dir` or `CARGO_TARGET_DIR`, Cargo still writes the binary under the workspace target directory, `mcp/target`.

Several packaging, staging, install, deploy, and smoke paths instead looked under a crate-local target directory beneath the member crate (a historical path removed by this fix). That directory happened to exist on development machines, so consumers could select an old binary instead of failing at the missing path.

## Failure mode

The dangerous assumption is:

```text
manifest path = crate directory
therefore artifact path = crate directory / target
```

Cargo's actual ownership rule is workspace-scoped. A member manifest selects the package to build; it does not relocate the target directory.

This produces an asymmetric failure:

- on a clean machine, the wrong path is absent and packaging fails loudly;
- on a long-lived development machine, the wrong path may contain an older executable and packaging succeeds dishonestly.

The second direction is more dangerous because the archive, checksum, and install step can all be internally consistent while carrying the wrong build.

## Solution

### Establish one artifact authority

For repository scripts, declare the workspace target directory once and construct every host or cross-target artifact beneath it:

```bash
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge_dir="$repo_root/mcp/actions-json-mcp"
workspace_target_dir="$repo_root/mcp/target"

cargo build --release --locked --manifest-path "$bridge_dir/Cargo.toml"
target_dir="$workspace_target_dir/release"
```

For a cross target, the binary lives at `$workspace_target_dir/$target/release`. If a build deliberately supplies `--target-dir`, the later package step must consume that exact same value rather than reconstructing another path.

For diagnostics and tests, ask Cargo directly:

```bash
cargo metadata \
  --manifest-path mcp/actions-json-mcp/Cargo.toml \
  --format-version 1 \
  --no-deps \
  | jq -r '.target_directory'
```

### Update every consumer, not only the packager

Artifact-path drift crossed several surfaces:

- bridge packaging;
- development staging instructions;
- authoring launch guidance;
- unsupported-platform npm instructions;
- eval registration and lifecycle smokes;
- deployment fallback paths.

Fixing only the script that first surfaced the bug leaves other workflows able to launch or recommend a stale binary. The regression test therefore names every active consumer and rejects the crate-local path in each.

### Verify content identity, not merely archive existence

A successful archive command proves only that some file was packaged. The release-integrity check builds an optimized binary, packages it, extracts it, and compares both hashes:

```bash
workspace_sha=$(sha256sum mcp/target/release/actions-json-mcp | awk '{print $1}')
packaged_sha=$(sha256sum "$extract/actions-json-mcp" | awk '{print $1}')
test "$workspace_sha" = "$packaged_sha"
```

Run `sha256sum -c` from the directory containing both `SHA256SUMS.txt` and the archive. A checksum invocation from another working directory is an invocation error, not evidence that packaging failed.

## Cross-repository closure

The development source and public source are separate remediation boundaries. Development changes fixed and tested the source, and the corresponding public change applied the same active-consumer fixes and regression gate to the user-facing repository.

Do not close a cross-repository investigation when only the private source is corrected. Verify the public default branch independently.

## Release applicability

The public v0.1.204 binary release was unaffected by this secondary packager defect. Its canonical `scripts/release-binaries.sh` already builds each platform with an explicit workspace target directory. Therefore the correct remediation was a public source PR, not replacement binaries.

This distinction must be proven from the release builder actually used. “The packaging script is wrong” does not imply “every published package is wrong” when multiple build paths exist.

## Prevention checklist

- Treat Cargo metadata or an explicit `--target-dir` as the artifact-path authority.
- Thread the chosen target directory from build into package; do not infer it again.
- Search all active staging, install, deploy, and test consumers when the authority changes.
- Keep historical investigation references marked as historical rather than rewriting evidence.
- Make the regression fail on crate-local target paths in active consumers.
- Compare the packaged executable hash to the freshly built workspace executable hash.
- Verify private and public repositories independently when both distribute the workflow.

## Evidence

- Canonical investigation: `investigations/remaining-cargo-workspace-artifact-paths-2026-07-12.md`
- Private remediation: PR #174, merge commit `c8284e64328299f0cd199554dfb0e25bc6e94c6a`
- Public remediation: [public PR #37](https://github.com/yaniv256/actions.json/pull/37)
- Current-main optimized package and workspace binary SHA-256: `9492c86a64ada06ac1712daae7ac1dd6eca9980b155bfaacda1900758bc38150`
- Public PR #37 checks: `validate`, `build-pages`, and `verify-windows-release-instructions` passed

## Related

- `docs/development-cycle.md` — authoritative staging and release workflow.
- `docs/solutions/best-practices/run-a-real-experiment-before-concluding-root-cause.md` — distinguish a plausible path story from a build-and-compare experiment.
