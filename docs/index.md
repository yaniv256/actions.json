---
title: Home
nav_order: 1
---

# actions.json Documentation

`actions.json` is a readable action map for websites. It lets agents operate a
site through declared actions instead of scraping, guessing, or rediscovering
the DOM.

Use this page to choose what to read next.

## Start By Task

| I want to... | Read |
|---|---|
| Try the browser-hosted agent | [Getting Started](getting-started.md), then [Hosted Agent](hosted-agent.md) |
| Understand the Chrome extension runtime | [Chrome Extension](chrome-extension.md) |
| See what tools the hosted agent can call | [Hosted Agent Tools](hosted-agent-tools.md) |
| Author or review an action map, workflow, or state projection | [actions.json Format](actions-json-format.md), then [Schema V1 Reference](schema-v1-proposal.md) |
| Use local storage for site maps and context | [actions.json.storage](actions-json-storage.md) |
| Reuse overlay templates without sharing private data | [Overlay Templates And Data](overlay-template-data.md) |
| Connect an external coding agent | [Bridge Architecture](bridge-architecture.md), then [Actions Bridge Protocol](actions-bridge-protocol.md) |
| Debug a broken setup | [Troubleshooting](troubleshooting.md) |
| Contribute to the repo structure | [Repository Structure](repo-structure.md) |

## Try The Hosted Browser Agent

- [Getting Started](getting-started.md): choose an install path, authorize a
  tab, add an OpenAI key, upload storage, and verify that tools are available.
- [Hosted Agent](hosted-agent.md): user guide for the extension-hosted
  `gpt-realtime-2` voice/text agent.
- [Chrome Extension](chrome-extension.md): the popup-settings UI (all settings
  live in the extension popup) and the runtime capabilities behind the hosted
  agent: overlays, storage tools, screenshots, bridge connection, and debugger
  fallback.
- [Hosted Agent Tools](hosted-agent-tools.md): how `actions.site`, direct
  primitives, screenshots, and storage-backed context reach the hosted agent.

## Author Action Maps

- [actions.json Format](actions-json-format.md): practical guide to what
  belongs in an action map.
- [Schema V1 Reference](schema-v1-proposal.md): field-level reference,
  including the implemented `workflow` (steps, loops, retries, strict
  validation) and `state_projections` schemas.
- [Primitive Dictionary Architecture](primitive-dictionary-architecture.md):
  portable and privileged primitive definitions across browser hosts.
- [Authoring Skill](../skills/SKILL.md): operational instructions for agents
  that explore sites and write action maps.

## Use Storage

- [actions.json.storage](actions-json-storage.md): file workspace for site
  maps, observations, item indexes, overlays, reports, and hosted-agent context.
- [Storage Visibility Scopes](storage-visibility-scopes.md): private, shared,
  and public promotion rules.
- [Overlay Templates And Data](overlay-template-data.md): reusable overlay
  templates, private JSON data, standalone downloads, and private-scope uploads.

## Use The Bridge Or Runtime

- [Bridge Architecture](bridge-architecture.md): how external agents, the
  hosted extension agent, browser runtimes, storage, and `actions.site` fit
  together.
- [Actions Bridge Protocol](actions-bridge-protocol.md): item shapes for
  runtime readiness, action calls, results, status, events, and errors.
- [Runtime README](../runtime/actions-json-runtime/README.md): bookmarklet and
  injectable runtime notes.
- [Extension Package README](../extensions/chrome-overlay-runtime/README.md):
  contributor/operator notes for the Chrome MV3 extension package.
- [MCP Bridge README](../mcp/actions-json-mcp/README.md): bridge command and
  endpoint reference.

## Troubleshooting And Release Notes

- [Troubleshooting](troubleshooting.md): symptom-based guide for extension,
  hosted-agent, storage, bridge, bookmarklet, screenshot, and tool-call issues,
  including policy exception reports, strict workflow validation errors, state
  projection payload limits, payload spill envelopes, and task-queue results.
- [0.1.74 Release Notes](release-notes/0.1.74.md): public release summary for
  the hosted agent, storage-backed tools, and durable session work.
- [0.1.78 Release Notes](release-notes/0.1.78.md): trusted overlay
  download/upload controls and visual overlay guidance.
- [0.1.79 Release Notes](release-notes/0.1.79.md): background-owned bridge
  WebSocket transport for HTTPS pages using insecure `ws:` bridge URLs.
- [0.1.80 Release Notes](release-notes/0.1.80.md): corrected background bridge
  handshake reporting for unreachable or failing WebSocket connections.
- [0.1.81 Release Notes](release-notes/0.1.81.md): sandboxed report overlay
  rendering so agent-authored full-document HTML and CSS display as intended.
- [0.1.82 Release Notes](release-notes/0.1.82.md): template/data overlay
  assets so reusable public templates can render private data bundles.
- [0.1.84 Release Notes](release-notes/0.1.84.md): consolidated public release
  summary for hosted-agent, bridge, storage, overlays, and claimed-tab work.
- [0.1.85 Release Notes](release-notes/0.1.85.md): extension-local transfer
  primitives development prerelease.
- [0.1.102 Release Notes](release-notes/0.1.102.md): actions.json-first
  operation with compound workflow actions and mandatory
  `policy_exception_report` fields on direct fallback tools.
- [0.1.103 Release Notes](release-notes/0.1.103.md): corrected policy-report
  contract across the hosted Realtime and MCP bridge surfaces.
- [0.1.117 Release Notes](release-notes/0.1.117.md): workflow settle_after and
  strict validation, overlay menu control, the session task queue, the
  popup-settings UI restructure, anti-masking error routing, and observable
  storage hydration.

## UI Implementation Reference

- [Hosted Agent Chat UI](hosted-agent-chat-ui.md): focused reference for
  transcript delta handling and status separation in the extension UI.
