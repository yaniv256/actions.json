---
name: write-actions-json
description: Use when Pi is exploring a website, automating a browser workflow, turning DOM operations into reusable actions, documenting how a website works for agents, or preparing a website action map for MCP/runtime use.
---

# Write actions.json

Follow the portable core skill at `../core/SKILL.md`.

Pi-specific notes:

- Pi packages can bundle skills, extensions, prompts, and themes.
- Keep this skill usable both as a standalone skill and as part of a Pi package.
- Pair with a Pi extension or external MCP-compatible adapter when available.
- Surface host capability limits in the package UI when a primitive needs extension, embed, or user-consented behavior.
- Package reviewed public examples, not raw private storage artifacts.
