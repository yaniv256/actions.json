# actions.json Schema V1 Proposal

Status: draft proposal derived from working browser-action prototypes and revised through state-machine, DOM-attachment, and runtime-bridge experiments.

## Purpose

`actions.json` is a readable action map for a website or web app.

It tells an agent which operations are intentionally available, what input each operation accepts, where the target exists on the live DOM, which JavaScript handler or DOM execution path implements it, which page-originated signals may be forwarded, and how the map should be checked against the current website.

The file has three audiences:

- the runtime bridge, which validates and dispatches actions;
- the agent, which uses the map to operate and maintain the page;
- the human reviewer, who can inspect what authority the map grants and how drift will be detected.

The schema is intentionally not a hidden automation binary. It should stay readable, auditable, and comparable against the live website it describes.

## Design Principles

`actions.json` is a map, not only a tool list.

The first prototype-derived proposal established the catalog layer: tools, signals, handler mappings, source hints, and result schemas. This revision keeps that layer and adds the missing operational geography:

- `target` descriptors say where a capability exists on the live DOM.
- `states` describe page or component conditions.
- `transitions` provide a readable state graph, including the tool to run for agent-executable state changes plus waits, rate limits, and stop rules.
- `attachments` describe user-visible DOM augmentations such as overlay launchers.
- `execution.steps` make handler behavior inspectable, testable, and usable as a fallback.
- `checks` probe living websites for drift and safety.
- `imports` compose maps from website, local, private, shared, and public sources.
- `signals` remain distinct from `tools`, and protocol bindings explain how both become bridge items.

## Prototype Provenance

The first working prototype came from internal workspace-tab experiments. That implementation generated three actionable surfaces:

- Kanban: board/card operations such as `board.get`, `card.create`, `card.move`, `card.read`, `card.update`, and `card.delete`.
- Trainables Dev chess port: `chess.move`, `chess.state`, `chess.reset`, plus a `chess.user_move` DOM event signal.
- Slide deck: `deck.next`, `deck.previous`, `deck.go_to_slide`, `deck.state`, and `deck.set_accent`.

The prototype used this root identifier:

```json
{
  "protocol": "prototype.workspace_tab.actions",
  "version": 1
}
```

For the portable public standard, this proposal generalizes the vendor-specific extension fields while preserving the same data model.

## Proposed Root Shape

```json
{
  "protocol": "actions.json",
  "version": 1,
  "surface": {
    "origin": "https://linear.app",
    "kind": "issue_page",
    "description": "Linear issue page for actions.json planning."
  },
  "imports": [],
  "prompt": {
    "title": "Linear issue page",
    "instructions": "Operate only the user-authorized Linear surface through declared tools and signals.",
    "state_summary": "Use state diagnostics before creating views, scrolling collections, or attaching overlays.",
    "source": {
      "files": ["sites/linear.app/actions.json"],
      "selectors": ["[aria-label=\"Issue title\"][role=\"textbox\"]"],
      "component": "Linear issue page"
    }
  },
  "context": [],
  "states": [],
  "transitions": [],
  "tools": [],
  "signals": [],
  "attachments": [],
  "checks": [],
  "provenance": {
    "created_from": ["workspace-tab prototypes", "schema design iteration"],
    "created_by": "codex",
    "updated_at": "2026-06-02"
  }
}
```

## Root Fields

`protocol`:
Required string. Identifies the manifest protocol. Proposed public value: `actions.json`.

`version`:
Required integer. The initial public schema version is `1`.

`surface`:
Optional object that describes the website surface. Common fields are `origin`, `kind`, `name`, `description`, and `surface_id`. This is descriptive metadata, not executable authority.

`imports`:
Optional array. Declares other action maps that are composed into this map.

`prompt`:
Optional broad agent-facing context for this page or surface. The prompt travels with the action catalog so the model can understand the current app while using the tools.

`context`:
Optional array. Declares scoped plain-English context blocks that a runtime or agent may load as the current URL, state, target, or task changes. Context is documentation, not execution authority.

