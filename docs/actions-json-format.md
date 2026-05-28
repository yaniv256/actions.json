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
- action names
- human-readable action descriptions
- input schemas
- output/result shapes
- DOM selectors
- JavaScript handler mappings
- DOM event mappings
- source hints
- readiness/precondition notes
- prompt/context guidance for agents
- provenance and revision metadata

## Non-Goals

`actions.json` should not be a hidden automation binary.

It should remain readable, auditable, and comparable against the live website.

It should not require one specific model provider, one browser automation library, or one agent runtime.
