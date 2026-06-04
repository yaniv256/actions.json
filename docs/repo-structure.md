# Repository Structure

This repository is the public source tree for `actions.json` documentation,
agent skill guidance, browser runtimes, bridge code, and examples.

The layout is designed so different agent ecosystems can consume the same
source without making one platform's packaging format the canonical project
shape.

## Source Layout

```text
actions.json/
  README.md
  LICENSE
  docs/
  skills/
  runtime/
  extensions/
  mcp/
  adapters/
  examples/
  scripts/
  tests/
  specs/
```

Generated directories such as `dist/`, `node_modules/`, `test-results/`, and
`playwright-report/` are not source documentation.

## `docs/`

Public documentation for users, implementers, and contributors.

Start with:

- `docs/index.md`
- `docs/getting-started.md`
- `docs/actions-json-format.md`

Reference docs include:

- schema reference;
- bridge architecture;
- bridge protocol;
- primitive dictionary architecture;
- storage model;
- repository structure.

Internal planning notes and private PR packaging notes do not belong in
`docs/`.

## `skills/`

Canonical installable authoring skill.

```text
skills/
  SKILL.md
  agents/
    openai.yaml
  references/
    getting-started.md
    docs/
```

`skills/SKILL.md` is the primary skill file. It should stay telescoped: short
operational guidance in the skill, longer references linked from
`skills/references/`.

`skills/references/getting-started.md` is a symlink to
`docs/getting-started.md`. The public docs and the skill share one source for
setup guidance.

`skills/references/docs/` exposes public docs as skill references. Agents should
read those references only when the current task needs them.

## `runtime/`

Shared JavaScript runtime code.

```text
runtime/
  actions-json-runtime/
```

The runtime is responsible for shared host behavior such as primitive dispatch,
storage sync, action/result envelopes, and bookmarklet/embed behavior where
implemented.

Host-specific code should stay below adapter boundaries instead of forking the
action model.

## `extensions/`

Browser extension runtime packages.

```text
extensions/
  chrome-overlay-runtime/
```

The Chrome extension is the privileged development host. It supports browser
capabilities that a bookmarklet/embed cannot provide, such as true screenshots
after user authorization and stable tab identity.

## `mcp/`

Agent-side bridge code.

```text
mcp/
  actions-json-mcp/
```

The current bridge is MCP-shaped: it exposes stable tool-list/tool-call style
endpoints and routes calls to connected browser runtimes. It should not be the
interpreter of site-specific `actions.json` maps; the browser runtime
interprets those maps.

## `adapters/`

Packaging and integration adapters for agent ecosystems.

```text
adapters/
  claude-code-plugin/
  codex/
  openclaw/
  pi-package/
```

Adapters should point to or package the canonical skill and runtime artifacts.
Do not maintain hollow platform-specific skills that replace
`skills/SKILL.md`.

If a platform eventually requires a platform-specific `SKILL.md`, generate a
self-contained copy from the canonical skill during packaging.

## `examples/`

Small public examples.

```text
examples/
  simple-form/
```

Examples should be neutral, public-safe, and runnable without private accounts.

## `scripts/`

Repository maintenance and packaging scripts.

Examples:

- extension packaging;
- skill validation;
- release artifact checks.

Scripts should avoid private absolute paths and should work from the repository
root unless documented otherwise.

## `tests/`

Repository-level tests that do not belong inside one package.

Package-specific tests may live beside their package, such as runtime tests
under `runtime/actions-json-runtime/` or extension tests under
`extensions/chrome-overlay-runtime/`.

## `specs/`

Spec Kit feature work and implementation task records.

These documents are useful for contributors working on active implementation,
but they are not the first place a user should learn the product. Public docs
should summarize stable outcomes rather than require readers to reconstruct the
spec history.

## Packaging Rule

The canonical project shape is not a Claude Code plugin, a Codex skill package,
or any other single platform package.

The source tree exposes real artifacts directly:

- public docs;
- canonical skill;
- browser runtime;
- browser extension;
- MCP-shaped bridge;
- examples.

Platform packages are adapters over those artifacts.
