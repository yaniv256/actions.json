import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Guards the 2026-07-05 select-and-type composite: text.type types a string as
// keystrokes. trusted:true routes to CDP Input.insertText (overtypes the active
// selection + reaches canvas editors, where clipboard.paste does not route to a
// keyboard-made selection). Optional select_back_chars extends the selection
// backward first, so one atomic call both selects a phrase and overtypes it.

const contentSource = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"));

test("trusted text.type relays to the background CDP insertText path", () => {
  assert.ok(contentSource.includes('type: "actions-json:marker-trusted-text"'), "content must relay trusted text");
  assert.ok(backgroundSource.includes('message?.type === "actions-json:marker-trusted-text"'), "background must handle the relay");
  assert.ok(backgroundSource.includes('debuggerSendCommand(target, "Input.insertText"'), "must use CDP Input.insertText");
});

test("select_back_chars extends the selection with Shift+Left before inserting", () => {
  assert.ok(
    backgroundSource.includes("modifiers: CDP_MODIFIER_BITS.shift") && backgroundSource.includes('cdpKeyInfo("ArrowLeft")'),
    "select_back_chars must dispatch Shift+ArrowLeft before insertText",
  );
  assert.ok(
    backgroundSource.includes("for (let i = 0; i < count; i += 1)"),
    "it must loop count times to select the phrase",
  );
  assert.ok(
    backgroundSource.includes("dispatchTrustedText(Number(tabId), args.text, args.select_back_chars)"),
    "the hosted-tool path must thread select_back_chars through",
  );
});

test("synthetic text.type (default) inserts at the focused editable, no debugger", () => {
  assert.ok(
    contentSource.includes('insertTextIntoEditable("text.type"'),
    "synthetic path reuses the portable insert",
  );
});

test("text.type is routed to background ONLY when trusted:true", () => {
  assert.ok(
    backgroundSource.includes('item?.name === "text.type" && item?.arguments && item.arguments.trusted === true'),
    "bridgeItemNeedsBackground must gate text.type on trusted:true",
  );
});

test("text.type is declared in both manifest surfaces with select_back_chars", () => {
  const tool = manifest.tools.find((t) => t.name === "text.type");
  assert.ok(tool, "tools[] must declare text.type");
  assert.ok(tool.input_schema.properties.select_back_chars, "tools[] text.type needs select_back_chars");
  const prim = manifest.primitive_dictionary.primitives.find((p) => p.name === "text.type");
  assert.ok(prim && prim.support === "supported", "primitive_dictionary must declare text.type supported");
  assert.ok(prim.input_schema.properties.trusted, "text.type must expose the trusted flag");
});

test("text.type is dispatched + allowed as a marker recipe primitive", () => {
  assert.ok(contentSource.includes('message.name === "text.type"'), "executeAction must dispatch text.type");
  assert.ok(contentSource.includes('case "text.type":'), "the marker runner must allow text.type recipe steps");
});
