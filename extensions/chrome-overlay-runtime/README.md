# Chrome Overlay Runtime Extension

This directory contains the Chrome MV3 runtime for `actions.json`.

The extension is both:

- a browser runtime that can execute `actions.json` primitives on authorized
  tabs; and
- a hosted `gpt-realtime-2.1` agent surface that uses the user's OpenAI API key,
  uploaded storage, screenshots, and runtime tools.

For user-facing setup, start with
[Getting Started](../../docs/getting-started.md) and
[Chrome Extension](../../docs/chrome-extension.md).

## What The Extension Provides

- Per-tab authorization from the extension popup.
- The trusted `actions.json` menu overlay.
- Top-level **Agent** and **Settings** tabs.
- Hosted voice/text agent controls, transcript, voice selection, and VAD
  settings.
- Extension-owned offscreen document for the live Realtime WebRTC session.
- Popup voice controls that can stop a hidden session even when no overlay is
  visible.
- Storage upload/download for `actions.json.storage` checkouts.
- `actions.site` for storage-backed current-site actions.
- Direct primitives such as screenshots, scrolling, pointer actions, DOM
  inspection, locator geometry, and overlay rendering.
- Debugger-backed authoring fallback through `debug.run_javascript`.

## Install For Local Testing

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this directory:

   ```text
   extensions/chrome-overlay-runtime
   ```

5. Open a website.
6. Click the extension icon.
7. Choose **Take control of this tab**.
8. Choose **Open actions.json menu**.

The hosted agent can run without the local bridge. Add an OpenAI API key in
**Settings**, upload storage if you want site-specific actions, then start the
voice session from **Agent**.

Run the local bridge only when an external coding agent needs to operate the
extension runtime:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve
```

## Source Map

- `manifest.json`: Chrome MV3 manifest and permissions.
- `popup.html` / `src/popup.js`: extension icon popup, tab authorization, menu
  launch, and direct voice controls.
- `sidepanel.html` / `src/sidepanel.js`: extension-owned Agent and Settings UI
  rendered inside the trusted overlay iframe.
- `offscreen.html` / `src/offscreen-agent.js`: hidden extension document that
  owns the live Realtime WebRTC session.
- `src/agent/`: hosted-agent session manager, transcript handling, tool catalog,
  voice settings, VAD settings, and memory helpers.
- `src/background.js`: tab authorization, bridge connection, tool routing,
  storage state, offscreen lifecycle, screenshot handling, and navigation
  reinjection.
- `src/content.js`: page overlay shell, portable primitives, launcher
  placement, page inspection, and storage import handling.
- `src/storage-bundle.mjs`: storage upload/download bundle handling.
- `actions/overlay.actions.json`: extension runtime action manifest.

## Permissions And Boundaries

The extension asks for permissions that match its current role:

- `activeTab`, `tabs`, and `scripting` for authorized tab operation;
- `storage` for API key state, settings, uploaded storage, and session memory;
- `offscreen` for the durable Realtime audio session;
- `tabGroups` for transparent controlled-tab grouping;
- `debugger` for authoring fallback tools.

Debugger-backed tools are privileged. Use them to learn how a page works, then
encode durable behavior as portable `actions.json` actions.

Do not use report overlays for credential capture, deceptive UI, or persistent
site modification. Inline agent-provided overlays are sanitized before render.
Template/data overlays run in a sandboxed report frame so reviewed template
JavaScript can render trusted JSON data without inheriting page CSS. The trusted
`actions.json` menu is extension-owned UI.

## Runtime Tools

The extension manifest currently includes:

- overlay tools: `overlay.open`, `overlay.register_launcher`, `overlay.close`;
- session tools: `runtime.configure_pacing`, `runtime.session.log`;
- browser tools: `browser.screenshot`, `browser.extract_elements`,
  `browser.claimed_tabs.list`, `browser.claimed_tabs.activate`;
- storage tools: `storage.import_bundle`, `storage.list`, `storage.sync`;
- DOM and locator tools: `dom.list_sections`, `locator.element_info`;
- visible action tools: `viewport.scroll`, `pointer.click`;
- JavaScript tools: `browser.run_javascript`, `debug.run_javascript`;
- current-site tool: `actions.site`.

Site maps can remove unsafe or blocked portable tools for a given website. For
example, if page JavaScript evaluation is blocked or inappropriate, remove
`browser.run_javascript` from the site-facing action set while keeping
`debug.run_javascript` available for extension authoring.

## Verify A Local Build

Run the relevant tests before packaging or release work:

```bash
node --test extensions/chrome-overlay-runtime/tests/*.test.mjs \
  tests/background-screenshot.test.mjs \
  tests/package-extension.test.mjs
```

Package validation checks that required files such as `popup.html`,
`offscreen.html`, and the hosted-agent modules are present.

## Related Docs

- [Hosted Agent](../../docs/hosted-agent.md)
- [Hosted Agent Tools](../../docs/hosted-agent-tools.md)
- [Hosted Agent Chat UI](../../docs/hosted-agent-chat-ui.md)
- [Bridge Architecture](../../docs/bridge-architecture.md)
- [Troubleshooting](../../docs/troubleshooting.md)
