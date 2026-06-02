# actions.json Format

## Purpose

`actions.json` is a readable website action map.

It describes the actions a website exposes so agents can operate the site through declared affordances instead of rediscovering the DOM on every run.

## Standard Scope

The project defines:

1. the `actions.json` schema
2. the Actions Bridge Protocol used to execute those actions through a browser runtime

## Schema Direction

The schema should describe:

- protocol name and version
- website/surface metadata
- map imports, namespaces, source trust, and override policy
- action names
- human-readable action descriptions
- input schemas
- output/result shapes
- live-DOM target descriptors
- JavaScript handler mappings
- inspectable execution steps
- DOM event mappings
- source hints
- scoped agent context loaded during website traversal
- page/component/runtime states
- state diagnostics and transition edges that identify the tool to call
- DOM attachment points and reattachment policy
- live-site checks, drift severity, and contingency paths
- signal-to-protocol conversion
- prompt/context guidance for agents
- provenance and revision metadata

## Current Draft

The current first-pass schema is in [schema-v1-proposal.md](schema-v1-proposal.md).

That schema is derived from working browser-action prototypes where `actions.json` powered a Kanban board, a chess surface, and an animated slide deck. The portable draft generalizes prototype-specific bridge metadata into `x_actions`.

The ACT-5 revision keeps that catalog layer and adds the runtime geography needed for living websites: target descriptors, scoped agent context, states, transition edges, attachments, checks, imports, signal conversion, and Responses-style protocol bindings.

## Non-Goals

`actions.json` should not be a hidden automation binary.

It should remain readable, auditable, and comparable against the live website.

It should not require one specific model provider, one browser automation library, or one agent runtime.
