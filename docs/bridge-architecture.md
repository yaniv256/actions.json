# Bridge Architecture

The bridge connects an agent to a browser runtime that understands
`actions.json`.

`actions.json` is the map. The browser runtime is the interpreter. The bridge is
the adapter that lets an agent discover and call actions on connected browser
surfaces.

## Components

```text
agent
  -> MCP-shaped bridge
  -> browser runtime
  -> website page
  -> actions.json.storage
```

### Agent

The agent asks what actions are available, calls actions, reads structured
results, and records useful learning back into storage.

The agent should prefer stored site actions. Debugger or privileged tools are
for authoring and repair, not the normal operating path.

### MCP-Shaped Bridge

The current bridge exposes stable HTTP endpoints shaped like MCP tool listing
and tool calling:

- list connected runtimes;
- list stable generic tools;
- route a tool call to one browser runtime;
- sync storage into a runtime;
- return structured results and errors.

The bridge should not create one globally advertised tool per website. It should
expose a small stable surface, then let the agent ask the selected runtime what
site actions are available for the current page.

Current implementation note: the bridge provides the generic `actions.site`
tool and currently performs some site-map resolution itself. Moving site-map
interpretation fully into the browser runtime is implementation pending.

### Browser Runtime

The browser runtime loads and validates `actions.json`, executes primitive
steps, renders overlays, observes page state, and reports structured results.

Runtime hosts include:

- Chrome extension runtime for privileged authoring;
- bookmarklet/embed runtime for portable page-JavaScript behavior;
- future mobile extension or browser-shell runtimes.

Each host advertises its capabilities. Unsupported operations must fail with a
structured capability error rather than pretending to work.

### Website Page

The page is the live DOM the runtime operates on. It may change after
navigation, re-rendering, account state changes, or product updates. Runtimes
must treat the page as a living surface and validate targets before acting.

### Storage

`actions.json.storage` holds learned site maps, observations, runs, item
indexes, overlays, and reports. The bridge can load relevant storage into a
runtime and can write updated artifacts back through structured storage
operations.

## Typical Flow

1. The user starts the bridge.
2. The user opens a page and connects a browser runtime.
3. The runtime announces itself to the bridge with runtime id, runtime key,
   authorization id, extension version, URL, and the loaded manifest.
4. The agent lists connected runtimes.
5. The agent chooses a runtime by id or unambiguous URL match.
6. The agent syncs storage for the current site.
7. The agent asks what site actions are available.
8. The agent calls a stored site action.
9. The bridge routes the call to the runtime.
10. The runtime validates input, page state, target descriptors, and host
    capability.
11. The runtime executes the action and returns a structured result or error.
12. The agent records observations, runs, or action-map updates when useful.

## Runtime Selection

When several browser runtimes are connected, routing must be explicit.

Acceptable selectors include:

- exact `runtime_id`;
- stable runtime key, such as a browser tab id when available;
- URL predicates that match exactly one runtime.

Implementation pending: title-based routing is part of the intended protocol,
but the current bridge request shape only supports `target_runtime_id` and
`target_url_contains`.

If a selector matches more than one runtime, the bridge should return an
ambiguous-routing error and send the action nowhere.

## Transport Options

The bridge and browser runtime do not need to run on the same machine.

Supported transport patterns include:

- local bridge and local browser;
- remote agent with local browser over a tunnel;
- local agent with remote browser;
- browser extension ports;
- WebSocket;
- HTTP polling where supported;
- hosted relay;
- Playwright/CDP for privileged development hosts.

The transport is not the action model. The same action call and result semantics
should apply across transports.

## Extension Versus Bookmarklet

The Chrome extension is the preferred authoring host when available. It can
provide privileged browser capabilities after user authorization, including true
screenshots and stable tab identity.

The bookmarklet/embed runtime is the portability host. It tests what can be done
from page JavaScript and approximates the future first-party website embed path.
It is constrained by the host page's Content Security Policy and cannot
autonomously take true rendered screenshots.

Both hosts should share the same action loading, primitive dictionary, result
shape, overlay shell, and storage-sync behavior wherever host capabilities
allow.

## Bridge Responsibilities

The bridge should:

- maintain a registry of connected runtimes;
- expose a stable generic tool surface;
- route calls to exactly one runtime;
- pass through structured runtime capabilities;
- support storage sync/reload without a process restart;
- preserve correlation ids;
- return structured errors;
- avoid interpreting site-specific action maps itself.

Implementation pending: normalized capability summaries and fully runtime-owned
site-map interpretation are not complete yet.

## Runtime Responsibilities

The browser runtime should:

- load and validate `actions.json`;
- advertise host capabilities;
- expose the current site action catalog;
- validate action inputs;
- validate page state and targets;
- execute supported primitive steps;
- render overlays and attachments where supported;
- enforce human-action pacing for visible actions;
- return structured results and errors;
- reject unsupported capabilities clearly.

Implementation pending: the runtime already reports its manifest and primitive
dictionary, but normalized capability advertisement and complete site action
catalog ownership are still being moved into the runtime layer.

## Agent Responsibilities

The agent should:

- inspect connected runtimes before acting;
- use stored site actions first;
- use debugger-only tools only to learn or repair;
- convert successful debugger discoveries into reusable `actions.json` actions;
- sync updated storage without restarting the bridge;
- record observations and runs when new information should persist.

## Protocol Reference

See [Actions Bridge Protocol](actions-bridge-protocol.md) for item types,
message fields, routing rules, correlation rules, and error envelopes.
