---
title: Hosted Agent
nav_order: 3
has_children: true
---

# Hosted Agent

The Chrome extension can host a `gpt-realtime-2.1` voice/text agent directly in
the browser.

This is the end-user path for `actions.json`: install the extension, authorize a
tab, upload site memory, add your OpenAI key, and talk to an agent that can see
and operate the current website through declared actions.

## What The Hosted Agent Is

The hosted agent is an extension-owned Realtime session. It uses:

- your OpenAI API key, stored in Chrome extension storage;
- the authorized browser tab as its operating surface;
- `browser.screenshot` to inspect visible page state;
- uploaded `actions.json.storage` to discover and run current-site actions
  through `actions.site`;
- direct primitives such as `locator.element_info`, `viewport.scroll`, and
  `pointer.click` when stored actions are missing or insufficient;
- extension-local transcript, tool, memory, and diagnostic logs.

The session is owned by an extension offscreen document, not by the page overlay.
That means closing or reinjecting the visible overlay should not intentionally
stop the live voice session. Use **Stop** when you want the session to end.

## What It Can Do

Current capabilities include:

- voice conversation through `gpt-realtime-2.1`;
- a text transcript with one mutable user and assistant bubble while speech
  deltas arrive, plus a composer for typed input;
- page screenshots after user authorization;
- storage-backed website context and actions through `actions.site`;
- direct browser primitives for visible page interaction;
- generated overlays and launchers;
- session memory rehydration;
- `runtime.session.log` diagnostics for transcript, tool calls, failures,
  screenshots, and lifecycle events.

## Start A Session

1. Install and authorize the Chrome extension. See
   [Getting Started](getting-started.md).
2. Click the extension icon to open the popup. In the embedded Settings area,
   save your OpenAI API key (the **OpenAI API key** section is open by
   default).
3. Optional but recommended: upload an `actions.json.storage` checkout from
   the **Storage folder** section.
4. Choose **Open agent overlay** to open the agent pane on the page.
5. Press **Start voice**.
6. Allow microphone permission if Chrome asks.

Expected result: the agent pane shows a live voice state and a transcript area.

## Agent Pane

The agent pane — the page overlay titled **actions.json agent** — is the
conversation surface.

It contains:

- the main voice control;
- Stop and mute controls;
- a bounded transcript;
- a text composer;
- current session status.

The transcript is for conversation. Successful tool calls do not add transcript
lines; the voice launcher shows a transient **Using tool** state instead. A
single line such as `Tool <name> failed: <message>.` appears only when a tool
call fails, and at session start one line reports
`Bridge tools loaded: <count>.` (a count, not a list). Detailed diagnostics
belong in `runtime.session.log`, not as token-by-token chat spam.

## Settings (Popup)

All operational configuration lives in the extension popup, in collapsible
settings sections:

- OpenAI API key save/delete state;
- Realtime voice selection;
- turn detection (VAD) controls for speech interruption behavior;
- bridge URL for external-agent workflows;
- storage folder Upload and Download;
- memory and log controls.

In the popup all sections are collapsed except the API key. Opened as a
top-level page, all sections are expanded. Folder pickers do not work inside
iframes, so the storage Upload and Download buttons open the top-level settings
page automatically.

Voice and VAD settings apply to the next Realtime session. OpenAI locks the
voice once audio has started in a session.

## Storage-Backed Context And actions.site

Uploaded storage makes the hosted agent site-aware.

The hosted agent receives one stable site-action tool: `actions.site`. It uses
that tool when you ask it to:

- list actions available for the current website;
- call a named current-site action;
- read storage-backed context actions such as summaries, navigation playbooks,
  product guides, or link lists.

There is no separate `actions.context` tool in the current v1 surface. Site
context should be exposed as callable `actions.site` actions.

See [Hosted Agent Tools](hosted-agent-tools.md).

## Screenshots And Tool Calls

The agent can call `browser.screenshot` after the tab is authorized. Screenshot
data is passed to the Realtime model as image input; large image payloads are
not stored in session logs.

Hosted screenshots default to a compact profile: JPEG at quality 60, scaled to
at most 960x960 pixels, capped at 180 KB, with a 10 second capture timeout.

For interaction, the agent should prefer stored actions. When it needs lower
level control, it can use primitives such as:

- `locator.element_info`;
- `viewport.scroll`;
- `pointer.click`;
- `dom.list_sections`;
- `browser.extract_elements`.

Direct generic primitive calls from the hosted agent must include a
`policy_exception_report` argument (`kind`, `intended_tool`,
`actions_json_path`, `reason`). Calls without it are rejected with
`policy_exception_report_required` before reaching the bridge. `actions.site`
calls and internal steps of compound actions are exempt.

Human-observable actions such as clicking and scrolling are paced by the
runtime so bursts of requests do not execute faster than a human-visible rhythm.

## Session Memory And Logs

The extension keeps a diagnostic session log in Chrome extension storage.

Use `runtime.session.log` when you need to inspect:

- transcript turns;
- tool call arguments and results;
- routing decisions;
- tool failures;
- screenshot metadata;
- Realtime lifecycle and audio configuration events.

`runtime.session.log` returns `{ ok, visitorId, eventCount, events }`. The
returned events are capped (default 80, maximum 2000) and sanitized: secrets
are redacted and image payloads are stripped.

The log is for debugging. It is not a public artifact and may include browsing
context from authorized tabs.

## Navigation Persistence

The live Realtime session is hosted by an extension offscreen document. The
visible page overlay is a controller/view that can reconnect to that durable
session.

This design is intended to keep conversation state alive when:

- the overlay is closed and reopened;
- the content script is reinjected;
- the page navigates within the same site;
- the active tab target changes and the extension can retarget tools.

Browser permissions, page lifecycle behavior, and cross-domain navigation can
still require user recovery in some cases. If navigation interrupts the session,
use [Troubleshooting](troubleshooting.md) and inspect `runtime.session.log`.

## Safety And Limitations

- The OpenAI key is stored in Chrome extension storage.
- Microphone permission is controlled by Chrome.
- The extension operates only on user-authorized tabs.
- Site actions depend on uploaded storage and current page compatibility.
- Debugger-backed actions are for authoring and repair, not normal product use.
- The project is pre-1.0; schema and runtime behavior may change.
