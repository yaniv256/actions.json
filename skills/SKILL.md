---
name: write-actions-json
description: Use when an agent is exploring a website, automating a browser workflow, converting browser discoveries into reusable actions.json actions, validating a site action map through MCP/runtime tools, or preparing public/shared website operating memory.
version: 0.1.6
---

# Write actions.json

Use this skill to turn website exploration into durable agent-operable memory.

`actions.json` is not a transcript of clicks. It is a reusable site map that lets
future agents ask, "what can I do on this site?" and then call established
actions instead of rediscovering the page.

## Mental Model

The project has three cooperating pieces:

- **Storage**: `actions.json.storage` holds learned site maps, observations,
  runs, items, and overlays. Private/dev work starts in private storage. Reviewed
  reusable artifacts are promoted or synced into public storage/public repo
  paths.
- **Runtime**: browser-side code that executes primitives and renders overlays.
  The Chrome extension is the privileged development host. The bookmarklet/embed
  runtime is the portable page-JavaScript host.
- **MCP-shaped bridge**: the current agent-facing adapter. It exposes stable
  generic HTTP tool-list/tool-call endpoints and routes calls to the selected
  runtime. It is not yet a fully conforming MCP server, and it should not create
  one tool per website.

The extension and bookmarklet should share the same primitive dictionary and
runtime contract. They differ only in host capability.

## Bridge Address Selection

Choose the bridge address based on where the browser runtime actually runs.
`localhost` and `127.0.0.1` are machine-local names, not project-local names.

- If the browser and bridge run in the same environment, the default MCP bridge
  launch is:

  ```bash
  actions-json-mcp mcp
  ```

  Use `ws://127.0.0.1:17345/extension` for extension WebSocket config.
  Agent tool calls should go through MCP `tools/list` and `tools/call`, not
  legacy HTTP tool endpoints.

- If Chrome runs on a different machine than the coding agent host where the
  bridge is running, do not use `127.0.0.1` in the extension config. That points
  Chrome at the browser machine, not the agent host. Launch the bridge on an
  externally reachable interface:

  ```bash
  actions-json-mcp mcp --bind 0.0.0.0:17345
  ```

  Then find the agent host's Tailscale IP and use it in the extension config:

  ```bash
  tailscale ip -4
  ```

  Configure the extension as `ws://<agent-host-tailscale-ip>:17345/extension`.

- Verify the boundary before debugging runtime code:

  ```bash
  # From the MCP client, read:
  # - actions-json://bridge/launch
  # - actions-json://bridge/tools
  # - actions-json://bridge/runtimes
  curl -sS http://127.0.0.1:17345/health
  curl -sS http://<agent-host-tailscale-ip>:17345/health
  ss -ltnp | rg ':17345'
  ```

  A listener on `127.0.0.1:17345` will refuse Tailscale connections even when
  Tailscale itself is healthy. For split-machine testing, the listener should
  show `0.0.0.0:17345` or a reachable non-loopback address.

When the extension reports `net::ERR_CONNECTION_REFUSED` from
`src/background.js`, first prove the bridge is listening on the address Chrome
is using. Treat this as a launch/bind problem until the Tailscale health
endpoint succeeds and MCP resource `actions-json://bridge/runtimes` shows the
expected connected runtime.

## Bridge Launch Contract

When validating unreleased or branch-local runtime capabilities, launch the real
MCP bridge from the same checkout/worktree as the extension artifact being
tested. Do not mix a newly installed extension with an older bridge binary or an
older actions catalog.

The bridge advertises model-facing tools from the manifest passed with
`--actions`, then augments that catalog from storage maps and built-in bridge
tools. A primitive being present in source code or in `primitive_dictionary` is
not enough; it must also appear in MCP `tools/list` and
`actions-json://bridge/tools` before an agent can call it.

For split-machine testing where Chrome runs on a Mac and the bridge runs on a
coding-agent host, the normal launch shape is:

```bash
cd /path/to/actions.json.dev
cargo build --manifest-path mcp/actions-json-mcp/Cargo.toml
./mcp/actions-json-mcp/target/debug/actions-json-mcp mcp \
  --bind 0.0.0.0:17345 \
  --actions /path/to/actions.json.dev/extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root /path/to/actions.json.storage
```

Then configure the extension with:

```text
ws://<coding-agent-host-tailscale-ip>:17345/extension
```

Before validating any website workflow, run all of these checks:

1. MCP `initialize` succeeds.
2. MCP `tools/list` includes the expected primitives and `actions.site`.
3. MCP `resources/read` for `actions-json://bridge/launch` shows the expected
   actions manifest and storage root.
4. MCP `resources/read` for `actions-json://bridge/runtimes` shows the browser
   tab after the extension connects.

If an expected primitive is missing from MCP `tools/list`, stop. Do not proceed
to site validation, and do not blame the website, the extension connection, or
the agent prompt. Inspect the launched bridge binary, the `--actions` manifest,
and `actions-json://bridge/tools`.

### Adding A New Generic Primitive: The Two Tool Surfaces

A new generic primitive (for example `overlay.menu.hide`) must be declared in
**two separate places** in the overlay actions manifest, because two different
consumers build their tool lists from different sections:

- `tools[]` — the array the **MCP bridge** advertises to direct callers. If a
  primitive is missing here, a direct call returns `unknown_action` (HTTP 400),
  and the tool never appears in MCP `tools/list` or
  `actions-json://bridge/tools`.
- `primitive_dictionary.primitives[]` — what the **extension's hosted-agent
  Realtime catalog** derives from. Each entry needs `summary` (non-empty),
  `support: "supported"`, an object `input_schema`, and an
  `x_actions.handler`. Missing or unsupported here means the hosted GPT agent
  never sees the tool.

Existing primitives such as `overlay.close` appear in **both**. Copy that exact
shape. Declaring a primitive in only one surface is the most common reason "I
added the primitive but the agent/bridge can't call it." Also wire the handler
into the content-script dispatch (`executeAction`) and, for catalog routability
tests, add it to the test's content-route allow-list.

Generic primitives are called as their **own** MCP tool (like `pointer.click`),
NOT through `actions.site mode=call`. `actions.site mode=call` resolves names
against the loaded **site** catalog (e.g. the Trello map); a generic primitive
is not a site action, so calling it that way returns `unknown_action`. Call
`overlay.menu.hide` directly; call `trello.card.due_date.set` through
`actions.site`.

### The Bridge Reads `--actions` Once, At Launch

The bridge loads its `--actions` manifest into memory when the process starts.
Editing or re-staging that file does **not** hot-reload it; the running process
keeps the version it launched with. `storage.sync` reloads **site storage maps**
into the browser runtime — it does **not** reload the bridge's own `--actions`
overlay manifest. To pick up a new generic primitive you must relaunch the
bridge process pointed at the updated manifest.

