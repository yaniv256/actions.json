---
module: strategy
tags: [competition, chrome-devtools-mcp, actions-json, positioning, a11y]
problem_type: analysis
date: 2026-07-08
---

# chrome-devtools-mcp vs actions.json — relationship, competition, lessons

**Prompt (task #174):** Google ships `chrome-devtools-mcp` (a first-party MCP that drives Chrome over
CDP/DevTools). How does it relate to actions.json? Competitor, complement, or different layer? What do
we learn?

## What chrome-devtools-mcp actually is (from its tool surface)
A **general-purpose, per-session Chrome driver** over the DevTools Protocol. Its primitives:
- `take_snapshot` — a **text snapshot of the a11y tree**, listing elements each with a transient `uid`.
  Its own docs: *"Prefer taking a snapshot over taking a screenshot."*
- `click`/`fill`/`hover`/`drag`/`type_text` — act on an element **by that snapshot `uid`**.
- `evaluate_script` — run JS in the page.
- `list_network_requests` / `get_network_request` — inspect network.
- `performance_start_trace` / `analyze_insight` — Core Web Vitals / perf tracing.
- `navigate_page`, `new_page`, `take_screenshot`, `handle_dialog`, `emulate`, `lighthouse_audit`.

Mental model: **snapshot → read uids → act on a uid → re-snapshot.** Nothing persists between
sessions; every run re-derives the page from scratch. It's a *debugging/automation console for a human
or agent driving one page right now.*

## The relationship: DIFFERENT LAYERS, mostly complementary
chrome-devtools-mcp is a **driver** (raw capability to touch a page). actions.json is a **durable,
named site-map + projection layer on top of a driver.** The distinction is exactly memory:

| | chrome-devtools-mcp | actions.json |
|---|---|---|
| Unit | ephemeral `uid` from this snapshot | named, reusable **site action** (`trello.card.delete`) |
| Persistence | none — re-derived each session | learned map stored + versioned + shared |
| Question it answers | "what's on this page right now?" | "what can I *do* on this site?" (`actions.site list`) |
| Targeting | transient uid (invalid next snapshot) | stable identity (testid/role/aria) that survives redesigns |
| Verification | agent eyeballs the re-snapshot | workflow **postconditions** assert the specific effect |
| Reuse across agents | zero | the whole point — one agent's learning serves the next |
| Scope | one page, one session | a site's whole capability surface, compounding |

So they are **not direct competitors** — they sit at different heights. chrome-devtools-mcp could even
be *a runtime actions.json drives through* (like our extension/CDP paths). Where they *do* overlap:
both can "drive a page," so a naive user might reach for devtools-mcp to do a one-off Trello move — but
they'd re-derive uids every time, with no durable action, no postcondition, no reuse. That's precisely
the gap actions.json fills.

## Lessons (this is the valuable part)
1. **Google independently converged on our thesis: a11y-tree over screenshots.** Its snapshot is the
   a11y tree, and it says to *prefer it over screenshots*. That is exactly [[accessibility-is-for-blind-agents]]
   / [[blind-by-default-take-screenshots]] — the a11y layer is the right substrate for an agent, and a
   major vendor shipping the same default is strong external validation of our design.
2. **The uid pattern is the anti-pattern we already named, institutionalized.** A `uid` is a transient
   locator that's invalid on the next snapshot — the *opposite* of [[locator-identity-not-geometry]] and
   the ambiguous-anchor lesson. It's fine for a live human-driven console, fatal for a *durable* map.
   actions.json's stable-identity binding is our moat over the raw driver.
3. **Verification is ours to own.** devtools-mcp has no postcondition concept — the agent must look and
   judge. Our workflow postconditions ("assert the SPECIFIC result") + projections are the reliability
   layer a raw driver lacks. Keep leaning into it (see the delete/checklist anti-pattern work).
4. **Complement, don't reinvent:** we should NOT rebuild perf-tracing / network-inspection /
   Lighthouse — devtools-mcp does those well and they're outside actions.json's job (durable *actions*,
   not one-off diagnostics). If we ever need network/perf signal in a workflow, treat devtools-mcp (or
   raw CDP, which we already use) as a *diagnostic capability*, not the semantics of a site action —
   same rule the authoring skill already states for `chrome.debugger`.
5. **Positioning line:** *chrome-devtools-mcp lets an agent operate a page; actions.json lets an agent
   operate a **site** — and remember how, so the next agent doesn't start from a blank snapshot.* Memory
   and reuse are the axis; the raw driver has neither.

## Verdict
Not a competitor to fear — a **complementary driver** whose design choices (a11y-first) validate ours
and whose omissions (transient uids, no durable actions, no postconditions, no cross-agent reuse) are
exactly actions.json's reason to exist. Strategy: cite it as validation of the a11y thesis; keep our
differentiation on **durable named actions + stable-identity targeting + postcondition verification +
cross-agent reuse**; don't rebuild its diagnostics.
