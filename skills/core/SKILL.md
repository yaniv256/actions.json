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
- **MCP bridge**: the agent-facing adapter. It exposes stable generic tools and
  routes calls to the selected runtime. It should not create one MCP tool per
  website.

The extension and bookmarklet should share the same primitive dictionary and
runtime contract. They differ only in host capability.

## Getting Started

Use the repo-local paths in the checkout you are working from. The examples
below assume the repo root is the current directory.

### 1. Install dependencies and build the bookmarklet

```bash
npm install
npm run build:storage-bookmarklet
```

The build produces:

```text
runtime/actions-json-runtime/bookmarklet/install.html
runtime/actions-json-runtime/bookmarklet/storage-bookmarklet.url
```

Open `runtime/actions-json-runtime/bookmarklet/install.html` in Chrome and drag
the `actions.json` link into the bookmarks bar. If drag install is unavailable,
copy the single `javascript:` URL from `storage-bookmarklet.url` into a browser
bookmark.

### 2. Install the Chrome extension runtime

In Chrome:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Choose **Load unpacked**.
4. Select `extensions/chrome-overlay-runtime` from this checkout.

On each page the agent should control, click the extension and authorize the
current tab. Authorized tabs should appear in the `actions.json` browser tab
group when controlled-tab grouping is available.

### 3. Start the MCP bridge

Run the bridge from the repo checkout. Use `--storage-root` when you have an
`actions.json.storage` checkout available.

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root ../actions.json.storage
```

The bridge listens on `127.0.0.1:17345` by default. If the browser is on another
machine, connect it through SSH, Tailscale, or another tunnel so the browser can
dial the bridge endpoint. From the browser's point of view it is still dialing
the configured local endpoint.

### 4. Connect runtimes

Extension runtime:

1. Start the bridge.
2. Open the target page.
3. Authorize the page through the extension popup.
4. The extension connects to the bridge WebSocket.

Bookmarklet/embed runtime:

1. Start the bridge.
2. Open the target page.
3. Click the `actions.json` bookmarklet.
4. If direct bridge transport is blocked by page CSP, authorize the extension on
   the same tab and let the bookmarklet use extension-assisted relay for parity
   testing.

### 5. Verify the system is connected

Check the bridge directly:

```bash
curl -s http://127.0.0.1:17345/runtimes
curl -s http://127.0.0.1:17345/mcp/tools/list
```

Expected result:

- `/runtimes` shows the extension and/or bookmarklet runtimes for the target
  pages, including URL and runtime id.
- `/mcp/tools/list` shows a stable generic tool surface such as `actions.site`,
  `storage.sync`, `storage.list`, `browser.screenshot`, and runtime primitives.

If the runtime does not appear:

- confirm the bridge is running;
- refresh or reauthorize the extension tab;
- rerun the bookmarklet on the target page;
- check whether page CSP blocks direct bookmarklet transport;
- avoid restarting the bridge for ordinary `actions.json` edits; use reload/sync
  paths instead.

### 6. Load page-relevant storage

Use the bookmarklet UI or the MCP storage sync tool to load the relevant site
folder from `actions.json.storage`. Prefer loading only the current site's
folder, not the entire storage tree, unless you are testing root-folder
discovery.

After syncing storage, ask the stable site action tool which actions are
available for the current page before reaching for debugger tools.

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
only request user-consented browser capture. Some sites also block direct bridge
transport with Content Security Policy. In those cases, extension-assisted
transport is a test harness for page-JavaScript behavior, not proof that
standalone bookmarklet networking works on every site.

## Stable MCP Tool Pattern

Do not expect or create site-specific MCP tools for every website. The bridge
should expose a small stable surface, then let the agent interrogate site
capabilities at runtime.

Expected stable flow:

1. List connected runtimes and choose the target runtime by URL/title.
2. Ask the stable site action tool what actions are available for the current
   site/surface.
3. Call the selected stored action through the stable site action tool.
4. If storage changed, sync/reload the storage bundle without restarting the
   bridge.
5. If a runtime disconnects, let it reconnect; do not require a bridge restart
   for ordinary `actions.json` edits.

Representative tool concepts:

- `actions.site`: discover and call stored site actions for the current runtime.
- `storage.sync`: send page-relevant storage files to the browser runtime.
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
