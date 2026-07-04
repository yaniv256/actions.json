---
title: Getting Started
nav_order: 2
---

# Getting Started

`actions.json` teaches a website to an AI agent. Instead of the agent scraping
the page and guessing, it calls named actions a site map describes — so it can
reliably search, click, fill, and read on a real site.

This guide gets you to a working setup. By the end, an agent will be operating a
website in your browser through `actions.json`.

## Choose A Path

There is one question that decides your path:

**Are you _building_ an `actions.json`, or _trying one out_?**

| You want to... | Path | Why |
|---|---|---|
| Use the hosted voice agent in the Chrome extension | **[Path A: Chrome Extension Hosted Agent](#path-a-chrome-extension-hosted-agent)** | You already have a map file. Upload it to the extension and see what it can do. No coding agent needed. |
| Build or change an `actions.json` for a site | **[Path B: External Coding Agent Through The Bridge](#path-b-external-coding-agent-through-the-bridge)** | Your coding agent edits the map _and_ loads it into your browser to test it — you don't need a finished map first. **Start here for authoring.** |
| Test bookmarklet or embed behavior | **[Path C: Bookmarklet Or Embed-Path Testing](#path-c-bookmarklet-or-embed-path-testing)** | Use this only when validating the portable runtime path. |

Most people arrive here to **build**, so Path B is the main path. If you are
developing a map, the standalone extension path is _not_ for you — you would
have nothing finished to upload yet (the exception is hand-writing the JSON with
no agent at all).

## Path B: External Coding Agent Through The Bridge

Use this when a coding agent (Codex, Claude Code, or similar) should build your
`actions.json` and drive a browser to test it.

The coding agent connects to a small **bridge** process. Once connected, the
bridge does the setup for you:

- it **loads your `actions.json` into the browser extension** as you edit it, so
  you never upload a map by hand, and
- it **loads your OpenAI key** into the extension.

So you point the agent at the bridge once, and the develop-test loop just works.

### 1. Install the Chrome extension

1. Download the latest extension from the
   [releases page](https://github.com/yaniv256/actions.json/releases)
   (`actions-json-overlay-runtime-*.zip`) and unzip it.
2. Open `chrome://extensions` and enable **Developer mode** (top-right toggle).
3. Choose **Load unpacked** and select the unzipped extension folder.

### 2. Register the bridge with your coding agent

The bridge runs with `npx` — no install, no toolchain, no paths to fill in. On
first run the `@actions-json/bridge` package downloads the prebuilt binary for
your platform, bundles the browser-control tool catalog, and creates your
storage at `~/.actions-json/storage`.

**Claude Code:**

```bash
claude mcp add actions-json -- npx -y @actions-json/bridge mcp
```

**Codex:**

```bash
codex mcp add actions-json -- npx -y @actions-json/bridge mcp
```

Other MCP clients (Claude Desktop, etc.) — add an `mcpServers` entry:

```json
{
  "mcpServers": {
    "actions-json": {
      "command": "npx",
      "args": ["-y", "@actions-json/bridge", "mcp"]
    }
  }
}
```

Optional overrides (the defaults are skipped when you pass your own):

| Flag | Default | Override when… |
|---|---|---|
| `--bind <addr>` | `127.0.0.1:17345` | Chrome runs on a different machine — use `0.0.0.0:17345` and the bridge host's reachable address. |
| `--storage-root <dir>` | `~/.actions-json/storage` | you want storage somewhere else (or set `ACTIONS_JSON_STORAGE`). |
| `--actions <file>` | bundled | you have a custom primitive dictionary. |

> Prebuilt binaries cover linux-x64, macos-x64, macos-arm64, and win-x64. On any
> other platform/arch, `npx` prints build-from-source instructions instead.

After registering, restart (or reconnect) your coding agent so it launches the
server. Confirm it connected by listing MCP servers in your agent (e.g.
`claude mcp list`). The agent should read `actions-json://bridge/launch` first —
it returns the launch context the agent needs.

### 3. Connect the extension to the bridge

1. Open a website and click the extension icon.
2. In the popup's **Bridge** section, enter the bridge URL and press **Connect**:

   ```text
   ws://<bridge-host>:17345/extension
   ```

3. Click **Take control of this tab**.

Use `127.0.0.1` only when Chrome and the bridge run on the same machine. If they
run on different machines, use the bridge host's reachable address (for example
its Tailscale IP) — never `127.0.0.1`, which would point Chrome at itself. See
[Bridge Architecture](bridge-architecture.md) for cross-machine setup, runtime
selectors, and large-result handling.

### 4. Verify

Ask your coding agent to read `actions-json://bridge/runtimes`. It should list
your connected browser with its tab info and extension version. You are now in
the develop-test loop: the agent edits the map, loads it into the browser, and
tries it on the live page.

## Path A: Chrome Extension Hosted Agent

Use this when a collaborator has given you an `actions.json` and you just want to
see what it does — no coding agent involved.

**Prerequisite:** you have a map to upload — an `actions.json.storage` folder (or
a single site map) someone shared with you. If you don't have one yet, you want
Path B.

### 1. Install the Chrome extension

Same as Path B, step 1 — from the
[releases page](https://github.com/yaniv256/actions.json/releases).

### 2. Add your OpenAI key

1. Click the extension icon. The **OpenAI API key** section is open by default.
2. Paste your OpenAI API key and save it.

The key is stored in Chrome extension storage and used only by this extension to
connect to OpenAI. (This is the same key you would hand a coding agent in Path B
— here you give it to the extension directly.)

### 3. Upload the map

1. Expand the **Storage folder** section and choose **Upload**.
2. Select the `actions.json.storage` root you were given, or a scope folder such
   as `scopes/private`.

The extension reads the files and stores a browser-local bundle.

### 4. Take control and start

1. Open the target website and click **Take control of this tab**.
2. Press **Start** in the **Session** card and allow microphone access if asked.
3. Ask the agent what it can do on this site.

### Verify Hosted Tools

A successful site-action lookup appears in the logs as an `actions.site` list
request. If no map matches the current site, the agent falls back to direct
primitives (screenshots, section listing, locator info, scroll, click).

If something is missing, see [Hosted Agent Tools](hosted-agent-tools.md) and
[Troubleshooting](troubleshooting.md).

## Know Your Way Around The Popup

All settings live in the extension popup. Click the extension icon to see, top
to bottom:

- **Take control of this tab** and **Open agent overlay** buttons;
- a **Session** card with **Start**, **Mute**, and **Stop**;
- a **Settings** area with collapsible sections: **OpenAI API key** (open by
  default), **Voice**, **Turn detection**, **Bridge**, **Storage folder**
  (**Upload**/**Download**), and **Memory**.

**Open agent overlay** opens a single agent pane on the page with the transcript
and voice controls. There is no Settings tab in the overlay — configure
everything from the popup.

## Drive Several Tabs At Once

One agent can operate more than one tab in the same session — the capability
behind cross-app workflows like "read this thread in Gmail, then put a follow-up
on the calendar, then update the CRM card." You authorize each tab once; the
agent moves between them and routes each action to the right one.

To set it up:

1. Open each tab you want the agent to operate.
2. In the extension popup on each tab, click **Take control of this tab**.
3. Ask the agent to work across them — it switches to the tab it needs.

Under the hood the agent has tab tools it uses on its own: it lists the
authorized tabs, switches the active one, and can **navigate**, **open**, and
**close** tabs as steps in a larger task. When several tabs are connected, each
action is routed to the intended tab (by its id or by a substring of its URL),
with one **active tab** as the default — so a multi-tab workflow doesn't get
ambiguous about where a click lands. See [Hosted Agent
Tools](hosted-agent-tools.md#claimed-tabs-and-tab-lifecycle) for the tab tools
and routing rules.

## Upload And Download Storage

Storage is what makes the agent site-aware. Upload it once and the agent can use
it whenever you ask what it can do on the current site. It holds:

- site action maps;
- page summaries and context actions;
- navigation playbooks;
- observations and item indexes;
- generated overlays and reports.

**Download** writes browser-local storage back to a folder. See
[actions.json.storage](actions-json-storage.md).

## Bookmarklet (Not Yet Available)

## Path C: Bookmarklet Or Embed-Path Testing

A bookmarklet/embed path — running `actions.json` from page JavaScript with no
extension install — is planned but **currently non-operational**; it has fallen
behind the rest of the runtime. **TODO:** bring the bookmarklet path back in
line with the extension and bridge runtimes before documenting it as usable.

## Content Security

Some sites restrict page scripts with Content Security Policy. Use the Chrome
extension path when CSP blocks bookmarklet or embed transport, and use the bridge
runtime checks to confirm which host is active before blaming a site map.

## Developer Builds

Only needed when changing runtime code:

```bash
npm install
npm run test:runtime
npm run test:overlay-runtime
node scripts/validate-skills.mjs
```
