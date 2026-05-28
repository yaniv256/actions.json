# Repository Structure

## Design Goal

The repo must be easy for multiple coding-agent ecosystems to consume.

Do not make the canonical source layout depend on Claude Code plugins, Codex skill metadata, OpenClaw installs, or Pi package conventions. Those are adapters. The shared repo should expose the three real artifacts directly:

1. authoring skill
2. MCP adapter
3. injected browser runtime

## Canonical Layout

```text
actions.json/
  README.md
  LICENSE
  docs/
    repo-structure.md
    bridge-architecture.md
    actions-json-format.md
  skills/
    core/
      SKILL.md
    codex/
      SKILL.md
      agents/openai.yaml
    claude-code/
      SKILL.md
    openclaw/
      SKILL.md
    pi/
      SKILL.md
  mcp/
    actions-json-mcp/
      README.md
      package.json
      src/
  runtime/
    actions-json-runtime/
      README.md
      package.json
      src/
  adapters/
    claude-code-plugin/
    codex/
    openclaw/
    pi-package/
  examples/
    simple-form/
      index.html
      actions.json
```

## Why Not Make The Whole Repo A Claude Code Plugin?

Claude Code plugins can carry skills, MCP configs, bins, settings, hooks, and arbitrary files. That is useful for a Claude Code adapter, but it is not the right canonical shape for the whole project.

The injected JavaScript runtime is a first-class artifact, not a Claude-only plugin component. It should live at `runtime/actions-json-runtime/` and be referenced by the MCP adapter, browser extension adapter, Claude Code plugin adapter, Pi package adapter, and future hosted/embedded adapters.

## Compatibility Strategy

### Core Skill

`skills/core/SKILL.md` uses the strict portable subset:

- YAML frontmatter with only `name` and `description`
- plain Markdown instructions
- no Claude-only `allowed-tools`
- no Claude-only `context`
- no Claude-only dynamic command injection
- no Codex-only assumptions in the body

### Runtime Wrappers

Wrappers adapt the core skill to each environment:

- `skills/codex/` can add Codex-facing `agents/openai.yaml`
- `skills/claude-code/` can be referenced from a Claude Code plugin
- `skills/openclaw/` can be installed as an OpenClaw skill
- `skills/pi/` can be loaded through Pi's skill/package system

### MCP Adapter

`mcp/actions-json-mcp/` exposes coding-agent tools and talks to the browser runtime. It should not be the interpreter of `actions.json`; it is the agent-side adapter.

### Browser Runtime

`runtime/actions-json-runtime/` loads and validates `actions.json`, attaches to the DOM, and exposes the bridge protocol. It is the interpreter.

The runtime and MCP adapter may be co-located, or connected over WebSocket, a tunnel, a hosted relay, browser extension ports, Playwright/CDP, or another transport.
