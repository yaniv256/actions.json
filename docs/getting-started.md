# Getting Started

This guide gets a user or agent from a fresh checkout or release artifact to a
connected browser runtime.

`actions.json` has three moving pieces:

- **Browser runtime**: code running in the browser page. Use the Chrome
  extension for the most capable authoring environment, or the bookmarklet to
  test the page-JavaScript/embed path.
- **MCP-shaped bridge**: the local or tunneled process that accepts agent calls
  and routes them to connected browser runtimes.
- **Storage**: an optional `actions.json.storage` checkout that holds learned
  site maps, observations, runs, items, and overlays.

## Choose A Runtime

Use the **Chrome extension** when you can install it. It is the preferred
authoring runtime because it can provide privileged browser capabilities after
the user authorizes a tab:

- true rendered screenshots;
- stable tab/session identity;
- controlled-tab grouping;
- extension-assisted relay for pages that block bookmarklet networking;
- debugger-only authoring tools.

Use the **bookmarklet** when you want a lightweight install or need to test what
a future first-party website embed can do from page JavaScript. It is useful,
but less capable:

- it cannot autonomously capture a true screenshot;
- overlays can be affected by the host page's CSS and security policy;
- many sites block direct calls to `127.0.0.1:17345` through Content Security
  Policy (CSP);
- on CSP-blocked pages, bookmarklet testing may require the extension relay.

The runtimes are alternatives, not mandatory sequential installs. You can use
only the extension, only the bookmarklet, or both.

## Install From A Release

For normal use, install released artifacts. Building from source is only needed
when changing the runtime or testing unreleased work.

A release should provide one or more of:

- a bookmarklet `install.html` page;
- a bookmarklet `.url` or text file containing a `javascript:` URL;
- a Chrome extension ZIP or unpacked extension directory;
- bridge binary or source checkout instructions.

The agent cannot drag bookmarks or load browser extensions by itself. It should
prepare the artifact, guide the user through the browser UI, then verify the
connection through the bridge.

## Install The Bookmarklet

Performed by the user:

1. Open the released bookmarklet `install.html`.
2. Drag the `actions.json` link into the browser bookmarks bar.
3. If drag install is unavailable, create a bookmark manually and paste the
   released `javascript:` URL into the bookmark URL field.
4. Open a target website and click the `actions.json` bookmark.

If the page blocks direct bridge transport, the bookmarklet may show a transport
or relay status instead of connecting directly.

## Install The Chrome Extension

Performed by the user:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Install the released extension package, or choose **Load unpacked** and select
   the released unpacked extension directory.
4. Open the target website.
5. Click the extension action and authorize the current tab.

Authorized tabs should appear in the `actions.json` browser tab group when the
extension runtime supports controlled-tab grouping.

## Start The Bridge

Start the released bridge binary when available. If you are developing from this
repository, run the bridge from source:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root ../actions.json.storage
```

`--storage-root` is optional. Include it when you have an
`actions.json.storage` checkout and want the bridge to load site action maps and
storage files from that workspace.

The default bridge endpoint is:

```text
http://127.0.0.1:17345
```

If the browser and agent are on different machines, expose the bridge endpoint
through SSH, Tailscale, or another tunnel. From the browser runtime's point of
view, it is still connecting to the configured bridge endpoint.

## Verify The Connection

Check connected runtimes:

```bash
curl -s http://127.0.0.1:17345/runtimes
```

Check the stable tool surface:

```bash
curl -s http://127.0.0.1:17345/mcp/tools/list
```

Expected result:

- `/runtimes` currently lists connected extension and/or bookmarklet runtimes
  with runtime id, runtime key, authorization id, extension version, timestamps,
  and URL.
- `/mcp/tools/list` lists stable generic tools such as site action discovery,
  storage sync/list operations, screenshot support where available, and the
  primitive tools currently exposed by the runtime manifest.

Implementation pending: `/runtimes` should eventually expose normalized host,
title, and capability summaries, and routing should eventually support title
predicates. Today, use `target_runtime_id` or `target_url_contains`.

If no runtime appears:

- confirm the bridge process is running;
- refresh and reauthorize the extension tab;
- rerun the bookmarklet on the target page;
- check whether the page's CSP blocks bookmarklet transport;
- avoid restarting the bridge for ordinary `actions.json` edits; use storage
  sync/reload paths instead.

## Load Site Storage

If you have an `actions.json.storage` checkout, load the relevant site folder
when using the browser runtime UI. Site storage commonly contains:

- `actions.json`: learned site actions;
- `observations/`: raw facts captured from the page;
- `items/`: deduplicated memory derived from observations;
- `runs/`: execution traces and lessons;
- `overlays/` or `reports/`: generated user-facing views.

After loading storage, ask the site action tool what actions are available for
the current page before using debugger-only tools.

Implementation pending: bridge-side `storage.sync` currently imports the
configured storage root bundle, excluding generated and dependency directories.
Page-relevant bridge sync is the intended behavior, but it is not the current
bridge implementation.

## Developer Builds

Use developer builds only when changing runtime code.

Install JavaScript dependencies:

```bash
npm install
```

Build the bookmarklet from source:

```bash
npm run build:storage-bookmarklet
```

Run runtime tests:

```bash
npm run test:runtime
```

Run Chrome overlay runtime tests:

```bash
npm run test:overlay-runtime
```
