---
title: Getting Started
nav_order: 2
---

# Getting Started

`actions.json` gives an AI agent a reliable way to operate websites. The Chrome
extension can host a voice/text agent directly, while the bridge lets an
external coding agent such as Codex or Claude Code inspect tabs, author site
maps, and test them in the browser.

This guide has two working paths:

- **Path A — use the hosted browser agent:** install the extension, add an
  OpenAI API key, authorize a tab, and talk or type to the agent.
- **Path B — author or test an action map:** install the extension, register the
  bridge with your coding agent, connect a tab, and verify the runtime.

A map is optional for Path A. Without one, the hosted agent uses its direct
browser primitives; adding a map makes it faster and more knowledgeable on that
site.

## Prerequisites

Before starting, confirm that you have:

- **Google Chrome** with permission to load an unpacked extension;
- **Node.js 18 or newer** and `npm`/`npx` for the bridge wrapper;
- for Path B, an MCP-capable client such as **Codex** or **Claude Code**;
- for hosted voice/text, an **OpenAI API** project key with available billing or
  credits. A ChatGPT subscription does not itself provide API credits;
- one of the supported bridge platforms: Linux x64, macOS x64, macOS arm64, or
  Windows x64.

Never paste an API key into a website, issue, chat message, or committed file.
Use the extension popup, the environment variable, or the ignored local config
described below.

## Install And Verify The Chrome Extension