`states`:
Optional array. Declares named page, component, authorization, runtime, or attachment states that affect action availability.

`transitions`:
Optional array. Declares how states are related to one another. A transition is not a second executable primitive; for agent-initiated movement it points to the `tools[]` entry the runtime should call to execute that edge. Transitions may also describe observed movement caused by page signals or runtime attachment lifecycle events.

`tools`:
Required array. Each entry declares one agent-callable action. Empty arrays are valid when the page wants a manifest and prompt but no callable actions.

`signals`:
Optional array. Each entry declares one page-originated event that can be converted into agent-side structured context.

`attachments`:
Optional array. Declares DOM affordances or augmentations that a runtime may install, keep attached, remove, and reattach.

`checks`:
Optional array. Declares living-site probes that validate whether the map still matches the website.

`provenance`:
Optional object. Describes origin, authoring, storage, revision, and review metadata.

## Prompt Shape

```json
{
  "title": "Kanban board",
  "instructions": "Use board and card tools to operate this Kanban board.",
  "state_summary": "Use board.get to inspect current state before making multi-step changes.",
  "source": {
    "files": ["index.html", "assets/kanban.js"],
    "symbols": ["roomjinniKanban.getBoard"],
    "selectors": ["#kanban-board"],
    "component": "KanbanBoard"
  }
}
```

Fields:

- `title`: short human-readable surface name.
- `instructions`: bounded agent-facing context. This is guidance, not a human user request.
- `state_summary`: optional hint about how the agent should discover current app state.
- `source`: optional non-executable source hints using the same source shape as tools and signals.

## Agent Context Shape

Context blocks are loadable documentation for traversal. They answer questions such as: where am I, what is true here, which actions are available, what should I inspect next, and what local vocabulary matters on this part of the website?

```json
{
  "context": [
    {
      "id": "prime.continue_watching.context",
      "title": "Continue Watching carousel",
      "body": "This carousel contains watch-history cards. First read the visible cards, then follow the carousel transition until no new detail URLs appear.",
      "load_when": {
        "states": ["continue_watching_visible"],
        "targets": ["prime.continue_watching.carousel"]
      },
      "available_tools": ["prime.continue_watching.read_visible", "prime.continue_watching.scroll"],
      "next_states": ["carousel_scrolled", "carousel_exhausted"],
      "source": {
        "files": ["sites/primevideo.com/actions.json"],
        "selectors": ["[data-testid='continue-watching']", "a[href*='/gp/video/detail/']"]
      }
    }
  ]
}
```

Context fields:

- `id`: safe identifier unique within the manifest.
- `title`: short human-readable context label.
- `body`: plain-English documentation intended to be loaded into agent context.
- `load_when`: optional predicates such as `states`, `targets`, URL patterns, or attachment states.
- `available_tools`: optional tool names relevant in this context.
- `next_states`: optional state names the agent may expect after acting or observing.
- `source`: optional non-executable source hints for review and drift repair.

Context blocks do not grant permission to call tools, emit signals, or read private data. Runtime authority still comes from `tools[]`, `signals[]`, imports, user authorization, and storage scope.

## Tool Shape

```json
{
  "name": "contact.submit_name",
  "description": "Fill the contact form name field and submit the form.",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" }
    },
    "required": ["name"],
    "additionalProperties": false
  },
  "target": {
    "selector": "#contact-form",
    "role": "form",
    "name": "Contact form",
    "state": "form_ready",
    "fallback_selectors": ["main form", "form"]
  },
  "x_actions": {
    "direction": "agent_to_html",
    "handler": "contactForm.submitName",
    "scope": "active_surface",
    "source": {
      "files": ["index.html"],
      "symbols": ["contactForm.submitName"],
      "selectors": ["#name", "#submit", "#result"],
      "component": "ContactForm"
    },
    "execution": {
      "mode": "handler_first",
      "steps": []
    },
    "result_schema": {
      "type": "object",
      "properties": {
        "ok": { "type": "boolean" },
        "result": { "type": "string" }
      },
      "required": ["ok"]
    }
  }
}
```

