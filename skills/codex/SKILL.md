---
name: write-actions-json
description: Use when Codex is exploring a website, automating a browser workflow, turning DOM operations into reusable actions, documenting how a website works for agents, or preparing a website action map for MCP/runtime use.
---

# Write actions.json

Follow the portable core skill at `../core/SKILL.md`.

Codex-specific notes:

- Keep frontmatter to `name` and `description`.
- Prefer the core skill by reference; do not fork operational guidance into this wrapper.
- Use repository-local scripts and MCP tools only after inspecting their contracts.
- When the browser runtime is remote, operate through the MCP bridge and tunnel rather than assuming browser and agent are on the same machine.
- Treat debugger tools as authoring aids. Convert discoveries into stored actions and retest through `actions.site`.
- Validate generated `actions.json` against any schema provided in this repo.
