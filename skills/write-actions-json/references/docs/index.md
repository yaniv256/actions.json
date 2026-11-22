---
title: Home
nav_order: 1
---

# actions.json Documentation

`actions.json` gives you a **voice agent that runs on any website** — install the
Chrome extension, bring your OpenAI key, and talk to the site while the agent
sees the page, navigates, and acts for you. Underneath, `actions.json` is a
**readable action map for websites**: it lets an agent operate a site through
declared actions instead of scraping, guessing, or rediscovering the DOM, and a
site that publishes a map turns the generic voice agent into an expert on that site.

Use this page to choose what to read next.

## Start By Task

| I want to... | Read |
|---|---|
| Try the browser-hosted agent | [Getting Started](getting-started.md), then [Hosted Agent](hosted-agent.md) |
| Understand the Chrome extension runtime | [Chrome Extension](chrome-extension.md) |
| See what tools the hosted agent can call | [Hosted Agent Tools](hosted-agent-tools.md) |
| Author or review an action map, workflow, or state projection | [actions.json Format](actions-json-format.md), then [Schema V1 Reference](schema-v1-proposal.md) |
| Audit, score, package, or prepare a site map for review | [Production Pipeline](actions-json-production-pipeline.md) |
| Use local storage for site maps and context | [actions.json.storage](actions-json-storage.md) |
| Reuse overlay templates without sharing private data | [Overlay Templates And Data](overlay-template-data.md) |
| Connect an external coding agent | [Operate actions.json](../skills/operate-actions-json/SKILL.md), then [Bridge Architecture](bridge-architecture.md) |
| Debug a broken setup | [Troubleshooting](troubleshooting.md) |
| Contribute to the repo structure | [Repository Structure](repo-structure.md) |

## Try The Hosted Browser Agent

- [Getting Started](getting-started.md): choose an install path, authorize a
  tab, add an OpenAI key, upload storage, and verify that tools are available.
- [Hosted Agent](hosted-agent.md): user guide for the extension-hosted
  `gpt-realtime-2.1` voice/text agent.
- [Chrome Extension](chrome-extension.md): the popup-settings UI (all settings
  live in the extension popup) and the runtime capabilities behind the hosted
  agent: overlays, storage tools, screenshots, bridge connection, and debugger
  fallback.
- [Hosted Agent Tools](hosted-agent-tools.md): how `actions.site`, direct
  primitives, screenshots, and storage-backed context reach the hosted agent.
- [Expenditure Tracking](expenditure-tracking.md): live per-response cost
  estimation for the hosted `gpt-realtime-2.1` session, whole-day totals, the
  cache-miss drain signature, and optional cloud persistence of usage records.
- [Awaiting Agent Events](agent-event-await.md): the `runtime.agent.await_event`
  supervision loop — learn of each hosted-agent response, tool call, refusal, or
  stall event-driven instead of polling.

## Author Action Maps

- [actions.json Format](actions-json-format.md): practical guide to what
  belongs in an action map.
- [Schema V1 Reference](schema-v1-proposal.md): field-level reference,
  including the implemented `workflow` (steps, loops, retries, strict
  validation) and `state_projections` schemas.
- [Primitive Dictionary Architecture](primitive-dictionary-architecture.md):
  portable and privileged primitive definitions across browser hosts.
- [Authoring Skill](../skills/write-actions-json/SKILL.md): operational instructions for agents
  that explore sites and write action maps.
- [Production Pipeline](actions-json-production-pipeline.md): offline audit,
  readiness score, proof packaging, and review-bundle preparation for durable
  site maps.

## Use Storage

- [actions.json.storage](actions-json-storage.md): file workspace for site
  maps, observations, item indexes, overlays, reports, and hosted-agent context.
- [Storage Visibility Scopes](storage-visibility-scopes.md): private, shared,
  and public promotion rules.
- [Overlay Templates And Data](overlay-template-data.md): reusable overlay
  templates, private JSON data, standalone downloads, and private-scope uploads.

## Use The Bridge Or Runtime

- [Operate actions.json](../skills/operate-actions-json/SKILL.md): primary CLI
  contract for scripts and coding agents, including profiles, stable targets,
  leases, receipts, logs, and diagnostics.
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

## Troubleshooting

- [Troubleshooting](troubleshooting.md): symptom-based guide for extension,
  hosted-agent, storage, bridge, bookmarklet, screenshot, and tool-call issues,
  including policy exception reports, strict workflow validation errors, state
  projection payload limits, payload spill envelopes, and task-queue results.
## UI Implementation Reference

- [Hosted Agent Chat UI](hosted-agent-chat-ui.md): focused reference for
  transcript delta handling and status separation in the extension UI.
