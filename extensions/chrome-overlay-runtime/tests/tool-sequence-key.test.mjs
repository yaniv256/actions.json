import assert from "node:assert/strict";
import test from "node:test";

import { toolSequenceKey } from "../src/agent/realtime-session-manager.mjs";

test("tab-lifecycle primitives route on the background lane, not the target tab's queue", () => {
  // The wedge bug: a tab frozen behind a native dialog cannot run content-script work,
  // so lifecycle ops keyed to that tab's queue are head-of-line blocked and never recover it.
  for (const name of [
    "browser.navigate",
    "browser.open_tab",
    "browser.close_tab",
    "browser.dismiss_dialog",
    "browser.claimed_tabs.activate",
  ]) {
    assert.equal(
      toolSequenceKey({ tab_id: 1848633310 }, name),
      "background",
      `${name} must use the background lane even when a tab_id is present`,
    );
  }
});

test("non-lifecycle tools keyed by tab_id still serialize on that tab's queue", () => {
  assert.equal(toolSequenceKey({ tab_id: 42 }, "pointer.click"), "tab:42");
  assert.equal(toolSequenceKey({ tab_id: 42 }), "tab:42");
});

test("runtime/target routing keys are preserved for non-lifecycle tools", () => {
  assert.equal(
    toolSequenceKey({ target_runtime_id: "rt-abc" }, "actions.site"),
    "rt-abc",
  );
  assert.equal(toolSequenceKey({ runtime_id: "rt-xyz" }, "pointer.click"), "rt-xyz");
  assert.equal(toolSequenceKey({}, "actions.site"), "default");
});

test("lifecycle lane wins even with an explicit target_runtime_id", () => {
  // A lifecycle op must not be serialized behind other work for a specific runtime either.
  assert.equal(
    toolSequenceKey({ target_runtime_id: "rt-abc", tab_id: 5 }, "browser.close_tab"),
    "background",
  );
});
