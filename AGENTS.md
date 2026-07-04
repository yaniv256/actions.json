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
Reusable authoring instructions live in `skills/SKILL.md`.

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

- `skills/SKILL.md`
- `docs/actions-json-format.md`
- `docs/actions-json-storage.md`

When changing public documentation, also read:

- `docs/index.md`

When changing runtime or bridge behavior, prefer focused tests near the changed
surface before broad release packaging.
