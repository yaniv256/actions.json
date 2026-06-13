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
6. Click the extension icon.
7. Choose **Take control of this tab**.

Expected result: the tab is authorized and may be placed into the
`actions.json` tab group when grouping is available.

### Know Your Way Around The Popup

All settings live in the extension popup. Click the extension icon to see,
from top to bottom:

- **Take control of this tab** and **Open agent overlay** buttons;
- a **Session** card with **Start**, **Mute**, and **Stop** controls;
- an embedded **Settings** area with collapsible sections: **OpenAI API key**
  (open by default), **Voice**, **Turn detection**, **Bridge** (URL plus
  **Connect**), **Storage folder** (**Upload**/**Download**), and **Memory**.

The page overlay opened by **Open agent overlay** is a single agent pane with
the transcript and voice controls. There is no Settings tab inside the
overlay; configure everything from the popup.

### Add Your OpenAI Key

1. Click the extension icon.
2. The **OpenAI API key** settings section is open by default.
3. Paste your OpenAI API key.
4. Save it.

Expected result: the key state shows saved/ready with a redacted key summary.
The key is stored in Chrome extension storage and used only by this extension to
connect to OpenAI.

### Upload actions.json.storage

Storage is optional, but it is what makes the hosted agent site-aware.

1. Click the extension icon.
2. Expand the **Storage folder** settings section and choose **Upload**.
3. Select your `actions.json.storage` root checkout, or a mounted scope
   folder such as `scopes/private`.

Expected result: the extension reads the selected storage files and stores a
browser-local bundle. The hosted agent can then use those files when you ask
what it can do on the current site.

### Start Voice

1. Press **Start** in the popup **Session** card, or use the voice control in
   the agent overlay.
2. Allow microphone permission if Chrome asks.

Expected result: the transcript appears, the voice control changes to live, and
the agent can use screenshots and tools available for the authorized page.

If the prompt is dismissed or blocked, see [Troubleshooting](troubleshooting.md).

## Path B: External Coding Agent Through The Bridge

Use this path when an external coding agent should call browser actions through
the MCP bridge.

The bridge is one process with two faces: an MCP stdio server for the coding
agent, and an HTTP/WebSocket listener for the browser runtime. Register it as
an MCP server in your coding agent using the `mcp` subcommand:

```bash
actions-json-mcp mcp \
  --bind 0.0.0.0:17345 \
  --actions <path-to>/overlay.actions.json \
  --storage-root <path-to>/actions.json.storage
```

Or run it from source:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- mcp \
  --bind 0.0.0.0:17345 \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root ../actions.json.storage
```

The `--actions` manifest is read once at launch. There is no hot reload;
`storage.sync` reloads site maps from the storage root, not the manifest.
Restart the bridge after editing the manifest.

The browser side connects to:

```text
ws://<bridge-host>:17345/extension
```

Set that URL in the extension popup's **Bridge** settings section and press
**Connect**. The default bind is loopback (`127.0.0.1:17345`), which is
correct only when Chrome and the bridge run on the same machine. If Chrome
runs on a different machine, `127.0.0.1` points Chrome at the browser machine,
not the bridge host. Launch the bridge with `--bind 0.0.0.0:17345` and use the
bridge host's reachable IP (for example its Tailscale address) in the
extension's Bridge URL — never `127.0.0.1`.

The agent-facing surface is MCP: `initialize`, `tools/list`, and `tools/call`,
plus these MCP resources:

- `actions-json://bridge/launch`: launch context — read this first;
- `actions-json://bridge/tools`: the current tool catalog;
- `actions-json://bridge/runtimes`: connected browser runtimes with runtime
  ids, tab info, extension version, timestamps, and URLs.

Verify the setup by reading `actions-json://bridge/runtimes` from your coding
agent after connecting the extension. If the extension cannot connect across
machines, confirm the bridge is not listening only on loopback
(`ss -ltnp | rg ':17345'`) and relaunch with `--bind 0.0.0.0:17345`.

If more than one runtime is connected, ask your coding agent to target one
runtime explicitly. The bridge supports selectors such as `target_runtime_id`
and `target_url_contains`.

Large tool results spill to disk instead of flooding the agent's context:
results bigger than `inline_limit_bytes` are written to a file and returned as
a compact envelope (`payload_path`, `payload_bytes`, `payload_hash`, and a
`preview`). Read or grep the file at `payload_path`; adjust the threshold with
the `bridge.payloads.configure` tool.

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

The **Storage folder** section in the popup settings includes **Upload** and
**Download**. The same settings page can also be opened as a full top-level
page when the popup is too small to work in.

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
