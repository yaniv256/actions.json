# Chrome Extension

The Chrome extension is the privileged browser runtime for `actions.json`.

It is both an authoring host for agents that are learning a website and an
end-user host for the extension-hosted Realtime agent.

## What The Extension Provides

The extension can:

- authorize the current browser tab for `actions.json` control;
- group authorized tabs for user-visible transparency;
- render the trusted `actions.json` menu overlay;
- host the GPT Realtime browser agent with your OpenAI key;
- take true visible-tab screenshots after authorization;
- upload and download `actions.json.storage`;
- execute portable primitives such as scroll, click, text insert, DOM reads, and
  locator lookup;
- switch among tabs the user has already authorized;
- run debugger-backed JavaScript for authoring-only repair work;
- relay bookmarklet traffic on pages where direct bookmarklet transport is
  blocked;
- return session diagnostics through `runtime.session.log`.

## Install And Authorize A Tab

1. Install the released extension or load
   `extensions/chrome-overlay-runtime/` unpacked for development.
2. Open a website.
3. Click the extension action.
4. Choose **Take control of this tab**.

Expected result: the tab is authorized. When tab grouping is available, the tab
is placed in the `actions.json` group.

If you want the agent to work across several tabs, repeat **Take control of this
tab** on each tab. The runtime can then list and activate claimed tabs without
asking for a new authorization on every switch.

## Popup Controls

The extension popup is the small menu opened by the browser action. It provides:

- **Take control of this tab**;
- **Open actions.json menu**;
- **Open storage tools**;
- hosted voice Play, Mute/Unmute, and Stop controls.

Stop is intentionally available from the popup so the user can stop a hidden
offscreen voice session even if every page overlay is closed.

## actions.json Menu Overlay

The `actions.json` menu is a trusted extension-owned overlay injected into the
page. It has top-level tabs:

- **Agent**: hosted voice controls and transcript.
- **Settings**: OpenAI key, bridge URL, voice, VAD, memory, and storage
  controls.

Unlike report overlays, the trusted menu embeds extension UI in an iframe so it
can request microphone permission from a visible extension surface.

## Hosted Agent Controls

The hosted agent uses the extension runtime to:

- inspect the page with screenshots;
- discover and run current-site actions through `actions.site`;
- use direct primitives;
- switch among claimed tabs when the user has authorized more than one tab;
- preserve transcript and diagnostic memory;
- keep the live session in an offscreen document.

Read [Hosted Agent](hosted-agent.md) for user workflow details.

## Storage Tools

The Settings tab can upload or download a local `actions.json.storage` checkout.

Upload stores a browser-local bundle that powers hosted-agent `actions.site`
lookups. Download writes browser-local storage files back to the selected local
folder.

Read [actions.json.storage](actions-json-storage.md).

## Overlays And Launchers

Agents can render HTML overlays with `overlay.open`. Report overlays are
temporary Shadow DOM surfaces in the page. Scripts are stripped from provided
HTML.

`overlay.register_launcher` can install visible launcher buttons near matching
page content. Launchers can restore when single-page apps rerender or when the
content script is reinjected.

Use overlays for reports, summaries, controls, and user-facing artifacts. Do
not use them for credential capture, deceptive UI, or persistent site
modification.

## Bridge And Relay

External coding agents connect through the MCP-shaped bridge. The extension can
connect to the bridge over WebSocket and receive bridge-routed action calls.

The hosted extension agent does not require the bridge for its local tool
catalog or uploaded storage-backed `actions.site` calls.

The extension can also relay bookmarklet traffic when a page blocks direct
bookmarklet transport. This is useful for testing page-JavaScript behavior on
sites with restrictive policies.

## Privileged And Debugger Operations

The extension declares privileged browser permissions because it is an authoring
runtime.

Important boundaries:

- `browser.screenshot` is user-authorized extension behavior.
- `debug.run_javascript` is an authoring/debug fallback for pages where content
  script JavaScript is blocked or insufficient.
- `browser.run_javascript` is page-context JavaScript and can be suppressed for
  sites that declare page eval blocked.
- Debugger discoveries should be converted into reviewed `actions.json`
  actions before normal use.

## Current Limitations

- The extension is pre-1.0.
- Browser and site policies can limit microphone, screenshot, JavaScript, and
  navigation behavior.
- Hosted-agent quality depends on the current site map and uploaded storage.
- The extension currently targets Chrome MV3. Other browsers need separate
  validation.

See [Troubleshooting](troubleshooting.md) for common failures.
