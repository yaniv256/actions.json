# Release archive verification instructions mismatch

Status: REMEDIATION IN PROGRESS — code and tests complete; publication and live verification pending

## Phase 0 — tools

- LinkedIn screenshots and message thread were inspected through the connected browser.
- GitHub release metadata was read with `gh release view`.
- The public repository was fetched and isolated in a clean worktree from `origin/main`.
- The onboarding contract suite passed 3/3 before changes.

## Phase 1 — timeline and symptom

- 2026-07-12 14:28: Atun ran the documented PowerShell command in a Windows 11 Downloads directory. No extension ZIP matched; `$archive` became null, followed by empty-pattern and null-path errors.
- 2026-07-12 14:32: Atun ran the macOS command. The ZIP glob matched nothing, the checksum pipeline reported no valid checksum line, and a guessed `.tar.gz` extension also matched nothing.
- The screenshots show a release-asset identity failure followed by opaque secondary errors, not a checksum mismatch.

## Phase 2 — initial hypotheses

| Hypothesis | Category | Initial P |
|---|---|---:|
| H1: the release stopped publishing the extension ZIP | packaging | 20% |
| H2: the guide incorrectly names every release archive as ZIP | documentation | 20% |
| H3: the release page mixes extension and bridge assets without enough role guidance, and commands lack missing-input guards | UX / failure handling | 45% |
| H?: unlisted cause | unknown | 15% |

Maximum-pain correction tested H3 first because it implicates our onboarding design and failure-path testing rather than the user's download choice.

## Phase 3 — evidence

- E1: latest release `extension-v0.1.204` contains `actions-json-overlay-runtime-0.1.204.zip`, four platform `actions-json-mcp-*.tar.gz` bridge archives, a Windows helper tarball, and `SHA256SUMS.txt`.
- E2: the guide says to download the extension ZIP but does not explicitly explain why adjacent tarballs are different products.
- E3: Linux/macOS use `ls` command substitution without a zero-match guard. PowerShell dereferences `$archive.Name` before checking `$archive`.
- E4: the screenshots exactly match those zero-input failure paths.
- E5: web and GitHub source checks found no evidence that `.tar.gz` should replace the extension ZIP.

## Phase 4 — revised hypotheses

H3 rises to 96%. H1 and H2 are refuted by the real release inventory. No experiment is required to distinguish archive formats, but command-level reproduction is required.

## Phase 5 — experiments

- X1 predicted the original Unix command would fail opaquely in a directory containing only bridge assets. Observed: no ZIP match and a downstream checksum-format error, matching Atun's screenshot.
- X2 predicted explicit precondition guards would stop before checksum work. Observed: the corrected command exits with `No actions-json-overlay-runtime-*.zip found` and identifies the bridge tarball as the wrong asset.
- X3 predicted the corrected commands would verify the real extension ZIP. Observed: release `0.1.204` passed both `sha256sum -c` and `shasum -a 256 -c`.
- X4 is automated on `windows-latest`: it extracts the PowerShell block from the published guide, verifies the latest real ZIP, deletes it, and requires the actionable missing-ZIP error.

## Phase 6 — final conclusion

Root cause confidence: 98%. The onboarding interface exposed several similarly named release artifacts but relied on users to infer their roles. Its verification snippets treated the required ZIP as guaranteed and converted a missing input into misleading checksum/null errors.

## Phase 7 — blame

### Level 1 — lines

- `docs/getting-started.md`: release download step omitted an explicit extension-versus-bridge distinction.
- The Linux/macOS snippets used unguarded match substitution.
- The PowerShell snippet dereferenced a possibly null archive and an absent checksum row.
- The byte-identical skill reference repeated the same behavior.

### Level 2 — anti-pattern

Happy-path documentation treated discovery as validation: it used the result of an asset lookup without first proving exactly the required input existed.

### Level 3 — practice

Documentation tests checked presence and parity, but did not execute platform commands against real release assets or exercise the no-match path.

## Phase 8 — immediate fix

- Explain that the Chrome extension is `actions-json-overlay-runtime-*.zip` and `actions-json-mcp-*.tar.gz` files are bridge binaries.
- Add missing-ZIP and missing-checksum-entry guards on all platforms.
- Use literal checksum entry matching in PowerShell.
- Keep the Pages guide and packaged skill reference byte-identical.

## Phase 9 — anti-pattern search

Repository-wide text search found the unsafe onboarding commands only in the two synchronized Getting Started copies. Release scripts generate the real ZIP and checksum entries; developer-only examples refer to explicit artifacts and do not reproduce this user-facing lookup failure.

## Phase 10 — remediation and closure evidence

- [x] Immediate documentation correction
- [x] Static regression contract for asset roles and zero-match guards
- [x] Real latest-release verification with Linux and macOS checksum tools
- [x] Windows CI that executes the published PowerShell block against real assets and its missing-ZIP path
- [ ] Merge the public PR
- [ ] Verify the GitHub Pages route contains the corrected guidance
- [ ] Run CE Compound and record the outcome

This investigation must remain open until the final three items are complete.
