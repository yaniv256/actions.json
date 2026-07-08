# Trusted Input Primitives — Design Spec

**Goal:** Give actions.json trusted (browser-level) keyboard and mouse input so
agents can operate hardened/canvas surfaces (Google Slides/Docs/Sheets editors)
that ignore synthetic events. This is the keystone that unblocks select-all,
atomic text replace, marquee selection, and object repositioning.

## Problem (root-caused)

- `content.js` `keyboardPress` (L3680) dispatches `new KeyboardEvent()` via
  `target.dispatchEvent` → **untrusted** (`isTrusted:false`). Canvas editors
  ignore it. Return carries `fidelity:"page_level"`.
- `content.js` `pointerDrag` (L3258) dispatches `new MouseEvent()` → same
  untrusted limitation.
- Consequence: `Ctrl+A` never selects inside a Slides text box; a wrong paste
  can't be corrected; boxes can't be marquee-selected or dragged.

## Mechanism (confirmed feasible)

The extension already wires `chrome.debugger` in `background.js`
(`debuggerAttach`/`debuggerDetach`/`debuggerSendCommand`, L1485-1492) and routes
background-only tools (screenshot, lifecycle) through
`executeBackgroundHostedToolCall` + `BRIDGE_BACKGROUND_ACTION_NAMES`.

CDP `Input.dispatchKeyEvent` and `Input.dispatchMouseEvent` emit **trusted**
events. So trusted-input primitives are **background-worker** primitives (NOT
content.js), routed like `browser.screenshot`.

## Primitives (this spec ships #1 first, then #2, #3)

### 1. `input.key` (trusted keypress) — KEYSTONE
Args: `{ key: string, modifiers?: string[] }` (same shape as keyboard.press).
Impl: attach debugger to the tab; for the chord, send `Input.dispatchKeyEvent`
`keyDown` then `keyUp` with the correct `windowsVirtualKeyCode`, `key`, `code`,
and `modifiers` bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8); detach.
Return: `{ pressed:true, key, modifiers, fidelity:"trusted" }`.
Live probe (ship gate): focus a Slides body box, `input.key {key:"a",
modifiers:["control"]}`, screenshot shows the box text selected.

### 2. `input.drag` (trusted drag) — select region OR move object
Args: `{ from:{x,y}, to:{x,y}, button?:"left" }`.
Impl: `Input.dispatchMouseEvent` `mousePressed` at from → several `mouseMoved`
steps → `mouseReleased` at to, all `button:"left"`, incrementing `buttons`.
Uses: marquee text/object selection; drag-reposition a selected box.

### 3. `input.click` (trusted click)
Args: `{ x, y, button?, clickCount? }`. `Input.dispatchMouseEvent`
pressed+released; `clickCount:2` for double-click.

## Derived (later, built ON the above, mostly maps/content)
- `select_all` — semantic wrapper = `input.key {key:"a", modifiers:[cmdOrCtrl]}`.
- `text.set_content` — focus + select_all + delete + paste (atomic replace).
- `object.nudge` — `input.key` arrows on a selected object.
- `menu` — open a named app menu, pick an item.

## Registration checklist (per write-actions-json skill)
For each new primitive: (a) add to `BRIDGE_BACKGROUND_ACTION_NAMES` and handle in
`executeBackgroundHostedToolCall`; (b) declare in `overlay.actions.json`
`tools[]` AND `primitive_dictionary.primitives[]` (summary, support:"supported",
input_schema, x_actions.handler); (c) add to the background-route allow-list test;
(d) bump manifest version; (e) package + release; (f) live-probe before "done".

## Non-goals
Not replacing the synthetic keyboard.press/pointer.drag (keep for portable
bookmarklet paths); trusted input is extension-only (needs chrome.debugger).

## Test plan
Source-assertion tests (matching the repo's style): assert `input.key` is in
`BRIDGE_BACKGROUND_ACTION_NAMES`, that its handler sends `Input.dispatchKeyEvent`,
and that it's declared in both manifest surfaces. Plus the live Slides Ctrl+A probe.
