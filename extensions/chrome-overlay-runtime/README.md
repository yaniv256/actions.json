# actions.json Overlay Runtime Extension

Experimental Chrome MV3 extension runtime for `actions.json`.

This extension is a first-pass implementation of an authorized browser-side runtime:

1. The user opens a page, such as Linear.
2. The user clicks the extension and authorizes the current tab.
3. The content script loads `actions/overlay.actions.json`.
4. The content script connects to a local bridge at `ws://127.0.0.1:17345/extension`.
5. The local bridge can send Responses-style `action_call` items for declared actions such as `overlay.open`.
6. The extension renders agent-provided HTML inside a draggable, resizable, minimizable popup overlay.
7. The same `overlay.open` call can install visible launcher buttons into the original page DOM so the user can reopen the overlay from the relevant page context.

The extension does not use an iframe for the overlay. It creates a temporary Shadow DOM surface in the page.

## Install for Local Testing

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select this directory:

   ```text
   extensions/chrome-overlay-runtime
   ```

5. Start the local bridge:

   ```bash
   cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve \
     --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json
   ```

6. Open the target page.
7. Click the extension action and choose **Authorize current tab**.

## Safety Model

This is intentionally user-authorized per tab. The extension only connects after the user clicks the extension on the target page.

The overlay is temporary and disappears on page reload or navigation. It should not be used for credential capture, deceptive UI, or persistent site modification.

## Overlay Controls

Each overlay has title-bar controls:

- **Minimize** collapses the overlay to a compact draggable title bar.
- **Expand** restores the overlay to its previous rendered size.
- **Reset** restores the default position and size.
- **Close** removes the overlay from the page.

## Page Launchers

`overlay.open` accepts optional `launchers`. A launcher is a small button inserted near a selected element in the original page DOM. This lets the user reopen a closed overlay from the page context that motivated it, such as:

- an schema demo launcher near Linear issue links or headings;
- a Continue Watching launcher near the Prime Video carousel title.

Launcher placement is selector-based with optional URL and visible-text filters. The runtime stores registered overlay payloads in the page content script, watches for SPA navigation and DOM replacement, and reinstalls matching launchers when the relevant page context reappears. Multiple overlay launchers can coexist on one authorized tab; each launcher reopens its own registered overlay without requiring a new bridge call.
