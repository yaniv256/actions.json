---
title: "Live-test the real bundled module past a tool that serializes the code under test"
date: 2026-07-06
problem_type: architecture_pattern
track: knowledge
category: architecture-patterns
module: chrome-overlay-runtime
component: hosted-realtime-session-manager
tags: [testing, playwright, live-harness, extension, concurrency, realtime, verification]
applies_when: "Verifying browser/integration behavior whose concurrency or timing the available live tool serializes or mocks away — especially the hosted Realtime session manager's send serialization."
---

# Live-test the real bundled module past a tool that serializes the code under test

## Context

The hosted-agent send-serialization fix (ext 0.1.175) makes `HostedRealtimeSessionManager.createResponse()` serialize `response.create` against the OpenAI Realtime **single-flight** protocol: only one response may generate at a time, and a second `response.create` while one is active is rejected ("Conversation already has an active response in progress"). `queue` mode waits for the active response's `response.done`; `interrupt` mode sends `response.cancel` then the new send; a cancelled response's tool result is discarded.

Eleven unit tests covered this. But the *live* verification kept coming back green-for-the-wrong-reason. Driving the manager through the MCP `runtime.agent.user_message` tool, both `queue` and `interrupt` returned `ok:true` with no error — yet the session log showed the long response's `response.done (status: completed)` firing **before** the interrupt event even arrived. The concurrency branches were never entered.

## Guidance

**When the live tool you drive a feature through serializes or awaits upstream of the code under test, that tool can never exercise the code — test at the seam below it.**

`runtime.agent.user_message` awaits each response to completion before returning, so a second `createResponse` is only invoked *after* the first's `response.done`. `isBusy()` is therefore always `false` at send time and the queue-wait / interrupt-cancel branches (`realtime-session-manager.mjs`, `createResponse()`) never run. Two "concurrent" tool calls are serialized by the tool, not by the code you want to prove.

The fix is a Playwright live harness (`tests/live/send-serialization-smoke.mjs`, wired as `npm run test:send-serialization-live`) built on two reusable techniques plus a discipline:

**1. Import the REAL bundled module — don't re-implement it.** `manifest.json`'s `web_accessible_resources` exposes `src/agent/*.mjs`, so a page loaded at `chrome-extension://<id>/…` can dynamically import the shipped artifact:

```js
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;        // extension id from the SW URL
await page.goto(`chrome-extension://${extId}/sidepanel.html`);  // an extension-origin page
const mod = await page.evaluate(async (id) =>
  import(`chrome-extension://${id}/src/agent/realtime-session-manager.mjs`), extId);
// -> drives the SHIPPED module, not a copy that can drift from it.
```

**2. Inject a controllable fake transport to force genuine overlap.** The transport records outbound events and does NOT auto-complete a response; the test opens and closes the in-flight window itself by feeding lifecycle events through `handleRealtimeEvent`:

```js
const sent = [];
const transport = { sendEvent(e){ sent.push(e); return Promise.resolve(); }, close(){ return Promise.resolve(); } };
const mgr = new HostedRealtimeSessionManager({ storage, transportFactory: { create: () => transport } });
mgr.transport = transport; mgr.state.status = 'connected';

mgr.handleRealtimeEvent({ type: 'response.created', response: { id: 'respA' } }); // A now active
const b = mgr.createResponse({ mode: 'queue', response: { instructions: 'B' } }); // B fired while A active
// assert B did NOT emit response.create yet, then:
mgr.handleRealtimeEvent({ type: 'response.done', response: { id: 'respA', status: 'completed' } });
await b; // B unblocks -> proves serialization
```

For interrupt, assert the outbound order is `["response.cancel", "response.create"]` and the replacement create waited for idle. For discard, assert `_shouldDiscardToolResult({ originResponseId: <cancelledId> })` is `true` and `false` for a live id.

**3. Negative-control every green live harness.** A test that can't go red proves nothing. Before claiming the pass, temporarily neuter the fix — e.g. replace the queue-wait `await this._awaitResponseIdle()` with `await Promise.resolve()` — re-run, and confirm the harness FAILs. Then restore and confirm it passes.

## Why This Matters

"Verify by contract" (the dev-cycle gate) confirms the bridge *advertises* a tool, and unit tests confirm the logic in isolation — but when the mocks (or the driving tool) *are* the exact seam the fix lives at, both stay green while the live path is unproven. This is the same class of failure that caused six release round-trips on the a11y feature (ext 0.1.162→0.1.167), where every bug lived at an integration/browser seam the unit tests mocked: unit-green ≠ works-live when the mock is the boundary. The general rule from that incident — *build a self-driven live smoke before the next human round-trip, so each install validates the final build, not the Nth guess* — is what this harness pattern operationalizes for the concurrency case. Loading the real bundled module under Playwright and reaching past the serializing tool is what closes the gap without spending a human install/restart or an expensive hosted-agent session per guess.

**Honest boundary:** a fake transport proves *our* state machine end-to-end in the shipped module. It does NOT prove OpenAI's server honors `response.cancel` — that is their documented single-flight API contract, verified by web research, not by this harness.

## When to Apply

- Verifying concurrency, ordering, cancel/interrupt, or timing in the hosted Realtime session manager or any extension module where the available live tool awaits/serializes each step.
- Any time a live probe returns green but you cannot point to the specific code path it exercised — suspect that the driving tool mocked the seam, and drop to the module seam below it.
- Adding a new `tests/live/*-smoke.mjs`: import the web-accessible bundled module, control timing with a fake dependency, and add a negative control before trusting the green.

## Examples

Existing sibling harnesses that follow the same load-the-unpacked-extension shape: `tests/live/a11y-live-smoke.mjs`, `tests/live/trusted-text-type-smoke.mjs`. The send-serialization harness is the first to also (a) import a web-accessible `src/agent/*.mjs` module directly and (b) inject a controllable fake dependency to manufacture the timing the real transport wouldn't expose on demand.
