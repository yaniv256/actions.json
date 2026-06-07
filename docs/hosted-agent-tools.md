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
- `browser.run_javascript`: run declared page-context JavaScript where allowed;
- `debug.run_javascript`: authoring-only privileged fallback through the Chrome
  debugger.

Agents should prefer stored actions. Primitives are for exploration, repair, or
cases where no reviewed site action exists.

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