Fields:

- `name`: required safe dotted identifier, for example `card.move` or `deck.go_to_slide`.
- `description`: required or strongly recommended human-readable action description.
- `input_schema`: required JSON Schema object for the action input.
- `target`: optional live-DOM target descriptor. This complements `source`; it does not replace source hints.
- `x_actions`: required action bridge metadata for browser-backed actions.

### `x_actions` Fields

`direction`:
Optional string. Allowed values:

- `agent_to_html`: the agent may call this action and the runtime invokes a JavaScript handler or execution plan.
- `html_to_agent`: the page may emit this action as an event.
- `bidirectional`: both directions are allowed.

For entries in `tools`, omitted `direction` defaults to `agent_to_html`.

`handler`:
Recommended for `agent_to_html` and `bidirectional` tools when page code already implements the behavior. A safe dotted JavaScript identifier resolves inside the page runtime, for example `deckRuntime.goToSlide`. It is a reference to loaded page code, not JavaScript source to evaluate.

`scope`:
Optional string. Proposed values:

- `active_surface`: projected only when this page/surface is active.
- `persistent`: may remain available while another page/surface is active, still routed back to this source page.

The prototype called this field `projection_scope`; the public proposal shortens it to `scope`.

`source`:
Required for callable browser actions. Non-executable hints that help the agent and validator connect the declaration to the actual website.

`state_machine`:
Optional object that links a tool to root-level `states` and `transitions`. The tool remains the callable capability; the transition remains the state-graph edge that can name this tool as its execution path.

`execution`:
Optional object that defines inspectable steps beside or instead of a handler.

`result_schema`:
Optional JSON Schema object for handler or execution-plan output.

## Target Descriptor Shape

Target descriptors describe runtime geography: where a capability exists on the live page and in which state it is available.

```json
{
  "selector": "[aria-label=\"Issue title\"][role=\"textbox\"]",
  "selectors": ["[aria-label=\"Issue title\"][role=\"textbox\"]", "h1"],
  "role": "textbox",
  "name": "Issue title",
  "text_equals": "Design schema for action.json files",
  "text_contains": "Design schema",
  "url_contains": "/issue/schema-design/",
  "url_matches": "/issue/schema-design/",
  "state": "issue_page_visible",
  "fallback_selectors": ["h1", "[role=\"heading\"]"],
  "confidence": "observed",
  "notes": "Attach to the main issue title, not breadcrumb links."
}
```

Fields:

- `selector`: preferred CSS selector for the live target.
- `selectors`: ordered selector candidates.
- `role`: semantic role or ARIA role when known.
- `name`: accessible name, label, or human-readable semantic name.
- `text_equals`: exact visible text predicate.
- `text_contains`: fuzzy visible text predicate.
- `url_contains`: required URL substring.
- `url_matches`: regular expression for the current URL.
- `state`: named owning state from root `states`.
- `fallback_selectors`: selectors to try when the preferred target drifts.
- `confidence`: `observed`, `inferred`, `generated`, or `unknown`.
- `notes`: reviewer-facing context.

Targets can appear on tools, signals, checks, execution steps, and attachments. A target says where the capability is in the running website; `source` says where the implementation or evidence can be found.

## State and Transition Shape

The available action set changes with page state, website state, user authorization, account state, runtime state, and DOM attachment state.

