---
name: write-actions-json
description: Create and maintain actions.json files for websites. Use when Codex is exploring a website, automating a browser workflow, turning DOM operations into reusable actions, documenting how a website works for agents, or preparing a website action map for MCP/runtime use.
---

# Write actions.json

Follow the portable core skill at `../core/SKILL.md`.

Codex-specific notes:

- Keep frontmatter to `name` and `description`.
- Prefer references over large inline instructions.
- Use repository-local scripts only after inspecting them.
- Validate generated `actions.json` against any schema provided in this repo.
