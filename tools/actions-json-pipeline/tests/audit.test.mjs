import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runAudit } from "../src/audit.mjs";
import { loadPipelineTarget } from "../src/storage-loader.mjs";

const execFileAsync = promisify(execFile);
const fixturesRoot = path.resolve("tools/actions-json-pipeline/fixtures");

test("audit flags broad generic and unscoped modal selectors", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const report = runAudit(context);

  const selectors = report.findings
    .filter((finding) => finding.code === "broad_selector")
    .map((finding) => finding.evidence.selector)
    .sort();
  assert.deepEqual(selectors, ["[role='dialog']", "button"]);
});

test("audit flags mutating workflows with missing or constant-true postconditions", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const report = runAudit(context);

  assert(report.findings.some((finding) => finding.id === "weak-postcondition:bad.card.move:missing"));
  assert(report.findings.some((finding) => finding.id === "weak-postcondition:bad.card.archive:constant-true"));
});

test("audit flags mutating workflows that do not neutralize the actions overlay", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.card.clear",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "find", primitive: "locator.element_info", args: { locator: { selector: "[data-testid='card']" } } },
              { id: "click", primitive: "pointer.click", args: { x: "{% steps.find.output.x %}", y: 1 } },
            ],
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "missing_overlay_invariant"));
});

test("audit flags retry loops whose after_each waits for a broader condition than retry_until", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.date.clear",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findDateBadge",
                primitive: "locator.element_info",
                args: { locator: { selector: "[role='dialog'] button" } },
                retry_until: "{% $count(steps.findDateBadge.output.candidates[$contains(text, 'Jun ')]) > 0 %}",
                max_attempts: 4,
                after_each: {
                  primitive: "locator.wait_for",
                  args: { locator: { selector: "[role='dialog'] button" }, state: "visible", timeout_ms: 1000 },
                },
              },
              {
                id: "clickDateBadge",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findDateBadge.output.candidates[0].clickable_center.x %}",
                  y: "{% steps.findDateBadge.output.candidates[0].clickable_center.y %}",
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "cards",
          postconditions: {
            "bad.date.clear": {
              projection: "cards",
              verify: { language: "jsonata", expression: "{% state.cards[id=input.id].due_date = null %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "retry_condition_mismatch"));
});

test("audit flags mutation clicks that are not preceded by target-control readiness", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.date.remove",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              { id: "verifyCard", primitive: "locator.element_info", args: { locator: { selector: "[data-testid='card-back-name']" } } },
              { id: "clickRemove", primitive: "pointer.click", args: { x: 1, y: 2 } },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "cards",
          postconditions: {
            "bad.date.remove": {
              projection: "cards",
              verify: { language: "jsonata", expression: "{% state.cards[id=input.id].due_date = null %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "missing_mutation_readiness"));
});

test("audit flags viewport-constant candidate geometry for mutating targets", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.description.set",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findEditor",
                primitive: "locator.element_info",
                args: { locator: { selector: "[role='dialog'] textarea" } },
              },
              {
                id: "clickEditor",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findEditor.output.candidates[bounding_box.top > 400][0].clickable_center.x %}",
                  y: "{% steps.findEditor.output.candidates[bounding_box.top > 400][0].clickable_center.y %}",
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "modal",
          postconditions: {
            "bad.description.set": {
              projection: "modal",
              verify: { language: "jsonata", expression: "{% $contains(state.text, input.text) %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "brittle_viewport_geometry"));
});

test("audit flags text insertion into ambient focus", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.composer.type",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findInput",
                primitive: "locator.element_info",
                args: { locator: { selector: "[role='dialog'] textarea", text_contains: "Title" } },
              },
              {
                id: "clickInput",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findInput.output.clickable_center.x %}",
                  y: "{% steps.findInput.output.clickable_center.y %}",
                },
              },
              { id: "insertText", primitive: "text.insert", args: { text: "{% input.text %}", mode: "replace" } },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "modal",
          postconditions: {
            "bad.composer.type": {
              projection: "modal",
              verify: { language: "jsonata", expression: "{% $contains(state.text, input.text) %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "ambient_text_insert"));
});

test("audit flags mutating workflows that do not assert required state boundaries", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.description.set",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            x_state_machine: {
              requires_state: {
                selector: "[data-testid='card-back-name'], [role='dialog'][aria-label], .window",
                text_contains: "Description",
              },
            },
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findEditor",
                primitive: "locator.element_info",
                args: {
                  locator: {
                    selector: "[role='dialog'] textarea[aria-label*='description' i], .window textarea[aria-label*='description' i]",
                  },
                },
              },
              {
                id: "clickEditor",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findEditor.output.clickable_center.x %}",
                  y: "{% steps.findEditor.output.clickable_center.y %}",
                },
              },
              {
                id: "insertText",
                primitive: "text.insert",
                args: {
                  text: "{% input.text %}",
                  mode: "replace",
                  target: {
                    selector: "[role='dialog'] textarea[aria-label*='description' i], .window textarea[aria-label*='description' i]",
                  },
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "modal",
          postconditions: {
            "bad.description.set": {
              projection: "modal",
              verify: { language: "jsonata", expression: "{% $contains(state.text, input.text) %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "missing_required_state_assertion"));
});

test("audit flags broad editable targets that can select the wrong rich-text surface", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.description.set",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findEditor",
                primitive: "locator.element_info",
                args: {
                  locator: {
                    selector: "[role='dialog'] textarea, [role='dialog'] [contenteditable='true'], .window textarea, .window [contenteditable='true']",
                  },
                },
              },
              {
                id: "clickEditor",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findEditor.output.clickable_center.x %}",
                  y: "{% steps.findEditor.output.clickable_center.y %}",
                },
              },
              {
                id: "insertText",
                primitive: "text.insert",
                args: {
                  text: "{% input.text %}",
                  mode: "replace",
                  target: {
                    selector: "[role='dialog'] textarea, [role='dialog'] [contenteditable='true'], .window textarea, .window [contenteditable='true']",
                  },
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "modal",
          postconditions: {
            "bad.description.set": {
              projection: "modal",
              verify: { language: "jsonata", expression: "{% $contains(state.text, input.text) %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "ambiguous_editable_target"));
});

test("audit flags prose-only preconditions on mutating workflows", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "bad.modal.edit",
          description: "Edit the current modal. Precondition: a card is open.",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findEditor",
                primitive: "locator.element_info",
                args: { locator: { selector: "[role='dialog'] textarea[aria-label*='description' i]" } },
              },
              {
                id: "clickEditor",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findEditor.output.clickable_center.x %}",
                  y: "{% steps.findEditor.output.clickable_center.y %}",
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "modal",
          postconditions: {
            "bad.modal.edit": {
              projection: "modal",
              verify: { language: "jsonata", expression: "{% true %}" },
            },
          },
        },
      ],
    },
  });

  assert(report.findings.some((finding) => finding.code === "prose_precondition_without_state_assertion"));
});