```json
{
  "states": [
    {
      "name": "continue_watching_visible",
      "description": "The Continue Watching carousel is visible and at least one card can be extracted.",
      "diagnostics": [
        {
          "name": "collect_visible_cards",
          "description": "Extract visible card title, detail URL, and cover image URL.",
          "target": {
            "selectors": ["a[href*='/gp/video/detail/']", "img[src*='pv-target-images']"]
          }
        }
      ],
      "observables": ["visible_detail_urls", "new_detail_url_count"]
    }
  ],
  "transitions": [
    {
      "name": "scroll_carousel_left_or_right",
      "tool": "prime.continue_watching.scroll",
      "from": "continue_watching_visible",
      "to": "carousel_scrolled",
      "method": "tool_call",
      "rate_limit_ms": 1000,
      "preconditions": ["carousel_has_more_content_or_user_requests_full_collection"],
      "reveals": ["additional_cards"],
      "convergence": {
        "complete_when": "no_new_detail_urls_after_allowed_scrolls",
        "max_attempts": 8
      },
      "do_not_use": ["left-side click for carousel movement"]
    }
  ]
}
```

State fields:

- `name`: safe identifier unique within the manifest.
- `description`: human-readable meaning.
- `diagnostics`: probes used to determine whether the state is current.
- `observables`: values a runtime or agent may collect while diagnosing the state.

Transition fields:

- `name`: safe identifier unique within the manifest.
- `from` and `to`: named states.
- `tool`: optional safe identifier of the `tools[]` entry that performs this transition. Required when the transition can be initiated by an agent.
- `signal`: optional safe identifier of the `signals[]` entry that reports an observed transition caused by the page or user.
- `method`: `tool_call`, signal observation, navigation, click, type, scroll, handler call, attachment install, or other transition method.
- `rate_limit_ms`: minimum delay before repeating this transition.
- `preconditions`: conditions required before transition.
- `reveals`: state or data the transition is expected to reveal.
- `convergence`: stop condition for traversal loops.
- `do_not_use`: known-bad operations that look plausible but should be avoided.

This split keeps execution authority in one place. An agent calls a tool; the transition explains how that tool changes state and when repeated calls should stop.

Attachment lifecycle states should use the same vocabulary:

- `unattached`: affordance is declared but absent.
- `attached`: affordance is installed in the correct context.
- `wrong_context`: current page does not match the attachment target.
- `stale`: host page replaced the DOM node and the affordance no longer exists.
- `reattached`: runtime reinstalled the affordance after navigation or DOM replacement.
- `drifted`: attachment cannot be installed because selectors, text, or state predicates no longer match.

## Attachment Shape

Attachments describe DOM augmentations, not ordinary website controls. They let a runtime install a visible affordance into the host page, such as a button that reopens an agent-created overlay.

```json
{
  "id": "linear-issue-execution-path",
  "kind": "overlay_launcher",
  "description": "Attach an execution path launcher to the matching issue title.",
  "target": {
    "selectors": ["[aria-label=\"Issue title\"][role=\"textbox\"]", "h1", "[role=\"heading\"]"],
    "text_equals": "Prototype actions.json browser extension and MCP bridge",
    "url_contains": "/issue/overlay-runtime/",
    "state": "issue_page_visible",
    "fallback_selectors": ["h1", "[role=\"heading\"]"]
  },
  "affordance": {
    "label": "Execution path",
    "title": "Open prototype execution path",
    "placement": "afterend",
    "max_instances": 1,
    "opens": {
      "tool": "overlay.open",
      "arguments": {
        "title": "Prototype execution path",
        "html_source": "sites/linear.app/workspace/overlays/prototype-execution-path.html"
      }
    }
  },
  "lifecycle": {
    "install": "when_target_matches",
    "remove": "when_context_mismatch",
    "reattach": "on_url_or_dom_change",
    "drift": "emit_signal_and_hide_affordance"
  },
  "signals": {
    "activated": "overlay.launcher_opened",
    "attached": "attachment.attached",
    "reattached": "attachment.reattached",
    "drifted": "attachment.drifted"
  }
}
```

Attachment fields:

- `id`: stable attachment identifier.
- `kind`: affordance category such as `overlay_launcher`, `annotation`, `shortcut`, or `status_badge`.
- `target`: target descriptor for the host DOM anchor.
- `affordance`: visible UI metadata and behavior.
- `lifecycle`: install, remove, reattach, and drift policy.
- `signals`: signal names emitted by activation or lifecycle changes.

