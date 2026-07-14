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

An `actions.site` call may carry a `timeout_ms` to bound how long the dispatch
waits before failing — useful for a slow or hanging site action so the call
returns a timeout instead of blocking indefinitely.

When a tool result is larger than the bridge's inline limit, it is spilled to a
file and the response returns a path to it instead of the full payload, so a
large DOM snapshot or session log does not blow the response budget. The inline
limit is adjustable with `bridge.payloads.configure`.

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

Agents should prefer stored actions. Primitives are for exploration, repair, or
cases where no reviewed site action exists. They fall into these groups.

**Observe the page**

- `page.info`: basic information about the current page;
- `dom.list_sections`: list rendered page sections with headings and viewport
  visibility;
- `dom.observe.visible`: observe visible DOM candidates matching a selector or
  text query;
- `dom.snapshot_text`: return a text snapshot of visible page content;
- `browser.extract_elements`: extract structured data from visible element sets;
- `browser.screenshot`: capture the visible authorized tab as image input.

**Resolve and locate**

- `locator.element_info`: resolve a locator to visible element geometry and a
  recommended clickable center;
- `locator.text_content`: resolve a locator and return its visible text;
- `locator.wait_for`: wait for a locator to reach a visible or attached state.

**Act on the page**

- `pointer.move` / `pointer.click` / `pointer.double_click`: move a visible
  pointer and click at viewport coordinates;
- `pointer.drag`: drag from one point or locator to another;
- `viewport.scroll`: scroll the viewport or a scoped scroll container;
- `text.insert`: insert text into the focused editable target or a requested
  editable locator;
- `keyboard.press`: dispatch a key or modifier chord to the focused element.

**Manage tabs and dialogs** (see [Claimed Tabs And Tab Lifecycle](#claimed-tabs-and-tab-lifecycle))

- `browser.navigate`, `browser.open_tab`, `browser.close_tab`;
- `browser.claimed_tabs.list`, `browser.claimed_tabs.activate`;
- `browser.dismiss_dialog`: dismiss a native JS dialog (alert/confirm/prompt/
  beforeunload) that is blocking a claimed tab, recovering a wedged tab.

**Move content between tabs** (see [Transfer Buffer](#transfer-buffer))

- `transfer.write`, `transfer.read`, `transfer.insert`, `transfer.clear`.

**Storage, overlay, and session**

- `storage.read_file`: read a declared text file from the loaded storage bundle;
- `overlay.open`, `overlay.close`, `overlay.register_launcher`, and the
  `overlay.menu.*` controls (see [Overlay Menu Control](#overlay-menu-control));
- `runtime.session.name`, `runtime.session.finalize_tabs`,
  `runtime.session.log`, `runtime.agent.memory_clear`.

**Privileged / authoring**

- `browser.run_javascript`: compatibility name for debugger-backed declared
  JavaScript; authoring-only and non-portable;
- `debug.run_javascript`: explicit authoring-only privileged evaluator through
  the Chrome debugger.

Agents should prefer stored actions. Direct primitives require a
`policy_exception_report` (below).

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

## Claimed Tabs And Tab Lifecycle

The extension can manage more than one user-authorized tab. This lets a hosted
agent or external coding agent switch between and manage pages the user has taken
control of without reauthorizing every tab.

From the user's point of view:

1. Open each tab you want the extension to operate.
2. Use the extension popup and choose **Take control of this tab** on each one.
3. Ask the agent to switch to the relevant authorized tab when needed.

Agent-facing flow for switching between existing tabs:

1. Call `browser.claimed_tabs.list`.
2. Choose the intended tab from the returned URL/title metadata.
3. Call `browser.claimed_tabs.activate` with that tab id.
4. Refresh current-site actions before operating the newly active page.

### Tab-lifecycle primitives

The agent can also move and manage tabs directly, as standalone steps between
actions (these are tab-lifecycle operations, not workflow steps):

- `browser.navigate`: navigate a claimed tab to a URL (or reload it) and
  reconnect its runtime;
- `browser.open_tab`: open a new tab, auto-claim it, and return a ready-to-drive
  runtime;
- `browser.close_tab`: close a claimed tab (defaults to the active tab; refuses
  to close the last remaining claimed tab);
- `browser.dismiss_dialog`: dismiss a native dialog that has wedged a tab.

### Routing when several tabs are connected

When more than one runtime is connected, a tool call chooses its target by
`target_runtime_id` (an exact runtime id) or `target_url_contains` (a URL
substring; it errors if the substring matches more than one tab). If neither is
given, calls route to the designated **active tab**. An external coding agent can
set that default with `browser.active_tab.set`; if the active tab disconnects,
the bridge adopts a remaining connected runtime rather than erroring.

## Transfer Buffer

For moving content between tabs without resending a full payload each time, the
runtime keeps an extension-local transfer buffer:

- `transfer.write`: store text or structured JSON under a label;
- `transfer.read`: read a stored item's metadata or payload by label or id;
- `transfer.insert`: render a stored item and insert it into a target editable
  element (the payload is not re-sent through the model);
- `transfer.clear`: clear one item or all items in the session.

This is the mechanism behind cross-tab authoring flows — capture on one page,
insert on another.

## Blocked Primitives And Site Policy

Some sites should not receive arbitrary JavaScript evaluation. A site map can
declare blocked primitives. The current hosted tool catalog can suppress the
compatibility name `browser.run_javascript` when a matching site map declares
page evaluation blocked.

Both JavaScript names use Chrome Debugger Protocol in the extension and are
debugger-class, non-portable authoring capabilities. `debug.run_javascript`
remains the explicit form where permission and policy allow it.

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
