# Incident-Investigation Skill as a Flat, Frame-Neutral Submodule — Design

**Date:** 2026-07-05
**Author:** Tempest (Zara Chen)
**Status:** Approved (Yaniv, voice, 2026-07-05) — ready for implementation plan
**Repos touched:** `yaniv256/incident-investigation` (source), `ActionsJson/actions.json.dev`, `yaniv256/heycode` (Elena's)

## Goal

Make the `incident-investigation` skill trivially includable as a git submodule
in any agent framework (Claude Code, Codex, or any harness that loads Markdown
skills), by flattening its standalone repo so the repo root **is** the skill.
Then convert the vendored copies in `actions.json.dev` and `heycode` to
submodules of that single source of truth.

## Motivation

The skill now lives in a standalone public repo (`yaniv256/incident-investigation`),
which is the single source of truth. But two facts collide:

1. **Every framework discovers a skill at a FLAT path:**
   `<skills-dir>/incident-investigation/SKILL.md` — SKILL.md and its
   `references/` + `examples/` sit directly at the skill-name directory.
   (Confirmed: `.claude/skills/incident-investigation/`, `.codex/skills/…` all
   have `SKILL.md examples references` at that level.)
2. **The standalone repo nests the skill one level deeper:**
   `repo/skills/incident-investigation/SKILL.md`, with `README.md` + `LICENSE`
   at the repo root.

Git submodules mount a **whole repo** at a path — they cannot mount a
subdirectory. So submoduling the repo at `<skills-dir>/incident-investigation`
would bury SKILL.md at `.../incident-investigation/skills/incident-investigation/
SKILL.md` — undiscoverable. The alternatives (submodule the whole repo to a
neutral path + symlink the inner subdir into each host's skills dir) push a
per-consumer symlink/config into every repo, forever.

**Decision (Yaniv):** flatten — pay the tidiness cost once in the skill repo so
every consumer is a dead-simple, zero-setup submodule. "One repo = one skill =
one clean mount."

## Design

### Part A — Flatten the standalone repo (`yaniv256/incident-investigation`)

Restructure so the repo root is the skill:

Before:
```
LICENSE
README.md
skills/
  incident-investigation/
    SKILL.md
    references/
    examples/
```
After:
```
SKILL.md
references/
examples/
README.md
LICENSE
```

- `git mv skills/incident-investigation/* .` (SKILL.md, references/, examples/) up
  to the root; remove the empty `skills/` directory.
- README.md + LICENSE stay at the root — harmless; skill loaders read `SKILL.md`
  and ignore the rest.
- **Relative-path check (mandatory):** SKILL.md and its references refer to
  sibling files as `references/…` and `examples/…`. After flattening, those
  relative references have the SAME depth (SKILL.md and references/ are still
  siblings), so they still resolve. VERIFY there are no `skills/`-prefixed or
  absolute paths anywhere in SKILL.md / references that assumed the old nesting;
  fix any that exist.
- Done as a PR on `yaniv256/incident-investigation` (public repo → Yaniv merges).
  The flattened commit SHA is what the submodules pin to.

### Part B — Submodule into `actions.json.dev`

> **Superseded 2026-07-06 (uniform-skills-layout):** the submodule now lives at
> `skills/incident-investigation`, not `agent-skills/incident-investigation`.
> The uniform-layout decision put every skill under `skills/<name>/` (inline
> skills inline, standalone skills as submodules at the same path), so the
> `agent-skills/` directory recommended below no longer exists. The rationale
> below is preserved as the original design record.

- `.claude/` is gitignored in dev (runtime-only, untracked), so the submodule
  needs a TRACKED path. Top-level `skills/` is already the write-actions-json
  skill. Recommended tracked path: **`agent-skills/incident-investigation`**
  (a new top-level dir clearly holding externally-sourced agent skills; avoids
  the Claude-Code-specific "plugins" word and doesn't collide with `skills/`).
  With flattening, SKILL.md lands at `agent-skills/incident-investigation/SKILL.md`
  — flat and discoverable.
- `git submodule add https://github.com/yaniv256/incident-investigation.git
  agent-skills/incident-investigation`, pinned to the flattened commit.
- PR on a branch in `actions.json.dev` (dev repo; self-merge per policy).

### Part C — Submodule into `heycode` (Elena's repo)

- Path is unambiguous: replace the vendored folder in place.
  `git rm -r open-source/plugins/b3/skills/incident-investigation`, then
  `git submodule add … open-source/plugins/b3/skills/incident-investigation`
  pinned to the flattened commit. SKILL.md lands exactly where it was.
- Side effect (intended): heycode auto-upgrades from its OLD v0.3.0 vendored
  content to the newer standalone content (Phase 0, maximum-pain, Original Shame).
- PR on a branch → **reach out to Elena to review and merge** (heycode is
  Elena's repo; PR-on-branch, do not self-merge).

## Deploy / Runtime Note (out of scope for the change, but must be recorded)

The runtime skill at `~/.claude/skills/incident-investigation` (and `.codex/…`)
is a PLAIN COPY — not a symlink, no local sync script. Converting the SOURCE
repos to submodules does NOT auto-update the deployed skill. The deploy/install
step (plugin install) must be pointed at the submodule content in a follow-up so
the running skill tracks the source. Flagged here; not implemented in this change.

## Order of Operations

1. **Part A first** (flatten + merge the standalone PR) — the submodules must pin
   to the flattened commit, so it has to exist first.
2. **Part B** (actions.json.dev submodule) — dev, self-merge.
3. **Part C** (heycode submodule) — PR + Elena review.

## Testing / Verification

- After Part A: clone the flattened repo fresh, confirm `SKILL.md` is at the root
  and every `references/…` / `examples/…` link in SKILL.md resolves (no broken
  relative paths). Screenshot/spot-check not needed — this is file-tree + grep.
- After Part B/C: in each consumer, `git submodule update --init`, confirm
  `<mount>/SKILL.md` exists and is the flattened content (grep for "Original
  Shame" to confirm it's the new version).
- Confirm `.gitmodules` in each consumer points at the standalone repo URL at the
  flattened SHA.

## Out of Scope

- Repointing the runtime deploy/install to the submodule (follow-up, noted above).
- Any further skill-content edits (the Original Shame / screenshot additions
  already merged into the standalone main).
- The other submodule tasks (#60 storage superproject, #61 storage.public in dev)
  — unrelated.