The attachment may be registered before its target is visible. A runtime should evaluate URL and DOM predicates over time and install only when the target context appears.

## Execution Shape

`execution.steps` are an inspectable fallback or testable trace beside a handler. They can be executable by a runtime that supports DOM automation, documentary for human review, or test-only for drift probes.

```json
{
  "mode": "handler_first",
  "fallback": "steps_on_missing_handler_or_drift",
  "steps": [
    {
      "id": "inspect_name_input",
      "type": "inspect",
      "target": { "selector": "#name", "role": "textbox", "name": "Name" },
      "assert": { "visible": true, "enabled": true }
    },
    {
      "id": "type_name",
      "type": "type",
      "target": { "selector": "#name" },
      "value_from": "name"
    },
    {
      "id": "click_submit",
      "type": "click",
      "target": { "selector": "#submit", "role": "button", "name": "Submit" }
    },
    {
      "id": "wait_for_result",
      "type": "wait",
      "until": { "selector": "#result", "text_contains": "Submitted" },
      "timeout_ms": 2000
    },
    {
      "id": "extract_result",
      "type": "extract",
      "target": { "selector": "#result" },
      "as": "result"
    }
  ]
}
```

Step types for v1:

- `inspect`: collect target state and optionally assert visibility, enabled state, text, role, or URL.
- `click`: click a target.
- `type`: type or fill a value.
- `scroll`: scroll a page or target region, with optional `rate_limit_ms`.
- `wait`: wait for a condition or timeout.
- `assert`: fail if a condition does not hold.
- `extract`: copy text, attributes, URLs, images, or structured values into the result.
- `call`: call a named handler or nested tool.
- `emit`: emit a declared signal or protocol item.

Execution precedence:

- `handler_first`: call `handler`; use steps only for validation, tracing, or fallback.
- `steps_first`: execute steps; call handler only if declared as a step.
- `documentary`: steps are reviewer/test guidance, not runtime authority.
- `test_only`: steps may run in checks but not in normal action execution.

## Check Shape

Checks are living-site probes. They validate that targets, states, attachments, and execution paths still match the website.

```json
{
  "id": "overlay_launcher_attaches_only_on_matching_issue",
  "description": "The overlay launcher appears on the matching issue page and not on unrelated issue pages.",
  "severity": "major",
  "setup": [
    {
      "type": "navigate",
      "url": "https://linear.app/example/issue/overlay-runtime/prototype-actionsjson-browser-extension-and-mcp-bridge"
    }
  ],
  "assertions": [
    {
      "target": {
        "selector": "[data-actions-json-overlay-launcher=\"linear-issue-execution-path\"]"
      },
      "visible": true,
      "expected_text": "Execution path"
    }
  ],
  "negative_assertions": [
    {
      "url_contains": "/issue/schema-design/",
      "selector": "[data-actions-json-overlay-launcher=\"linear-issue-execution-path\"]",
      "visible": false
    }
  ],
  "on_fail": {
    "store_evidence": ["url", "screenshot", "dom_snapshot"],
    "contingency": "handoff_to_user",
    "alternate_selectors": ["h1", "[role=\"heading\"]"]
  }
}
```

Severity values:

- `info`: documentation or non-blocking evidence.
- `minor`: selector or copy drift with low safety risk.
- `major`: action likely fails or installs in the wrong context.
- `critical`: action may affect the wrong user data, credential surfaces, purchases, payments, destructive operations, or privacy boundaries.

Check results should store:

- `check_id`;
- `status`: `pass`, `fail`, `skipped`, or `error`;
- `observed_at`;
- `url`;
- relevant selector matches;
- optional screenshot or DOM snapshot evidence;
- structured error envelope when failed.

## Import and Composition Shape

`imports[]` lets users combine website-provided maps, local overrides, private storage, shared-group maps, and public packages.

