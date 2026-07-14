---
title: Chrome Extension
nav_order: 4
---

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

The extension popup is the small menu opened by the browser action. It is the
home of all settings. From top to bottom it shows:

- an **actions.json / runtime** header;
- **Take control of this tab**;
- **Open agent overlay**;
- a **Session** card with the current session state (`Session: <state>`) and
  **Start**, **Mute**, and **Stop** buttons;
- an embedded **Settings** area with collapsible sections: **OpenAI API key**
  (open by default), **Voice**, **Turn detection**, **Bridge**, **Storage
  folder**, and **Memory and logs**.

Stop is intentionally available from the popup so the user can stop a hidden
offscreen voice session even if every page overlay is closed.

In the popup the settings sections are collapsed except the API key. The same
settings page can be opened as a full top-level page, where all sections are
expanded.

## actions.json Menu Overlay

The `actions.json` menu is a trusted extension-owned overlay injected into the
page. It is a single agent pane titled **actions.json agent**: hosted voice
controls and transcript. There are no tabs and no Settings inside the overlay;
all settings live in the extension popup.

The pane header is a drag handle with a collapse (☰) and a close (×) button.
Collapsed, the pane shrinks to a small square. Position, size, and collapsed
state persist across page navigation.

Unlike report overlays, the trusted menu embeds extension UI in an iframe so it
can request microphone permission from a visible extension surface.

The agent can also control the pane programmatically through the
`overlay.menu.collapse`, `overlay.menu.expand`, `overlay.menu.move`,
`overlay.menu.hide`, and `overlay.menu.show` primitives. A hide-operate-unhide
sequence makes page clicks reliable when the pane covers a click target.

## Hosted Agent Controls

The hosted agent uses the extension runtime to:

- inspect the page with screenshots;
- discover and run current-site actions through `actions.site`;
- use direct primitives;
- switch among claimed tabs when the user has authorized more than one tab;
- preserve transcript and diagnostic memory;
- keep the live session in an offscreen document.

For multi-step work, the hosted agent also has session-scoped task queue
primitives: `task.add`, `task.next`, `task.complete`, `task.list`, and
`task.clear`. The agent seeds a plan with `task.add` and drains it one task at
a time; an empty `task.next` returns `done: true` plus a summary of every
task's status and result.

Read [Hosted Agent](hosted-agent.md) for user workflow details.

## Storage Tools

The **Storage folder** section in the popup settings can upload or download a
local `actions.json.storage` checkout.

Upload stores a browser-local bundle that powers hosted-agent `actions.site`
lookups. Download writes browser-local storage files back to the selected local
folder.

Chrome blocks folder pickers inside iframes. The Upload and Download buttons
detect this and automatically open the top-level settings page, where the
picker works.

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
- `debug.run_javascript` is an authoring/debug fallback evaluated through Chrome
  Debugger Protocol.
- `browser.run_javascript` is a compatibility name for the same debugger-class,
  non-portable execution path. Manifest V3 content-script CSP forbids dynamic
  string evaluation, so it is never a generic content-script capability.
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
