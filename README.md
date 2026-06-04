# actions.json

`actions.json` is a readable action map for websites.

It lets an agent ask a browser surface what can be done, call declared actions,
and reuse learned website knowledge instead of rediscovering the same page from
scratch.

The project is currently an experimental runtime, bridge, storage model, and
authoring skill for building those maps.

<p align="center">
  <a href="https://yaniv256.github.io/actions.json/decks/schema-v1-proposal-deck.html">
    <img src="docs/assets/schema-v1-teaching-deck-preview.gif" alt="Animated preview of the actions.json schema v1 teaching deck" width="960">
  </a>
</p>

## What This Repository Contains

- **Public docs** for the draft schema, bridge protocol, primitive dictionary,
  storage model, and runtime architecture.
- **A canonical authoring skill** at `skills/SKILL.md` that teaches agents how
  to explore a website, use debugger tools only for learning, and turn those
  discoveries into reusable `actions.json` actions.
- **A Chrome extension runtime** for privileged browser authoring. It can take
  true screenshots after tab authorization, keep authorized tabs grouped, render
  overlays, and execute the currently exposed primitive/tool surface.
- **A bookmarklet/runtime shell** for testing what can be done from page
  JavaScript. It is useful as an embed-path approximation, but it is constrained
  by page CSP and cannot autonomously capture true screenshots.
- **An MCP-shaped bridge** in Rust. It exposes stable HTTP tool-list/tool-call
  endpoints and routes calls to connected browser runtimes. It is not yet a
  fully conforming MCP server.

## Current Shape

The core loop is:

1. Start the bridge.
2. Connect a browser runtime, usually the Chrome extension for authoring.
3. Load or sync `actions.json.storage` when site memory exists.
4. Ask the stable site-action tool which actions are available.
5. Use stored actions first.
6. Use debugger or primitive tools only when the action map is missing or
   broken.
7. Write the learned operation back into `actions.json`.
8. Retest through the stored action.

The current bridge exposes routes such as:

- `GET /health`
- `GET /runtimes`
- `GET /mcp/tools/list`
- `POST /mcp/tools/call`
- `POST /mcp/tools/reload`
- `POST /mcp/tools/resolve`
- `GET /extension` for the browser runtime WebSocket

The current `/runtimes` response reports runtime ids, runtime keys,
authorization ids, extension version, timestamps, and URL. Normalized host,
title, and top-level capability summaries are implementation pending.

## Runtime Choices

Use the **Chrome extension** when possible. It is the preferred development
environment because it can provide privileged browser capabilities after user
authorization:

- true rendered screenshots;
- stable tab/session identity;
- controlled-tab grouping;
- extension-assisted relay for bookmarklet pages blocked by CSP;
- debugger-only authoring fallback tools.

Use the **bookmarklet** when you need a lightweight install or want to test the
page-JavaScript/embed path. It can run portable primitives and local overlay
logic, but it is intentionally less capable:

- page CSP may block direct bridge transport;
- overlays can be affected by the host page;
- true screenshots require browser/user consent and cannot be taken
  autonomously.

The two hosts should share the same action model and primitive dictionary where
their capabilities allow it.

## Install Or Try It

For normal use, install released artifacts rather than building from source.
A release should provide one or more of:

- a bookmarklet `install.html`;
- a bookmarklet `.url` or text file containing a `javascript:` URL;
- a Chrome extension ZIP or unpacked extension directory;
- bridge binary or source checkout instructions.

For source-based development, start the bridge with:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root ../actions.json.storage
```

Then verify:

```bash
curl -s http://127.0.0.1:17345/runtimes
curl -s http://127.0.0.1:17345/mcp/tools/list
```

See [Getting Started](docs/getting-started.md) for the complete install and
connection flow.

## Development

Install JavaScript dependencies:

```bash
npm install
```

Build the bookmarklet from source:

```bash
npm run build:storage-bookmarklet
```

Run runtime tests:

```bash
npm run test:runtime
```

Run Chrome overlay runtime tests:

```bash
npm run test:overlay-runtime
```

Validate skill packaging:

```bash
node scripts/validate-skills.mjs
```

## Repository Map

```text
docs/                         Public documentation and schema references
skills/SKILL.md               Canonical installable authoring skill
skills/references/            Skill reference docs, symlinked to public docs
runtime/actions-json-runtime/ Shared runtime and bookmarklet code
extensions/chrome-overlay-runtime/
                              Chrome extension runtime
mcp/actions-json-mcp/         MCP-shaped bridge
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

- [Getting Started](docs/getting-started.md)
- [actions.json Format](docs/actions-json-format.md)
- [Documentation Index](docs/index.md)

Reference:

- [Schema V1 Reference](docs/schema-v1-proposal.md)
- [Schema Teaching Deck](docs/decks/schema-v1-proposal-deck.html)
- [Bridge Architecture](docs/bridge-architecture.md)
- [Actions Bridge Protocol](docs/actions-bridge-protocol.md)
- [Primitive Dictionary Architecture](docs/primitive-dictionary-architecture.md)
- [actions.json.storage](docs/actions-json-storage.md)
- [Storage Visibility Scopes](docs/storage-visibility-scopes.md)
- [Repository Structure](docs/repo-structure.md)

## Status

This repository is pre-1.0. The schema, bridge protocol, primitive dictionary,
and runtime split are active design surfaces. Documents should distinguish
current implementation from implementation-pending architecture.

## License

MIT