```json
{
  "imports": [
    {
      "id": "website-linear",
      "kind": "website",
      "uri": "https://linear.app/actions.json",
      "namespace": "linear",
      "trust": "website",
      "enabled": true
    },
    {
      "id": "private-linear-memory",
      "kind": "storage",
      "uri": "github:<owner>/actions.json.storage.private/sites/linear.app/workspace/actions.json",
      "namespace": "private.linear",
      "trust": "private",
      "enabled": true,
      "provenance": {
        "owner": "<owner>",
        "visibility": "private"
      }
    }
  ],
  "composition": {
    "default_conflict_policy": "prefer_local",
    "namespace_required": true,
    "overrides": [
      {
        "name": "linear.overlay.open_execution_path",
        "prefer": "private.linear.overlay.open_execution_path"
      }
    ],
    "disabled_sources": []
  }
}
```

Import fields:

- `id`: stable source identifier.
- `kind`: `website`, `local`, `storage`, `shared`, `public`, or `package`.
- `uri`: source location. URI schemes may include HTTPS, local relative paths, and package/storage-specific schemes.
- `namespace`: prefix applied to imported names when exposed to an agent.
- `trust`: `website`, `private`, `shared`, `public`, `local`, or `unknown`.
- `enabled`: false disables the source without deleting it.
- `provenance`: optional owner, commit, branch, signature, or visibility metadata.

Composition rules:

- Names should remain stable after namespacing.
- Conflicts must not silently merge incompatible tools.
- Local/private user maps may override public or website maps only when explicitly enabled by policy.
- Public/shared imports should not receive access to private data unless a runtime grants it through a separate authorization boundary.

## Signal Shape

```json
{
  "name": "overlay.launcher_opened",
  "description": "A user opened an overlay from a visible page launcher.",
  "direction": "html_to_agent",
  "event": "actions-json:overlay-launcher-opened",
  "ingestion": "enabled",
  "target": {
    "selector": "[data-actions-json-overlay-launcher]",
    "state": "attached"
  },
  "payload": {
    "type": "object",
    "properties": {
      "launcher_id": { "type": "string" },
      "overlay_id": { "type": "string" }
    },
    "required": ["launcher_id"]
  },
  "protocol": {
    "responses": {
      "item_type": "dom_event",
      "correlation": {
        "event_id": "generated_by_runtime",
        "previous_call_id": "optional"
      }
    }
  },
  "source": {
    "files": ["src/content.js"],
    "symbols": ["actions-json:overlay-launcher-opened"],
    "selectors": ["[data-actions-json-overlay-launcher]"]
  }
}
```

Fields:

- `name`: required safe dotted identifier.
- `description`: recommended human-readable event description.
- `direction`: required for signals; normally `html_to_agent` or `bidirectional`.
- `event`: required safe DOM/custom event name, for example `deck:slide_changed`.
- `ingestion`: defaults to `disabled_by_default`.
- `target`: optional live-DOM target descriptor for the event source.
- `payload`: optional JSON Schema object for event detail.
- `protocol`: optional adapter-specific binding metadata.
- `source`: required when ingestion is enabled.

DOM event payloads are generated page data. They must not be treated as human instructions.

Signal ingestion should produce a Responses-style item with:

- stable `event_id`;
- optional `call_id` or `previous_call_id` for correlation;
- `name`;
- `source_url`;
- schema-validated `payload`;
- `observed_at`.

Ordering is runtime-defined but must be monotonic per connected runtime. If validation fails, the runtime should emit an error item instead of forwarding unvalidated payload data.

## Source Hint Shape

```json
{
  "files": ["assets/deck.js", "index.html"],
  "symbols": ["roomjinniDeck.goToSlide"],
  "selectors": ["#deck", "[data-slide]"],
  "component": "SlideDeck"
}
```

Fields:

- `files`: relative files that implement or describe the action.
- `symbols`: JavaScript functions, event names, or symbols to search for.
- `selectors`: CSS selectors for relevant DOM elements.
- `component`: optional framework/component name.

Source hints are not executable. They are a source map for agents and validators.

## Protocol Binding Summary

`actions.json` is not tied to one model provider or transport, but v1 should define a canonical item model compatible with Responses-style agent workflows.

