---
name: write-actions-json
description: Use when an agent is exploring a website, automating a browser workflow, converting browser discoveries into reusable actions.json actions, validating a site action map through MCP/runtime tools, or preparing public/shared website operating memory.
version: 0.1.11
---

# Write actions.json

Use this skill to turn website exploration into durable agent-operable memory.

`actions.json` is not a transcript of clicks. It is a reusable site map that lets
future agents ask, "what can I do on this site?" and then call established
actions instead of rediscovering the page.

## The Authoring Role: Fix The Tool, Do Not Do The Task

**This is the single most important instruction in this skill, and the most
common failure mode to guard against.** When you author `actions.json`, your job
is to **build, fix, and shape the TOOLS and the map that will guide any LLM
operating this website** — not to accomplish the end task yourself.

When the site-driving agent can't do something — a tool is missing, broken,
mis-described, or the agent doesn't even know it exists — your instinct will be
to reach in and *just do it yourself* (call the primitive directly, click the
control, hand-edit the document). **That instinct is the bug.** Doing the task by
hand:

- fixes it once, for this one run, and leaves the next agent exactly as stuck;
- often makes things *worse* (a hand-run edit without the tool's guardrails); and
- hides the real defect (a missing/undiscoverable/underspecified tool) instead of
  repairing it.

So when the agent is blocked, diagnose **why the agent couldn't do it**, and fix
*that*:

- **Tool missing?** Build the site action / primitive.
- **Tool broken?** Fix the workflow or the underlying primitive (it may be a
  runtime/extension change, not just a map edit).
- **Tool works but the agent didn't use it?** The map is not giving the agent the
  *state of affairs*: add it to the map's `prompt`/`instructions` and the
  `*.map` static output so the agent learns the tool exists and when to reach for
  it. Agents do not use tools they were never told about — they pixel-hunt or give
  up instead. (Concrete: an agent reported a tool "isn't in my toolset" when it
  was callable via `actions.site list` — the map's prompt simply never mentioned
  it.)
- **Tool exists but is hard to find at runtime?** Point the agent at
  `actions.site mode=list` in the map instructions.

Then let the AGENT run the task with the fixed tool, and verify by contract. You
are shaping the experience of every future LLM on this site; a document you
hand-edited teaches nothing. **Fix the tool, not the document.**

## Authoring Is UX Engineering For A Blind Consumer (And The Consumer Is The LLM)

Hold this mental model the whole time you author: **`actions.json` is a user
experience, the user is an LLM agent navigating a website, and that agent is
functionally a ~95%-blind screen-reader user.** (Not fully blind — it can take a
screenshot and squint, that's the ~5%, but it must not rely on that; design the
blind-first path.) So the entire canon of UX design — and specifically
*accessibility design for blind people* — is your design language. You are not
writing a config file; you are designing how it *feels* to operate this site with
almost no eyes. Every principle below is a real UX/accessibility heuristic
translated into an authoring directive.

**From accessibility design for blind / screen-reader users** (the closest human
analog to your consumer):

- **Structure over layout; name over position.** A screen-reader user navigates by
  semantic structure and by *name*, never by where something sits on screen. So
  bind every target by its accessible name / role / stable attribute, NEVER by
  pixel geometry or rendered position (which the agent can't perceive and which
  shifts). This is why `a11y.query {role, name}` is the first-choice resolver.
- **Navigate by position and structure, NOT by text search (no Ctrl+F editing).**
  Do NOT build editing/navigation affordances on find/Ctrl+F. It is **fragile** —
  it breaks on invisible characters (a stray non-breaking space defeats an exact
  match), and the match count is often stale/lying. And it is **non-human**: a
  person editing a document they've been working on already knows where things are
  from having read it — they place the cursor and edit; they do not search for a
  paragraph they just wrote. The correct foundation for structural editing is
  **positional**: read the current content and order, address a location by
  cursor / paragraph index / outline node, and edit there. If a surface only
  offers text-search today, that is a *missing positional primitive to build*, not
  a Find recipe to ship. (Learned the hard way on Google Docs: every Find-based
  edit tool — replace, delete, insert-heading, format, select-and-type — was
  fragile and got removed in favor of a positional foundation.)
- **No contextless labels.** "Click here" is useless to a blind user reading a
  flat list of links out of context; likewise a site action named `do_it` or
  `action_3` is useless to an agent scanning `actions.site list`. Name every
  action and argument so it is self-explanatory *out of context* — the name is the
  entire affordance.
- **One thing at a time; the consumer can't scan.** A sighted user takes in a
  whole page at a glance; a screen-reader user (and your agent) receives content
  serially, one piece at a time. So don't assume the agent "sees" the page — give
  it a *reading order*: a `docs.map`/`*.map` overview action, state projections
  that summarize "what's here and what can I do", and a recommended sequence.
- **Announce state; never make them guess where they are.** Blind users depend on
  the system announcing status and location. Your maps must do the same: after a
  mutation, expose how to VERIFY it (read-back / projection), and surface "where am
  I / what changed" — this is the actions.json version of an ARIA live region.
- **POUR** (WCAG): make every capability **Perceivable** (discoverable via
  `actions.site list` + named in the map prompt), **Operable** (a real action, not
  a recipe the agent must improvise), **Understandable** (self-describing names +
  the map's `prompt` explaining the surface), and **Robust** (bound to stable
  identity so it survives redesigns).

**From general UX heuristics** (Nielsen), each re-read for a blind LLM consumer:

- **Visibility of system status.** The map must tell the agent the state of
  affairs — what tools exist, what mode the surface is in, what just happened.
  (An agent that says a tool "isn't in my toolset" when it's callable is a
  *status-visibility* failure in your map's `prompt`, not an agent failure.)
- **Match the agent's world.** Describe actions in the agent's terms and the
  site's real concepts, not internal implementation trivia.
- **User control & freedom / error prevention.** Prefer reversible actions and name
  the irreversible ones loudly (`archive` vs `delete`); require confirmation-shaped
  arguments for destructive ops; make postconditions assert the *specific* result.
- **Consistency & standards.** Name and shape actions the same way across every map
  (`site.surface.operation`), so an agent that learned one map can predict the next.
- **Recognition rather than recall.** Let the agent *discover* capabilities
  (`actions.site list`, `*.map`) instead of having to remember or re-derive them.
- **Aesthetic & minimalist / flexibility.** A small, sharp, well-named action set
  beats a sprawling one; every extra ambiguous action is noise in the agent's
  serial reading channel.
- **Help the agent recover.** Action outputs should carry a `next_step` that says
  what to do or how to verify — diagnostic, in the agent's language.

The through-line: **when you author a map, you are the UX designer for a blind
agent. Design the experience you would want if you were operating this site with
no eyes — clear names, announced state, reversible-by-default, discoverable,
serial-order-friendly.** See [[accessibility-is-for-blind-agents]]. Sources: WCAG
POUR + screen-reader UX practice; Nielsen's 10 usability heuristics.

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

Do not use privileged extension-only debugger APIs as the stable implementation
of generic actions. `chrome.debugger`, screenshots, and debugger-world
evaluation are diagnostic capabilities, not the final semantics of a site action
or generic primitive. A generic primitive such as `text.insert` must have a
portable JavaScript-level behavior that can also run in bookmarklet/embed
runtimes. If an operation requires extension-only privileges, expose it as an
explicit debug or nonportable capability and do not let site actions depend on
it for normal operation.

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
`skills/write-actions-json/references/getting-started.md`. This is a symlink to the canonical
public doc at `docs/getting-started.md`, so the skill and public documentation
share one source. Do not burden already-connected authoring sessions with setup
steps; load that reference only when installation, runtime selection, bridge
startup, or connection troubleshooting is needed.

## Documentation Routing

Read public docs selectively through the skill-local references in
`skills/write-actions-json/references/docs/`. Do not bulk-load the whole docs set.

- `skills/write-actions-json/references/docs/actions-json-format.md`: read when writing or
  reviewing an `actions.json` file, choosing manifest fields, or deciding what
  belongs in the action map.
- `skills/write-actions-json/references/docs/schema-v1-proposal.md`: read when changing schema
  semantics, adding fields, defining targets/states/transitions/attachments, or
  reviewing whether an action map matches the current draft schema.
- `skills/write-actions-json/references/docs/actions-bridge-protocol.md`: read when changing
  runtime-to-agent messages, action call/result/error shapes, runtime status,
  signals, or Responses-style item semantics.
- `skills/write-actions-json/references/docs/bridge-architecture.md`: read when deciding where
  behavior belongs between skill, runtime, MCP-shaped bridge, transport, and
  browser host.
- `skills/write-actions-json/references/docs/primitive-dictionary-architecture.md`: read when
  adding, classifying, or implementing primitives across extension/CDP,
  bookmarklet/embed, and mobile/browser hosts.
- `skills/write-actions-json/references/docs/actions-json-storage.md`: read when changing
  `actions.json.storage` layout, observations, runs, items, overlays, or
  agent-written browser memory.
- `skills/write-actions-json/references/docs/storage-visibility-scopes.md`: read when deciding
  whether an artifact is private, shared, or public, when preparing storage
  promotion rules, **and before editing or adding any map action, or whenever a
  map exists in more than one scope** (private is probed before public and wins —
  see "Storage Scopes & The Private→Public Development Process").
- `skills/write-actions-json/references/docs/repo-structure.md`: read when moving files, adding
  packages/adapters, changing skill layout, or deciding where a new public
  artifact belongs.
- `skills/write-actions-json/references/docs/index.md`: read when updating public documentation
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

A clickable coordinate is not proof of activation. Some controls only respond
after the page has entered a hover, focus, expanded, or otherwise armed state.
When a locator resolves with `fully_visible: true` and `clickable: true` but the
postcondition does not change, do not keep trying nearby coordinates. Identify
the minimal human-observable activation sequence, such as
`overlay.menu.hide -> locator.element_info -> pointer.move -> pointer.click ->
state projection`, then encode that sequence in the site action and verify it
through the hosted Realtime agent. The action output should report which
activation steps ran so later investigations can distinguish "could not find
the control" from "found it but did not activate it."

If a model-facing tool fails with `unknown_action`, `bridge_tool_call_failed`,
`Failed to fetch`, or a missing required parameter, treat that as a contract
failure until proven otherwise. Check the bridge tool list, the shipped
primitive manifest, the hosted model catalog, and `runtime.session.log` routing
events. Do not infer that the website is unreadable or unclickable from a
catalog/runtime mismatch.

## Authoring Discipline

**Writing convention for this skill.** The reader is authoring a map for *some*
website, not the one you happened to learn a lesson on. Write every guideline as
a general principle first; cite a specific site only as a labeled *example*. When
an example uses site-specific jargon or a proprietary term (a framework name, a
URL parameter, an internal mode, a selector convention), introduce it as an
example and give the one-clause context a stranger to that site needs — e.g.
"ProseMirror (a rich-text editor framework)", "LinkedIn's `/preload/` iframe (a
child frame it paints the view into)". Never assume the reader knows a term that
is specific to one site.

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
8. **Run the production pipeline for durable maps**: before demo, shared, or
   public preparation, run the offline pipeline from the repo checkout:

   ```bash
   node tools/actions-json-pipeline/bin/actions-json.js audit <map-or-site-folder>
   node tools/actions-json-pipeline/bin/actions-json.js score <map-or-site-folder>
   node tools/actions-json-pipeline/bin/actions-json.js package <map-or-site-folder>
   node tools/actions-json-pipeline/bin/actions-json.js promotion-prep <map-or-site-folder>
   ```

   Use `audit` to catch broad selectors, weak mutating-workflow
   postconditions, and missing declared files. Use `score` to combine
   mechanical findings with explicit agent/operator readiness judgments. Use
   `package` after validation runs to preserve the tested map, task list,
   action log, failures/fixes, score report, accepted gaps, and important
   screenshot metadata beside the site map. Use `promotion-prep` to create the
   review bundle before any shared or public copy.
9. **Iterate until the target score is met**: repair every gap found by the
   score, sync/reload storage, retest through stored actions, and score again.
   Continue until the map reaches the declared quality target, normally at least
   95/100 for production or demo use.
   For mutating workflows, the mechanical audit must be clean for state-machine
   shape: no `missing_overlay_invariant`, `missing_mutation_readiness`,
   `retry_condition_mismatch`, `missing_postcondition`, `weak_postcondition`,
   or `broad_selector` findings on the mutation path. These are not cosmetic
   score nits; each corresponds to a known failure mode where an agent can click
   the wrong surface, wait for the wrong condition, or claim success without the
   user's requested state changing.
10. **Reload/sync storage**: push the updated site map to the runtime without
   restarting the bridge.
11. **Retest using stored actions only**: the proof is that the agent can repeat
   the workflow without the debugger.
12. **Harvest failures into authoring principles**: when an action fails, do not
   treat it only as a local selector or timing bug. First name the general
   authoring lesson: what assumption was unsafe, what state boundary was
   unproven, what postcondition was missing, or what workflow shape invited the
   failure. If the lesson applies beyond the current site, update this skill or
   the relevant reusable authoring guidance before reworking the site map. Then
   implement the concrete fix from the improved principle and retest. If the fix
   fails, iterate on the principle, not just the selector.
13. **Record evidence**: update observations/runs/items/overlays so the next
   agent can see what was tested and why. For validation runs, use
   `skills/write-actions-json/references/run-evidence-template.md` — every success claim names its
   evidence, failures link to the matching failure pattern, and `untested` is
   mandatory.
14. **Promote or sync public artifacts**: when guidance is reusable and safe,
   first run `promotion-prep` and review redaction/attribution status. Shared or
   public writes are outside v1 automation and require explicit operator
   approval. Then mirror approved guidance into the public skill/storage surface
   rather than leaving it only in private scratch space.

Do not solve the user's task with `debug.run_javascript` and stop there. That
creates a one-off success and loses the learning. The debugger's output is raw
material for an `actions.json` action.

### Pipeline Findings Are Map Work, Not Runtime Work

Treat production-pipeline findings as action-map quality signals. Fix broad
selectors by scoping the map. Fix weak postconditions by adding state-backed
verification. Fix missing declared files by creating or removing the declaration.

Do not use pipeline findings to paper over runtime or bridge failures. If a
primitive is missing from MCP `tools/list`, the bridge launched with an old
manifest, the extension handler is stale, or runtime routing is broken, repair
that contract at the runtime/bridge layer before changing the site map.

### What A Workflow Can Do (read this BEFORE reaching for a new primitive)

A `workflow` is not a linear macro. It is a small program. Before you conclude
"a workflow can't express this, so I need a new primitive," know what it already
does — because the answer is almost always "yes, it can":

- **Sequential steps** — any ordered list of primitive calls.
- **Loops** — `for_each` over a jsonata array (with `max_items`, cap 50), binding
  `item` and `index` per iteration. To repeat a fixed action N times, iterate
  `{% [1..input.n] %}`. **Yes, workflows loop.**
- **Conditionals** — `when` gates a step on a jsonata predicate.
- **Retry / poll** — `retry_until` (with `max_attempts`) plus `after_each` for
  scroll-until-visible and settle-then-check patterns.
- **Data flow** — jsonata over `input` (validated args), `steps.<id>.output`
  (prior step results), and `item`/`index` inside a loop.
- **Typed output** — a jsonata `output` expression shapes the return value.

Engine source of truth: `extensions/chrome-overlay-runtime/src/agent/workflow-actions.mjs`.
When unsure whether the engine supports a control-flow shape, READ that file —
do not assert a limit from memory.

> **GATE — do not invent a primitive to do what a workflow can compose.** A new
> PRIMITIVE is the heaviest, most expensive path in this whole system: it is an
> extension/bridge code change requiring the three-artifact release (extension +
> bridge binary + `--actions` manifest) and a human install/restart. The
> composition layer (workflows over existing primitives) is FREE — a map edit +
> `storage.sync`, no release. So **before authoring any new primitive, you MUST
> first write the composed-workflow sketch (`for_each` / `when` / `retry_until`
> over existing primitives) and show it genuinely cannot work.** "This needs a
> primitive because a workflow can't do X" is an ATTRACTOR — it exonerates your
> design instinct and blames a plausible-sounding platform limit; it is usually
> wrong. Verify the limit against `workflow-actions.mjs`, not your mental model.
> (Real instance, 2026-07-06: built a whole `cursor.to_paragraph` primitive + cut
> a release on the false belief "workflows can't loop" — `for_each` had existed
> all along. See `investigations/workflow-loop-capability-blindspot.md`.)

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

### Workflows Are State Machines, Not Optimistic Macros

Do not write a mutating workflow as one long hopeful script that assumes every
prior click produced the intended UI state. A workflow that resets page state,
finds an object, opens it, opens a nested editor, mutates it, closes it, and
claims success without proved boundaries is fragile even if it passes once.

Design mutating workflows as explicit state machines:

1. **Precondition**: prove the starting surface. If the page might be on a modal,
   route, popover, drawer, or horizontally scrolled region, add an action or
   step that returns to the intended surface and then verifies that surface.
   `Escape` or `Back` is not a state reset unless a read step proves the result.
   A prose precondition in the action description is not enough. If an action
   depends on a route, modal, editor, popover, selected object, active tab, or
   scroll region, declare it in `workflow.x_state_machine.requires_state` and
   assert the same selector/text in a pre-mutation `locator.wait_for`,
   `locator.element_info`, or `locator.text_content` step.
   If a workflow is completing, checking off, closing, or otherwise updating an
   item that lives on an owner surface, the owner surface is part of the
   precondition. For example, a validation checklist item lives on the validation
   card, not on the temporary card created while doing the validation. Remember
   the owner identity before navigating away, return to it before the completion
   mutation, and assert that the exact item exists on the owner surface before
   clicking anything.
2. **Readiness**: prove the specific next control exists before mutating it.
   Container readiness is not control readiness: a card title being visible does
   not prove the `Dates` badge, `Remove` button, save button, or target menu item
   is mounted and clickable.
3. **Transition**: perform one visible operation from a proved state, such as
   opening a card, composer, menu, popover, or editor. Bind pointer coordinates
   to the readiness step's `clickable_center`; do not click constants or broad
   candidate lists and hope downstream filtering picked the right target.
4. **Postcondition**: immediately read the new state with a locator, text read,
   candidate action, or state projection that proves the transition occurred and
   proves the target object is the intended object.
5. **Next transition**: only continue after the postcondition succeeds. If it
   fails, stop with a useful failure rather than clicking the next control in a
   stale state.
6. **Cleanup/recovery**: leave the page in a known state for the next call, and
   make the failure boundary recoverable. Close popovers/modals that the next
   call would otherwise inherit, and restore agent-owned overlays only after the
   mutation/postcondition boundary.
7. **Final verification**: for user-visible mutations, verify the logical state
   changed through a state projection or equivalent read. A clicked button,
   successful workflow result, or closed modal is not enough.

Editor and rich-text actions need stricter identity than ordinary buttons:

- Do not fall back from a semantic editor locator to generic
  `textarea`/`[contenteditable='true']` within a modal. That can type into a
  title, comment box, checklist item, search field, or another rich-text surface.
- The text insertion target must itself carry semantic identity: `aria-label`,
  `placeholder`, `data-testid`, a known editor-body class, or a verified wrapper
  specific to the intended field. If the site has separate title/body editors,
  prove which one is active before typing.
- Rich-text replacement must follow the browser/editor editing path. Do not
  clear `textContent` on a contenteditable and then insert text; controlled
  editors — rich-text editor frameworks that keep their own document model, such
  as ProseMirror or Atlassian Editor — can show the mutated DOM while keeping a
  different internal document model, so Save commits stale or empty state. Replace by focusing the semantic editor, selecting the editor contents,
  inserting text through a native/user-equivalent input path when available, and
  verifying the saved projection after the component's own commit control runs.
- For portable runtimes, prefer JavaScript-level editor event surfaces before
  DOM mutation. A synthetic `paste`/`beforeinput` path that the editor handles is
  more likely to update the editor's internal model than direct `textContent`
  replacement. Extension-only debugger input can be used to diagnose a page, but
  it must not become the final implementation of a generic primitive or site
  action.
- Commit controls must be scoped to the same component as the editor. A generic
  `button` with text `Save` inside a modal is not enough when the modal can
  contain description, checklist, comment, label, and date editors. Prefer a
  component-specific commit selector such as a field-specific `data-testid` or
  an adjacent control inside the verified editor wrapper, and treat commit
  settle timeouts as failures rather than recoverable noise.
- After opening an editor, assert the editor body state before `text.insert`;
  after insertion, assert the associated Save/commit control or a verified
  autosave signal before claiming success.
- Treat a pre-save DOM observation as an intermediate diagnostic, not a pass
  condition. The action contract is only satisfied after the site commit
  boundary has run and a reopened modal, refreshed projection, or other
  persisted state surface contains the exact requested value.
- If navigation, route change, modal close, or lost selectors occur between
  steps, stop at that boundary. Re-open/re-align and reassert
  `requires_state`; do not keep executing mutation steps against stale state.

**Keyboard focus does not always return to where you assume after a transient
UI closes.** When a recipe opens a transient surface that owns keyboard focus —
an overlay search/find field, a command palette, an inline popover input — and
then closes it to continue typing elsewhere, the focus may **not** return to the
previous element. Later `text.type`/arrow/Enter steps then land in the wrong
place (often the just-closed field). This bites hardest on app-managed editors
where focus and selection are owned by the application rather than by DOM focus
(canvas-rendered editors are the extreme case — e.g. Google Docs/Slides/Sheets,
where the visible surface is a `<canvas>`), but any focus-stealing overlay can
cause it.
- **It is a focus-ownership problem, not a timing one.** Adding `settle_after`
  delay does not fix it — the focus never transfers no matter how long you wait.
  A recipe that must type into a target *after* using such a surface needs an
  **explicit re-focus step** on that target (a trusted click on it, or a focus
  primitive) before the typing steps — do not assume closing the overlay
  restores focus.
- **Prefer patterns that act on the surface's own selection/controls**, which
  sidestep the focus transfer entirely: operate through the surface's buttons,
  or apply an operation to a selection the surface leaves in place, rather than
  closing it and re-typing from a caret you have to re-establish.
- **Don't over-attribute to the trusted/untrusted input boundary** — that is a
  known hypothesis-space attractor; the usual real cause is wrong focus or
  edit-mode state, not event trust. Confirm which element actually holds focus
  before blaming input trust.
- **Verification pitfall — validate the recipe the way it will actually run.** If
  you exercise a recipe by driving primitives one at a time with a
  `browser.screenshot` between steps, be aware the screenshot can re-activate the
  tab and incidentally move focus — so a manual, screenshot-interleaved run
  "passes" while the packaged workflow (no such side effects) fails, and you
  chase a phantom timing/primitive difference. Validate through the same path the
  action runs in production (the packaged workflow via `actions.site`); a manual
  success that depends on your observation tool is not a passing recipe.

When supported by the runtime, add `workflow.x_state_machine` metadata with the
states the workflow implements (`precondition`, `readiness`, `mutation`,
`postcondition`, `cleanup`, `recovery`) so reviewers and mechanical audit tools
can distinguish deliberate state transitions from click transcripts.

Prefer small composable actions for repeated UI boundaries:

- `surface.ensure_open` or `surface.reset_and_verify`;
- `object.open_by_identity`;
- `object.editor.open_and_verify`;
- `editor.mutate`;
- `object.verify_state` or a state projection read.

Then expose a higher-level recipe or orchestration action only after the smaller
actions are independently validated and their preconditions are documented. If a
high-level action is still useful, it should call or inline the same proved
state boundaries and should be validated by repeated consecutive calls, because
single-call validation does not expose stale route/modal/popover state.

The Trello due-date clear failure is the canonical warning pattern: an action
that worked once failed under repeated calls because it assumed `Escape` returned
from `/c/...` card routes to a clean board state and assumed the existing
due-date badge would be visible before opening the date popover. The right fix is
not "add another retry"; it is to make route/modal reset, card identity,
date-editor opening, removal, and board-state verification separate proved
boundaries.

Do not make an internal selector the identity of a user-visible control when the
page already exposes a logical value. Internal attributes such as `data-testid`
are useful fast paths, but they can vary by layout, route, account state,
responsive breakpoint, or component implementation. For stateful controls, carry
the visible state fact from a projection or prior read into the action, then
select the control by that visible fact and geometry. Examples: choose a due-date
button by the visible date text (`Jun 18`) rather than only by Trello's internal
date-badge test id; choose a move-list option by the visible list name rather
than by option order; choose a label by visible label text/color rather than a
generated DOM id. Treat internal selectors as accelerators, not the proof of
identity.

Resolve semantic user intent to exact state before parameterized mutations.
Users say "the matching validation item", "the next unfinished task", "the
relevant row", or "that contact"; mutating actions usually need exact strings,
ids, positions, or visible labels. Do not let the model invent those parameters
from the user's phrasing. Provide a low-token projection for the current surface
that lists the candidate entities with exact user-visible text and state, then
instruct the agent to copy an exact value from that projection into the mutation
action. Keep the mutator strict: if the exact item is absent, it should fail
rather than click a nearby or paraphrased target. The Trello checklist failure is
the canonical example: "mark the matching validation item complete" must first
read unchecked checklist items, bind the completed work to an exact checklist
item string, and only then call the exact checklist completer.

Treat validation and progress markers as evidence gates, not bookkeeping. A
checkbox, status label, progress badge, or "validated" field must only be
mutated after the underlying requested operation has succeeded and a projection
proves the requested outcome. If the agent cannot perform or verify the
underlying operation, it should report the blocker and leave the marker
unchanged. Provide a repair action for false positives when the UI supports it
(for example, unchecking a validation item), but do not rely on repair as the
normal path. The Trello Linear-import failure is the canonical example: the
agent could not see or import a Linear task, yet checked the Linear validation
item; the fix is to gate checklist completion on verified import evidence and
provide an exact `uncomplete` recovery action.

When a task depends on provenance, keyword matches are not evidence. "Imported
from Linear", "copied from LinkedIn", "synced from email", and similar claims
require a source projection that carries origin evidence: a source URL, issue
key, profile URL, transfer-buffer record, copied payload, or authorized source
tab state. A target app record whose title merely contains the source product's
name is not enough. Encode provenance-bearing projections and make completion
or validation actions depend on them instead of letting the model infer origin
from matching words.

Cross-tab workflows must discover capabilities on the source surface before
refusing. A destination catalog such as Trello cannot prove whether Linear or
LinkedIn body-read actions exist. For transfer tasks, the agent must list
claimed tabs, activate the source tab, inspect that source site's `actions.site`
catalog, and attempt the relevant source projection before saying source details
are unavailable. Encode this explicitly in destination-site guidance, because a
hosted agent may otherwise see only the destination actions and prematurely
refuse.

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
- **When a step needs a real inter-operation DWELL** (let an animated menu open,
  a search widget register, a dialog blur before the next key), use the
  `settle_after: { "delay_ms": N }` FIELD on that step — it is a genuine timed
  wait (`setTimeout`). Do **not** insert a `locator.wait_for` as its own step to
  create the delay: `wait_for` returns instantly when the element is already
  present/visible, so it is a **no-op** and buys zero time. This is a recurring
  self-inflicted trap — an author reaches for a `wait_for` step to "settle,"
  sees it do nothing, then wrongly concludes timing is not the issue. The delay
  knobs are `settle_after: { delay_ms }` (linear step dwell) and, inside a
  `retry_until` loop, `after_each` (dwell between attempts). Reach for those, not
  a standalone `wait_for`.
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

Projection coverage is a first-class part of authoring an `actions.json`, not a
nice-to-have after the click paths work. For every important state the map can
navigate into, the map should also provide a named, low-token projection or
read action that tells the agent what is currently true in that state. A board
needs a board projection; an opened card needs a card-detail projection; a
popover needs a popover projection; a modal editor needs an editor projection.
If the agent can open a state but cannot inspect it structurally, the map is
not complete for that state.

This is the replacement for screenshot-driven operation. Screenshots are useful
evidence during authoring, but they are token-heavy and visually ambiguous.
The finished map should let the hosted agent orient itself with compact JSON:
identity, visible controls, selected values, editable fields, rows/items, and
any truncation or virtualization limits. A projection that only returns "some
text from the modal" is not enough when the state has separate logical parts
the agent must act on, such as title, list, labels, due date, description,
checklists, and comments.

Spatial coverage is part of projection coverage. Build site-specific
projections from reusable spatial primitives instead of hand-inventing geometry
for every site. The runtime should provide standard building blocks such as
viewport bounds, clipping containers, scroll ranges, visible rectangles,
scroll-reachable targets, and progressive-loading frontiers. The site projection
then translates those generic facts into domain language: Trello lists/cards,
options rows, conversations, table pages, or modal fields.

A robust projection does not only say what is visible right now; it
distinguishes three layers:

1. **Clickable now**: controls/items whose visible rect is large enough for a
   user-like pointer click.
2. **Scroll-reachable now**: rendered controls/items outside the current clipped
   region, with the scroll container, axis, and delta needed to bring them fully
   into view.
3. **Load frontier**: scroll boundaries or virtualized regions where more
   content is expected to appear only after scrolling, with `complete: false`
   and a reason such as `virtualized`, `infinite_scroll`, or
   `collapsed_until_scrolled`.

When a locator fails, do not collapse these into `target_not_found`. First ask
whether the element is absent, rendered-but-clipped, partially visible, or
blocked behind a load frontier. Good actions expose that geometry to the agent
so it can make one measured scroll, then verify visibility before clicking.

Author state coverage alongside navigation:

1. For each state in `states[]`, add at least one projection or read action that
   answers "what can the agent see and decide from here?"
2. For each mutating action, name the projection that proves the postcondition.
3. For each nested surface opened by an action, add a matching projection before
   declaring the action reliable.
4. Include coverage metadata when the page virtualizes or collapses data:
   `complete: true/false`, visible item counts, expected counts when visible,
   and a clear `truncation_reason` instead of silently returning partial state.
   If the page hides completed rows, filters items, or virtualizes long lists,
   the projection must say so explicitly and must not let the agent infer that
   missing rows are absent. A checklist projection that returns only mounted
   rows must expose the visible count, known total/progress when available, the
   filter/collapse state, and a next action for revealing or scrolling more
   rows.
5. Prefer several focused projections over one giant raw text dump. The goal is
   low-token situational awareness at every step of navigation.

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

### Validate Through The Hosted Realtime Agent

Direct MCP calls prove that a primitive or stored action can execute. They do
not prove that a GPT Realtime user-facing agent can choose the right operation,
sequence it correctly, recover from intermediate state, and explain the result
honestly. For any action map meant for the hosted voice agent, the acceptance
test is a conversation with the hosted Realtime agent.

Treat this as the normal development cycle for production-grade maps:

1. Write or update the projections and actions.
2. Sync storage into the connected runtime.
3. Start or restart the hosted Realtime agent in text-only mode when doing
   developer validation.
4. Send a user-style task prompt with `runtime.agent.user_message`.
5. Read `runtime.session.log` and inspect transcripts, tool calls, tool
   outputs, and failures.
6. Assign blame at three levels: the local map/action line, the abstract
   anti-pattern, and the authoring style principle that would have prevented it.
7. Update the authoring principle or site-specific skill when a general lesson
   exists, then update the action map.
8. Repeat with a fresh user-style prompt until the hosted agent completes the
   task reliably and verifies its own result through projections.

Restart the hosted validation session after changing action descriptions,
available actions, neighboring skills, or projection names. `storage.sync`
updates what the runtime can execute, but an already-running model may continue
from old catalog context, old plans, or old failure memories. A same-session
retry is useful for recovery testing; it is not a clean discovery test for a
new or renamed operating surface.

User-style means the prompt should sound like a real user, not like an
actions.json author. Do not tell the hosted agent DOM selectors, primitive
names, action names, projection names, internal IDs, or the expected tool
sequence unless the test is explicitly a diagnostic catalog test. A real user
says, "Move the Record demo card to today" or "Read the checklist on this card
and do each item." They do not say, "Call `trello.card.detail.read`, then scroll
`.window main` by 500 pixels." If the agent only succeeds with internal hints,
the map or prompt context is still incomplete.

Build a user-task regression set from the real work the agent is expected to do.
Each test prompt should describe the desired outcome, the relevant public object
name, and any safety boundary a user would know, such as "do not edit the demo
card." It should not describe how the agent should navigate, which action to
call, what selector to use, or which projection will prove success. The point of
the test is to verify the hosted agent's judgment over the map, not the
author's memory of the map internals.

When the goal is reliability, test the same way the product will be used:
simulate a human asking for real work in ordinary language. The test prompt
should not mention internal operation names, DOM element names, action-map
terminology, workflow steps, or state-projection labels. If the task is "clear
the due dates from these three cards," ask exactly that; do not ask the agent to
call the due-date clearer, open the date popover, inspect a named projection, or
use a particular selector. The reliable unit is the whole hosted-agent loop:
user intent to agent interpretation to projection-based orientation to action
selection to verified website state.

Keep the loop honest by making the hosted agent do the operation. Do not perform
the website task yourself through direct MCP calls and then count that as
validation. Direct calls are for diagnosis, mechanism discovery, and proving a
candidate fix before encoding it. The acceptance run is the hosted agent
receiving a normal user request, choosing actions from the catalog, using
projections to orient itself, mutating only the intended state, and reporting
what it verified. If the hosted agent needs a detailed script from the author,
the `actions.json` is not yet an operating surface.

After each failure, extract the reusable failure mode. The output should not be
only "selector X was wrong"; it should name the robust interaction style the map
must teach. Examples: "opened state needs its own projection," "batch work needs
an external queue," "custom selects require selected-option verification,"
"offscreen content requires a named scroll action for the correct container."
Encode the principle first when it generalizes, then encode the local fix.

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
proposing any fix. This table is a menu of candidates, not a lookup that returns
one answer: a single symptom row often lists several patterns because the symptom
is generic and the causes are many. Read *Explanation Attractors* below before
committing to any one of them — the discipline there is what keeps this table
from becoming a machine for confirming your first guess.

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
| `verified: false` on a mutation that visibly succeeded | Normalize Whitespace At Verification Boundaries; Verify URLs By Href, Never By Visible Text |
| A pasted URL is missing from every text projection of the page | Verify URLs By Href, Never By Visible Text |
| Open-by-key/id fails on a page where a link to the target is plainly visible | Bind Targets By Canonical Attributes, Not Rendered Text |
| Click on a `fully_visible` element does nothing and the overlay is already hidden | The Overlay Occludes The Page It Operates (site-native sticky occluders) |
| A screenshot shows the content but a DOM read of the same page returns empty/boilerplate | Suspect The Frame Before The Load: Reads Are Scoped To One Document |
| A projection/read returns 0 items on a page that visibly has them, right after an in-page navigation | Suspect The Frame Before The Load; Navigation Is Often Stateful |
| A synthetic keystroke fires `keydown`/`keyup` but no text appears | Synthetic Keyboard Does Not Insert Text; Use `text.insert` |
| A field's value is set and visible but is lost/blank in the saved record | Some Widgets Commit From An Async Model, Not The DOM Value |
| The same author action succeeds once and fails once with nothing changed | Flaky Means A Race Or Dirty State, Not A New Theory |
| Recovering a wedged tab drops other tabs | Do Not Force A Reconnect To Recover One Tab (in Runtime Hosts) |

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

The occluder is not always the overlay. Sites have their own sticky headers,
toolbars, and floating bars that cover controls when an inner container is
scrolled — and `locator.element_info` reports geometry only, so a covered
control still reads `fully_visible: true` with an empty `clipped_by`. Trello's
card modal is the canonical example: with the modal's inner `main` scrolled
down, the sticky title header sits over the Description "Edit" button, and
`pointer.click` at its center lands on the header. When a click on a
"fully visible" element does nothing and the overlay is already hidden, check
`elementFromPoint` for a *site* element on top, then encode a scroll-to-known-
position step (for example `viewport.scroll` with a large negative `delta_y`
scoped to the correct inner scroller) before the find/click sequence. Beware
nested scrollers when scoping that scroll: a combined selector list resolves in
document order, so `"[role='dialog'] main, [role='dialog']"` scopes to the
outer dialog, not `main` — scope to the actual scrolled container only.

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

Verification reads must also bind target identity. A broad board, list, table,
or page projection that returns `ok` but omits the target object is not
verification. If a workflow creates a card in `Next Up`, a later board read that
only returns `Backlog` and `To Do` cannot prove the card exists, even if the
creation action itself returned success. The verifying output must contain the
exact title, source URL or provenance marker when relevant, and expected
container when placement matters. If the projection is spatially partial, either
scroll/read until the target appears or use a title-scoped verification action
that navigates to the target; otherwise report verification as incomplete.

For parameterized mutations, bind every requested parameter in the proof. A
date action that was asked for "tomorrow at 9:00 AM" has not succeeded because
some due-date badge exists; it must prove the concrete day and time, or fail
before any follow-on action can mark validation complete. A label action must
prove the requested label, a move action must prove the requested destination,
and an editor action must prove the requested saved text. If a required
sub-step fails, the recipe must stop at that boundary. Do not let the agent save
partial state and then complete a checklist item from a weaker, generic
projection.

If an action returns both transport success and a domain-specific verification
field, the verification field governs the user claim. `ok: true` means the
workflow ran; `verified: false` means the requested state was not proven. For
long text writes where the UI projection can truncate, add a short
`verify_contains`/sentinel parameter and verify that distinctive substring
instead of pretending a full-body comparison passed.

For controlled inputs, prove the framework-observed value, not just the DOM
property you changed. React-style inputs can briefly show a value that the
application model later discards. A text primitive or site action should emit
native-value-setter/input semantics and a state projection should read the
field's committed `value`; the final mutation should then verify the saved
application state after the control's own Save/commit operation.

### Bind Targets By Canonical Attributes, Not Rendered Text

When an element carries a canonical identity attribute — an `href` containing
an issue key, an `id`, a `data-testid` with the object key — bind the locator
to that attribute alone. Do not add a `text_contains` for the same identity:
rendered text varies by surface while the attribute does not. A Linear issue
link shows `ACT-111` in an issues list but shows only the issue *title* in a
relations/related-issues section; a locator that demands both
`a[href*='/issue/ACT-111']` and `text_contains: "ACT-111"` fails on the second
surface even though the link is right there, and the failure classifier may
blame something else entirely (the overlay, visibility). Over-binding is as
real a failure mode as ambiguity. Tighten the attribute instead: append a
delimiter so prefixes cannot alias (`/issue/ACT-11/` does not match
`/issue/ACT-111/`). Reserve `text_contains` for elements whose only identity
is their text.

### The Ambiguous-Anchor + Self-Certified-Success Anti-Pattern (the #1 reliability killer)

This is the single most common way a workflow "passes" but does nothing — and an
audit of a mature Trello map found it in a third of the mutating actions. It has
two halves that usually appear together; forbid both.

**Half 1 — resolve by an ambiguous / non-unique anchor.** A step targets a
control by text or a fuzzy attribute that matches *more than one* element:

- **Reusing ONE text-locator for TWO distinct steps.** The classic: a delete flow
  where both "click the Delete menu item" and "click the Delete in the
  confirmation popover" use the identical locator `[role='dialog'] button` +
  `text_contains:'Delete'`. There are two "Delete" buttons, so both steps resolve
  to the *first* one — the confirmation is never clicked, and nothing is deleted.
  Two distinct affordances that happen to share a label MUST have two distinct
  anchors: scope each to its own container (`[data-testid='popover'] button` for
  the confirm vs the menu), or use each one's own testid.
- **Resolving a repeatable LIST ITEM by its text.** A checklist item, a card, a
  row — targeted by `text_contains:'{item_text}'` — is non-unique the moment two
  items share text, and a wrong-item mutation is silent. Worse when paired with a
  scroll-and-retry ladder (`readItem`, `scrollForItem1`, `readItem1`, …) and a
  geometry click on a "row lane." Address list items by **structural position
  within a uniquely-identified container** (the Nth `[data-testid='check-item-
  container']` of the target checklist), not by bare text.
- **Fuzzy selectors that match the wrong control.** `button[aria-label*='ction']`
  intended for "Actions" also matches "Add reaction" / a cover picker, opening the
  *wrong menu*. Use the exact stable testid (`[data-testid='card-back-actions-
  button']`), never a substring gamble.

**Half 2 — self-certified success.** The workflow returns `{deleted:true}` /
`{moved:true}` / `{opened:true}` from its own weak read — often a *proxy* ("the
board is visible", "a dialog closed") that is true regardless of whether the
intended effect happened. A verify step that references a non-existent step (a
dangling `steps.verifyListGone`) is the degenerate case: it evaluates to a
constant and certifies nothing. **Success must be gated on the SPECIFIC
observable effect**: the card-back is *gone* (delete), the card is *in the target
list* (move), the item shows *checked* (complete) — asserted against the real
DOM, and flagged for an independent projection re-check where the client read
could lie. (See the sibling rule *Postconditions Must Assert The Specific
Result*.)

**The positive style to copy** (from the same audit's clean actions): a Trello
date-picker save binds `[data-testid='save-date-button']` and verifies via
`button[aria-pressed='true']`; `checklist_item.add` binds `check-item-name-input`
+ `check-item-add-button` and verifies the item text appears in the specific
`checklist-container`; `description.set` binds `description-save-button` and
re-reads the saved text. Every step a unique stable anchor; every mutation a real
postcondition. When you catch yourself writing `text_contains` for a control that
has a testid, or returning `:true` without reading the specific effect, stop —
that is this anti-pattern forming.

### Verify URLs By Href, Never By Visible Text

Rich-text surfaces convert pasted URLs into titled smart links: Trello renders
`https://linear.app/...ACT-111...` as "ACT-111: Prepare …" and a homepage URL
as the page's `<title>`. The raw URL text is *gone* from every text projection
— `modal_text`, `dom.snapshot_text`, full-body reads — while the URL survives
intact as the anchor's `href`. Consequences for authoring:

- A text sentinel (`verify_contains`) must be **URL-free**. A sentinel that
  embeds the source URL verifies `false` forever after the site unfurls it,
  even though the save succeeded — and a false-negative verification teaches
  the agent to re-run the mutation, which overwrites the saved formatting.
- Source-provenance checks (the Linear URL on a synced card) need a dedicated
  **link projection**: extract the anchors in the description/body scope with
  their `text` and `href` fields and match the href. Give every site map whose
  workflows write URLs into rich text such a projection.

### Normalize Whitespace At Verification Boundaries

A sentinel copied from a source document carries newlines; a DOM text
projection is space-joined and can carry non-breaking or zero-width characters
that print like spaces. A literal `$contains` across those two representations
fails on identical content. Any verification that compares agent-supplied text
against projected page text must collapse whitespace on **both** sides first
(`$replace(x, /[\s\u200B\u200C\u200D\uFEFF\u00A0]+/, ' ')`), in every layer
that compares — the workflow output expression *and* the state postcondition;
fixing one and not the other leaves the action failing with a different
message. Locator `text_contains` matching already normalizes, so a workflow
can pass its locator step and still fail a literal output comparison on the
same text: two layers, two verdicts, one string.

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

**When the failure is more than a trivial fix, branch into a real
incident-investigation — don't fix-forward.** Authoring a map surfaces genuine
bugs (an action that "verifies true" but did nothing; a control that resolves to
the wrong element; a mutation that silently fails). If you catch yourself patching
blindly, guessing, or on your *second* failed fix attempt, STOP and run the
`incident-investigation` skill as a **chained-prompt** (`chain_start("incident-investigation")`
→ do each phase → `chain_complete(...)`), which is installed as a submodule at
`skills/incident-investigation`. It forces the discipline this document keeps
returning to: a low prior on your first-guess hypothesis (Core Principle #11), the
maximum-pain ranking (below), a REAL experiment before any conclusion, and
three-level blame — the proximate code, the **anti-pattern** (search every other
action for the same class of defect), and the **coding-style/skill** deficiency
that let it be authored (fix THIS document so the class can't recur — see
[[blame-level-3-lives-in-the-skill]]). Write the investigation to
`investigations/<slug>.md`; if the map lives on a task board, the investigation
card should cite that file. This is not overhead for a broken selector you can see;
it is the correct response the moment a map bug becomes a *class* of bug or resists
a first cheap fix. (This whole authoring role is "fix the tool, not the task" — and
a real bug in the tool deserves a real investigation, not a patch.)

### Explanation Attractors: The Reasoning Bug Behind The Wrong Stories

> **Yaniv's Rule (the maximum-pain principle).** When several explanations
> compete, rank them by how much each *hurts to accept*, and test the most
> painful one first. Pain is a proxy for truth. In debugging, the sharpest form
> of that pain is embarrassment: the most personally embarrassing explanation —
> usually that you were stupid in your own actions — is the most likely one, so
> start by trying to eliminate it.

The general principle is bigger than debugging: **truth and pain are positively
correlated.** Not because truth must hurt, but because the mind routes around
pain — comfort is the bias — so the explanation you are motivated to avoid is the
one your comfort-seeking already filtered out before you noticed. Whatever
survived that flinch and still stings is precisely where you have not been
looking. So the painful candidate is not merely *tolerable* as an answer; its
pain is *evidence for* it. Rank by hurt, test the top of that list first.

**Why the pain is evidence (the suppression-tax argument).** A painful
explanation reaches your awareness only after paying a tax: comfort-seeking
suppressed its felt probability *before* it could surface. What you notice is
roughly (true probability) × (a suppression factor well below 1 for anything
that hurts). So the very fact that a painful hypothesis got conceived *at all* —
against that headwind — means its true probability had to be large enough to
overcome the penalty. The pain is a headwind; anything that crossed the line
despite it was running far faster than it looks. Felt salience *understates* a
painful hypothesis, so correct upward: the more it hurt and the more surely you
still thought it, the higher you rank it.

**It is a gradient, not a switch — and that is the advance.** "It's your fault,
not the tool" is a binary: once you accept it is you, it falls silent and gives
no further direction. The maximum-pain principle keeps resolving *inside* the set
of causes that are all your own. When five candidates are all your mistake, they
are not equal — one paints you as merely careless, one as negligent, one as
having fooled yourself for an hour. The same suppression tax applies within the
group, so rank those five by how bad each would make you look and test the worst
one first. This is the move no prior adage makes: it gives you a direction even
after "whose fault" has already been answered.

That is the whole section in one line, and it is operational: **the wince is a
proxy for probability.** You do not have to reason your way through priors and
biases in the moment — just ask, of the candidates on the table, *which one would
hurt most to admit?* and test that one first. In website mapping the pain is
almost always embarrassment (you clicked the wrong spot, read the wrong frame,
never checked your own write); in larger work it wears other faces — cost, loss,
"the thing I built is the thing that is broken," "I was the bottleneck." Same
razor, different flavors of hurt, all pointing the same direction. The wince is
the signal.

It is Murphy's Law's debugging cousin: not "anything that can go wrong will," but
"of the ways it went wrong, the one you'd least like to own is the one to check
first." Its nearest named ancestor is the 1980s adage *Select Isn't Broken* (The
Pragmatic Programmer) — "it's always your fault, not the OS/library" — but that
one is dated to a Solaris syscall nobody debugs anymore, and it only asserts *it
is you*. Yaniv's Rule keeps the truth and drops the mustiness: it gives the
operational ranking key (rank by pain, test the most painful first) and it
travels — it lands the same on a soft-nav iframe, a DPR coordinate bug, or a
model confabulating a tool call as it did on a Solaris box. Everything below is
why this rule is true and how to run it.

Before the instruments, name the failure honestly, because it is upstream of any
one wrong guess. The bug is not "I picked a bad hypothesis." The bug is the
**shape of the reasoning**:

1. A symptom appears ("my clicks are ignored," "the projection is empty").
2. One explanation surfaces that *would* account for it ("trusted-input wall,"
   "the page didn't load").
3. It fits. The "that explains it" click fires, and the search **stops there.**

Every step of that is a trap. An explanation that *would* account for the symptom
is not evidence the explanation is *true* — it is one member of a large set of
causes that would all produce the same symptom. "Clicks are ignored" is
consistent with: wrong coordinates (DPR scaling), an occluding overlay, a
response-ack stall (the click worked, the reply didn't return), the wrong frame,
a disabled control, a not-yet-hydrated handler, and a trusted-input gate — among
others. Picking the first one that fits and moving on skips the only step that
matters: **discriminating among the candidates.**

Worse, the explanations you reach for first are not random. They are
**attractors in explanation space** — low-effort, high-availability stories that
your prior turns and training make cheap to generate: "trusted input,"
"React-controlled," "still loading," "the selector changed." Their availability
is exactly why they are so often wrong: you produce them *because they are easy
to produce*, not because this page earned them. The tell that you are caught in
an attractor is that **you have offered this same explanation before and it was
refuted before** — and you reached for it anyway. If a hypothesis has failed you
in the past, its prior is *lower*, not higher; the pull you feel toward it is a
bias to correct, not a signal to follow.

There is a common thread running through the attractors, and it is the real tell:
**they all blame something other than the operator.** "The site rejects synthetic
clicks," "the page didn't load," "the tab is hung," "the field is controlled,"
"the selector drifted" — every one puts the fault in the website, the browser, or
the framework. Not one of them is "I clicked the wrong coordinates," "I read the
wrong frame," "I typed the value but never verified it landed," "I saved before
it committed," "I sequenced two actions and left a popover open." The bias is not
toward *simple* explanations; it is toward **exculpatory** ones. That is why they
survive refutation: accepting the true cause means accepting that the operator —
you — did the wrong thing. Use this as a razor. When two explanations both fit
the symptom, the one that blames the page is the one to distrust first, and the
one that implicates your own last action is the one to test first — precisely
because it is the one you are motivated not to look at. Point the first
experiment at your own move.

The discipline that breaks the attractor is not a mindset, it is an artifact you
**write down** before you touch an instrument: a short list of candidate causes,
explicitly ranked. Producing the list defeats sufficiency-stopping (you cannot
stop at the first item if the step is "list several"); ranking it defeats the
exculpatory pull (the story you *want* is forced to compete on paper against the
one that blames your own move). Do it literally, every time:

1. **List at least three distinct causes** that would produce this symptom. If
   you can only think of one, you are not done — the symptom is generic and the
   causes are many. "Clicks ignored," "read empty," "value not saved" each have a
   standard menu; write the menu, not the first item. Include at least one cause
   that is *your own last action* (wrong coordinates, wrong frame, unverified
   insert, save-before-commit, a stale popover) — it belongs on every list.
2. **Rank them by Yaniv's Rule — most embarrassing first:**
   - the candidate you would **most wince to admit** (you clicked the wrong
     spot, read the wrong frame, never checked your own write) goes to the
     **front**. The wince is the proxy for probability; do not discount it,
     rank *by* it;
   - any explanation that **blames the page/browser/framework** — the ones that
     cost you no embarrassment — moves toward the **back**, and any you have
     **had refuted before** (this session or in memory) goes to the very back —
     a refuted hypothesis has a *lower* prior;
   - strike outright any story that needs an **implausible magnitude** to be
     true. "The page hadn't loaded" after *nineteen seconds* is disqualified on
     its face: pages do not take nineteen seconds to render a list a reload
     paints in two. A story that needs an unlikely quantity is falsifying itself.
3. **Test from the top of the ranked list** with the experiment below — not from
   the explanation that feels right.

Worked example — symptom: "my clicks on the event are ignored."

| Rank | Candidate | Why here |
|------|-----------|----------|
| 1 | I clicked the wrong coordinates (DPR/scaled screenshot) | my own move; cheap to check with one geometry read |
| 2 | An overlay/occluder is intercepting the click | my own setup; check with a hit-test |
| 3 | The click executed but the response ack stalled | my read of "ignored" may be wrong; screenshot verifies |
| 4 | The control is disabled / not yet wired | page state; check the element |
| 5 | ~~The site rejects synthetic/untrusted clicks~~ | blames the page **and** refuted before → back of the line, likely struck |

The attractor ("untrusted clicks") is exactly the one that would have been tried
first by instinct; the ranking puts it last, on evidence, where it belongs.
- **Pick the experiment that splits the field.** Choose the single observation
  that eliminates the most candidates at once. A screenshot splits "didn't load"
  from "loaded but I can't read it." A frame dump splits "wrong frame" from
  "wrong selector." Do not run the test that merely *confirms* your favorite —
  run the one that could *kill* it.

Only then reach for an instrument. The instruments below are how you execute the
discriminating experiment; the enumeration above is what tells you which one to
run and stops you from confirming an attractor instead of testing it.

### Measure The Failure Before You Explain It

The most expensive authoring failure is not a broken selector — it is a
**confident wrong story about why something broke.** A plausible cause
("the field is React-controlled," "the page is still loading," "synthetic input
is untrusted," "the selector changed") costs nothing to say and sends the next
hour in the wrong direction. Every one of the following real diagnoses was
reached only *after* discarding a tidy-sounding theory that turned out to be
fiction. The pattern is consistent enough to be a rule:

> When a page operation fails, the real cause is almost always mundane and in a
> different place than your first story. Instrument first; theorize never.

Anti-pattern tells — if you catch yourself doing any of these, stop and measure:

- Naming a mechanism you have not observed ("it's React state", "trusted-input
  wall", "the SPA is still hydrating"). You are pattern-matching training data,
  not reading this page.
- Explaining an **intermittent** failure with a **deterministic** cause. If the
  same action worked once and failed once with nothing else changed, the cause
  is a race or dirty state, not a property of the widget (see below).
- Concluding "the page did not load" or "the element does not exist" while a
  screenshot shows the content plainly. A screenshot that contradicts your read
  is the single loudest signal that you are looking in the wrong place — usually
  the wrong **frame** or the wrong **document** (see below).
- Reusing a hypothesis that a previous investigation already disproved.

The cheap instruments, in order of reach for:

1. `browser.screenshot` — does the page actually show what you think? A
   screenshot that disagrees with a DOM read is decisive: trust neither the read
   nor your story until you reconcile them.
2. A frame/context dump — `window === window.top`, `window.frames.length`, and
   the body length + a known target string per frame. Content rendered into a
   child frame is invisible to a top-document query.
3. Event recorders — attach listeners for `keydown`/`beforeinput`/`input`/
   `change` and read back which fired with what value. This distinguishes "the
   value was never set" from "the value was set but not committed."
4. Read the framework, do not assume it — `Object.keys(el)` reveals
   `__reactProps$…` / `__reactFiber$…` if the element is React, and their
   absence if it is not. Do not attribute behavior to a framework the page is
   not using.

Ground every "it broke because X" in one of these observations before you write
a fix. A fix built on an unmeasured cause is a guess wearing a lab coat.

Case review — every one of these was a *confidently stated* cause that the
evidence killed. The column that mattered was always the last one:

| Symptom | The invented story (wrong) | The measured cause (right) |
|---------|----------------------------|-----------------------------|
| Clicks on a calendar event landed on empty grid | "The site rejects synthetic clicks / trusted-input wall" | Screenshot returned at devicePixelRatio 2; click coords were 2× off. Halve DPR-2 screenshot coords, or use `clickable_center`. |
| Time-widget interaction timed out every tool call | "The tab is hung / modals wedge the runtime" | The tab was fine; only the response **ack** stalled. Background screenshot kept working; the clicks executed. Verify by screenshot, not by the response code. |
| Calendar event saved with no title | "The title is a React-controlled input that ignores synthetic value" | The page is not even React. `text.insert` set the value and fired `input`; the save committed from an **async model** and fired before it ingested — a race. Blur + settle before save. |
| Same insert→save worked once, failed once | "Google resists synthetic text on save" | Intermittent ⇒ race/dirty-state, not a widget property. The instrumented run added just enough delay to win the race. |
| Move-card action failed at its list step | "The list combobox selector drifted" (partly) plus no theory for the flakiness | Two things: the readiness selector wanted a `--control` child that only exists on the board select; **and** a prior open popover dirtied state. Fix the selector; start clean. |
| Voice agent said it could not see LinkedIn messages | "The maps or the agent are broken" | The agent routed `actions.site` to the **wrong (wedged) active tab**; hosted tools route to the claimed active tab, not the start target. Make the target tab active. |
| Three of four tabs dropped off the bridge | "`claimed_tabs.activate` cascaded a reconnect and killed them" (stated as fact) | Unproven — no disconnect log existed. Built persistent lifecycle logging; the log later showed activate causes only a **brief** all-tab reconnect, permanent loss only when a tab was already wedged. |
| LinkedIn inbox projection returned 0 conversations the user could plainly see | (1) "soft-nav never loaded" → (2) "still loading after 19s" → (3) "selector mismatch" | All three wrong. The whole list rendered **inside a `/preload/` child iframe**; the projection queried the top document (an empty shell). A frame walk found 20 items in `frames[1]`. Wrong frame, not load/timing/selector. |

The throughline: a screenshot, a frame dump, an event recorder, or a lifecycle
log answered each one in a single call. The stories cost far more than the
measurement would have.

### Suspect The Frame Before The Load: Reads Are Scoped To One Document

A projection or DOM read runs against **one document** — the top document of the
runtime, unless the read explicitly traverses frames. Modern SPAs (LinkedIn
observed) sometimes render a whole view, list and all, **inside a child iframe**
(e.g. `…/preload/?_bprMode=vanilla`) that is painted over the viewport. The user
sees a full UI; a top-document query sees an empty shell (`document.body`
reduced to a few boilerplate characters, target selectors returning 0).

Diagnose it, do not theorize it:

1. Screenshot the page. If content is visible but the read is empty, this
   pattern is the leading suspect — not "still loading," not "wrong selector."
2. Walk the frames: for each of `window.frames`, read `location.href`, the body
   length, and whether a known target string (a name, a heading) is present.
   The frame that contains the target is where the content lives.
3. If the content lives in a same-origin child frame, the map is broken because
   the read is frame-blind, not because the site is broken.

Fixes, preferred order: (a) make the read/projection frame-aware so it queries
the same-origin child frame that holds the content — confirm the projection
engine's `source: dom` can traverse child frames before relying on it; or
(b) reach the view through a **full page load** rather than an in-page (soft)
navigation, so the view renders into the top document and no preload frame
exists. This is why a full reload "fixes" an empty read while more waiting never
does — the reload removes the frame split, it does not give a slow page more
time.

### Synthetic Keyboard Does Not Insert Text; Use `text.insert`

`keyboard.press` dispatches `keydown` and `keyup` and nothing else. On a normal
input, a *trusted* keydown carries a browser default action that inserts the
character and emits `input`; a *synthetic* keydown has no such default. Measured
result on a plain text input: `keydown`/`keyup` fire, `.value` stays empty, no
`input` event. So keyboard-typing a value into a field does not work through the
portable runtime — use `text.insert`, which sets the value via the native value
setter and dispatches `beforeinput`/`input`/`change`. Reserve `keyboard.press`
for real key semantics (Enter to submit, Escape to close, Tab to move focus),
not for entering text.

The exception is **canvas editors** (Docs/Slides/Sheets): there a *trusted*
`text.type {trusted:true}` (real per-character `Input.dispatchKeyEvent`, ext ≥
0.1.172) is exactly how you enter/overtype text, because those editors ignore
both synthetic input and `text.insert` on their canvas. See "Canvas Editors:
Selection And Input Live In Different Layers" below.

### Some Widgets Commit From An Async Model, Not The DOM Value

A field can show your typed value in `.value`, survive a blur, and still save
blank — because the widget commits from an **internal model that ingests the
`input` event asynchronously**, and the save fired before that model caught up.
The tell is that it is **intermittent**: the identical insert→save sequence
persists the value when something slowed the path down (instrumentation, an
extra read) and drops it on the fast path. This is a race, not a "trusted input"
wall and not (necessarily) a framework-controlled input — verify what the page
actually is before naming a cause.

When a set-then-commit action loses its value intermittently, make the commit
deterministic in the action itself:

1. `text.insert` the value.
2. Dispatch `input` and `change`, then blur the field, to force the widget's
   model to ingest the value.
3. Add a real settle (a few hundred ms) or an explicit `locator.wait_for` on a
   state that only appears after the commit, before the save click.
4. Verify the saved record through a read/projection, never from the field's
   own `.value` — the field is exactly the surface that lies here.

### Canvas Editors (Google Docs/Slides/Sheets): Selection And Input Live In Different Layers

Google Docs and its siblings paint the document to a `<canvas>` and take
keyboard input through a **hidden off-screen `.docs-texteventtarget-iframe`**.
The DOM you can see is not the DOM that edits. Two consequences dominate every
edit action and cost many cycles to rediscover:

- **Reads are canvas-blind.** The rendered text is not in the DOM — `snapshot`,
  `observe.visible`, and `dom.*` return empty. Read via the doc's own
  `/mobilebasic` HTML (`page.fetch`, same-origin) and parse block tags there.
  For structure (headings vs paragraphs) parse `<h1..6>`/`<p>` — and strip inner
  tags when reading a block's text, because Docs wraps heading text in a
  `<span>` inside the `<hN>` (`<h2><span>Title</span></h2>`); a check that
  expects text *directly* inside `<hN>` gives a false negative.
- **Writes: the selection and the input point are DECOUPLED.** `Find`
  (Ctrl+F → `text.insert` the query into `input.docs-findinput-input` → Enter →
  Escape) genuinely SELECTS the match in the **canvas** layer (screenshot-proven:
  the run highlights). But a frame-targeted `clipboard.paste` inserts at the
  **iframe** caret, which does not track that canvas selection — so paste can
  never *replace* a selection; it duplicates. And raw `Delete`/`Ctrl+X` do
  nothing to a canvas selection.

What actually works, by operation:

- **Append / insert a block at the cursor:** frame-`clipboard.paste` into
  `{frame:'.docs-texteventtarget-iframe', selector:"[contenteditable='true']"}`.
  Pasted `<h1>`/`<p>`/`<table>` HTML lands as REAL Docs structure (no flatten).
- **Insert a heading without duplicating a paragraph:** paste a **heading-only**
  block; it lands cleanly immediately AFTER the anchored paragraph (there is
  nothing to duplicate). Do NOT include body text in the paste — that duplicates.
- **Replace / delete a run:** Find-select it, then **type over it with real
  per-character key events** (`text.type {trusted:true}` on ext ≥ 0.1.172, which
  dispatches `Input.dispatchKeyEvent` keyDown+keyUp per char). A single typed
  char replaces the selection; to delete, type a single space (you cannot type
  ""). `Input.insertText` is IGNORED against a canvas selection — this was the
  root of the long "select_and_type is broken" saga; it was insertText-not-
  honored, never a timing bug.
- **Never** use a native find-and-replace for structure: it flattens every
  newline to a space and fuses a heading into the next paragraph.

Two verification traps specific to this surface, both of which lie:

- The **piggybacked a11y announcement can be STALE.** The Docs findbar's
  "N of M" announcement may echo an *old* search state (e.g. "0 of 0") while a
  screenshot shows "1 of 1" and the match highlighted. Do not treat the
  piggybacked count as the live find result — screenshot the findbar, or verify
  the edit's effect in `/mobilebasic`.
- **Presence is not structure.** "My text is in `/mobilebasic`" passes even when
  the block is mis-styled or duplicated. Verify the block TAGS and counts, not
  just that the string appears.

### Flaky Means A Race Or Dirty State, Not A New Theory

If an action fails, and you change nothing, and it now succeeds — or vice versa —
you have a **race** or **residual state**, and inventing a per-attempt cause
("maybe the selector shifted," "maybe React re-rendered") is the wrong move.
Two mundane sources cover most cases:

- **Left-over UI state.** A prior attempt left a popover, menu, or modal open, so
  the next attempt's first click toggled the wrong thing. The fix is caller
  discipline — start each attempt from a known-clean state — not a blunt
  `Escape` inside the action, which can dismiss the very surface the action needs
  (e.g. closing the card modal a move action depends on).
- **A commit/render race** (see the async-model pattern above).

Confirm which by re-running from a verified-clean state. If it then succeeds
every time, the action is correct and the discipline belongs in how it is
sequenced, not in a new hypothesis about the widget.

## Primitive Policy

**Resolve controls by ACCESSIBLE IDENTITY first — it is the most reliable way
to find a target and it does not break when the layout shifts.** The extension
exposes accessibility primitives that every map should lean on and every map's
`prompt`/`instructions` should mention (agents don't use tools they aren't told
exist):

- `a11y.query {role, name}` or `{role, name_contains}` → resolves a control by
  its ARIA role and accessible name and returns its exact `clickable_center`
  (and backend node id, state). Use it before `pointer.click` for any button,
  menu item, link, or field you'd otherwise pixel-hunt — "Create", "Add a card",
  "Save", a named menu entry, a toolbar toggle. Identity, not geometry.
- `a11y.tree` → a role/name/state outline of the page (and its live regions).
  Consult it when you're unsure what's on screen or what a control is called,
  instead of squinting at a screenshot.
- `a11y.watch` → subscribe to the site's live-region announcements (caret text,
  status messages) streamed into context — the eyes for canvas/no-DOM surfaces.

Order of preference for ANY interaction: (1) a site-specific action from the
map; (2) `a11y.query`/`a11y.tree` to resolve the control by identity, then
`pointer.click`; (3) only then a screenshot + pixel/`locator` fallback. When
authoring a map, add a short "ACCESSIBILITY NAVIGATION" note to its instructions
pointing the agent at `a11y.query`/`a11y.tree` — otherwise the hosted agent
pixel-hunts because it never learned the tools exist. See
[[accessibility-is-for-blind-agents]].

Then human-visible point-based actions:

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

## Storage Scopes & The Private→Public Development Process (READ before editing any map)

A site map can exist in TWO scopes at once, and **this is the #1 place a wrong
mental model causes silent bugs.** Get these facts right before you touch a map:

```text
actions.json.storage/
  scopes/
    private/sites/<host>/<surface>/actions.json   ← THE WORKBENCH — edit here
    public/sites/<host>/<surface>/actions.json    ← the shelf — a redacted MIRROR
```

- **PRECEDENCE — private WINS.** The runtime loader probes `scopes/private/<host>`
  **before** `scopes/public/<host>` (`storage-bundle.mjs relevantStorageProbePaths`).
  So for the same host+surface, **the private map shadows/outranks the public one.**
  An action that exists only in `public` is a **latent shadow bug** — it is
  outranked by private and can silently vanish. (It may appear to work today only
  because the current sync merges both scopes; do not rely on that.)
- **WHERE TO EDIT — always the PRIVATE map.** Private is the workbench AND it's
  what actually loads. **Never edit the public map directly.** If you're adding or
  fixing an action, you edit `scopes/private/...`, full stop.
- **THE PROCESS — private first, then promote:**
  1. Edit the **private** map.
  2. `storage.sync` to the runtime and **validate live**.
  3. Only after it's proven, and with the **user's explicit approval**, redact and
     **promote to public** (see "Syncing Private/Dev Work To Public" below). Public
     is the shelf, not a staging area.
- **KEEP THEM CONSISTENT.** Public must be a **strict, redacted subset/mirror** of
  private — never ahead of it. Public may carry LESS (evidence/provenance fields
  stripped) but never a functional action that private lacks. If public and private
  diverge functionally, private is the source of truth; reconcile toward private.

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

> This is the second-of-a-class blindspot: the system's operational invariants
> (what wins, where to edit) must be a scannable rule at the decision point, not
> deep prose. See `investigations/storage-scope-model-blindspot.md` and its sibling
> `investigations/workflow-loop-capability-blindspot.md`. Before editing/adding a
> map action — or whenever a map exists in more than one scope — also read
> `references/docs/storage-visibility-scopes.md`.

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