1. Open the [latest release](https://github.com/yaniv256/actions.json/releases/latest).
2. Download both:
   - `actions-json-overlay-runtime-<version>.zip`
   - `SHA256SUMS.txt`
3. Verify the archive before unzipping it.

On Linux:

```bash
archive="$(ls actions-json-overlay-runtime-*.zip)"
grep " $(basename "$archive")$" SHA256SUMS.txt | sha256sum -c -
```

On macOS:

```bash
archive="$(ls actions-json-overlay-runtime-*.zip)"
grep " $(basename "$archive")$" SHA256SUMS.txt | shasum -a 256 -c -
```

On Windows PowerShell:

```powershell
$archive = Get-ChildItem actions-json-overlay-runtime-*.zip | Select-Object -First 1
$expected = ((Select-String -Path SHA256SUMS.txt -Pattern ([regex]::Escape($archive.Name))).Line -split '\s+')[0].ToLower()
$actual = (Get-FileHash $archive.FullName -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "SHA-256 mismatch for $($archive.Name)" }
"SHA-256 verified: $($archive.Name)"
```

4. Unzip the archive.
5. Open `chrome://extensions`.
6. Enable **Developer mode**.
7. Choose **Load unpacked** and select the unzipped extension directory.
8. Open the extension's **Details** page and record its **extension version**.
   If Chrome shows errors, stop and open the error details before continuing.

## Path A: Use The Hosted Browser Agent

### 1. Add your OpenAI key

1. Click the extension icon.
2. Open **Settings → OpenAI API key**.
3. Paste the key and save it.

The key is stored in Chrome extension-local storage and sent to OpenAI only to
run your hosted session. You can remove it from the same settings panel.

### 2. Authorize a tab

1. Open the website you want the agent to operate.
2. Click the extension icon.
3. Click **Take control of this tab**.
4. Choose **Open agent overlay** or open the side panel.
5. Press **Start** and allow microphone access if you want voice. You can also
   type in the transcript composer.

### 3. Verify the hosted agent

Ask:

> What page are you on, and what can you do here?

**Expected result:** the transcript identifies the current page and describes
available site actions or direct browser primitives. If a map applies, the logs
show an `actions.site` list call. If no map applies, direct tools such as
screenshots, accessibility queries, scrolling, and clicking remain available.

For a shared map, upload its `actions.json.storage` folder under **Settings →
Storage folder → Upload**. Uploading a map is an enhancement, not a prerequisite
for starting the generic hosted agent.

If Start remains disabled or the agent cannot see the authorized tab, follow
[Hosted Agent](hosted-agent.md) and then [Troubleshooting](troubleshooting.md).

## Path B: Connect An External Coding Agent

Use this path when Codex, Claude Code, or another MCP client should author,
inspect, or test `actions.json` files.

### 1. Register the bridge

Run one command for your client:

**Codex**

```bash
codex mcp add actions-json -- npx -y @actions-json/bridge@latest mcp
```

**Claude Code**

```bash
claude mcp add actions-json -- npx -y @actions-json/bridge@latest mcp
```

For another MCP client, use:

```json
{
  "mcpServers": {
    "actions-json": {
      "command": "npx",
      "args": ["-y", "@actions-json/bridge@latest", "mcp"]
    }
  }
}
```

Restart or reconnect the MCP client so it launches the registered server.

### 2. Verify the installed bridge artifact

From a clean terminal, run:

```bash
npx -y @actions-json/bridge@latest --version
npx -y @actions-json/bridge@latest --help
npm view @actions-json/bridge version
```

The first command prints the **npm wrapper version** without downloading a
binary. The second downloads or reuses the pinned bridge binary and must print
its help without an HTTP error. The npm wrapper version and bridge binary
version may differ when the wrapper deliberately pins a compatible binary; a
missing release asset or HTTP 404 is a broken installation, not a compatible
version difference.

Compare this output with the extension version recorded above. Use the latest
public extension and latest npm wrapper together. When reporting a problem,
include both version numbers and the full download error.

### 3. Configure OpenAI credential hydration (optional)

An external coding agent can operate the browser without an OpenAI key. A key is
needed only when you also want the extension-hosted agent.

The bridge does **not** discover a key from an arbitrary coding-agent session.
It hydrates the extension only from one of these explicit local sources:

```bash
export ACTIONS_JSON_OPENAI_API_KEY="sk-..."
```

or an ignored `.actions-json.local.json` in the directory from which the bridge
starts:

```json
{
  "openai_api_key": "sk-..."
}
```

Add `.actions-json.local.json` to `.gitignore` before creating it. The
environment variable takes precedence. You can instead enter the key manually
in the extension popup.

### 4. Connect Chrome to the bridge

1. Open a normal HTTPS website.
2. Open the extension popup.
3. Under **Bridge**, enter:

   ```text
   ws://127.0.0.1:17345/extension
   ```

4. Click **Connect**.
5. Click **Take control of this tab**.

Use `127.0.0.1` only when Chrome and the bridge run on the same computer.

For cross-machine operation, the bridge can bind to `0.0.0.0:17345` and Chrome
can connect to the bridge host's reachable VPN address. **This exposes the
bridge on every network interface.** Restrict access with a host firewall and a
private network such as Tailscale. Do not expose port 17345 directly to the
public internet. See [Bridge Architecture](bridge-architecture.md) before using
a non-loopback bind address.

### 5. Verify the complete bridge path

Ask the coding agent to perform these checks in order:

1. Read `actions-json://bridge/launch`.
2. Read `actions-json://bridge/runtimes`.
3. Call `browser.claimed_tabs.list`.
4. Call `actions.site` in list mode for the authorized tab.

**Expected result:**

- the launch resource reports the bridge bind address and tool interface;
- the runtime resource contains the authorized tab, its URL, and extension
  version;
- `browser.claimed_tabs.list` reports at least one live runtime;
- `actions.site` lists applicable site actions, or returns an honest empty
  site catalog while direct primitives remain available.

If a check fails, diagnose in that order:

1. bridge process did not launch;
2. extension Bridge URL is wrong;
3. tab was not authorized with **Take control of this tab**;
4. the runtime disconnected or is stale;
5. no map applies to the current URL.

Do not reload Chrome, reinstall the extension, or edit a site map until the
earliest failing layer is known. See [Troubleshooting](troubleshooting.md) for
the exact symptom.

## Drive Several Tabs

Authorize each tab separately with **Take control of this tab**. The agent can
then list, activate, navigate, open, and close claimed tabs and route calls by
runtime ID or URL substring.

Before closing an editor tab, save or discard its changes. Current releases may
show a native `beforeunload` confirmation when unsaved changes exist; use the
dialog recovery tools rather than killing or restarting Chrome. See [Hosted
Agent Tools](hosted-agent-tools.md#claimed-tabs-and-tab-lifecycle).

## Storage

Storage holds site maps, page summaries, navigation guidance, observations,
overlays, and reports. The extension's **Upload** action imports a storage root
or scope folder; **Download** writes browser-local storage back to disk.

Read [actions.json.storage](actions-json-storage.md) before sharing a bundle so
private and public scopes remain separate.

## Current Limitations

The bookmarklet/embed runtime is not currently a supported onboarding path. Use
the Chrome extension for real browser operation and Content Security Policy
compatibility. Contributors working on portable runtime parity should start
from the [Runtime README on
GitHub](https://github.com/yaniv256/actions.json/blob/main/runtime/actions-json-runtime/README.md),
not from this user setup guide.

## Developer Builds

These commands are for contributors changing runtime code, not for ordinary
installation:

```bash
npm install
npm run test:runtime
npm run test:overlay-runtime
node scripts/validate-skills.mjs
```

Continue with [Documentation Home](index.md), [Hosted Agent
Tools](hosted-agent-tools.md), or [Troubleshooting](troubleshooting.md).