When the bridge is spawned by an MCP client config (e.g. `.claude.json`
`mcpServers.actions-json` with `command` + `--actions` args), updating the
staged manifest file is not enough: repoint both `command` and the `--actions`
path at the new staged build directory, then restart the client/session so it
respawns the bridge. Staged builds follow
`~/.local/share/actions-json-mcp/<version>-spec<NNN>/` containing the bridge
binary plus `overlay.actions.json`. If only the extension changed (not `mcp/`),
reuse the prior bridge binary and swap in the new manifest.

### A "Version" Is Three Independently-Loaded Artifacts

A new primitive's "0.1.x" version spans three artifacts that load separately and
do **not** update together:

1. the **bridge binary** (`actions-json-mcp`);
2. the **bridge `--actions` manifest** (overlay.actions.json the bridge reads at
   launch — governs which tools the bridge advertises);
3. the **Chrome extension** content.js/background.js (governs which handler
   actually runs when a primitive is dispatched).

Updating the staged manifest (#2) makes the bridge advertise and route the new
primitive — but if the loaded extension (#3) is older, the handler it routes to
is missing and the call fails inside the handler even though routing succeeded.
The manifest's `version` string does not prove the extension matches it. After
any change touching content.js, reload the Chrome extension from the build that
contains that content.js (the released zip, or an unpacked checkout of the right
branch) — a session or bridge restart alone does not reload the extension.

**Confirm by calling the primitive, not by probing from page-world JS.**
`debug.run_javascript` evaluates in the page's **main world**, but content
scripts run in an **isolated world**. A JS expando set on a DOM node from the
content script (e.g. `host.__someControl = {...}`) is **invisible to main-world
JS** — a main-world `!!host.__someControl` check returns a false `false` even
when it is attached and working. Do not conclude the extension is stale from such
a probe. Instead, call the primitive (which runs in the content-script world) and
check observable effects: computed styles, `dataset` attributes the handler sets,
or the handler's own return value. A real version mismatch shows up as the
primitive returning `unknown_action` (not advertised) or a handler error, never
as a missing expando seen from page world.

### Verify By Contract Before Concluding It Works

After any bridge relaunch for a new primitive, confirm the whole chain in order;
do not assume a restart worked:

1. `actions-json://bridge/launch` — `actions_manifest` points at the **intended**
   staged manifest path (not a stale older `-specNNN`).
2. `actions-json://bridge/tools` — the new primitive name is present (parse the
   JSON and check `tools[].name`; a raw substring grep can miss nested shapes).
3. The new primitive appears as a callable MCP tool in the client.
4. Only then call it. If the on-screen artifact predates the reload (e.g. an
   overlay rendered before the extension reloaded lacks a freshly-added control
   surface like `__actionsJsonMenuControl`), re-open it so the new code path
   runs and attaches the control before invoking the primitive.

## Setup Reference

If the runtime or MCP-shaped bridge is not installed or connected, read
`skills/references/getting-started.md`. This is a symlink to the canonical
public doc at `docs/getting-started.md`, so the skill and public documentation
share one source. Do not burden already-connected authoring sessions with setup
steps; load that reference only when installation, runtime selection, bridge
startup, or connection troubleshooting is needed.

## Documentation Routing

Read public docs selectively through the skill-local references in
`skills/references/docs/`. Do not bulk-load the whole docs set.

- `skills/references/docs/actions-json-format.md`: read when writing or
  reviewing an `actions.json` file, choosing manifest fields, or deciding what
  belongs in the action map.
- `skills/references/docs/schema-v1-proposal.md`: read when changing schema
  semantics, adding fields, defining targets/states/transitions/attachments, or
  reviewing whether an action map matches the current draft schema.
- `skills/references/docs/actions-bridge-protocol.md`: read when changing
  runtime-to-agent messages, action call/result/error shapes, runtime status,
  signals, or Responses-style item semantics.
- `skills/references/docs/bridge-architecture.md`: read when deciding where
  behavior belongs between skill, runtime, MCP-shaped bridge, transport, and
  browser host.
- `skills/references/docs/primitive-dictionary-architecture.md`: read when
  adding, classifying, or implementing primitives across extension/CDP,
  bookmarklet/embed, and mobile/browser hosts.
- `skills/references/docs/actions-json-storage.md`: read when changing
  `actions.json.storage` layout, observations, runs, items, overlays, or
  agent-written browser memory.
- `skills/references/docs/storage-visibility-scopes.md`: read when deciding
  whether an artifact is private, shared, or public, or when preparing storage
  promotion rules.
- `skills/references/docs/repo-structure.md`: read when moving files, adding
  packages/adapters, changing skill layout, or deciding where a new public
  artifact belongs.
- `skills/references/docs/index.md`: read when updating public documentation
  navigation, not as the primary source for design details.
- Use the public docs index (`docs/index.md`) when you need to route yourself to
  the current user-facing or contributor-facing reference. Public action-map
  work should rely on the shipped docs and source manifests, not on unpublished
  internal notes.

Development-team documents are not part of this public-docs reference set. If a
topic points to prototype history, private PR packaging, or implementation
planning rather than user-facing documentation, it belongs on the permanent
`internal-docs` orphan branch, not under the public docs references.

## Runtime Hosts

### Chrome Extension

Use the extension when the agent needs privileged browser abilities:

- true rendered screenshots without a browser permission dialog after the tab is
  authorized;
- controlled tab/session visibility;
- extension-assisted bookmarklet relay on pages whose CSP blocks direct
  bookmarklet transport;
- authoring/debugging fallbacks such as privileged JavaScript evaluation.

The extension is the primary authoring and development host. It is allowed to
see the browser surface after user authorization, but portable site actions
should still be expressed through the shared primitive dictionary.

### Bookmarklet / Embed

Use the bookmarklet to test what a future first-party website embed can do from
page JavaScript:

- local folder load/write flows for page-relevant storage bundles;
- portable point/input primitives;
- DOM observation and locator-to-point resolution;
- overlay rendering where the page permits it.

The bookmarklet cannot autonomously capture a true rendered screenshot. It can
only request user-consented browser capture. Many sites block direct bridge
transport to `127.0.0.1:17345` with Content Security Policy (CSP), so the
bookmarklet may need the Chrome extension relay even when the runtime being
tested is still the JavaScript/bookmarklet runtime. Bookmarklet overlays can
also fail or render with incorrect styling because they share the host page's
DOM, CSS, and security constraints.

The bookmarklet's main purpose is to simulate what a first-party website embed
can do from plain JavaScript. Extension-assisted transport is a test harness for
page-JavaScript behavior, not proof that standalone bookmarklet networking works
on every site.

## Stable MCP-Shaped Tool Pattern

Do not expect or create site-specific tools for every website. The current
bridge is MCP-shaped, not a fully conforming MCP server: it exposes stable HTTP
endpoints for tool listing and tool calling. The bridge should expose a small
stable surface, then let the agent interrogate site capabilities at runtime.

Expected stable flow:

1. List connected runtimes and choose the target runtime by runtime id or URL:
   `GET /runtimes`.
2. Confirm the stable tool surface is available:
   `GET /mcp/tools/list`.
3. Execute any tool call by posting a JSON body to the bridge:

   ```bash
   curl -s http://127.0.0.1:17345/mcp/tools/call \
     -H 'content-type: application/json' \
     --data '{ "name": "storage.list", "target_url_contains": "example.com", "arguments": {} }'
   ```

4. If storage changed, sync/reload the storage bundle without restarting the
   bridge:

   ```json
   {
     "name": "storage.sync",
     "target_url_contains": "example.com",
     "arguments": {}
   }
   ```

5. Ask `actions.site` what actions are available for the current site/surface:

   ```json
   {
     "name": "actions.site",
     "arguments": {
       "mode": "list",
       "target_url_contains": "example.com"
     }
   }
   ```

6. Call the selected stored action through `actions.site`, not as a globally
   advertised site-specific tool:

   ```json
   {
     "name": "actions.site",
     "target_url_contains": "example.com",
     "arguments": {
       "mode": "call",
       "action": "site.surface.operation",
       "arguments": {}
     },
     "timeout_ms": 10000
   }
   ```

7. Call primitive tools directly only when the operation is primitive-level work,
   not an already-learned site action:

   ```json
   {
     "name": "browser.screenshot",
     "target_runtime_id": "runtime-id-from-/runtimes",
     "arguments": {},
     "timeout_ms": 10000
   }
   ```

8. If a runtime disconnects, let it reconnect; do not require a bridge restart
   for ordinary `actions.json` edits.

Send the JSON examples above to `POST /mcp/tools/call`. Use
`target_runtime_id` when you know the exact runtime, or `target_url_contains`
when matching by URL is enough. If more than one runtime matches, select a
specific runtime id from `GET /runtimes`.

Representative tool concepts:

- `actions.site`: discover and call stored site actions for the current runtime.
- `storage.sync`: send the configured storage root bundle to the browser
  runtime. Page-relevant bridge sync is implementation pending.
- `storage.list`: inspect runtime-local storage state.
- `browser.screenshot`: true screenshot in extension; capability error or
  consent path in bookmarklet/embed.
- `debug.run_javascript`: privileged authoring fallback, not a portable action.
- `runtime.configure_pacing`: configure delays between human-observable actions.

### Read Session Logs From The Current Envelope

When inspecting `runtime.session.log`, do not guess at older wrapper shapes.
First print the raw response, then read events from the current primitive
envelope:

```bash
curl -sS http://<bridge-host>:17345/mcp/tools/call \
  -H 'content-type: application/json' \
  --data '{
    "name": "runtime.session.log",
    "target_runtime_id": "runtime-id-from-/runtimes",
    "arguments": { "limit": 2000 }
  }' | jq '.output.value'
```

The current successful shape is:

```json
{
  "ok": true,
  "call_id": "...",
  "output": {
    "adapter": "extension",
    "ok": true,
    "primitive": "runtime.session.log",
    "value": {
      "eventCount": 86,
      "events": []
    }
  },
  "error": null
}
```

Use `output.value.eventCount` and `output.value.events`. Do not treat the mere
presence of an `error` key as failure; check whether it is non-null and whether
top-level `ok` is false. If `output.value.events` is empty while the user just
ran a hosted-agent session, that is itself evidence to investigate logging or
session ownership rather than assuming there were no events.

### Verify Tool Availability By Contract

Do not treat a tool as available just because its name appears in a tool list.
For hosted Realtime and bridge-driven sessions, a tool is available only when
the whole contract is intact:

1. the primitive exists in the formal dictionary;
2. the active host declares it supported;
3. the shipped runtime artifact preserves its description and input schema;
4. the model-facing catalog exposes the normalized tool name and required
   parameters;
5. the model calls the tool with the required arguments;
6. the executor maps the normalized name back to the primitive name;
7. the runtime executes the primitive and logs the result.

For point navigation, specifically verify that `pointer.click` / `pointer_click`
has required `x` and `y` parameters. If a site action returns
`clickable_center`, the next portable operation should be a paced pointer action
using those coordinates. If navigation fails, inspect `runtime.session.log` by
boundary before changing prompts, adding primitives, or falling back to
JavaScript navigation.

If a model-facing tool fails with `unknown_action`, `bridge_tool_call_failed`,
`Failed to fetch`, or a missing required parameter, treat that as a contract
failure until proven otherwise. Check the bridge tool list, the shipped
primitive manifest, the hosted model catalog, and `runtime.session.log` routing
events. Do not infer that the website is unreadable or unclickable from a
catalog/runtime mismatch.

## Authoring Discipline

Use the debugger to learn. Use `actions.json` to operate.

Correct loop:

1. **Start from storage**: load the relevant site folder from
   `actions.json.storage` into the runtime. Prefer existing stored actions.
2. **Try stored actions first**: use `actions.site` or equivalent stable tool to
   inspect and call the actions already defined for the page.
3. **Use debugger only when stored actions are missing or broken**: run
   exploratory JavaScript, screenshots, DOM inspection, or CDP-style probes to
   understand the page.
4. **Translate discoveries into portable actions**: encode the useful operation
   in the site `actions.json` using existing primitives such as
   `locator.element_info`, `pointer.click`, `viewport.scroll`,
   `browser.extract_elements`, and `overlay.open`.
5. **Expose context as callable actions**: if the storage context says a page,
   section, step, card, resource, or overlay matters, add an action that can read
   or align that object on the live page. Context that cannot be queried or
   brought into view is only prose, not operating memory.
6. **Attach a neighboring skill when actions are not enough**: if proficient
   operation requires judgment, sequencing, persona, recovery tactics, or
   domain-specific teaching/sales/support behavior, add a `SKILL.md` beside the
   site `actions.json`. The action map should tell future agents to read it
   before operating the site. Actions answer "what can be done"; the skill
   answers "how to use those actions well."
7. **Score the artifact adversarially**: after the first draft, score the
   `actions.json` and neighboring skill before calling the work complete. Score
   the user's actual capability, not just selector count. A high site-map score
   is not enough if the agent still cannot do the job a visitor expects.
8. **Iterate until the target score is met**: repair every gap found by the
   score, sync/reload storage, retest through stored actions, and score again.
   Continue until the map reaches the declared quality target, normally at least
   95/100 for production or demo use.
9. **Reload/sync storage**: push the updated site map to the runtime without
   restarting the bridge.
10. **Retest using stored actions only**: the proof is that the agent can repeat
   the workflow without the debugger.
11. **Record evidence**: update observations/runs/items/overlays so the next
   agent can see what was tested and why. For validation runs, use
   `skills/references/run-evidence-template.md` — every success claim names its
   evidence, failures link to the matching failure pattern, and `untested` is
   mandatory.
12. **Promote or sync public artifacts**: when guidance is reusable and safe,
   mirror it into the public skill/storage surface rather than leaving it only
   in private scratch space.

Do not solve the user's task with `debug.run_javascript` and stop there. That
creates a one-off success and loses the learning. The debugger's output is raw
material for an `actions.json` action.

### Compound Workflow Actions

When a site operation naturally requires multiple primitives, encode the
sequence as one stored site action with a `workflow`. Do not make the model call
a geometry action and then separately call `pointer.click` when the sequence is
known. The model should select `actions.site`; the map should choreograph the
internal primitives.

Use workflow actions for common patterns:

- locate geometry, then click the returned `clickable_center`;
- locate two elements, then drag from one center to the other;
- scroll until a target becomes visible, then return its geometry;
- open a composer, insert text, press Enter, then verify with a read action;
- repeat a read action over a bounded list of candidates.

Workflow v1 uses JSONata expression slots for data binding. Use whole-string
expression slots only:

```json
{
  "name": "site.card.by_title.open",
  "input_schema": {
    "type": "object",
    "required": ["title"],
    "properties": {
      "title": { "type": "string" }
    },
    "additionalProperties": false
  },
  "workflow": {
    "version": 1,
    "expression_language": "jsonata",
    "steps": [
      {
        "id": "findCard",
        "primitive": "locator.element_info",
        "args": {
          "locator": {
            "selector": "[data-testid='card-name']",
            "text_contains": "{% input.title %}"
          }
        }
      },
      {
        "id": "clickCard",
        "primitive": "pointer.click",
        "args": {
          "x": "{% steps.findCard.output.clickable_center.x %}",
          "y": "{% steps.findCard.output.clickable_center.y %}"
        }
      }
    ],
    "output": "{% {'opened': input.title, 'card': steps.findCard.output} %}"
  }
}
```

Workflow context is:

- `input`: validated action arguments;
- `steps.<id>.output`: the normalized output from prior primitive steps;
- `item` and `index`: current item and index inside a bounded `for_each`.

Use `when` for conditional steps, `for_each` with `max_items` for bounded
iteration, and `retry_until` with `max_attempts` plus `after_each` for
scroll-until-visible patterns. Keep workflows sequential, bounded, and
human-observable. Mutating workflows must include a verification step or a
description that tells the caller what read action proves success.

Internal primitive steps inside a stored workflow do not require fallback
policy reports. Direct model calls to generic primitives still do.

Verified engine-contract facts to author against, not guess at:

- The recognized step fields are `primitive`, `args`, `when`, `for_each` (+
  `max_items`), `retry_until` (+ `max_attempts`, `after_each`), `settle_after`,
  and `on_error` (`"stop"` | `"continue"`). There is **no `finally`** — any
  cleanup that must run on both success and failure has to be a normal trailing
  step, reached by setting `on_error: "continue"` on the steps that might fail
  before it.
- `args` is optional. A no-argument primitive step (for example
  `overlay.menu.hide`) is valid with no `args` key.
- `settle_after` waits for a locator or delay after a step but its timeout is
  non-fatal — it does not, by itself, make the step fail. Do not rely on it as a
  postcondition; add an explicit verification step whose own success encodes the
  result.
- `retry_until` needs `max_attempts`; `after_each` must declare a `primitive`.
  Choose the `retry_until` predicate to match the axis of progress you are making
  (`candidate_count > 0` to prove an element is merely present;
  `clickable_center.x != null` to prove it is on-screen and clickable).
- For `viewport.scroll`, the scope element must pass `isElementVisible`; the
  engine then walks from it to the nearest scrollable ancestor whose axis matches
  your non-zero delta. Scope to a *visible* container, never to an off-screen
  target. Do not invent primitives — only the names in the primitive dictionary
  exist (there is no `locator.scroll_into_view`, `dom.click`, or `locator.fill`).
- In JSONata, comparing a missing path is silently false: `steps.x.output.y =
  null` does NOT detect absence, and its negation does not detect presence.
  Guard `when` conditions and `retry_until` predicates on optional outputs with
  `$exists(steps.x.output.y)`, never with `= null` / `!= null` alone, or a
  fallback branch will be skipped exactly when it is needed.

Before encoding any workflow step, gate it against the contract — every one of
these has been violated by a confident author who "knew" the field existed:

1. The `primitive` name appears in the site map's `required_primitives` /
   `optional_primitives` (and, for anything the model calls directly, in the
   bridge `tools/list`).
2. Every step field is in the recognized set above — anything else is silently
   meaningless or rejected.
3. Every expression is a whole-string `{% ... %}` slot, with `$exists()` guards
   on any path that can be absent.

When a stored action's first fix does not work, prove the next one against the
live page with the authoring debugger before encoding it. Read the actual DOM —
`elementFromPoint` at the intended click center, the target's bounding box and
viewport position, the real scrollable ancestor and its `scrollTop`/`scrollHeight`
— and confirm the mechanism un-blocks the operation, then encode exactly what you
proved. Name the root cause in one sentence before editing; if you cannot, you
are still diagnosing, not fixing. A green tool result is not proof; the verified
DOM state is. Fixing the same action twice means the first fix addressed a
symptom.

### Logical State Projections

When a website has meaningful application state, declare `state_projections`
next to the site actions. A state projection turns DOM records into compact
logical JSON that the agent can use for orientation, verification, and deltas.
Use this when screenshots or raw DOM reads would be expensive, ambiguous, or
too page-shaped for the task.

Use the standard stack:

- CSS selectors, and XPath only when needed, for DOM addressability;
- JSONata for transforming extracted records into logical JSON;
- JSON Schema for the projected state shape;
- JSON Pointer and JSON Patch vocabulary for paths and future deltas.

Do not invent a custom scripting language and do not write arbitrary page
JavaScript as the state reader. The runtime extracts safe DOM fields first, then
JSONata transforms those records.

Example:

```json
{
  "state_projections": [
    {
      "name": "trello.board",
      "description": "Logical board state: lists, cards, labels, due dates, and checklist summaries.",
      "snapshot": {
        "version": 1,
        "source": "dom",
        "extract": [
          {
            "id": "lists",
            "selector": "[data-testid='list-wrapper']",
            "many": true,
            "fields": {
              "name": {
                "selector": "[data-testid='list-name']",
                "property": "innerText",
                "trim": true,
                "required": true
              },
              "cards": {
                "selector": "[data-testid='card-name']",
                "many": true,
                "fields": {
                  "title": { "property": "innerText", "trim": true },
                  "url": { "attribute": "href" }
                }
              }
            }
          }
        ],
        "projection": {
          "language": "jsonata",
          "expression": "{% {'board': {'lists': $append([], $map(records.lists, function($list) { {'name': $list.name, 'cards': $count($list.cards) > 0 ? $append([], $map($list.cards, function($card) { {'title': $card.title, 'url': $card.url} })) : []} }))}} %}"
        },
        "output_schema": {
          "type": "object",
          "required": ["board"],
          "properties": {
            "board": { "type": "object" }
          }
        }
      },
      "summaries": [
        {
          "name": "agent_context",
          "max_bytes": 12000,
          "expression": "{% {'lists': $append([], $map(state.board.lists, function($list) { {'name': $list.name, 'card_count': $count($list.cards)} }))} %}"
        }
      ]
    }
  ]
}
```

JSONata array shape matters. `$map()` can collapse singleton arrays and can
produce surprising placeholder values for empty collections if you do not guard
them. For state projections, explicitly preserve arrays with `$append([], ...)`
and guard empty collections with `$count(collection) > 0 ? ... : []`. Absence
is equally treacherous: a comparison against a missing path is silently false
in both directions, so test optional fields with `$exists(...)`, not with
`= null` or `!= null`.

Author projections so the agent can call:

- `actions.site` with `mode=list` to discover available projections;
- `actions.site` with `mode=state_summary` for compact orientation;
- `actions.site` with `mode=state_read` for exact state;
- `actions.site` with `mode=state_diff` to see what changed since the last
  full state snapshot.

Prefer `state_summary` before full `state_read` when the state might be large.
If the runtime returns `state_payload_too_large`, narrow the projection or use a
summary instead of trying to force a huge payload through the data channel.

### Iterate Toward A Minimal State Representation

A state projection's first draft is a hypothesis, not a deliverable. Author it,
measure it against the live page, and shrink it until it represents the
logical state and nothing else. Large payloads are acceptable only on the
debug path while you iterate; they are never acceptable in the final map.

The iteration loop:

1. **Measure before trusting.** Run `mode=state_read` and look at three
   numbers: the payload byte size, the `diagnostics.selector_counts`, and the
   entity counts you can verify on the visible page. If the selector counts do
   not match what a human sees (7 lists on screen, 14 in the diagnostics), the
   extraction is over-matching and every record is being duplicated.
2. **Use exactly one container selector per logical entity.** Defensive
   OR-chains (`[data-testid='card-name'], a[href*='/c/'],
   [data-testid='trello-card'], ...`) feel robust but match several elements
   per entity, multiplying record counts and payload size. Pick the one
   selector that wraps the entity once, and anchor every field as a
   sub-selector inside it. Verify containment on the live DOM with the
   debugger before encoding it.
3. **Project only fields the agent acts on.** Identity, position, the labels
   and dates that drive decisions. Anything an agent merely *might* ask about
   belongs in a narrower read action, not in every snapshot.
4. **Keep the full state in single-digit kilobytes for a typical page.** The
   engine enforces hard byte budgets on expression output, full state, and
   summaries; a projection near those limits on a normal page will fail on a
   busy one. Summaries must fit their declared `max_bytes` with room to
   spare.
5. **Re-run and compare.** After each narrowing pass, run `state_read` again
   and check the byte size dropped while the verified entity counts stayed
   exact. Then run a mutation and `state_diff` to confirm the patch describes
   the change in one or two operations — noisy diffs are a sign the
   projection still carries unstable or duplicated data.

The bridge's payload spill (oversized results written to disk with a compact
envelope, threshold via `bridge.payloads.configure`) exists so an oversized
intermediate result cannot wreck the authoring session. It is a debugging
aid. If a finished map's state modes routinely spill or return
`state_payload_too_large`, the projection is wrong — fix the selectors or the
projection expression; do not raise the threshold and ship it.

Worked example: the `trello.board` projection initially failed every state
mode with `expression_output_too_large`. Diagnostics showed 14 list records
for 7 visible lists and 126 card records for 21 visible cards — the list
selector matched both `list-wrapper` and the `list` it contains, and the card
OR-chain matched up to six elements per card. Narrowing to one container
selector each (`list-wrapper`, `list-card`) with anchored field sub-selectors
cut the state from over 32 KB to 8.9 KB with exact entity counts, and diffs
of a single card creation produced exactly two patch operations.

### Adversarial Scoring Rubric

Every non-trivial site map needs an explicit quality score. Write the score in
the action map, a neighboring `quality-score.md`, or both. The score should name
the current target, list gaps, and say what must change before the next pass.

Use a 100-point rubric adapted to the website:

- **Operational completeness (25)**: covers every operation required for an
  agent to be proficient on the site or surface. Include reads, navigation,
  creation/editing flows, recovery paths, verification actions, and safe
  boundaries. If the user showed a tutorial, demo, or target workflow, every
  operation in that evidence must be represented or explicitly deferred.
- **Actionability and portability (15)**: actions are callable through the
  stable runtime contract and prefer visible, human-like primitives. Mutating
  actions include preconditions, success checks, and rollback/recovery notes.
  Privileged debugger actions are marked authoring-only or extension-only.
- **Navigation and state alignment (15)**: the agent can tell where it is,
  bring relevant content into view, return from places it can reach, handle
  menus/popovers/modals/tabs, and keep the visible page aligned with the
  conversation.
- **Context and knowledge loading (15)**: the map exposes the facts, pages,
  products, articles, tutorial evidence, overlays, and reference files the
  agent needs at session start and during operation. Important adjacent `*.md`
  files or `SKILL.md` references are named explicitly.
- **Neighboring skill quality (10)**: the site skill explains sequencing,
  judgment calls, common failure modes, verification loops, and when to use
  each action family. It should not repeat the raw JSON; it should teach
  proficiency.
- **Persona and user-fit behavior (10)**: the map/skill defines what role the
  agent should embody on this site, such as teacher, sales guide, support
  navigator, productivity assistant, or research host. It should say what
  questions to ask the visitor and how to adapt to their goals.
- **Evidence and validation (10)**: the score names how the map was tested,
  which stored actions were used without debugger help, what logs/screenshots
  proved, and what remains untested.

If the score is below target, do not stop at the score. Convert each gap into
an edit, resync storage, run the relevant workflow again, and rescore. The loop
ends only when the target is reached or the remaining gaps are explicitly
declared out of scope by the user.

Before scoring persona or proficiency, interview the user when the answer is
not obvious from the website. Ask what "a proficient agent on this site" means:
what it should help visitors accomplish, what tone or role it should embody,
what operations are sensitive, and what evidence counts as success.

## Website Mapping Failure Patterns

Every failed operation should improve the site map. Do not treat a failed click,
navigation, screenshot, or extraction as a one-off runtime problem until you
have checked whether the website map is missing state, preconditions, or a
portable path.

Route from the symptom you are seeing to the pattern that explains it before
proposing any fix:

| Symptom | Read first |
|---------|-----------|
| Action reported success but the page did not change | The Overlay Occludes The Page It Operates; Postconditions Must Assert The Specific Result |
| Element found with a `clickable_center`, but clicking never activates it | The Overlay Occludes The Page It Operates |
| Intermittent per-item failures across a batch (some items work, others never do) | The Overlay Occludes The Page It Operates (position-dependent); Scroll Both Axes |
| `candidate_count > 0` but no `clickable_center` | Scroll Both Axes; A Container Can Hold An Off-Screen Element |
| `target_not_found` for an element you can see in the DOM | Hidden DOM Is Not A Clickable Affordance; Navigation Is Often Stateful |
| A workflow fails at a late step with an error that does not name the real cause | Keystone Preconditions Fail Fast |
| A read returns wrong, stale, or boilerplate text instead of failing | Keystone Preconditions Fail Fast (scoped reads); Postconditions Must Assert The Specific Result |
| Zero-result text read | Text Read Failures Need Selector Evidence |
| The operation succeeds on the page but the tool call times out | Budget The Workflow's Worst Case |
| The agent plans a multi-item job, does one or two items, and declares it done | Batch Jobs Stall Without An External Queue |
| A model-facing tool returns `unknown_action` or a missing-parameter error | Verify Tool Availability By Contract (above) |
| The agent hunts a page section with repeated small scrolls | Scroll With Measured Targets |

### Navigation Is Often Stateful

Do not map navigation as "find link and click" until you know whether the link
is always visible. Many sites hide links behind sidebars, hamburger menus,
accordions, tabs, popovers, or nav groups.

For stateful navigation, write actions in this shape:

1. Read the navigation state, such as `aria-expanded`, selected tab, visible
   panel, current route, or open menu label.
2. Resolve the parent toggle only if the desired group is closed.
3. Click the parent toggle with `pointer.click`.
4. Resolve the now-visible child link with `locator.element_info`.
5. Click the child link with `pointer.click`.
6. Verify the new URL or page state with `page.info`, `dom.list_sections`, or a
   site-specific read action.

Avoid non-idempotent actions like "click the Try It toggle" unless the action
description says when to click it. A toggle clicked twice closes what it opened.
Prefer paired actions such as:

- `site.nav.groups.read`: returns labels and expanded/collapsed state.
- `site.nav.<group>_toggle_info`: returns the clickable center for the group
  toggle and says to click only when the group is collapsed.
- `site.nav.<destination>_info`: returns the child link center after its parent
  group is open.

### Hidden DOM Is Not A Clickable Affordance

It is common for links to exist in the DOM while their bounding box is zero or
their parent is collapsed. Treat these as discovered but not actionable.

When a link exists but `locator.element_info` says `target_not_found`:

- extract nearby nav buttons and their state;
- inspect whether the link is inside a collapsed region;
- add a state-read action for the region;
- add an expand-if-collapsed path before the child-link action;
- retest through stored actions only.

Do not weaken the locator to click hidden elements. The point of the portable
runtime is to operate through visible user-like affordances.

### Text Read Failures Need Selector Evidence

Never say that page text is unavailable until you have disproved the selector,
state, and tool-contract alternatives.

A zero-result DOM read usually means "this query did not match," not "the page
cannot be read." Before concluding that text is unavailable:

1. Confirm the active URL, scroll position, and open/closed page state.
2. Ask `actions.site` for existing read or alignment actions for the current
   surface.
3. Try a narrow stored action first when one exists.
4. If a generic DOM primitive returns nothing, inspect the selector's meaning.
   `section,[role=region]` misses pages whose content is in standalone `h1`,
   `h2`, `span`, `li`, or card nodes.
5. Retry with a broader text-bearing selector such as `main *, article *, body *`
   and an explicit `heading_selector` such as
   `h1,h2,h3,h4,[role='heading'],strong`.
6. Cross-check with another read primitive, such as `locator.text_content`,
   `dom.snapshot_text`, `browser.extract_elements`, or a screenshot only when
   visual truth is required.
7. If storage context already names the object, add a specific stored action
   rather than forcing future agents to rediscover it generically.

For numbered steps, timelines, carousels, resource grids, and menus, write at
least two actions:

- a collection action, such as `site.surface.steps.list`, that lists visible or
  rendered items with enough text to identify them;
- an item geometry/actionability action, such as
  `site.surface.step_two_info`, that resolves the specific item to viewport
  geometry for `viewport.scroll` or `pointer.click`.

The collection action answers "what is here?" The geometry action answers "how
do I align the page with the thing we are discussing?" Both are needed for a
voice guide that keeps the visible page synchronized with the conversation.

### Scroll With Measured Targets

When a visitor asks to go to a specific part of a long page, do not make the
agent scroll repeatedly in small increments. That looks clumsy and often misses
the target.

Write a measured-scroll playbook or action for long pages:

1. Call the page's section/list action first.
2. Match the requested topic to a section heading or card label.
3. Compute one decisive scroll delta from the current `scroll_y` to the target
   section's `scroll_y`, subtracting a sticky-header offset when needed.
4. Call `viewport.scroll` once with that measured delta.
5. Verify the target heading or section is visible.
6. Make at most one corrective measured scroll.

Record the formula in the site map, for example:

```text
delta_y = target_section.scroll_y - current_scroll_y - sticky_header_offset
```

The agent should not narrate its internal scroll mechanics. It can say a short
phrase such as "I'll take you there," execute the measured action, then confirm
the visible section.

### Preserve Commercial And Attribution Links Exactly

For affiliate links, sponsor links, citation links, checkout/cart links, and
other attribution-sensitive URLs, preserve the exact `href` from the page. Do
not expand shortlinks, remove query parameters, canonicalize retailer URLs, or
replace them with a cleaner-looking destination.

When a site includes recommendations or product references:

- add an action such as `site.topic.affiliate_links` or
  `site.products.cart_catalog` that returns the exact observed `href` values;
- include the visible label, merchant/source, `rel`, target, and the page where
  the link was observed;
- add a live extraction action when the page can be authorized, so future agents
  can verify current links before quoting them;
- instruct the agent to show the exact URL when recommending the item.

This is not only a commerce concern. It protects attribution, analytics,
affiliate revenue, and the website owner's intended routing.

### Build Product Guides As Interview Flows

For websites that sell products, courses, services, or paid workshops, a useful
agent is not just a product index. It should interview the visitor to discover
fit before recommending anything.

Create a product-guide layer with:

- a scored action such as `site.products.score` that evaluates product-guide
  readiness separately from general site coverage;
- a catalog action listing every product, bundle, course, or service with its
  name, type, explanation, best-fit visitor profile, primary page, and observed
  cart or purchase URL when appropriate;
- an interview action with diagnostic questions about the visitor's goal,
  current tools, skill level, constraints, and buying intent;
- recommendation rules that map visitor signals to one or two best-fit options;
- comparison actions for bundles or related offers;
- explicit boundaries for cart, checkout, payment, credential entry, account
  login, and other sensitive operations.

Allow cart initiation only when the user explicitly asks for it and the site
owner wants that behavior. Even then, separate "add/request cart" from checkout:
the agent may route to or click a cart link after confirmation, but payment,
billing, personal data, credentials, and final purchase confirmation stay under
direct user control unless the product explicitly defines a consent model.

### Prefer User-Like Navigation Over Script Navigation

Website CSP commonly blocks string evaluation and script navigation. A failure
such as "unsafe-eval is not an allowed source of script" is a mapping signal,
not permission to keep trying JavaScript.

For navigation, try in this order:

1. Stored site navigation actions through `actions.site`.
2. Visible locator resolution plus `pointer.click`.
3. Menu/group expansion plus visible child-link click.
4. Only then use `debug.run_javascript` to discover structure, and convert the
   discovery back into portable actions.

Do not encode final navigation behavior as `browser.run_javascript` unless the
project explicitly marks that action as privileged and non-portable.

### Screenshots Are Expensive Evidence

Use screenshots when visual truth matters, but do not make every page read
depend on screenshots. Prefer DOM reads for text, links, cards, tables, and nav
state. In hosted Realtime sessions, screenshots may need compact capture
constraints so the tool result does not overwhelm the data channel.

When a screenshot causes a hang or disconnect:

- pull `runtime.session.log`;
- check whether `browser.screenshot` completed and whether the failure happened
  while returning the result to the model;
- retry with compact arguments such as JPEG format, bounded width/height,
  quality, size budget, and timeout;
- add or update a DOM read action when the user only needs text or structure.

### The Overlay Occludes The Page It Operates

The actions.json menu overlay is a real DOM element on the page, with a high
z-index, sitting over part of the site. Any element the overlay covers is not
clickable: a `pointer.click` at that point lands on the overlay, not the target,
and the click silently does nothing. This is the single most common cause of
"the action ran and reported success but nothing happened" on a click-heavy
site.

Symptoms that point here:

- a card/button/link is found (`locator.element_info` returns a
  `clickable_center`) but clicking it never opens or activates anything;
- the failure is intermittent across a batch — items outside the overlay's
  rectangle succeed, items under it fail;
- `document.elementFromPoint(cx, cy)` (via the authoring debugger) returns a
  high-z-index `position: fixed` element with no site `data-testid`, or the
  overlay host (for example `#__actions_json_menu_overlay_host`), instead of the
  target.

The fix is **hide-operate-unhide**, encoded inside the stored action, not left
to the agent's memory. Any click-heavy action should:

1. `overlay.menu.hide` before the scroll/find/click sequence;
2. do the visible work with the overlay out of the way;
3. `overlay.menu.show` afterward, as a trailing step with
   `on_error: "continue"` so the overlay is restored even when the operation
   failed.

The workflow engine has no `finally` step, so restoration cannot hang off the
gate step. Put `overlay.menu.show` as its own trailing step and make the
verification step that precedes it `on_error: "continue"`, so a failed
postcondition still falls through to the restore. Verify the un-occlusion before
encoding: hide the overlay, then confirm `elementFromPoint` at the target's
center now returns the target element.

### Postconditions Must Assert The Specific Result, Not "Something Happened"

A mutating action that opens or selects a specific object must verify that **the
requested object** is now active — not merely that *an* object of that kind is
present. A generic postcondition is a false-positive waiting to happen.

Two traps seen together on the same action:

- **Always-true postcondition.** Checking only that a logical state projection
  returned `ok` proves nothing — the projection is valid whether or not the
  click worked. A `settle_after` that is treated as non-fatal is not a
  postcondition either; if its timeout is swallowed, the step "succeeds" on a
  click that missed.
- **Stale-object match.** If a previous object of the same kind is still open, a
  selector like `[data-testid='card-back-name']` matches the *old* one and the
  check passes for the wrong target. Always start the action from a known base
  state (for example, press Escape and `settle_after` the prior modal becoming
  `hidden`) so a leftover object cannot satisfy the check.

Write the postcondition to bind the target identity. Prefer a title/text-scoped
locator (`[data-testid='card-back-name']` with `text_contains: "{% input.title
%}"`) or a URL assertion that the page reached the expected `/path`. Surface the
honest result in the action's `output` (for example a boolean
`card_back_open`) so the caller or recipe can gate on it, rather than reporting
unconditional success.

