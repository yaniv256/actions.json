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

## Which Path Is Yours?

There is one question that decides your path:

**Are you _building_ an `actions.json`, or _trying one out_?**

| You want to... | Path | Why |
|---|---|---|
| Build or change an `actions.json` for a site | **[Develop with a coding agent](#path-1-develop-with-a-coding-agent-mcp)** | Your coding agent edits the map _and_ loads it into your browser to test it — you don't need a finished map first. **Start here.** |
| Try out an `actions.json` a collaborator gave you | **[Explore a finished map](#path-2-explore-a-finished-map-standalone-extension)** | You already have a map file. Upload it to the extension and see what it can do. No coding agent needed. |

Most people arrive here to **build**, so Path 1 is the main path. If you are
developing a map, the standalone extension path is _not_ for you — you would
have nothing finished to upload yet (the exception is hand-writing the JSON with
no agent at all).

## Path 1: Develop With A Coding Agent (MCP)

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

The bridge runs with `npx` — no install, no toolchain. The
`@actions-json/bridge` package downloads the matching prebuilt binary on first
run and execs it.

**Claude Code** — one command:

```bash
claude mcp add actions-json -- \
  npx -y @actions-json/bridge mcp \
  --bind 0.0.0.0:17345 \
  --actions /abs/path/to/actions.json/extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root /abs/path/to/actions.json.storage
```

**Codex / other clients** — add an entry to the MCP servers config (Codex uses
`~/.codex/config.toml`):

```toml
[mcp_servers.actions-json]
command = "npx"
args = [
  "-y", "@actions-json/bridge", "mcp",
  "--bind", "0.0.0.0:17345",
  "--actions", "/abs/path/to/actions.json/extensions/chrome-overlay-runtime/actions/overlay.actions.json",
  "--storage-root", "/abs/path/to/actions.json.storage",
]
```

The equivalent generic `mcpServers` JSON block (Claude Desktop and most other
clients):

```json
{
  "mcpServers": {
    "actions-json": {
      "command": "npx",
      "args": [
        "-y", "@actions-json/bridge", "mcp",
        "--bind", "0.0.0.0:17345",
        "--actions", "/abs/path/to/actions.json/extensions/chrome-overlay-runtime/actions/overlay.actions.json",
        "--storage-root", "/abs/path/to/actions.json.storage"
      ]
    }
  }
}
```

What the flags mean:

| Flag | Meaning |
|---|---|
| `mcp` | Run as an MCP stdio server (the mode your coding agent talks to). |
| `--bind 0.0.0.0:17345` | Where the browser connects. `0.0.0.0` accepts connections from another machine; use `127.0.0.1:17345` if Chrome and the bridge run on the same machine. |
| `--actions <file>` | The browser-control primitive manifest. Read **once at launch** — restart the bridge after editing it. The repo's `extensions/chrome-overlay-runtime/actions/overlay.actions.json` is the standard one; pass its absolute path. |
| `--storage-root <dir>` | Your `actions.json.storage` checkout. The bridge loads site maps and context from here and pushes them to the browser. |

> **Prebuilt binaries are published for linux-x64, macos-x64, macos-arm64, and
> win-x64** — `npx` picks the right one for your machine automatically. On any
> other platform/arch it prints build-from-source instructions instead (clone
> the repo and `cargo build --release --manifest-path mcp/actions-json-mcp/Cargo.toml`,
> then point `command` at `mcp/actions-json-mcp/target/release/actions-json-mcp`).

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

## Path 2: Explore A Finished Map (Standalone Extension)

Use this when a collaborator has given you an `actions.json` and you just want to
see what it does — no coding agent involved.

**Prerequisite:** you have an `actions.json.storage` checkout (or a single map
file) ready to upload. If you don't, you want Path 1.

### 1. Install the Chrome extension

Same as Path 1, step 1 — from the
[releases page](https://github.com/yaniv256/actions.json/releases).

### 2. Add your OpenAI key

1. Click the extension icon. The **OpenAI API key** section is open by default.
2. Paste your OpenAI API key and save it.

The key is stored in Chrome extension storage and used only by this extension to
connect to OpenAI. (This is the same key you would hand a coding agent in Path 1
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

## About Storage

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

A bookmarklet/embed path — running `actions.json` from page JavaScript with no
extension install — is planned but **currently non-operational**; it has fallen
behind the rest of the runtime. **TODO:** bring the bookmarklet path back in
line with the extension and bridge runtimes before documenting it as usable.

## Developer Builds

Only needed when changing runtime code:

```bash
npm install
npm run test:runtime
npm run test:overlay-runtime
node scripts/validate-skills.mjs
```
