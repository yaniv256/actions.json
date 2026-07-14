---
title: "Make whole-worker VM loaders fail at the import boundary"
date: 2026-07-13
problem_type: developer_experience
track: knowledge
category: developer-experience
module: chrome-overlay-runtime
component: test_harness
tags: [actions-json, mv3, service-worker, vm, playwright, import-drift, anti-drift]
applies_when: "A test executes an ES-module service worker as a classic script after replacing its imports with harness dependencies."
---

# Make whole-worker VM loaders fail at the import boundary

## Context

Two actions.json test harnesses execute `background.js` outside its production
MV3 module environment: one through Node `vm.Script`, and one as an inline
classic script in Playwright. Both must remove static imports and provide the
imported bindings as test dependencies.

Each harness originally described the import prelude with a path- and
format-specific regex. As production added modules, the replacements stopped
matching. The resulting parse or evaluation failure happened before background
listeners registered, so many behavior tests failed far from the real fault.

## Durable pattern

Treat source transformation as a tested boundary:

1. Remove every static import declaration, including multiline declarations,
   without assuming a directory, extension, order, or exact imported names.
2. Count removals and fail if the count is zero.
3. scan the transformed body and fail if any static import remains.
4. Derive the imported binding names and refuse injection unless every binding
   is provided explicitly in the harness environment.
5. Keep focused production-module tests for behavior that does not need the
   whole worker; use whole-worker tests only for registration and integration.
6. Run every independent loader in the full gate. Repairing one copy is not
   evidence that another copy is current.

The key assertion is:

```text
production module changes
  -> loader either maps the new dependency
  -> or fails immediately with an import-boundary error
```

It must never become:

```text
production module changes
  -> listener silently never registers
  -> dozens of unrelated tests time out
```

## Current actions.json application

PR #173 repaired the Node VM loader and moved screenshot behavior to the
extracted `background-screenshot-capture.mjs` boundary. The closure audit found
the Playwright loader still stale, then applied the same generic removal guards,
updated its dependency map, and reconciled characterization expectations with
the current runtime contract.

## Verification

- red baseline: Node whole-worker suite 0/11, import syntax error;
- focused Node and screenshot modules: 15/15;
- Playwright overlay characterization: 72/72;
- release-script suite: 29/29.

## Evidence

- `investigations/background-screenshot-vm-import-loader-2026-07-12.md`
- PR #173, merge commit `57194b1703fa16c7b49d36acbd7c026b578b9c71`
