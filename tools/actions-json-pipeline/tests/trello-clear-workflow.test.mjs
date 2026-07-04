import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const trelloMapPath = path.resolve("../actions.json.storage/scopes/private/sites/trello.com/board/actions.json");

async function loadTrelloClearWorkflow(t) {
  let source;
  try {
    source = await readFile(trelloMapPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("Sibling actions.json.storage checkout is not available.");
      return null;
    }
    throw error;
  }
  const map = JSON.parse(source);
  const tool = map.tools.find((candidate) => candidate.name === "trello.card.due_date.clear");
  assert(tool, "trello.card.due_date.clear should exist in the Trello map");
  return { map, workflow: tool.workflow };
}

test("Trello clear-date workflow neutralizes overlay before pointer mutation", async (t) => {
  const loaded = await loadTrelloClearWorkflow(t);
  if (!loaded) return;
  const { workflow } = loaded;
  const firstPointerIndex = workflow.steps.findIndex((step) => step.primitive === "pointer.click");
  assert(firstPointerIndex > 0, "workflow should contain pointer mutation steps");
  assert(
    workflow.steps.slice(0, firstPointerIndex).some((step) => step.primitive === "overlay.menu.hide"),
    "workflow should hide the actions overlay before the first pointer click",
  );
  assert(
    workflow.steps.some((step) => step.primitive === "overlay.menu.show"),
    "workflow should restore the actions overlay during cleanup",
  );
});

test("Trello clear-date workflow waits for specific date controls, not only the card title", async (t) => {
  const loaded = await loadTrelloClearWorkflow(t);
  if (!loaded) return;
  const { workflow } = loaded;
  const findDateBadge = workflow.steps.find((step) => step.id === "findDateBadge");
  const findRemove = workflow.steps.find((step) => step.id === "findRemove");

  assert(findDateBadge?.retry_until, "date badge readiness should be retried");
  assert(findDateBadge.after_each?.args?.locator?.text_contains, "date badge retry wait should include visible date text");
  assert.match(findDateBadge.retry_until, /due_date_text|Overdue|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);

  assert.equal(findRemove?.args?.locator?.text_contains, "Remove");
  assert.equal(findRemove.after_each?.args?.locator?.text_contains, "Remove");
});

test("Trello clear-date workflow resets stale card routes and verifies board state before search", async (t) => {
  const loaded = await loadTrelloClearWorkflow(t);
  if (!loaded) return;
  const { workflow } = loaded;
  const stepIds = workflow.steps.map((step) => step.id);

  assert(stepIds.indexOf("findExistingCloseButton") < stepIds.indexOf("findCard"));
  assert(stepIds.indexOf("closeAnyOpenCard") < stepIds.indexOf("findCard"));
  assert(stepIds.indexOf("verifyBoardBeforeSearch") < stepIds.indexOf("findCard"));
  assert(stepIds.indexOf("verifyCard") < stepIds.indexOf("findDateBadge"));
});

test("Trello clear-date workflow has a trello.board due-date postcondition and preserves related actions", async (t) => {
  const loaded = await loadTrelloClearWorkflow(t);
  if (!loaded) return;
  const { map } = loaded;
  const names = new Set(map.tools.map((tool) => tool.name));

  for (const name of [
    "trello.card.by_title.open",
    "trello.board.visible_cards_by_list.read",
    "trello.card.date_popover.open",
    "trello.card.date_popover.save",
    "trello.card.due_date.clear",
    "trello.card.due_date.recipe",
  ]) {
    assert(names.has(name), `${name} should remain available`);
  }

  const postcondition = map.state_projections
    .flatMap((projection) => Object.entries(projection.postconditions || {}))
    .find(([name]) => name === "trello.card.due_date.clear")?.[1];
  assert.equal(postcondition?.projection, "trello.board");
  assert.match(postcondition.verify?.expression || "", /due_date != null/);
});
