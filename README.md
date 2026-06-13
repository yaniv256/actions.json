# actions.json

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/yaniv256/actions.json?include_prereleases&sort=semver)](https://github.com/yaniv256/actions.json/releases)
[![npm: @actions-json/bridge](https://img.shields.io/npm/v/@actions-json/bridge?label=%40actions-json%2Fbridge)](https://www.npmjs.com/package/@actions-json/bridge)

**A readable action map for websites — so AI agents operate a site through
declared actions instead of scraping and guessing.**

For **site owners** who want their site to work well with agents, and for
**developers** whose coding agents (Claude Code, Codex) need to drive a browser
reliably. `actions.json` lets an agent discover what a site can do, call
declared actions, and reuse website knowledge instead of rediscovering the same
DOM every run.

It's **OpenAPI for website actions**: OpenAPI describes what a server can do;
`actions.json` describes what a website can do.

<p align="center">
  <a href="https://yaniv256.github.io/actions.json/decks/schema-v1-proposal-deck.html">
    <img src="docs/assets/schema-v1-teaching-deck-preview.gif" alt="Animated preview of the actions.json schema v1 teaching deck" width="960">
  </a>
</p>

## Quickstart

Register the bridge with your coding agent.

**[Claude Code](https://claude.ai/code):**

```bash
claude mcp add actions-json -- npx -y @actions-json/bridge mcp
```

**[Codex](https://openai.com/codex):**

```bash
codex mcp add actions-json -- npx -y @actions-json/bridge mcp
```

That's the whole setup. On first run, `npx` downloads the prebuilt bridge for
your platform (linux-x64, macos-x64, macos-arm64, win-x64), bundles the
browser-control tool catalog, and creates your storage at
`~/.actions-json/storage` (scopes: `private` / `public` / `shared`) — nothing to
configure. Override storage with `--storage-root <dir>` if you want it
elsewhere.

Then install the Chrome extension:

1. Download `actions-json-overlay-runtime-*.zip` from the
   [latest release](https://github.com/yaniv256/actions.json/releases) and unzip
   it.
2. Open `chrome://extensions` and turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the unzipped folder.

Connect it to the bridge and take control of a tab. Ask your agent to explore a
site and write an `actions.json` for it — the agent loads the map and your
OpenAI key into the browser for you.

Full walkthrough, plus the standalone-extension path: **[Getting
Started](https://yaniv256.github.io/actions.json/getting-started.html)**.

## What You Can Do Now

This repository contains the current public reference implementation for:

- writing `actions.json` maps with an agent authoring skill;
- running a Chrome extension that can host a GPT Realtime browser agent with
  your own OpenAI API key;
- loading `actions.json.storage` so the hosted agent can use site-specific
  context and actions;
- exposing actions to external coding agents through a Model Context Protocol
  (MCP) bridge;
- testing the page-JavaScript/embed path through the bookmarklet runtime;
- rendering in-page overlays, launchers, screenshots, and structured reports.

The project is pre-1.0. The schema, primitive dictionary, bridge protocol, and
runtime split are still active design surfaces. Current docs distinguish
implemented behavior from future direction.

## Choose Your Path

### I Want An Agent On The Current Website

Install the Chrome extension, authorize a tab, open the `actions.json` menu, add
your OpenAI API key, and start the hosted agent from the Agent tab.

The extension-hosted agent can:

- speak and listen through `gpt-realtime-2`;
- use screenshots after tab authorization;
- use uploaded storage to discover and run current-site actions;
- use direct primitives such as `browser.screenshot`, `locator.element_info`,
  `viewport.scroll`, and `pointer.click`;
- keep transcript and session diagnostics in extension storage;
- keep the live voice session in an extension-owned offscreen document so page
  overlay reinjection does not intentionally restart the session.

Read [Hosted Agent](https://yaniv256.github.io/actions.json/hosted-agent.html) and
[Chrome Extension](https://yaniv256.github.io/actions.json/chrome-extension.html).

### I Want My Coding Agent To Operate A Website

Use the authoring skill and the MCP bridge. The coding agent explores a
site, writes or improves `actions.json`, syncs storage, asks `actions.site` what
actions are available, and then calls stored actions instead of rediscovering
the page. From the user's point of view, you ask the coding agent to inspect the
site, write the map, test it, and save the reusable actions.

Read [Getting Started](https://yaniv256.github.io/actions.json/getting-started.html),
[Bridge Architecture](https://yaniv256.github.io/actions.json/bridge-architecture.html), and the authoring skill at
[skills/SKILL.md](skills/SKILL.md).

### I Want To Make My Website Agent-Ready

Write an official `actions.json` for your site. Use it to describe important
workflows, page context, product or documentation knowledge, navigation targets,
and safe actions. A first-party action map gives agents the official context for
how your website should be understood and operated.

Read [actions.json Format](https://yaniv256.github.io/actions.json/actions-json-format.html),
[Schema V1 Reference](https://yaniv256.github.io/actions.json/schema-v1-proposal.html), and
[actions.json.storage](https://yaniv256.github.io/actions.json/actions-json-storage.html).

### I Want To Test The Embed Path

Use the bookmarklet/runtime shell to test what can be done from page
JavaScript. This approximates a future first-party website embed, but it is less
capable than the extension because host pages can block local transport, affect
overlay styling, and require user consent for screenshots.

Read [Getting Started](https://yaniv256.github.io/actions.json/getting-started.html) and
[Runtime README](runtime/actions-json-runtime/README.md).

## Runtime And Bridge Model

`actions.json` is the map. A browser runtime interprets the map. An agent
adapter translates model or MCP tool calls into runtime actions.

Current runtime hosts:

- **Chrome extension**: preferred authoring and hosted-agent runtime. It has tab
  authorization, screenshots, storage upload/download, overlay UI, debugger
  fallback for authoring, and durable hosted voice sessions.
- **Bookmarklet/runtime shell**: lightweight page-JavaScript runtime for
  bookmarklet and future embed-path testing.
- **MCP bridge**: an MCP server (stdio: `initialize`, `tools/list`,
  `tools/call`, `resources/list`, `resources/read`) that a coding agent
  registers and that routes calls to connected browser runtimes over a
  WebSocket. Run it with `npx @actions-json/bridge mcp`.

The hosted extension agent does not require the local bridge for its local tool
catalog or uploaded storage-backed `actions.site` actions. External coding
agents still use the bridge.

## Install Or Try It

For normal use you don't build anything. The bridge runs via
`npx @actions-json/bridge` (see [Quickstart](#quickstart)); the Chrome extension
installs from [Releases](https://github.com/yaniv256/actions.json/releases).
Start with [Getting Started](https://yaniv256.github.io/actions.json/getting-started.html).

### Building from source

For runtime development:

```bash
npm install
npm run test:runtime
npm run test:overlay-runtime
node scripts/validate-skills.mjs
```

To run the bridge from a source checkout instead of `npx`, use the `mcp`
subcommand (the MCP server a coding agent connects to):

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- mcp \
  --bind 0.0.0.0:17345 \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root .storage
```

## Repository Map

```text
docs/                         Public documentation and schema references
skills/SKILL.md               Canonical installable authoring skill
skills/references/            Skill reference docs (the published docs/ mirror these)
runtime/actions-json-runtime/ Shared runtime and bookmarklet code
extensions/chrome-overlay-runtime/
                              Chrome extension runtime and hosted-agent UI
mcp/actions-json-mcp/         MCP bridge for external agents
examples/                     Public examples
adapters/                     Packaging glue for agent ecosystems
specs/                        Spec Kit feature work and task records
scripts/                      Packaging and validation scripts
tests/                        Repository-level tests
```

Internal planning and private PR notes do not belong in public docs. Public docs
should describe user-facing behavior, stable architecture, or clearly marked
implementation-pending design.

## Documentation

Start here:

- [Documentation Index](https://yaniv256.github.io/actions.json/)
- [Getting Started](https://yaniv256.github.io/actions.json/getting-started.html)
- [Hosted Agent](https://yaniv256.github.io/actions.json/hosted-agent.html)
- [Chrome Extension](https://yaniv256.github.io/actions.json/chrome-extension.html)
- [Troubleshooting](https://yaniv256.github.io/actions.json/troubleshooting.html)
- [Releases](https://github.com/yaniv256/actions.json/releases)

Reference:

- [actions.json Format](https://yaniv256.github.io/actions.json/actions-json-format.html)
- [Schema V1 Reference](https://yaniv256.github.io/actions.json/schema-v1-proposal.html)
- [Bridge Architecture](https://yaniv256.github.io/actions.json/bridge-architecture.html)
- [Actions Bridge Protocol](https://yaniv256.github.io/actions.json/actions-bridge-protocol.html)
- [Primitive Dictionary Architecture](https://yaniv256.github.io/actions.json/primitive-dictionary-architecture.html)
- [Hosted Agent Tools](https://yaniv256.github.io/actions.json/hosted-agent-tools.html)
- [actions.json.storage](https://yaniv256.github.io/actions.json/actions-json-storage.html)
- [Storage Visibility Scopes](https://yaniv256.github.io/actions.json/storage-visibility-scopes.html)
- [Repository Structure](https://yaniv256.github.io/actions.json/repo-structure.html)

## Status And Boundaries

The Chrome extension requires user authorization for browser tabs. The hosted
agent uses the OpenAI API key you store in Chrome extension storage. The
debugger fallback is for authoring and repair, not normal product actions. Site
policies, browser permissions, CSP, and microphone settings can limit what a
runtime can do.

## License

MIT
