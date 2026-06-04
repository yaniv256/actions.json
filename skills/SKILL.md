---
name: write-actions-json
description: Use when an agent is exploring a website, automating a browser workflow, converting browser discoveries into reusable actions.json actions, validating a site action map through MCP/runtime tools, or preparing public/shared website operating memory.
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
5. **Reload/sync storage**: push the updated site map to the runtime without
   restarting the bridge.
6. **Retest using stored actions only**: the proof is that the agent can repeat
   the workflow without the debugger.
7. **Record evidence**: update observations/runs/items/overlays so the next
   agent can see what was tested and why.
8. **Promote or sync public artifacts**: when guidance is reusable and safe,
   mirror it into the public skill/storage surface rather than leaving it only
   in private scratch space.

Do not solve the user's task with `debug.run_javascript` and stop there. That
creates a one-off success and loses the learning. The debugger's output is raw
material for an `actions.json` action.

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
