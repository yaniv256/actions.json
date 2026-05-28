---
name: write-actions-json
description: Create and maintain actions.json files for websites. Use when OpenClaw is exploring a website, automating a browser workflow, turning DOM operations into reusable actions, documenting how a website works for agents, or preparing a website action map for MCP/runtime use.
---

# Write actions.json

Follow the portable core skill at `../core/SKILL.md`.

OpenClaw-specific notes:

- Keep this installable as a standalone Git skill.
- Do not assume Claude Code plugin paths or Codex UI metadata.
- Pair with the MCP adapter or an OpenClaw plugin wrapper when available.
