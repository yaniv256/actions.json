---
name: write-actions-json
description: Use when Claude Code is exploring a website, automating a browser workflow, turning DOM operations into reusable actions, documenting how a website works for agents, or preparing a website action map for MCP/runtime use.
---

# Write actions.json

Follow the portable core skill at `../core/SKILL.md`.

Claude Code-specific notes:

- This skill may be bundled in a Claude Code plugin with the MCP adapter.
- Keep the core workflow compatible with non-Claude agents.
- Do not depend on Claude-only dynamic command injection in the portable core.
- When Claude Code has browser tools or MCP access, use them to prove actions, then write the durable `actions.json` map.
- Keep private observations out of public skill packaging unless they have been reviewed and redacted.
