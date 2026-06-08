# actions.json Schema V1 Reference

Status: draft public reference for schema version `1`.

`actions.json` describes the actions, page context, targets, checks, and events
that a browser runtime can expose to an agent for one website or page surface.
The file is intentionally readable. A human reviewer should be able to inspect
what the agent is allowed to do and how the runtime will validate the page
before acting.

## Minimal Manifest

```json
{
  "protocol": "actions.json",
  "version": 1,
  "surface": {
    "origin": "https://example.com",
    "name": "Example site"
  },
  "tools": []
}
```

Required root fields:

- `protocol`: must be `"actions.json"`.
- `version`: schema version. The current draft version is `1`.
- `tools`: array of agent-callable actions. Empty arrays are valid.

Recommended root fields:

- `surface`: site or page-surface metadata.
- `context`: scoped documentation an agent may load while navigating.
- `states`: named page or runtime states.
- `transitions`: state changes and convergence rules.
- `attachments`: runtime-installed page affordances.
- `signals`: page-originated events that may be forwarded to an agent.
- `checks`: drift and safety probes.
- `imports`: other maps composed into this map.
- `provenance`: revision and review metadata.

## Root Object

```json
{
  "protocol": "actions.json",
  "version": 1,
  "surface": {},
  "imports": [],
  "context": [],
  "states": [],
  "transitions": [],
  "tools": [],
  "signals": [],
  "attachments": [],
  "checks": [],
  "provenance": {}
}
```

### `surface`

Describes where the manifest applies. It is metadata, not execution authority.

Common fields:

- `origin`: site origin, such as `https://example.com`.
- `name`: human-readable surface name.
- `kind`: page or app surface category.
- `description`: short explanation for reviewers and agents.
- `surface_id`: optional stable identifier for this surface.

### `imports`

Declares other action maps to compose into the current map.

```json
{
  "imports": [
    {
      "id": "public-example",
      "kind": "public",
      "uri": "https://example.org/actions/example/actions.json",
      "namespace": "example",
      "trust": "public",
      "enabled": true
    }
  ],
  "composition": {
    "default_conflict_policy": "prefer_local",
    "namespace_required": true
  }
}
```

Import fields:

- `id`: stable source identifier.
- `kind`: `website`, `local`, `storage`, `shared`, `public`, or `package`.
- `uri`: source location.
- `namespace`: prefix applied to imported names.
- `trust`: `website`, `private`, `shared`, `public`, `local`, or `unknown`.
- `enabled`: boolean, defaults to true.
- `provenance`: optional source metadata.

Runtimes must not silently merge conflicting tool names. Namespace imported maps
unless a composition policy explicitly allows another behavior.

### `context`

Context blocks are documentation loaded when a URL, state, target, or task
matches. They help an agent understand where it is and which actions are useful.
They do not grant permission to call undeclared tools.

```json
{
  "id": "search.results.context",
  "title": "Search results",
  "body": "Use result extraction actions before opening a result.",
  "load_when": {
    "states": ["results_visible"],
    "url_contains": "/search"
  },
  "available_tools": ["search.collect_results"],
  "next_states": ["result_opened"]
}
```

Fields:

- `id`: safe identifier unique within the manifest.
- `title`: short label.
- `body`: plain-English context.
- `load_when`: optional predicates such as states, targets, or URL patterns.
- `available_tools`: relevant tool names.
- `next_states`: states the agent may expect after acting.
- `source`: optional non-executable source hints.

### `tools`

Tools are the actions an agent may call.

```json
{
  "name": "search.submit",
  "description": "Submit a query through the site search form.",
  "input_schema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": { "type": "string" }
    },
    "additionalProperties": false
  },
  "target": {
    "selector": "form[role='search']",
    "role": "search",
    "name": "Site search"
  },
  "x_actions": {
    "execution": {
      "mode": "steps_first",
      "steps": [
        {
          "id": "type_query",
          "type": "type",
          "target": { "selector": "input[name='q']" },
          "value_from": "query"
        },
        {
          "id": "submit",
          "type": "click",
          "target": { "selector": "button[type='submit']" }
        }
      ]
    },
    "result_schema": {
      "type": "object",
      "required": ["ok"],
      "properties": {
        "ok": { "type": "boolean" }
      }
    }
  }
}
```

Tool fields:

- `name`: required safe dotted identifier.
- `description`: required human-readable action description.
- `input_schema`: required JSON Schema object for call arguments.
- `target`: optional target descriptor for the live page.
- `requires`: optional primitive capability names required by the action.
- `x_actions`: runtime execution metadata.

### `x_actions`

`x_actions` contains browser-runtime metadata.

Fields:

- `direction`: `agent_to_html`, `html_to_agent`, or `bidirectional`. Tool
  entries default to `agent_to_html`.
