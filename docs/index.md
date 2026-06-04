# actions.json Documentation

`actions.json` is a readable action map for websites. It lets an agent discover
what a site can do, call declared actions, and reuse learned website knowledge
without rediscovering the page from scratch.

Use this page to choose the right document for the task in front of you.

## Start Here

- [Getting Started](getting-started.md): install a runtime, start the
  MCP-shaped bridge, connect a browser page, and verify that the system is
  reachable.
- [actions.json Format](actions-json-format.md): learn what belongs in an
  `actions.json` file and how site actions are written.

## Authoring And Schema

- [Schema V1 Reference](schema-v1-proposal.md): field-level reference for the
  current draft manifest shape.
- [Schema Teaching Deck](decks/schema-v1-proposal-deck.html): visual walkthrough
  of the schema concepts. This is educational; the schema reference is the
  authoritative document.

## Runtime And Bridge

- [Bridge Architecture](bridge-architecture.md): how the skill, bridge, browser
  runtime, storage, and agent fit together.
- [Actions Bridge Protocol](actions-bridge-protocol.md): message shapes for
  runtime readiness, action calls, action results, events, status, and errors.
- [Primitive Dictionary Architecture](primitive-dictionary-architecture.md):
  how portable and privileged browser primitives are defined across extension,
  bookmarklet/embed, and future mobile hosts.

## Storage

- [actions.json.storage](actions-json-storage.md): recommended file workspace
  for observations, runs, item indexes, overlays, and site action maps.
- [Storage Visibility Scopes](storage-visibility-scopes.md): private, shared,
  and public promotion rules for stored artifacts.

## Repository

- [Repository Structure](repo-structure.md): where the public docs, skill,
  runtime, bridge, and examples live in this repository.
