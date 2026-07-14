import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const bridge = await readFile(
  new URL("../../../mcp/actions-json-mcp/src/lib.rs", import.meta.url),
  "utf8",
);

test("rich-editor insertion reports the mutation boundary for timeout diagnosis", () => {
  for (const phase of [
    "editable_selection_settled",
    "synthetic_paste_dispatched",
    "editable_handlers_settled",
  ]) {
    assert.match(content, new RegExp(`reportProgress\\?\\.\\(\\"${phase}\\"`));
  }
  assert.match(content, /type:\s*"action_progress"/);
});

test("the bridge retains action progress and exposes it on dispatch_timeout", () => {
  assert.match(bridge, /action_progress:\s*Arc<Mutex<HashMap<String, Value>>>/);
  assert.match(bridge, /Some\("action_progress"\)/);
  assert.match(bridge, /"last_entered_content_phase"/);
  assert.match(bridge, /"last_completed_content_phase"/);
});