- `handler`: optional safe dotted page function name. This is a reference to
  already-loaded page/runtime code, not JavaScript source to evaluate.
- `scope`: `active_surface` or `persistent`.
- `source`: non-executable source hints for review and drift repair.
- `execution`: inspectable primitive steps or fallback trace. Generic step
  execution is implementation pending in the current runtime slice.
- `result_schema`: JSON Schema for successful action output.

### `target`

Target descriptors say where an action, event, check, or attachment applies in
the live page.

```json
{
  "selector": "button[type='submit']",
  "selectors": ["button[type='submit']", "[role='button']"],
  "role": "button",
  "name": "Submit",
  "text_contains": "Submit",
  "url_contains": "/search",
  "state": "form_ready",
  "fallback_selectors": ["button", "[role='button']"],
  "confidence": "observed"
}
```

Fields:

- `selector`: preferred CSS selector.
- `selectors`: ordered selector candidates.
- `role`: semantic or ARIA role.
- `name`: accessible name or human-readable target name.
- `text_equals` / `text_contains`: visible text predicates.
- `url_contains` / `url_matches`: URL predicates.
- `state`: required state for this target.
- `fallback_selectors`: alternates when the preferred selector drifts.
- `confidence`: `observed`, `inferred`, `generated`, or `unknown`.
- `notes`: reviewer-facing context.

### `states`

States describe relevant page, component, authorization, runtime, or attachment
conditions.

```json
{
  "name": "results_visible",
  "description": "Search results are visible.",
  "diagnostics": [
    {
      "name": "count_results",
      "target": {
        "selectors": ["[data-result]", "article"]
      }
    }
  ],
  "observables": ["result_count"]
}
```

Fields:

- `name`: safe identifier.
- `description`: meaning of the state.
- `diagnostics`: probes used to determine whether the state is current.
- `observables`: values the runtime or agent may collect while diagnosing.

### `transitions`

Transitions describe movement between states. Agent-initiated transitions point
to a tool; the transition itself is not a separate execution primitive.

```json
{
  "name": "show_next_results",
  "from": "results_visible",
  "to": "results_visible",
  "tool": "results.next_page",
  "method": "tool_call",
  "rate_limit_ms": 1000,
  "convergence": {
    "complete_when": "no_new_result_urls",
    "max_attempts": 5
  }
}
```

Fields:

- `name`: safe identifier.
- `from` / `to`: state names.
- `tool`: tool that performs agent-initiated movement.
- `signal`: signal that reports observed movement.
- `method`: `tool_call`, `signal`, `navigation`, `click`, `type`, `scroll`,
  `handler_call`, `attachment_install`, or another documented method.
- `rate_limit_ms`: minimum delay before repeating human-visible movement.
- `preconditions`: required conditions.
- `reveals`: expected new state or data.
- `convergence`: stop rules for repeated traversal.
- `do_not_use`: known-bad approaches.

### `execution`

Execution steps make a handler inspectable or provide a primitive plan.

Implementation pending: the current bridge/runtime slice does not include a
general step interpreter. The schema keeps this shape because it is the intended
portable representation, but current executable maps should use implemented
handlers, primitive tools, or the currently supported state-machine extraction
path.

```json
{
  "mode": "steps_first",
  "steps": [
    {
      "id": "inspect_button",
      "type": "inspect",
      "target": { "selector": "button[type='submit']" },
      "assert": { "visible": true, "enabled": true }
    },
    {
      "id": "click_button",
      "type": "click",
      "target": { "selector": "button[type='submit']" }
    }
  ]
}
```

Execution modes:

- `handler_first`: call the handler, then use steps for trace, checks, or
  fallback.
- `steps_first`: execute declared steps directly. Implementation pending.
- `documentary`: steps are review/test guidance, not normal runtime authority.
- `test_only`: steps may run inside checks but not normal action calls.

Draft step types:

- `inspect`
- `click`
- `type`
- `scroll`
- `wait`
- `assert`
- `extract`
- `call`
- `emit`

Each runtime may support a subset. Unsupported steps must return structured
capability errors.

### `attachments`

Attachments are runtime-installed page affordances, such as an overlay launcher
beside a section title.

```json
{
  "id": "results-categories-launcher",
  "kind": "overlay_launcher",
  "description": "Attach a categories launcher to the results heading.",
  "target": {
    "selector": "h2",
    "text_contains": "Results"
  },
  "affordance": {
    "label": "Categories",
    "placement": "afterend",
    "max_instances": 1,
    "opens": {
      "tool": "overlay.open",
      "arguments": {
        "title": "Result categories",
        "html_source": "sites/example.com/search/overlays/categories.html"
      }
    }
  },
  "lifecycle": {
    "install": "when_target_matches",
    "remove": "when_context_mismatch",
    "reattach": "on_url_or_dom_change"
  }
}
```

