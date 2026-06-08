# Primitive Dictionary Architecture

The primitive dictionary defines the browser operations that `actions.json`
actions can use.

Site actions should be written in terms of stable primitive contracts rather
than hidden scripts or one automation library's private API. A primitive such as
`pointer.click` or `viewport.scroll` has a name, input schema, output schema,
capability requirements, and adapter implementations for supported runtime
hosts.

## Why The Dictionary Exists

`actions.json` needs to work across different browser hosts:

- a privileged extension runtime used for authoring and debugging;
- a bookmarklet or website embed running as page JavaScript;
- future mobile extension or browser-shell runtimes.

Those hosts do not have identical privileges. The dictionary gives them one
shared semantic contract and lets each host advertise which capabilities it can
provide.

The goal is not to hide capability differences. The goal is to make them
explicit, testable, and visible to agents.

## Host Families

### Privileged Browser Hosts

Examples:

- Chrome extension runtime;
- browser extension with privileged APIs;
- CDP-backed development host;
- project-owned browser shell.

These hosts can provide capabilities that page JavaScript cannot normally
provide, such as true screenshots, tab identity, browser history, console
diagnostics, network diagnostics, and debugger-style JavaScript evaluation.

Use privileged hosts for authoring, debugging, and repair. Portable site actions
should still be lowered to portable primitives whenever possible.

### Page JavaScript Hosts

Examples:

- bookmarklet runtime;
- first-party website embed.

These hosts run inside the page. They can inspect and manipulate the page DOM
using ordinary browser APIs, but they cannot autonomously capture true rendered
screenshots or access browser-level debugging surfaces.

Bookmarklets are also constrained by the host page's Content Security Policy
(CSP). A page may block a bookmarklet from connecting to a local or tunneled
bridge even though the same bridge works on another site.

Use page JavaScript hosts to test embed portability.

### Mobile Hosts

Examples:

- iOS Safari Web Extension;
- Android browser extension host where supported;
- project-owned mobile browser or browser shell.

Mobile hosts should implement the same primitive dictionary where platform APIs
allow it. If a mobile host cannot support a primitive, it must report that
capability clearly.

## Shared Runtime Shell

Host adapters should share as much runtime code as possible.

Shared behavior should include:

- manifest loading and validation;
- primitive dictionary loading;
- action catalog presentation;
- storage sync;
- structured result envelopes;
- overlay shell behavior where supported;
- human-action pacing;
- capability errors;
- conformance test fixtures.

Host-specific code should be limited to the adapter layer that actually performs
the primitive through extension APIs, page JavaScript, CDP, or mobile platform
APIs.

## Primitive Record

Each primitive should have a versioned record.

```json
{
  "name": "pointer.click",
  "version": 1,
  "stage": 1,
  "summary": "Move to a point and click.",
  "capability_class": "portable",
  "portable": true,
  "capabilities": ["pointer.move", "pointer.click"],
  "input_schema": {
    "type": "object",
    "required": ["x", "y"],
    "properties": {
      "x": { "type": "number" },
      "y": { "type": "number" },
      "button": { "type": "string", "enum": ["left", "middle", "right"] }
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "required": ["ok"],
    "properties": {
      "ok": { "type": "boolean" }
    }
  },
  "adapters": {
    "extension": { "support": "supported" },
    "embed": { "support": "supported" }
  },
  "errors": ["target_not_found", "unsafe_state"],
  "conformance": {
    "fixture": "button-fixture",
    "assertions": ["click_event_dispatched"]
  }
}
```

Required fields in the current primitive dictionary validator:

- `name`: stable primitive name.
- `version`: primitive contract version.
- `stage`: dictionary rollout stage.
- `summary`: short description.
- `capability_class`: `portable`, `privileged`, `debug`, or `mixed`.
- `portable`: whether the primitive is expected to work in portable hosts.
- `capabilities`: host capabilities required.
- `input_schema`: JSON Schema for arguments.
- `output_schema`: JSON Schema for results.
- `adapters`: implementation references for host adapters.
- `errors`: stable error codes.
- `conformance`: fixture and assertion reference.

Optional descriptive fields such as longer descriptions or observable effects
may be added later, but they are not required by the current validator.

## Capability Classes

Classify primitives by required capability, not by implementation language.

### Portable Capabilities

Portable capabilities should work in both privileged hosts and page JavaScript
hosts, though implementations may differ.

Examples:

- `pointer.move`
- `pointer.click`
- `pointer.double_click`
- `pointer.drag`
- `text.insert`
- `viewport.scroll`
- `locator.element_info`
- `locator.text_content`
- `locator.wait_for`
- `dom.observe.visible`
- `dom.snapshot_text`
- `overlay.render`
- `storage.read`
- `storage.write`

