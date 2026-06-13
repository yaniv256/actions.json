---
title: Hosted Agent Tools
nav_order: 1
parent: Hosted Agent
---

# Hosted Agent Tools

The extension-hosted Realtime agent receives a small stable tool surface.

The goal is not to advertise one global tool for every website. The goal is to
give the hosted agent a stable way to answer the user's question, "What can you
do on this page?" and then run the actions declared for the current site.

## Why Stable Tools Matter

`actions.json` may eventually cover hundreds or thousands of websites. A model
should not receive a separate globally advertised tool for each website action.
That would make the tool catalog noisy, stale, and unrelated to the current tab.

Instead, the hosted agent receives:

- one current-site tool: `actions.site`;
- direct primitives from the extension primitive dictionary;
- storage-backed context and action maps uploaded into extension storage.

## actions.site

`actions.site` is the stable current-site action interface.

When the user asks what the agent can do on the current page, the agent-facing
request is:

```json
{
  "mode": "list"
}
```

When the agent chooses one listed action, the agent-facing request is:

```json
{
  "mode": "call",
  "action": "example.page.summary",
  "arguments": {}
}
```

The action must come from a site map that matches the current page. Unknown or
unmatched actions should fail without executing unrelated site maps.

## Storage-Backed Context Instead Of actions.context

The current v1 hosted-agent surface does not include a separate
`actions.context` tool.

Instead, site context is exposed as callable `actions.site` actions. Good site
maps should include actions such as:

- `*.summary`;
- `*.site_map`;
- `*.navigation_targets`;
- `*.product_guide`;
- `*.resources.list`;
- `*.links.contact`;
- `*.overlay.open`;
- `*.recommendation_policy`;
- exact-link actions for commercial or affiliate links where exact URLs matter.

This keeps context and actions in the same map and lets the site owner or map
author decide which knowledge is official, reviewed, and callable.

## Direct Primitives

When stored actions are missing or insufficient, the hosted agent can use
direct primitives exposed by the extension runtime.

Common direct tools include:

- `browser.screenshot`: capture the visible authorized tab as image input;
- `dom.list_sections`: list visible page sections;
- `browser.extract_elements`: extract structured data from visible element
  sets;
- `locator.element_info`: find element geometry and clickable centers;
- `viewport.scroll`: scroll the viewport or a scoped scroll container;
- `pointer.click`: click a viewport point;
- `browser.claimed_tabs.list`: list tabs the user has authorized for
  `actions.json` control;
- `browser.claimed_tabs.activate`: switch to an already-authorized tab;
- `browser.run_javascript`: run declared page-context JavaScript where allowed;
- `debug.run_javascript`: authoring-only privileged fallback through the Chrome
  debugger.

Agents should prefer stored actions. Primitives are for exploration, repair, or
cases where no reviewed site action exists.

### Policy Exception Reports

A direct generic primitive call from the hosted agent must include a
`policy_exception_report` argument:

```json
{
  "policy_exception_report": {
    "kind": "generic",
    "intended_tool": "pointer.click",
    "actions_json_path": "none",
    "reason": "No stored site action covers this control yet."
  }
}
```

`kind` is `generic` for ordinary primitives or `debugger` for privileged
fallbacks. `intended_tool` names the primitive being called,
`actions_json_path` names the closest stored action considered (or
`none`/`missing`), and `reason` says why the stored surface was not enough.

Calls without a valid report are rejected with
`policy_exception_report_required` before they reach the bridge. The hosted
tool catalog decorates every direct primitive's schema with this required
parameter, so the model sees the requirement. Two paths are exempt:
`actions.site` calls (the stored action *is* the site-specific operation) and
internal primitive steps executed inside a stored workflow. The report is
stripped before the primitive executes and recorded in the session log as
diagnostic evidence — agents should not narrate it to the user.

### Session Task Queue

For multi-item jobs (bulk edits, batch rescheduling, audits) the runtime
provides a session-scoped task queue: `task.add` (one `text` or a `tasks`
array, FIFO), `task.next` (pull and mark in progress), `task.complete` (report
`done` or `failed` with a `result` note), `task.list`, and `task.clear`. Seed
the entire plan first, then loop next → work → complete; a pulled-but-never-
completed task is returned again rather than skipped, and the empty-queue
`task.next` response includes every task's status and result so the final
report is grounded in recorded outcomes. State lives for the tab session.

### Overlay Menu Control

The agent can move its own overlay out of the way: `overlay.menu.collapse`,
`overlay.menu.expand`, `overlay.menu.move` (corner or coordinates),
`overlay.menu.hide`, and `overlay.menu.show`. The overlay is a real on-page
element with a high z-index — a click on a page target it covers lands on the
overlay instead. For click-heavy operations, hide the overlay first, operate,
then show it again (stored site actions can encode this hide-operate-unhide
sequence themselves).

## Claimed Tabs

The extension can manage more than one user-authorized tab. This lets a hosted
agent or external coding agent switch between pages the user has already taken
control of without asking the user to reauthorize every tab.

From the user's point of view:

1. Open each tab you want the extension to operate.
2. Use the extension popup and choose **Take control of this tab** on each one.
3. Ask the agent to switch to the relevant authorized tab when needed.

Agent-facing flow:

1. Call `browser.claimed_tabs.list`.
2. Choose the intended tab from the returned URL/title metadata.
3. Call `browser.claimed_tabs.activate` with that tab id.
4. Refresh current-site actions before operating the newly active page.

## Blocked Primitives And Site Policy

Some sites should not receive page-context JavaScript evaluation. A site map can
declare blocked primitives. The current hosted tool catalog suppresses
`browser.run_javascript` when a matching site map declares page eval blocked.

`debug.run_javascript` is not a portable product primitive. It remains available
as an authoring/debug fallback in the extension host where permission and policy
allow it.

## Tool Results And Logs

Hosted tool calls are recorded in extension-local diagnostics. Users can ask
their coding agent to inspect `runtime.session.log`, or use extension
diagnostics when available, to review:

- tool names;
- arguments;
- compact outputs;
- failures;
- routing decisions;
- screenshot metadata;
- Realtime session lifecycle events.

Logs should not store screenshot image payloads or API keys.

## How Action Maps Should Expose Context

If the agent is expected to answer questions about a page, product, person,
resource, or workflow, the map should expose that knowledge as an action.

Examples:

- a page summary action for a voice guide;
- a navigation target list before clicking;
- a product comparison guide before recommending products;
- exact URL actions when links must be shown exactly as published;
- overlay actions when a visual answer is more useful than speech alone.

See [actions.json Format](actions-json-format.md),
[Primitive Dictionary Architecture](primitive-dictionary-architecture.md), and
[Troubleshooting](troubleshooting.md).
