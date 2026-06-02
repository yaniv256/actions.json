# actions.json

`actions.json` is a readable file that describes how agents can operate a website.

The goal is to turn websites from visual surfaces into agent-operable software.

This project defines two related standards:

1. the `actions.json` schema for describing website actions
2. the Actions Bridge Protocol for carrying those actions between an agent adapter and a browser runtime

The Actions Bridge Protocol is modeled primarily on OpenAI Responses-style item semantics: typed input/output items, explicit tool/action requests, structured action results, stable correlation IDs, and transport-independent delivery.

This repository contains three public components:

- an agent skill for authoring `actions.json`
- an MCP adapter that exposes website actions as coding-agent tools
- an injectable JavaScript runtime that loads `actions.json` in the browser and exposes an item-based bridge API

## Repository Shape

```text
docs/                         Human-facing specs and architecture notes
skills/core/                  Portable SKILL.md for any SKILL.md-compatible agent
skills/codex/                 Codex wrapper and Codex-specific metadata
skills/claude-code/           Claude Code wrapper/plugin-facing skill
skills/openclaw/              OpenClaw wrapper skill
skills/pi/                    Pi-compatible wrapper skill
mcp/actions-json-mcp/         MCP adapter for coding agents
runtime/actions-json-runtime/ Injectable browser runtime and bridge interpreter
examples/                     Small websites and action maps for tests/docs
adapters/                     Runtime/agent-specific packaging glue
```

The core rule is: keep the shared implementation portable first, then add thin wrappers for each agent runtime.

## Draft Schema

The first schema proposal is [docs/schema-v1-proposal.md](docs/schema-v1-proposal.md). It is derived from working `actions.json` manifests for a Kanban board, a chess port, and a slide deck, then revised with target descriptors, state machines, DOM attachments, inspectable execution steps, live checks, imports, signals, and Responses-style bridge bindings.

## Documentation

- [Schema v1 proposal](docs/schema-v1-proposal.md)
- [Schema v1 teaching deck](https://yaniv256.github.io/actions.json/decks/schema-v1-proposal-deck.html)
- [actions.json format](docs/actions-json-format.md)
- [Actions Bridge Protocol](docs/actions-bridge-protocol.md)
- [Bridge architecture](docs/bridge-architecture.md)
- [actions.json.storage proposal](docs/actions-json-storage.md)
- [Storage visibility scopes](docs/storage-visibility-scopes.md)
- [Repository structure](docs/repo-structure.md)

## Architecture

`actions.json` is the map.

The injected runtime is the interpreter. It loads `actions.json`, attaches to the DOM, and exposes the Actions Bridge Protocol.

The MCP adapter is the translator. It exposes actions as coding-agent tools and talks to the runtime over the bridge protocol.

The skill is the authoring guide. It teaches an agent how to explore a website and write `actions.json` as durable operating memory.

## License

MIT