Portable does not mean risk-free. Human-visible actions such as pointer and
scroll operations should still use pacing rules and visible targets.

Current implementation note: `keyboard.press` is classified as `mixed`, not
portable. The extension can support it in more contexts, while the
bookmarklet/embed path can only dispatch page-level unmodified key events.

### Privileged Capabilities

Privileged capabilities require browser-level access.

Examples:

- `browser.screenshot`
- `browser.claimed_tabs.list`
- `browser.claimed_tabs.activate`
- `browser.tabs`
- `browser.history`
- `browser.downloads`
- `browser.file_chooser`
- `browser.clipboard`
- `browser.console`
- `browser.network`
- `browser.cdp`
- `browser.permissions`

Privileged actions may be valid in an authoring workflow, but they must not be
advertised as portable embed actions.

Claimed-tab primitives are privileged browser-host primitives. They are useful
when the user has explicitly authorized more than one tab and wants an agent to
switch among those known surfaces. Bookmarklet/embed hosts should report
`capability_unavailable` for tab-management primitives unless the first-party
site provides its own equivalent navigation surface.

### Debug-Only Capabilities

Debug-only capabilities help an agent understand a page while authoring or
repairing an action map.

Examples:

- `debug.javascript`
- `debug.inspect`
- `debug.trace`
- `debug.network_probe`

Debug-only output should be converted into durable `actions.json` actions or
observations. Do not use debug-only primitives as the final operating path when
a stored portable action can be written.

## Locator-To-Point Pattern

Point-based actions are the preferred first operating path for user-visible
interaction. They simulate what the user can see: move, click, type, scroll.

Locators still matter. They let the runtime find a visible target and compute a
viewport point:

1. Use locator or DOM observation to identify a visible element.
2. Resolve the element to bounding box and clickable center.
3. Use pointer primitives to move and click.
4. Return structured evidence describing the target used.

This pattern keeps the visible action human-understandable while still allowing
the agent to choose targets semantically.

## Human-Action Pacing

Primitives that create human-visible page effects should be paced.

Examples:

- pointer movement;
- clicks;
- drag operations;
- scroll operations;
- typing or key presses.

Observation-only primitives, such as reading DOM text or resolving locator
geometry, do not need the same delay because they do not simulate visible user
input.

Pacing should be configurable, but runtimes should provide conservative
defaults for human-visible primitives.

## Adapter Contract

Every adapter that claims a primitive must return the same canonical result
shape.

### Extension Adapter

The extension adapter may use extension APIs, browser APIs, CDP, or privileged
runtime support. It can implement privileged primitives as well as portable
primitives.

### Embed Adapter

The embed adapter uses ordinary page JavaScript. It implements portable
primitives where possible and returns `capability_unavailable` for privileged
operations.

### Mobile Adapter

The mobile adapter uses the platform APIs available to the mobile host. It
should implement the same primitive contract for every primitive it marks
supported.

## Conformance Testing

Portable primitives require conformance tests.

For each portable primitive, tests should:

1. load the same fixture page;
2. execute the extension implementation;
3. reset the fixture;
4. execute the embed/page-JavaScript implementation;
5. reset the fixture;
6. execute mobile implementations where available;
7. compare observable outcomes and structured result shape.

Compare outcomes, not implementation details:

- DOM state;
- focused element;
- typed value;
- scroll position;
- emitted events;
- overlay state;
- extracted text;
- result payload;
- stable error code.

A primitive that cannot pass conformance across the adapters it claims should
not be marked portable for those adapters.

## Relationship To actions.json

An `actions.json` tool should reference primitive capabilities rather than
embedding hidden executable code.

Example:

```json
{
  "name": "results.collect_visible",
  "description": "Collect visible result titles and URLs.",
  "requires": ["dom.observe.visible", "locator.element_info"],
  "x_actions": {
    "execution": {
      "mode": "steps_first",
      "steps": [
        {
          "id": "read_results",
          "type": "extract",
          "target": { "selectors": ["[data-result]", "article"] },
          "fields": ["text", "href"]
        }
      ]
    }
  }
}
```

Implementation pending: this `steps_first` shape is the intended portable
schema direction. The current bridge/runtime slice does not include a general
step interpreter; stored actions should route to implemented primitive handlers
or to the currently supported state-machine extraction path.

If a tool requires privileged capability, say so:

```json
{
  "name": "debug.capture_page",
  "description": "Capture a true browser screenshot for authoring diagnostics.",
  "requires": ["browser.screenshot"],
  "portable": false
}
```

## Non-Goals

The primitive dictionary is not:

- an arbitrary remote-code loading mechanism;
- a hidden automation binary;
- a promise that privileged browser features work in embeds;
- a commitment to one browser automation provider;
- a substitute for explicit user authorization and storage visibility rules.
