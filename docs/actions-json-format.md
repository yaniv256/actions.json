# actions.json Format

An `actions.json` file describes how an agent can operate one website, web app,
or page surface.

It is meant to be readable by three audiences:

- an agent choosing what action to call;
- a browser runtime validating and executing that action;
- a human reviewer checking what authority the file grants.

Use this guide when writing or reviewing a site action map. For field-level
details, see the [Schema V1 Reference](schema-v1-proposal.md).

## What Belongs In actions.json

An action map should answer four questions:

1. **Where does this map apply?** Describe the site or surface.
2. **What can the agent do?** Declare named actions with input and output
   schemas.
3. **How does the runtime perform each action?** Reference primitive steps,
   handlers, targets, or attachments that the runtime can validate.
4. **How does the agent know whether the page still matches the map?** Include
   targets, states, checks, and observations where they are useful.

An `actions.json` file should not be a hidden automation script. Avoid opaque
JavaScript blobs. Prefer declared actions built from documented runtime
primitives, selectors, target descriptions, and result schemas.

## Minimal Shape

```json
{
  "protocol": "actions.json",
  "version": 1,
  "surface": {
    "origin": "https://example.com",
    "name": "Example task page"
  },
  "tools": []
}
```

`tools` may be empty when the file only provides metadata or context, but most
useful maps declare one or more actions.

## A Small Action Example

{% raw %}
```json
{
  "protocol": "actions.json",
  "version": 1,
  "surface": {
    "origin": "https://example.com",
    "name": "Example search page"
  },
  "tools": [
    {
      "name": "search.submit",
      "description": "Search for a query from the site search form.",
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
      "workflow": {
        "version": 1,
        "expression_language": "jsonata",
        "steps": [
          {
            "id": "findSearchInput",
            "primitive": "locator.element_info",
            "args": {
              "locator": { "selector": "input[name='q']" }
            }
          },
          {
            "id": "focusSearch",
            "primitive": "pointer.click",
            "args": {
              "x": "{% steps.findSearchInput.output.clickable_center.x %}",
              "y": "{% steps.findSearchInput.output.clickable_center.y %}"
            }
          },
          {
            "id": "typeQuery",
            "primitive": "text.insert",
            "args": {
              "text": "{% input.query %}",
              "mode": "replace"
            }
          },
          {
            "id": "submit",
            "primitive": "keyboard.press",
            "args": { "key": "Enter" }
          }
        ],
        "output": "{% {'ok': true, 'query': input.query} %}"
      }
    }
  ]
}
```
{% endraw %}

This example is intentionally small. Real maps can also declare context blocks,
states, transitions, attachments, imports, signals, and checks.

The `workflow` shape shown here is the implemented execution path: steps invoke
named primitives, {% raw %}`{% ... %}`{% endraw %} slots are JSONata expressions over `input` and
prior `steps.<id>.output`, and validation strictly rejects unknown workflow or
step fields and (when the runtime supplies its primitive dictionary) unknown
primitive names. Steps also support `when` conditions, bounded `for_each`
iteration, `retry_until` with `after_each` for scroll-until-visible patterns,
`settle_after` for SPA settling, and `on_error` stop/continue — see the schema
reference for the full contract.

Beyond tools, two more implemented blocks matter for real maps:

- `requires.primitive_dictionary` declares which runtime primitives the map's
  workflows depend on (required and optional), so a runtime can check support
  before operating.
- `state_projections` turn DOM records into compact logical JSON that agents
  read through `actions.site` modes `state_read`, `state_summary`, and
  `state_diff` for orientation and post-mutation verification. See the schema
  reference for the projection shape.

## Actions And Primitives

Agents should call site actions when they exist. A site action is a named,
reviewable operation such as `search.submit`, `inbox.open_message`, or
`catalog.collect_visible_items`.

Under the action, the runtime executes primitives such as:

- pointer movement and clicks;
- typing or key presses;
- viewport scrolling;
- locator inspection;
- DOM text extraction;
- overlay rendering;
- storage sync.

Some primitives are portable across extension and bookmarklet/embed hosts.
Others require privileged browser capabilities, such as screenshots or tab
management. A portable action should only use primitives available in the
portable runtime. If an action requires privileged capability, mark that
requirement clearly so bookmarklet/embed runtimes can reject it with a useful
error.

## Authoring Workflow

Use debugger tools to learn how a page works. Do not leave the learning trapped
in a one-off debugger call.

Recommended loop:

1. Load the relevant site storage.
2. Ask which actions already exist for the current site.
3. Use existing actions first.
4. If an action is missing or broken, use screenshots, DOM inspection, or
   debugger-only probes to understand the page.
5. Convert the discovery into an `actions.json` action using documented
   primitives, targets, inputs, outputs, and checks.
6. Reload or sync the updated storage.
7. Retest the workflow using the stored action, not the debugger.

The proof of a good action map is that the next agent can operate the page
through declared actions without rediscovering the implementation.

## Naming Actions

Use stable dotted names:

```text
surface.operation
surface.collection.operation
```

Examples:

- `search.submit`
- `carousel.collect_visible`
- `carousel.scroll_right`
- `overlay.open_categories`
- `profile.read_visible_posts`

Names should describe the user-visible operation, not the implementation detail.
Prefer `carousel.scroll_right` over `click_button_3`.

## What To Avoid

Avoid:

- absolute local file paths;
- private account identifiers in public maps;
- raw tokens, cookies, local storage, or secrets;
- site-specific debug scripts masquerading as portable actions;
- action names tied to a transient DOM layout;
- duplicated copies of actions already provided by an imported map;
- actions that click or type without describing the visible target.

## Next References

- Read [Schema V1 Reference](schema-v1-proposal.md) for field definitions.
- Read [Primitive Dictionary Architecture](primitive-dictionary-architecture.md)
  to understand portable and privileged primitive capability boundaries.
- Read [actions.json.storage](actions-json-storage.md) to understand where site
  maps, observations, runs, and overlays are stored.