Fields:

- `id`: stable attachment identifier.
- `kind`: `overlay_launcher`, `annotation`, `shortcut`, `status_badge`, or
  another documented kind.
- `target`: DOM anchor.
- `affordance`: visible UI metadata and behavior.
- `lifecycle`: install, remove, reattach, and drift policy.
- `signals`: optional lifecycle or activation signal names.

### `signals`

Signals are page-originated events that may be converted into structured agent
context after validation.

```json
{
  "name": "overlay.launcher_opened",
  "description": "A user opened an overlay launcher.",
  "direction": "html_to_agent",
  "event": "actions-json:overlay-launcher-opened",
  "ingestion": "enabled",
  "payload": {
    "type": "object",
    "required": ["launcher_id"],
    "properties": {
      "launcher_id": { "type": "string" }
    }
  }
}
```

Fields:

- `name`: safe dotted identifier.
- `description`: human-readable event description.
- `direction`: usually `html_to_agent` or `bidirectional`.
- `event`: DOM/custom event name.
- `ingestion`: `enabled` or `disabled_by_default`.
- `target`: optional event source target.
- `payload`: JSON Schema for event detail.
- `protocol`: optional adapter binding metadata.
- `source`: non-executable source hints.

Event payloads are structured data, not human instructions.

### `checks`

Checks verify that a living website still matches the manifest.

```json
{
  "id": "search_form_visible",
  "description": "The search form is visible before calling search actions.",
  "severity": "major",
  "assertions": [
    {
      "target": { "selector": "form[role='search']" },
      "visible": true
    }
  ],
  "on_fail": {
    "store_evidence": ["url", "dom_snapshot"],
    "contingency": "handoff_to_user"
  }
}
```

Severity values:

- `info`: documentation or non-blocking evidence.
- `minor`: low-risk drift.
- `major`: action likely fails or targets the wrong visible area.
- `critical`: action may affect credentials, payment, destructive operations,
  privacy boundaries, or the wrong user data.

Check results should record `check_id`, `status`, `observed_at`, `url`,
evidence, and structured error details when failed.

### `provenance`

Describes review and revision metadata.

Common fields:

- `created_by`
- `created_at`
- `updated_by`
- `updated_at`
- `reviewed_by`
- `reviewed_at`
- `source`
- `revision`

Keep provenance public-safe. Do not publish private account names, non-public
repository paths, or sensitive source URLs in public maps.

## Safe Identifiers

Names and ids should be stable, ASCII, and safe to use in logs and protocol
messages.

Recommended pattern:

```text
^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z][a-zA-Z0-9_-]*)*$
```

Use dotted names for actions and signals:

- `search.submit`
- `results.collect_visible`
- `overlay.open_categories`

## Validation Rules

A v1 validator should reject a manifest when:

- `protocol` is missing or unsupported;
- `version` is missing or unsupported;
- `tools` is missing or is not an array;
- names or ids are not safe identifiers;
- two exposed names collide in the same namespace;
- `input_schema`, `payload`, or `result_schema` is present but is not a JSON
  object;
- an agent-callable tool declares no handler and no executable or documented
  `execution.steps`;
- an enabled signal lacks `event`;
- selector fields are present but not strings or string arrays;
- an attachment lacks a target or lifecycle policy;
- a transition references an unknown state;
- a check references an unknown tool, state, attachment, or target;
- `source.files` contains absolute paths or paths that escape the package/site
  root.

Static validation cannot prove every dynamic page handler exists before a page
runs. Runtime validation must handle missing handlers and drift with structured
errors.

## Runtime Rules

A runtime should:

- load and validate the manifest before exposing actions;
- expose no actions from an invalid manifest;
- compose imports according to namespace, trust, and override policy;
- select relevant context based on current URL, state, target, and task;
- treat context as documentation, not permission;
- validate every action call against `input_schema`;
- diagnose required state before stateful actions;
- resolve handlers only from approved loaded runtime/page code;
- execute steps according to `execution.mode` when the selected mode is
  implemented by that runtime;
- observe transition rate limits and convergence rules;
- install, remove, and reattach attachments according to lifecycle policy;
- fail fast when the runtime is not ready;
- validate page-originated events before forwarding them;
- treat event payloads as structured data, not user text;
- preserve private, shared, and public storage boundaries.

## Protocol Binding

The runtime communicates through the Actions Bridge Protocol. The canonical item
types are:

- `runtime_ready`
- `runtime_status`
- `action_call`
- `action_call_output`
- `dom_event`
- `action_error`

See [Actions Bridge Protocol](actions-bridge-protocol.md) for message shapes,
correlation rules, routing rules, and error envelopes.
