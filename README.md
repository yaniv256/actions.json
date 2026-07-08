# actions.json

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/yaniv256/actions.json?include_prereleases&sort=semver)](https://github.com/yaniv256/actions.json/releases)
[![npm: @actions-json/bridge](https://img.shields.io/npm/v/@actions-json/bridge?label=%40actions-json%2Fbridge)](https://www.npmjs.com/package/@actions-json/bridge)

**Talk to any website. `actions.json` gives you a voice agent that runs on any
site — it hears you, sees the page, navigates, and acts on your behalf.**

Install the Chrome extension, bring your own OpenAI API key, and press **Start**:
a `gpt-realtime` voice agent takes control of the tab and you *speak* to the
site — "file this expense," "reply to the last message," "book the 3pm slot." No
per-site integration required; it works on sites as they already are. A site can
go further by publishing an `actions.json` map, which turns that generic voice
agent into a fluent expert on that specific site.

Under the hood, `actions.json` is **a readable action map for websites** — so an
agent operates a site through declared actions instead of scraping and guessing.
It's **OpenAPI for website actions**: OpenAPI describes what a server can do;
`actions.json` describes what a website can do. The voice agent is the product;
the map is what makes it reliable.

Three ways in: a **voice agent** for anyone on the current site; a **coding-agent
bridge** (Claude Code, Codex) that drives the browser through an MCP server; and
a **first-party map** a site owner publishes so every agent understands their
site.

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

On first run, `npx` downloads the prebuilt bridge for your platform (linux-x64,
macos-x64, macos-arm64, win-x64), bundles the browser-control tool catalog, and
creates your storage at `~/.actions-json/storage` — nothing to configure.

The bridge drives a browser through the Chrome extension, so install that next:

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

This repository contains the current public reference implementation.

### A voice agent on any website — the headline

Install the Chrome extension, add your OpenAI API key, click **Take control of
this tab**, and press **Start**. A `gpt-realtime` agent joins the page: you speak
to it, it speaks back, and it operates the site for you — reading the page,
clicking, typing, filling forms, moving between tabs. It runs on any site out of
the box, and gets sharper on any site that ships an `actions.json` map. The live
session lives in an extension-owned offscreen document, so it survives page
overlays and navigation instead of dropping mid-conversation. Everything below —
the accessibility layer, the canvas-editing stack, marker projections — exists to
make *this* agent reliable on real, messy websites.

### An agent that operates by structure, not pixels — the accessibility layer

An agent driving a site is, in effect, a blind screen-reader user: it should
navigate by structure and announcements, not by guessing at pixels. So we
replatformed **ChromeVox** (Chromium's own screen reader) onto the runtime and
expose its output as primitives:

- `a11y.tree` — read the page's accessibility tree (the structure a
  screen-reader user perceives);
- `a11y.query` — find a control by role and accessible name, the way you'd bind
  a target that survives a redesign;
- `a11y.events.read` / `a11y.watch` / `a11y.announcements.*` — subscribe to
  live-region announcements and receive real screen-reader utterances as the
  page changes.

### Editing Google Docs, Sheets, and Slides for real

Canvas apps have no editable DOM, so ordinary synthetic input can't touch them.
A trusted-input + positional-editing stack now drives them the way a person
who has read the document would — by position, never by blind find-and-replace:

- `text.type` (trusted CDP keystrokes) and the `docs.select_and_type` composite,
  which overtypes even a phrase that straddles formatting runs;
- positional caret navigation — `cursor.to_paragraph`, word-wise
  `words_forward`/`words_backward`, `pointer.click` modifiers for range
  selection;
- `keyboard.press_gated` — repeat a key but gate each press on a live
  accessibility read, so a word-walk stops exactly on its target instead of
  overshooting;
- the `clipboard` and selection family for writing into iframe editors and
  moving content across apps.

### Durable positions on any surface — marker projections

A projection can declare **markers**: named, typed promises (this marker's
cursor ends *here*; this one's pointer ends *there*) built from portable
primitives, with no stored coordinates. `marker.query`, `cursor.move_to`, and
`pointer.move_to` resolve them live — re-resolvable positions even on a canvas.

### And the platform underneath

- writing `actions.json` maps with an agent authoring skill;
- running a Chrome extension that hosts a GPT Realtime browser agent with your
  own OpenAI API key;
- **driving several authorized tabs from one agent** — it moves between, opens,
  and closes tabs and routes each action to the right one, so a workflow can
  span Gmail, a calendar, and a CRM board in one session;
- loading `actions.json.storage` for site-specific context and actions, with
  **private-over-public scope precedence** so a private map cleanly overrides a
  public one;
- exposing actions to external coding agents through a Model Context Protocol
  (MCP) bridge;
- supervising the hosted agent event-driven, learning of each response, tool
  call, and stall the moment it happens (`runtime.agent.await_event`);
- tracking the hosted agent's per-response cost live, with optional persistence
  of usage records to your own cloud storage;
- rendering in-page overlays, launchers, screenshots, and structured reports.

A bookmarklet/embed path (running from page JavaScript with no extension) is
planned but **not yet operational**.

The project is pre-1.0. The schema, primitive dictionary, bridge protocol, and
runtime split are still active design surfaces. Current docs distinguish
implemented behavior from future direction.

## Choose Your Path

### I Want An Agent On The Current Website

Install the Chrome extension, add your OpenAI API key in the extension popup,
click **Take control of this tab**, and press **Start** in the Session card. (No
coding agent needed — but you supply your own key and storage.)

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

This is the [Quickstart](#quickstart) path. Your coding agent explores a site,
writes or improves `actions.json`, asks `actions.site` what actions are
available, and calls stored actions instead of rediscovering the page.

Read [Bridge Architecture](https://yaniv256.github.io/actions.json/bridge-architecture.html)
and the authoring skill at [skills/write-actions-json/SKILL.md](skills/write-actions-json/SKILL.md).

### I Want To Make My Website Agent-Ready

Write an official `actions.json` for your site. Use it to describe important
workflows, page context, product or documentation knowledge, navigation targets,
and safe actions. A first-party action map gives agents the official context for
how your website should be understood and operated.

Read [actions.json Format](https://yaniv256.github.io/actions.json/actions-json-format.html),
[Schema V1 Reference](https://yaniv256.github.io/actions.json/schema-v1-proposal.html), and
[actions.json.storage](https://yaniv256.github.io/actions.json/actions-json-storage.html).

### I Want To Test The Embed Path

A bookmarklet/runtime shell for running from page JavaScript (approximating a
future first-party embed) is **planned but not yet operational** — it has fallen
behind the extension and bridge runtimes. Use the Chrome extension for now.

See the [Runtime README](runtime/actions-json-runtime/README.md).

## Runtime And Bridge Model

`actions.json` is the map. A browser runtime interprets the map. An agent
adapter translates model or MCP tool calls into runtime actions.

Current runtime hosts:

- **Chrome extension**: preferred authoring and hosted-agent runtime. It has tab
  authorization, screenshots, storage upload/download, overlay UI, debugger
  fallback for authoring, and durable hosted voice sessions.
- **Bookmarklet/runtime shell**: a lightweight page-JavaScript runtime for the
  future embed path — **not yet operational**.
- **MCP bridge**: an MCP server (stdio: `initialize`, `tools/list`,
  `tools/call`, `resources/list`, `resources/read`) that a coding agent
  registers and that routes calls to connected browser runtimes over a
  WebSocket. Run it with `npx @actions-json/bridge mcp`.

The hosted extension agent does not require the local bridge for its local tool
catalog or uploaded storage-backed `actions.site` actions. External coding
agents still use the bridge.

## Building From Source

For normal use you don't build anything — see the [Quickstart](#quickstart).
Build only when developing the runtime:

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
skills/write-actions-json/SKILL.md               Canonical installable authoring skill
skills/references/            Skill reference docs (the published docs/ mirror these)
runtime/actions-json-runtime/ Shared runtime and bookmarklet code
extensions/chrome-overlay-runtime/
                              Chrome extension runtime and hosted-agent UI
mcp/actions-json-mcp/         MCP bridge for external agents
examples/                     Public examples
adapters/npm-bridge/          @actions-json/bridge — the npx wrapper for the MCP bridge
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