### Scroll Both Axes; A Container Can Hold An Off-Screen Element

`viewport.scroll` scoped to one container moves one axis of one scroll context.
A long page often has nested scrollers: an outer container that pages
horizontally (columns, lists) and inner containers that scroll vertically
(a column's items). An element can be present in the DOM but unreachable because
it is scrolled out of an *inner* container that your discovery step never moves.

Symptom: `locator.element_info` for the target returns `candidate_count > 0`
(the element exists) but no `clickable_center` (it is off-screen), and paging the
outer container horizontally never brings it into view because the offset is
vertical.

Split discovery into two retry loops, one per axis:

1. **Find the container.** Loop `locator.element_info` for the target until
   `candidate_count > 0`, scrolling the *outer* container (for example
   `[data-testid='lists']`, `delta_x`) in `after_each`. This proves the target's
   group is rendered even while the target row is scrolled off.
2. **Bring the target into view.** Loop `locator.element_info` until
   `clickable_center` resolves, scrolling the target's *inner* container
   vertically in `after_each`.

The scope trick for step 2: an inner scroll container is itself visible and its
`textContent` still includes the target's text even when the target row is
scrolled out of view. So scope the vertical scroll to the inner container plus
the target text — `{ "selector": "[data-testid='list-cards']", "text_contains":
"{% input.title %}", "root_strategy": "scope" }` with `delta_y` — and the engine
resolves it to exactly the right vertical scroller (`findScopedElement` requires
the scope element be visible, which the container is; `findScrollableElement`
then picks the vertical scroller because you passed `delta_y`).

Do not scope the scroll to the off-screen target element itself: it fails
`isElementVisible`, so the scope will not resolve. And do not invent a primitive
to do this — there is no `locator.scroll_into_view`. Use `viewport.scroll` with a
scope that resolves to a *visible* scrollable ancestor, which is the only
supported mechanism.

### Keystone Preconditions Fail Fast

A keystone step is one that every later step in the workflow depends on — the
modal is open, the page navigated, the popover rendered. Putting
`on_error: "continue"` on a keystone step does not make the workflow robust; it
makes it dishonest. When the keystone fails, every downstream step no-ops or
misfires against the wrong state, and the workflow finally fails at the *last*
step with an error that names the wrong cause. The author then debugs the
popover when the card never opened.

Policy:

- `on_error: "continue"` is for genuinely optional steps — restoring an
  overlay, an alternate branch guarded by `when`, a best-effort cleanup.
- A precondition the rest of the workflow depends on must stop the workflow,
  with its own step id and evidence in the error. A clear early failure is
  cheaper than a misleading late one.
- The same rule applies to reads. A read that *succeeds* against the wrong
  scope is worse than a failed read: a `body` fallback can "successfully"
  return hidden noscript boilerplate when the modal it was meant to read never
  opened, sending the agent to a confident wrong conclusion. Scope every read
  to the target container so a missing target returns a clean `target_not_found`
  instead of plausible garbage. Fix the lying observation before fixing
  anything it reported.

### Budget The Workflow's Worst Case

A workflow's worst-case duration is the sum of every `settle_after` timeout,
every `retry_until` attempt with its `after_each` wait, and every primitive's
own latency. The dispatch budget for an `actions.site` call defaults to 30
seconds (`timeout_ms`). If the worst case exceeds the dispatch budget, the
workflow can succeed on the page and still time out at the bridge — the
operation happened, the caller saw a failure, and the agent retries something
that already worked.

When authoring:

1. Sum the worst case. A 12s settle plus a 3-attempt verify loop with 2s waits
   is already 18s before any primitive latency; two such sequences cannot fit a
   30s budget.
2. Keep verification after a `settle_after` cheap. The settle already waited
   for the locator; the verification step confirms identity, it does not need
   its own retry loop with long waits.
3. When a workflow legitimately needs a long worst case (multi-axis scrolling,
   month paging), say so in the action description so the caller raises
   `timeout_ms`, and keep each retry bounded.
4. A timeout report from the caller does not mean the operation failed. Before
   re-running a mutating action after a timeout, verify current state with a
   read or `state_diff` — the mutation may have landed.

### Batch Jobs Stall Without An External Queue

Agents reliably plan a multi-item job, execute one or two items, and then
declare the run complete — the plan lived only in conversation context, and the
loop pressure faded. Do not fight this with prompt exhortations; externalize
the loop.

The runtime provides a session-scoped task queue as primitives: `task.add`
(one `text` or a `tasks` array, FIFO), `task.next` (pull and mark in-progress),
`task.complete` (report `done` or `failed` with a short `result` note),
`task.list`, and `task.clear`. Confirm the runtime advertises them before
relying on the loop.

The batch shape that holds:

1. Seed the entire plan first with `task.add` — one task per item, each task
   text naming the concrete target and the intended change ("<card title> ->
   set due date to <date>").
2. Loop: `task.next` → do the item through stored actions → verify the result
   with a read or `state_diff` → `task.complete` with a result note. Do not
   pause between items to check in; continue until `task.next` returns
   `done: true`.
3. A task pulled but never completed is returned again by the next `task.next`
   — the queue does not skip stalled work. If an item genuinely cannot be done
   after a real attempt, report it `failed` with the precise reason and move
   on; one item's failure must not end the batch.
4. The empty-queue `task.next` response includes every task's status and
   result. Build the final report from that grounded summary, not from memory.
5. Failed items are diagnostic gold: identical failure notes across items point
   to a single broken stored action. Fix the action at the root, resync
   storage, re-seed only the failed items, and drain again. Do not retry
   in-loop against a broken action.

### Convert The Failure Into A Durable Action

After diagnosing a failure, update the relevant `actions.json` file immediately.
The new action should encode the missing precondition or state transition, not
just the final endpoint. Then sync storage and repeat the user's workflow using
only stored actions.

## Primitive Policy

Prefer human-visible point-based actions first:

- `locator.element_info` to find a target's viewport box and clickable center;
- `pointer.move` before click-like actions when the surface is visible;
- `pointer.click`, `pointer.double_click`, and `pointer.drag`;
- `viewport.scroll` for page or scoped carousel/region movement;
- `text.insert` and page-level `keyboard.press` where supported.

Use DOM reads freely for observation and extraction:

- `page.info`
- `dom.observe.visible`
- `dom.snapshot_text`
- `locator.text_content`
- `locator.wait_for`
- `browser.extract_elements`

Verify each read primitive against the active runtime before relying on it in a
hosted Realtime session. If a read primitive is present in one catalog but not
executable by the current runtime, use a supported primitive or add the missing
runtime mapping; do not paper over the gap with a prompt.

Keep direct DOM mutation deferred unless the project explicitly adds a consent
and safety model. Do not invent portable actions such as `dom.click`,
`locator.click`, or `locator.fill` just because they would be convenient.

Human-observable primitives should be paced. Clicks, pointer moves, scrolls,
text insertion, and key presses should not fire in suspicious machine bursts.
Use the runtime pacing configuration when available; DOM reads and storage
inspection do not need pacing.

## Storage Layout

Common site map paths:

```text
actions.json.storage/
  scopes/
    private/sites/<host>/<surface>/actions.json
    public/sites/<host>/<surface>/actions.json
```

Site folders may also contain:

```text
items/*.items.json
observations/*.jsonl
overlays/*.overlay.json
overlays/*.html
runs/*.json
```

Use private storage for raw observations, unreviewed screenshots, personal
state, and working drafts. Use public storage/public repo paths for reviewed,
redacted, reusable maps, overlays, examples, and skills.

## Syncing Private/Dev Work To Public

Public repos are not staging areas. Do not push to a public repo, even by
opening a public PR, until the private/dev PR has been reviewed and the user has
explicitly approved public promotion.

When syncing private/dev work to public:

- copy only reviewed content;
- remove personal browsing state and private identifiers;
- preserve relative paths so overlays can reference their files;
- keep the public skill files synchronized with the private/dev skill files when
  the guidance is meant for future agents.

## Writing Site Actions

For each action, capture:

- stable action name;
- human-readable purpose;
- input schema and required arguments;
- output/result shape;
- primitive binding or handler name;
- selectors, locator text, or extraction rules;
- readiness/precondition notes;
- expected capability requirements;
- failure modes and evidence.

Good actions are reusable operations: "list visible cards in this carousel",
"advance this carousel right", "open the stored categories overlay", "capture
creator analytics cards". Poor actions are one-off click transcripts.

For pages that are meant to support a knowledgeable voice guide, include actions
for both knowledge and alignment:

- `*.context` or `*.summary` actions for the durable facts the agent should know;
- `*.list` actions for collections the agent may discuss;
- `*.info` actions for specific links/headings/cards with geometry;
- `*.open` or `*.navigate` actions only when the visible click path and
  postcondition are known;
- `*.overlay` actions for reusable visual explanations.

Do not leave important thought-leadership content only in free-form context
fields. If a visitor can ask about it, the agent needs a callable way to confirm
the relevant page/section and, when useful, bring it into view.

## Verification Checklist

Before calling a site map ready:

- Existing stored actions were tried before debugger fallback.
- Any debugger discovery was converted into `actions.json`.
- The updated storage bundle was synced/reloaded without a bridge restart.
- The workflow was repeated through stored actions only.
- Extension behavior was checked for privileged authoring capabilities when
  screenshots or tab control mattered.
- Bookmarklet/embed behavior was checked for portable page-JS parity when the
  action is meant to run as an embed.
- Human-observable actions are paced.
- Direct DOM mutation primitives were not introduced as Stage 1 portable
  actions.
- Text-read failures were disproved with alternate selectors/read primitives
  before being reported as website limitations.
- Every workflow primitive name was verified against the primitive dictionary,
  and every step field against the recognized engine set — nothing invented.
- Each workflow's worst-case duration (settles + retries + waits) fits the
  dispatch timeout, or the action description tells the caller to raise it.
- Mutating actions bind target identity in their postcondition (title-scoped
  locator or URL assertion), and keystone precondition steps stop on error
  rather than continue.
- Every fix encoded after a failure was first proven against the live DOM with
  the authoring debugger, with the root cause named in one sentence.
- Multi-item batch flows seed the task queue and drain it to the grounded
  empty-queue summary rather than holding the plan in conversation context.
- Context that the agent is expected to discuss has matching read/list/info or
  alignment actions, not only prose.
- Model-facing tools were checked against the active runtime executor; catalog
  mismatches were fixed or recorded as capability gaps.
- Observations/runs/items/overlays were updated with useful evidence.
- Reviewed reusable material was synced or promoted to the public surface.

## Report Back

When finished, report:

- which runtime(s) were used;
- which storage folder and `actions.json` files changed;
- which stored actions were added or modified;
- what was learned through debugger tools, if any;
- proof that stored actions now work without debugger fallback;
- what was kept private and what was synced/promoted to public;
- remaining capability gaps or uncertain selectors.
