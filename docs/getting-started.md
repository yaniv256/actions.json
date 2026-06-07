# Getting Started

This guide gets you from a release artifact or fresh checkout to a working
`actions.json` runtime.

You do not need every component for every workflow. Choose one path first.

## Choose A Path

| Path | Use When | Requires |
|---|---|---|
| Chrome extension hosted agent | You want an agent on the current website, using your OpenAI key. | Chrome extension, OpenAI API key, tab authorization |
| External coding agent through bridge | You want Codex, Claude Code, or another local agent to call browser actions. | MCP-shaped bridge, connected browser runtime |
| Bookmarklet/embed test path | You want to test what page JavaScript can do without extension privileges. | Bookmarklet, compatible page policy |

The Chrome extension is the most capable runtime. It supports screenshots,
stable tab identity, storage upload/download, extension overlays, debugger
fallback for authoring, and the hosted voice/text agent.

The bookmarklet is useful for embed-path testing, but sites can block it with
Content Security Policy, mixed-content rules, or screenshot permission limits.

## Path A: Chrome Extension Hosted Agent

Use this path when you want the browser extension to host a `gpt-realtime-2`
agent directly.

### Install The Extension

Performed by the user:

1. Download the released Chrome extension artifact.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** for an unpacked release directory, or install the
   packaged release according to the release instructions.
5. Open a website.
6. Click the extension action.
7. Choose **Take control of this tab**.

Expected result: the tab is authorized and may be placed into the
`actions.json` tab group when grouping is available.

### Open The actions.json Menu

1. Click the extension action.
2. Choose **Open actions.json menu**.

Expected result: an in-page menu opens with **Agent** and **Settings** tabs.
Opening the menu closes the small extension popup.

### Add Your OpenAI Key

1. Open **Settings**.
2. Paste your OpenAI API key.
3. Save it.

Expected result: the key state shows saved/ready with a redacted key summary.
The key is stored in Chrome extension storage and used only by this extension to
connect to OpenAI.

### Upload actions.json.storage

Storage is optional, but it is what makes the hosted agent site-aware.

1. Open **Settings**.
2. Use **Upload** in the Storage folder section.
3. Select your `actions.json.storage` root checkout, or a mounted scope
   folder such as `scopes/private`.

Expected result: the extension reads the selected storage files and stores a
browser-local bundle. The hosted agent can then use those files when you ask
what it can do on the current site.

### Start Voice

1. Open **Agent**.
2. Press **Start voice**.
3. Allow microphone permission if Chrome asks.

Expected result: the transcript appears, the voice control changes to live, and
the agent can use screenshots and tools available for the authorized page.

If the prompt is dismissed or blocked, see [Troubleshooting](troubleshooting.md).

## Path B: External Coding Agent Through The Bridge

Use this path when an external coding agent should call browser actions through
the MCP-shaped bridge.

Run the bridge from source:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root ../actions.json.storage
```

The default endpoint is:

```text
http://127.0.0.1:17345
```

If the browser and agent are on different machines, expose the bridge endpoint
through SSH, Tailscale, or another tunnel. Use a URL that the browser runtime
can reach.

Verify the bridge:

```bash
curl -s http://127.0.0.1:17345/health
curl -s http://127.0.0.1:17345/mcp/tools/list
```

Connect the Chrome extension or bookmarklet runtime, then verify connected
runtimes:

```bash
curl -s http://127.0.0.1:17345/runtimes
```

Expected result: `/runtimes` lists connected browser surfaces with runtime ids,
runtime keys, authorization ids where available, extension version, timestamps,
and URLs.

If more than one runtime is connected, ask your coding agent to target one
runtime explicitly. The bridge supports selectors such as `target_runtime_id`
and `target_url_contains`.

## Path C: Bookmarklet Or Embed-Path Testing

Use the bookmarklet when you need a lightweight install or want to test what a
future first-party embed can do from page JavaScript.

Performed by the user:

1. Open the released bookmarklet install page.
2. Drag the `actions.json` bookmarklet to the bookmarks bar, or manually create
   a bookmark with the released `javascript:` URL.
3. Open a target website.
4. Click the `actions.json` bookmark.

Expected result: the bookmarklet UI appears if the page allows it. If direct
transport is blocked, it may show a bridge/relay status instead.

Bookmarklet limits:

- it cannot autonomously capture a true rendered screenshot;
- page CSS and security policy can affect overlays;
- HTTPS pages can block insecure local HTTP or WebSocket calls;
- some sites require the extension relay for bookmarklet transport testing.

## Upload And Download Storage

The extension Settings tab includes storage **Upload** and **Download**.

- **Upload** reads a local `actions.json.storage` checkout or scope repository
  and stores a browser-local bundle.
- **Download** writes browser-local storage files back to the selected folder.

Use storage when site knowledge should survive the current page session:

- site action maps;
- page summaries and context actions;
- navigation playbooks;
- observations and item indexes;
- generated overlays and reports.

See [actions.json.storage](actions-json-storage.md).

## Verify Hosted Tools

With the extension authorized and storage uploaded, ask the hosted agent what it
can do on the current site. In the logs, a successful site-action lookup appears
as an `actions.site` list request. If no site map matches, the agent can still
use direct primitives such as screenshots, section listing, locator information,
scroll, and click where available.

If tools are missing, see [Hosted Agent Tools](hosted-agent-tools.md) and
[Troubleshooting](troubleshooting.md).

## Developer Builds

Use developer builds only when changing runtime code.

```bash
npm install
npm run test:runtime
npm run test:overlay-runtime
node scripts/validate-skills.mjs
```