test("audit accepts a mutating workflow shaped as observable state transitions", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "good.date.remove",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            x_state_machine: {
              states: ["precondition", "readiness", "mutation", "postcondition", "cleanup"],
            },
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findRemove",
                primitive: "locator.element_info",
                args: {
                  locator: {
                    selector: "[data-testid='date-range-picker'] button",
                    text_contains: "Remove",
                  },
                },
                retry_until: "{% steps.findRemove.output.clickable_center.x != null %}",
                max_attempts: 4,
                after_each: {
                  primitive: "locator.wait_for",
                  args: {
                    locator: {
                      selector: "[data-testid='date-range-picker'] button",
                      text_contains: "Remove",
                    },
                    state: "visible",
                    timeout_ms: 1000,
                  },
                },
              },
              {
                id: "clickRemove",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findRemove.output.clickable_center.x %}",
                  y: "{% steps.findRemove.output.clickable_center.y %}",
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "cards",
          postconditions: {
            "good.date.remove": {
              projection: "cards",
              verify: { language: "jsonata", expression: "{% state.cards[id=input.id].due_date = null %}" },
            },
          },
        },
      ],
    },
  });

  assert.deepEqual(report.findings, []);
});

test("audit flags declared files that are absent from the site folder", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const report = runAudit(context);

  assert(report.findings.some((finding) => finding.id === "missing-file:SKILL.md"));
});

test("accepted ledger keeps findings visible and reports stale entries", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const report = runAudit(context, {
    ledger: {
      accepted_gaps: [
        {
          finding_id: "broad-selector:bad.button.find:x_actions.binding.arguments.locator.selector",
          rationale: "Fixture intentionally keeps this broad selector.",
          accepted_by: "test",
        },
        {
          finding_id: "missing-file:no-longer-present.md",
          rationale: "Old fixture gap.",
        },
      ],
    },
  });

  const accepted = report.findings.find(
    (finding) => finding.id === "broad-selector:bad.button.find:x_actions.binding.arguments.locator.selector",
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.accepted_gap.rationale, "Fixture intentionally keeps this broad selector.");
  assert.deepEqual(report.stale_ledger_entries, [
    {
      finding_id: "missing-file:no-longer-present.md",
      rationale: "Old fixture gap.",
      status: "stale",
    },
  ]);
});

test("good fixture has no open audit findings", async () => {
  const context = await loadPipelineTarget(path.join(fixturesRoot, "good-map"));
  const report = runAudit(context);

  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.open, 0);
});

test("audit CLI applies an accepted-gap ledger", async () => {
  const ledgerPath = path.join(fixturesRoot, "bad-map", "accepted-gaps.json");
  await fs.writeFile(
    ledgerPath,
    JSON.stringify({
      accepted_gaps: [
        {
          finding_id: "missing-file:SKILL.md",
          rationale: "Missing on purpose for the fixture.",
        },
      ],
    }),
    "utf8",
  );
  try {
    const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "audit", path.join(fixturesRoot, "bad-map")], {
      cwd: path.resolve("."),
    });
    const report = JSON.parse(stdout);
    const missing = report.findings.find((finding) => finding.id === "missing-file:SKILL.md");
    assert.equal(missing.status, "accepted");
  } finally {
    await fs.rm(ledgerPath, { force: true });
  }
});
