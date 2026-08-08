import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const content = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const background = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
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

test("site-action dispatch reports execution progress and uses the same timeout evidence", () => {
  assert.match(background, /last_entered_content_phase:\s*"site_action_execution"/);
  assert.match(background, /last_completed_content_phase:\s*"site_action_execution"/);
  const siteActionDispatch = bridge.slice(
    bridge.indexOf("async fn dispatch_site_action_call"),
    bridge.indexOf("async fn site_storage_state_projections_for_target"),
  );
  assert.match(siteActionDispatch, /take_action_timeout_context/);
  assert.doesNotMatch(siteActionDispatch, /pending_cleanup": "scheduled/);
});
