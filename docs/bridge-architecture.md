---
title: Bridge Architecture
nav_order: 7
has_children: true
---

# Bridge Architecture

The bridge lets an agent talk to a browser runtime that understands
`actions.json`.

The important split is:

- `actions.json` is the readable action map for a website.
- The browser runtime is the interpreter that can load that map and operate the
  page.
- The bridge is the optional adapter that lets an external coding agent discover
  connected runtimes and call their tools.

The extension-hosted Realtime agent does not need the local bridge for normal
use. It runs inside the Chrome extension and talks to the same runtime/storage
interfaces directly.

## Runtime Paths

```text
External coding agent
  -> MCP-shaped bridge
  -> browser runtime
  -> authorized page and uploaded storage

Extension-hosted Realtime agent
  -> Chrome extension background/offscreen session
  -> browser runtime
  -> authorized page and uploaded storage
```

Both paths should converge on the same action model: a small generic tool
surface, current-site action discovery through `actions.site`, and primitive
execution through the runtime.

## Components

### Browser Runtime

A browser runtime is the thing that can operate the page. Current runtimes are:

- **Chrome extension runtime**: preferred for authoring and user testing because
  it has tab identity, screenshots, extension storage, debugger-backed fallback
  tools, and a durable hosted voice session.
- **Bookmarklet/embed runtime**: useful for testing what a first-party page
  embed can do from page JavaScript. It is constrained by Content Security
  Policy, mixed-content rules, and screenshot limits.

Future runtimes should keep the same action/result semantics and advertise
clear capability errors when a host cannot support a primitive.

### MCP-Shaped Bridge

The bridge exposes HTTP endpoints shaped like MCP tool listing and tool calling.
Use it when an external coding agent needs to operate a browser runtime.

The bridge can:

- list connected runtimes;
- expose the stable generic tool catalog;
- route a tool call to one selected runtime;
- import or sync `actions.json.storage`;
- return structured tool results and errors;
- expose session diagnostics such as `runtime.session.log`.

The bridge should not advertise one global tool per website. A user may have
hundreds of site maps. The stable external surface stays small; the selected
runtime answers what is available for the current site through `actions.site`.

### Extension-Hosted Realtime Agent

The hosted agent is a consumer of the same browser runtime ideas, but it lives
inside the Chrome extension. It can use:

- `actions.site` for uploaded storage-backed site actions;
- direct portable primitives such as screenshots, scrolling, pointer clicks, and
  section extraction;
- extension storage for the OpenAI key, voice settings, runtime settings,
  uploaded storage bundles, and session memory;
- an offscreen document for the live Realtime WebRTC session.

The hosted agent should not depend on the local bridge for its normal tool
catalog. The bridge remains useful for external coding agents and diagnostics.

### Website Page

The page is the live surface being operated. It can change because of navigation,
SPA route changes, account state, experiments, or product updates.

Good actions validate the current page before acting. If an action needs a
specific region, it should either locate that region dynamically or return a
clear failure that explains what was missing.

### actions.json.storage

Storage is the user-owned file workspace for site maps and operating memory.
The extension can upload a local storage checkout into browser storage and can
download changed storage back to a folder selected by the user.

The bridge can also import storage for external-agent workflows. In both cases,
stored site maps become available to the runtime through `actions.site`.

## Stable Tool Pattern

The stable catalog should stay generic:

- `actions.site` lists and calls current-site actions from uploaded storage.
- `browser.screenshot` captures the visible page when the host supports it.
- `viewport.scroll`, `pointer.click`, and related primitives perform visible
  human-like actions.
- `browser.extract_elements`, `dom.list_sections`, and locator tools inspect
  page structure.
- `runtime.session.log` returns transcript, tool-call, and diagnostic events.
- `storage.import_bundle`, `storage.list`, and storage sync tools load operating
  memory into the runtime.

Site-specific actions belong inside storage-backed `actions.json` files. If you
are operating through a coding agent, ask the agent to list current-site actions.
The underlying agent-facing call is:

```json
{
  "name": "actions.site",
  "arguments": {
    "mode": "list"
  }
}
```

When the agent chooses one listed action, the underlying agent-facing call is:

```json
{
  "name": "actions.site",
  "arguments": {
    "mode": "call",
    "action": "sections.list",
    "arguments": {}
  }
}
```

## Runtime Selection

External agents must route each bridge call to exactly one browser runtime.
Good selectors include:

- exact runtime id;
- exact tab identity when available;
- URL predicate that matches one connected runtime.

If a selector matches more than one runtime, the bridge should return an
ambiguous-routing error and send the call nowhere.

## Extension Versus Bookmarklet

Use the Chrome extension when you can. It is more capable and more stable.

Use the bookmarklet when you specifically need to test the portable
page-JavaScript path that resembles a future first-party website embed. Expect
some sites to block local bridge connections or script execution through CSP and
mixed-content policy. On those sites, the extension can sometimes relay
transport for testing, but that means you are no longer testing a pure
JavaScript-only embed path.

## Safety Boundaries

- The user must authorize tabs before the extension runtime operates them.
- The hosted agent uses the user's OpenAI API key stored in Chrome extension
  storage.
- Debugger-backed tools are privileged authoring tools. Convert debugger lessons
  into portable `actions.json` actions before relying on them.
- Both `browser.run_javascript` and `debug.run_javascript` are debugger-class,
  non-portable extension authoring tools. Manifest V3 content-script CSP forbids
  the former's historical `new Function` implementation, so both names now use
  Chrome Debugger Protocol. Convert their discoveries into portable actions.
- Screenshots require host support and browser permission.
- The bridge and runtimes should return structured errors rather than silently
  falling back to unsafe behavior.

## Verify The Bridge Path

1. Run the bridge only if you are using an external coding agent.
2. Open a page and authorize it in the Chrome extension.
3. Confirm the bridge lists one connected runtime for the tab.
4. Upload or sync an `actions.json.storage` checkout.
5. Ask your agent to list actions for the current site.
6. Ask your agent to run one listed action.
7. If something fails, ask your agent to inspect `runtime.session.log` and look
   for tool-call arguments, result, and error fields.

See [Getting Started](getting-started.md), [Hosted Agent Tools](hosted-agent-tools.md),
and [Troubleshooting](troubleshooting.md) for user-facing workflows.
