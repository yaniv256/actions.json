import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSiteActionCallArgs } from "../src/agent/site-action-args.mjs";

test("canonical shape passes through unchanged", () => {
  const result = normalizeSiteActionCallArgs({
    mode: "call",
    action: "trello.card.by_title.open",
    arguments: { title: "ACT-1" },
  });
  assert.deepEqual(result, {
    action: "trello.card.by_title.open",
    actionArguments: { title: "ACT-1" },
  });
});

test("legacy action_name alias is accepted", () => {
  const result = normalizeSiteActionCallArgs({ action_name: "x.y", arguments: {} });
  assert.deepEqual(result, { action: "x.y", actionArguments: {} });
});

test("model-style name alias is accepted", () => {
  const result = normalizeSiteActionCallArgs({
    mode: "call",
    name: "trello.board.title.info",
    arguments: {},
  });
  assert.deepEqual(result, { action: "trello.board.title.info", actionArguments: {} });
});

test("duplicate action nested inside arguments is stripped", () => {
  const result = normalizeSiteActionCallArgs({
    mode: "call",
    name: "trello.board.visible_lists.read",
    arguments: { action: "trello.board.visible_lists.read" },
  });
  assert.deepEqual(result, {
    action: "trello.board.visible_lists.read",
    actionArguments: {},
  });
});

test("nested-only action is lifted out of arguments", () => {
  const result = normalizeSiteActionCallArgs({
    mode: "call",
    arguments: { action: "trello.card.date_popover.open", day: 3 },
  });
  assert.deepEqual(result, {
    action: "trello.card.date_popover.open",
    actionArguments: { day: 3 },
  });
});

test("a nested action argument is preserved when a top-level action exists and differs", () => {
  const result = normalizeSiteActionCallArgs({
    mode: "call",
    action: "site.workflow.run",
    arguments: { action: "approve" },
  });
  assert.deepEqual(result, {
    action: "site.workflow.run",
    actionArguments: { action: "approve" },
  });
});

test("missing action in every position returns null", () => {
  assert.equal(normalizeSiteActionCallArgs({ mode: "call", arguments: { x: 1 } }), null);
  assert.equal(normalizeSiteActionCallArgs({ mode: "call" }), null);
  assert.equal(normalizeSiteActionCallArgs({}), null);
});

test("non-object arguments are treated as empty", () => {
  const result = normalizeSiteActionCallArgs({ action: "a.b", arguments: "junk" });
  assert.deepEqual(result, { action: "a.b", actionArguments: {} });
});
