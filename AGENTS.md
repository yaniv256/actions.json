# Agent Guidance

Use this file as the first routing layer for agents working in this repository.
Keep the always-loaded context small, then open the referenced files only when
the task matches their trigger.

## Repository Summary

`actions.json` is the specification and runtime stack for agent-operable
websites. The codebase has three main implementation surfaces:

- `extensions/chrome-overlay-runtime/`: Chrome extension runtime, overlays,
  hosted GPT Realtime agent, storage import/export, screenshots, tab control,
  and privileged authoring/debugging paths.
- `runtime/actions-json-runtime/`: shared page-JavaScript runtime and
  bookmarklet/embed-oriented runtime shell.
- `mcp/actions-json-mcp/`: Rust MCP-shaped bridge that exposes stable HTTP
  tool-list/tool-call endpoints and routes agent calls to connected browser
  runtimes.

Storage-backed site maps and overlays live outside this repo in
`actions.json.storage`. Public-facing documentation lives under `docs/`.
Reusable authoring instructions live in `skills/write-actions-json/SKILL.md`.

Documented solutions to past problems (bugs, patterns, methodology) live under
`docs/solutions/`, organized by category with YAML frontmatter (`module`,
`tags`, `problem_type`) — relevant when implementing or debugging in documented
areas. Shared domain vocabulary lives in `CONCEPTS.md` at the repo root.

## Reference Routing

When new to the repo, unsure where behavior belongs, or changing architecture
across extension, runtime, bridge, storage, hosted-agent, overlay, or
bookmarklet boundaries, start with:

- `docs/index.md`
- `docs/bridge-architecture.md`
- `docs/chrome-extension.md`
- `docs/primitive-dictionary-architecture.md`

When mapping a website, creating or reviewing an `actions.json` file, or
scoring site coverage, read:

- `skills/write-actions-json/SKILL.md`
- `docs/actions-json-format.md`
- `docs/actions-json-storage.md`

When changing public documentation, also read:

- `docs/index.md`

When changing runtime or bridge behavior, prefer focused tests near the changed
surface before broad release packaging.

**MANDATORY — before ANY release (dev pre-release, version bump, package, or
`gh release`), you MUST read `docs/development-cycle.md` first.** Not "when
unsure" — every time. Reading it is the procedural gate, not a reminder you hope
to recall: the release checklist (run the Playwright live test before asking a
human to install; the restart ask must contain the GitHub release URL with
verified assets; verify the fix is in the packaged zip before publishing; add
new runtime files to `scripts/package-extension.sh`) is exactly the discipline
that gets skipped under momentum. Re-read it at the start of the release, act on
its checklist, then proceed. Skipping this re-read is the recurring failure this
gate exists to stop.

- `docs/development-cycle.md`
