---
title: "Derive advertised primitive route contracts from production dispatch, then prove them live"
date: 2026-07-13
problem_type: architecture_pattern
track: knowledge
category: architecture-patterns
module: chrome-overlay-runtime
component: testing_framework
tags: [actions-json, hosted-agent, primitive-catalog, content-dispatch, anti-drift, playwright, mv3, live-smoke]
applies_when: "Adding or auditing a primitive that is advertised to the hosted agent and dispatched by the Chrome extension content runtime."
---

# Derive advertised primitive route contracts from production dispatch, then prove them live

## Context

The hosted-agent catalog is assembled from the packaged extension manifest, while primitive execution ultimately passes through `executeAction` in `extensions/chrome-overlay-runtime/src/content.js`. A catalog entry is usable only when the production dispatcher routes its name to a concrete handler.

An anti-drift test attempted to enforce that relationship, but it maintained a separate set of dynamic route names. That duplicate model became stale and falsely reported three implemented primitives as unroutable:

- `dom.observe.attributes`
- `locator.value`
- `dom.focus`

All three handler functions and all three `message.name` branches already existed. The test, not the runtime, was wrong.

## Failure mode

A hand-maintained test whitelist is another source of truth. It can drift in either direction:

- a real production route is omitted, producing a false failure;
- a name is added to the test set without a production route, producing a false pass.

The first failure wastes remediation effort by turning a test-model defect into an alleged product defect. The second is worse: the hosted agent receives a tool that fails only when invoked.

## Solution

Use two complementary gates.

### 1. Bind every exceptional route name back to production source

The route-contract change retained the small dynamic-route set but made every entry prove that its matching `message.name` branch exists in the real `content.js` dispatcher. Adding a name to the test set alone can no longer satisfy the contract.

The static catalog test now checks the complete relationship:

```text
packaged primitive declaration
        +
production executeAction route
        =
hosted catalog may advertise the primitive
```

This is the fast anti-drift gate. It detects missing declarations and missing route branches without launching a browser.

### 2. Drive the real content action path in an isolated browser

Static source evidence does not prove that Chrome can execute the route. The live smoke harness loads the unpacked extension and drives:

```text
extension-owned page
  -> chrome.tabs.sendMessage
  -> content.js onMessage listener
  -> executeAction
  -> concrete primitive handler
  -> behavioral postcondition
```

The smoke verifies behavior, not just names:

- `dom.observe.attributes` returns requested live attributes and normalized text;
- `locator.value` reads a property-only input value;
- `dom.focus` makes the requested element the document's active element.

Run it with:

```bash
npm run test:hosted-catalog-routes-live
```

## MV3 harness detail: keep privileged calls in an extension page

The first harness version evaluated `chrome.tabs.query` inside the MV3 service worker. Playwright obtained the worker, but the evaluation could disappear when Chrome suspended the worker between protocol turns, leaving the test silent until interrupted.

The stable pattern is:

1. obtain the extension ID from the service worker URL;
2. open an extension-owned page such as `extensions/chrome-overlay-runtime/src/options.html`;
3. run `chrome.tabs.query`, `chrome.scripting.executeScript`, and `chrome.tabs.sendMessage` from that persistent page;
4. bound every external await with a timeout that clears its timer after settlement.

This still exercises the real content dispatcher. It changes only the privileged test controller, replacing an ephemeral MV3 execution context with a persistent extension context.

## Why both gates are necessary

The static gate is fast, exhaustive over the catalog, and suitable for ordinary CI. The live gate proves the browser integration seam and concrete behavior for the routes that triggered the incident. Neither substitutes for the other:

- static-only can pass while browser execution is broken;
- live-only covers only the sampled primitives and is slower;
- a manually maintained whitelist without production-source proof can certify its own mistake.

Treat declarations, dispatch, and behavior as three distinct authorities and connect them with independent evidence.

## When to apply

- Adding a primitive to `primitive_dictionary.primitives[]` for hosted agents.
- Changing `executeAction`, content-script injection, or the content message listener.
- Seeing a catalog test claim that an apparently implemented primitive is unroutable.
- Building a live extension smoke that needs `chrome.tabs` or `chrome.scripting` from Playwright.
- Reviewing any test that duplicates a production registry, allowlist, dispatcher, or route table.

## Evidence

- Investigation: `investigations/hosted-catalog-three-primitives-route-contract-2026-07-12.md`
- Static remediation: PR #175, merge commit `672f4ce74ccfe9e8cb3058b5790d61a5568ae26e`
- Live closure: PR #188, merge commit `47efa735294bfabe97123520d187f573a8ff0c6e`
- Static catalog suite: 8/8 passed on current main
- Isolated-browser route smoke: 4/4 behavioral assertions passed

## Related

- `docs/solutions/architecture-patterns/live-harness-past-the-serializing-tool.md` — choose a live seam that actually reaches the behavior under test.
- `docs/solutions/best-practices/run-a-real-experiment-before-concluding-root-cause.md` — source reading forms a hypothesis; a behavioral experiment establishes the finding.