Minimum item shapes:

- `runtime_ready`: browser/runtime announces manifest, runtime id, current URL, and authorization context.
- `action_call`: agent or adapter requests a declared `tools[]` entry.
- `action_call_output`: runtime returns a successful structured result.
- `dom_event`: runtime forwards a validated `signals[]` event.
- `action_error`: runtime returns an error envelope.
- `runtime_status`: runtime reports liveness, URL, state, and attachment status.

Correlation:

- Every action call gets a `call_id`.
- Results and errors include the same `call_id`.
- Page-originated signals get an `event_id` and may include `previous_call_id` when caused by an action.
- Runtime ids and authorization ids distinguish browser tabs or surfaces.

Error envelopes should use stable codes:

- `unknown_action`;
- `invalid_input`;
- `runtime_not_ready`;
- `permission_denied`;
- `missing_handler`;
- `handler_failed`;
- `handler_timeout`;
- `invalid_result`;
- `target_not_found`;
- `state_mismatch`;
- `drift_detected`;
- `unsafe_state`.

The detailed protocol appendix lives in [actions-bridge-protocol.md](actions-bridge-protocol.md).

## Validation Rules

V1 validators should reject the manifest when:

- `protocol` is missing or unsupported.
- `version` is missing or unsupported.
- `tools` is missing or is not an array.
- a tool, signal, state, transition, context block, attachment, import, or check id/name is not a safe identifier.
- two tools normalize to the same name in the same namespace.
- `input_schema`, `payload`, or `result_schema` is present but is not a JSON object.
- an agent-callable tool declares neither a safe dotted `handler` nor executable/documented `execution.steps`.
- a callable browser tool lacks source linkage.
- an enabled signal lacks `event`.
- an enabled signal lacks source linkage.
- any target selector fields are present but not strings or string arrays.
- an attachment lacks a target or lifecycle policy.
- a transition references an unknown state.
- a check references an unknown tool, state, attachment, or target.
- any referenced `source.files` path is absolute, escapes the site/package root, or cannot be found when local validation is possible.

Dynamic JavaScript targets are validated at runtime. Static validation should check that source files exist and that handler/event names are safe, but it should not require proving that a dynamically registered handler exists before the page runs.

## Runtime Rules

The bridge runtime should:

- load and validate `actions.json` as a whole;
- expose no actions from an invalid manifest;
- compose imports according to namespace, trust, and override policy;
- select relevant `context[]` blocks based on current URL, state diagnostics, target predicates, and active task;
- treat context blocks as documentation, not as authority to call undeclared tools or cross privacy boundaries;
- validate every action call against the matched tool's `input_schema`;
- diagnose relevant state before executing stateful actions;
- resolve the declared `handler` inside the page when handler execution is selected;
- execute or test `execution.steps` according to `execution.mode`;
- observe transition rate limits and convergence conditions before repeating the tool named by a transition;
- install, remove, and reattach declared attachments according to target predicates and lifecycle policy;
- fail fast when the page runtime is not ready instead of queueing calls silently;
- return structured errors such as `unknown_action`, `invalid_input`, `runtime_not_ready`, `missing_handler`, `handler_failed`, `handler_timeout`, `invalid_result`, `target_not_found`, `state_mismatch`, `drift_detected`, and `unsafe_state`;
- validate page-originated events against `signals[]` before forwarding them to an agent;
- treat event payloads as structured data, not user text;
- preserve private storage boundaries across imports and protocol messages.

## Open Naming Decision

The prototype used a vendor-specific extension key. The portable schema should use a neutral extension key.

This proposal uses `x_actions`.

Alternatives:

- `action`: shorter, but risks colliding with existing tool schemas.
- `bridge`: describes runtime transport but undersells source-map guidance.
- `target`: clear for handler mapping but weaker for signals and prompt projection.

Recommendation: use `x_actions` for v1 because it preserves the existing extension-field pattern while making the standard vendor-neutral.
