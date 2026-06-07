---
name: write-actions-json
description: Use when an agent is exploring a website, automating a browser workflow, converting browser discoveries into reusable actions.json actions, validating a site action map through MCP/runtime tools, or preparing public/shared website operating memory.
version: 0.1.4
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
6. **Score the user capability, not just coverage**: when the site has a
   business goal, define focused scoring actions for the actual user job, such
   as product guidance, support routing, booking, documentation lookup, or
   purchasing boundaries. A high site-map score is not enough if the agent still
   cannot do the job a visitor expects.
7. **Reload/sync storage**: push the updated site map to the runtime without
   restarting the bridge.
8. **Retest using stored actions only**: the proof is that the agent can repeat
   the workflow without the debugger.
9. **Record evidence**: update observations/runs/items/overlays so the next
   agent can see what was tested and why.
10. **Promote or sync public artifacts**: when guidance is reusable and safe,
   mirror it into the public skill/storage surface rather than leaving it only
   in private scratch space.

Do not solve the user's task with `debug.run_javascript` and stop there. That
creates a one-off success and loses the learning. The debugger's output is raw
material for an `actions.json` action.

## Website Mapping Failure Patterns

Every failed operation should improve the site map. Do not treat a failed click,
navigation, screenshot, or extraction as a one-off runtime problem until you
have checked whether the website map is missing state, preconditions, or a
portable path.

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
