import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { auditBroadSelectors, auditFallbacksShareDeadScope, runAudit } from "../src/audit.mjs";
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

test("audit accepts a11y.query as target-control readiness for mutation clicks", () => {
  const report = runAudit({
    mapPath: "inline",
    siteFolder: "inline",
    declaredFiles: [],
    map: {
      tools: [
        {
          name: "good.checklist.complete",
          workflow: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "hideOverlay", primitive: "overlay.menu.hide", on_error: "continue" },
              {
                id: "findCheckbox",
                primitive: "a11y.query",
                args: {
                  role: "checkbox",
                  name: "{% input.item_text %}",
                },
              },
              {
                id: "clickCheckbox",
                primitive: "pointer.click",
                args: {
                  x: "{% steps.findCheckbox.output.clickable_center.x %}",
                  y: "{% steps.findCheckbox.output.clickable_center.y %}",
                },
              },
            ],
          },
        },
      ],
      state_projections: [
        {
          name: "card",
          postconditions: {
            "good.checklist.complete": {
              projection: "card",
              verify: { language: "jsonata", expression: "{% true %}" },
            },
          },
        },
      ],
    },
  });

  assert(!report.findings.some((finding) => finding.code === "missing_mutation_readiness"));
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
                // Arms the ladder: without this, locator.element_info's
                // target_not_found/target_not_actionable aborts on attempt 1 and the
                // retry never runs. Exhaustion still hard-fails via
                // workflow_retry_exhausted, which ignores on_error. Proven in
                // extensions/chrome-overlay-runtime/tests/workflow-retry-arming.test.mjs.
                on_error: "continue",
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

test("audit CLI --fail-on ignores accepted gaps", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "actions-json-audit-accepted-"));
  const ledgerPath = path.join(fixtureRoot, "accepted-gaps.json");
  await fs.writeFile(
    path.join(fixtureRoot, "actions.json"),
    JSON.stringify({
      protocol: "actions.json",
      name: "accepted.only.fixture",
      x_actions: {
        files: [
          {
            id: "missing-skill",
            path: "SKILL.md",
            kind: "skill",
          },
        ],
      },
      tools: [],
    }),
    "utf8",
  );
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
    const { stdout } = await execFileAsync(
      process.execPath,
      [cli, "audit", fixtureRoot, "--fail-on", "high"],
      {
        cwd: path.resolve("."),
      },
    );
    const report = JSON.parse(stdout);
    const missing = report.findings.find((finding) => finding.id === "missing-file:SKILL.md");
    assert.equal(missing.status, "accepted");
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

// REGRESSION GUARDS (found 2026-07-09 auditing the public Trello map, card #170).
//
// Three ways a workflow reports success while mutating nothing. Each shipped in a
// mature, previously-audited map; none was caught by the anchor/postcondition
// audits, because each step has a correct anchor AND a verify step.
//
//  1. SELF-SKIPPING MUTATION. A required pointer/text step gated on
//     `when: $exists(<its own find-step>.output.clickable_center)` silently skips
//     itself when the control is matched-but-unclickable. Real:
//     trello.card.description.set typed a description and never clicked Save.
//  2. DISARMED RETRY. `retry_until` + `on_error: "stop"` aborts on attempt 1,
//     because locator.element_info ERRORS on target_not_found /
//     target_not_actionable — exactly the states being retried for. The loop is
//     armed by `on_error: "continue"`; exhaustion still hard-fails via
//     workflow_retry_exhausted (which ignores on_error). 31 of 48 such steps in
//     the Trello map could never retry.
//  3. INVERTED ABSENCE CHECK. A `verify*Gone` step implemented as an
//     element_info presence read with `on_error: "continue"` succeeds whether the
//     object was deleted (error swallowed) or is still there (read succeeds). Only
//     dom.observe.visible returns success with match_count: 0 on absence.

import { auditSilentNoOpSteps } from "../src/audit.mjs";

test("audit flags a required mutation gated on its own find-step (self-skipping)", () => {
  const map = {
    tools: [
      {
        name: "bad.card.description.set",
        workflow: {
          steps: [
            { id: "findSave", primitive: "locator.element_info", args: { locator: { selector: "[data-testid='save']" } } },
            {
              id: "clickSave",
              primitive: "pointer.click",
              args: { x: "{% steps.findSave.output.clickable_center.x %}", y: "{% steps.findSave.output.clickable_center.y %}" },
              when: "{% $exists(steps.findSave.output.clickable_center.x) %}",
              on_error: "stop",
            },
          ],
        },
      },
    ],
  };
  const findings = auditSilentNoOpSteps(map);
  const hit = findings.find((f) => f.code === "self_skipping_mutation");
  assert(hit, "expected a self_skipping_mutation finding");
  assert.equal(hit.action, "bad.card.description.set");
  assert.equal(hit.severity, "high");
  assert.deepEqual(hit.evidence.gates_on, ["findSave"]);
});

test("audit does NOT flag an inverted idempotency guard or a guard on another element", () => {
  const map = {
    tools: [
      {
        name: "ok.list.create",
        workflow: {
          steps: [
            { id: "findComposer", primitive: "locator.element_info", args: { locator: { selector: "[data-testid='composer']" } }, on_error: "continue" },
            { id: "findAddList", primitive: "locator.element_info", args: { locator: { selector: "[data-testid='add-list']" } }, on_error: "continue" },
            {
              // "click Add only if the composer is NOT already open" — legitimate.
              id: "clickAddList",
              primitive: "pointer.click",
              args: { x: "{% steps.findAddList.output.clickable_center.x %}", y: "{% steps.findAddList.output.clickable_center.y %}" },
              when: "{% $exists(steps.findComposer.output.clickable_center.x) ? false : true %}",
            },
          ],
        },
      },
    ],
  };
  assert.deepEqual(auditSilentNoOpSteps(map).filter((f) => f.code === "self_skipping_mutation"), []);
});

test("audit flags a retry_until loop disarmed by on_error stop", () => {
  const map = {
    tools: [
      {
        name: "bad.card.open",
        workflow: {
          steps: [
            {
              id: "findCard",
              primitive: "locator.element_info",
              args: { locator: { selector: "[data-testid='card']" } },
              retry_until: "{% $exists(steps.findCard.output.clickable_center.x) %}",
              max_attempts: 4,
              on_error: "stop",
            },
          ],
        },
      },
    ],
  };
  const hit = auditSilentNoOpSteps(map).find((f) => f.code === "disarmed_retry_loop");
  assert(hit, "expected a disarmed_retry_loop finding");
  assert.equal(hit.evidence.on_error, "stop");
});

test("audit flags a retry_until loop with no on_error at all (defaults to stop)", () => {
  const map = {
    tools: [
      {
        name: "bad.list.find",
        workflow: {
          steps: [
            {
              id: "findList",
              primitive: "locator.element_info",
              args: { locator: { selector: "[data-testid='list']" } },
              retry_until: "{% $exists(steps.findList.output.clickable_center.x) %}",
              max_attempts: 3,
            },
          ],
        },
      },
    ],
  };
  assert(auditSilentNoOpSteps(map).some((f) => f.code === "disarmed_retry_loop"));
});

test("audit does NOT flag an armed retry loop", () => {
  const map = {
    tools: [
      {
        name: "ok.card.find",
        workflow: {
          steps: [
            {
              id: "findCard",
              primitive: "locator.element_info",
              args: { locator: { selector: "[data-testid='card']" } },
              retry_until: "{% $exists(steps.findCard.output.clickable_center.x) %}",
              max_attempts: 4,
              on_error: "continue",
            },
          ],
        },
      },
    ],
  };
  assert.deepEqual(auditSilentNoOpSteps(map).filter((f) => f.code === "disarmed_retry_loop"), []);
});

test("audit flags an absence check that cannot observe absence", () => {
  const map = {
    tools: [
      {
        name: "bad.card.delete",
        workflow: {
          steps: [
            { id: "confirmDelete", primitive: "pointer.click", args: { x: 1, y: 2 } },
            {
              // element_info ERRORS when the card is gone; on_error:continue swallows it.
              id: "verifyCardGone",
              primitive: "locator.element_info",
              args: { locator: { selector: "[data-testid='card-back-name']" } },
              on_error: "continue",
            },
          ],
        },
      },
    ],
  };
  const hit = auditSilentNoOpSteps(map).find((f) => f.code === "inverted_absence_check");
  assert(hit, "expected an inverted_absence_check finding");
  assert.equal(hit.evidence.primitive, "locator.element_info");
});

test("audit flags wait_for state:hidden, which the runtime does not implement", () => {
  const map = {
    tools: [
      {
        name: "bad.modal.close",
        workflow: {
          steps: [
            { id: "press", primitive: "keyboard.press", args: { key: "Escape" },
              settle_after: { locator: { selector: "[role='dialog']" }, state: "hidden", timeout_ms: 5000 } },
          ],
        },
      },
    ],
  };
  assert(auditSilentNoOpSteps(map).some((f) => f.code === "unsupported_hidden_state"));
});

test("audit accepts dom.observe.visible + match_count = 0 as a real absence assertion", () => {
  const map = {
    tools: [
      {
        name: "ok.card.delete",
        workflow: {
          steps: [
            { id: "confirmDelete", primitive: "pointer.click", args: { x: 1, y: 2 } },
            {
              id: "verifyCardGone",
              primitive: "dom.observe.visible",
              args: { selector: "[data-testid='card-back-name']" },
              retry_until: "{% steps.verifyCardGone.output.match_count = 0 %}",
              max_attempts: 4,
              on_error: "continue",
            },
          ],
        },
      },
    ],
  };
  const codes = auditSilentNoOpSteps(map).map((f) => f.code);
  assert.deepEqual(codes, [], `expected a clean absence assertion, got ${codes.join(", ")}`);
});

test("runAudit composes the silent-no-op findings", () => {
  const report = runAudit({
    mapPath: "x", siteFolder: "y", declaredFiles: [],
    map: { tools: [ { name: "bad.x", workflow: { steps: [
      { id: "find", primitive: "locator.element_info", args: { locator: { selector: "[data-testid='a']" } } },
      { id: "click", primitive: "pointer.click", args: { x: "{% steps.find.output.clickable_center.x %}" },
        when: "{% $exists(steps.find.output.clickable_center.x) %}" },
    ] } } ] },
  });
  assert(report.findings.some((f) => f.code === "self_skipping_mutation"));
});

// REGRESSION GUARD (self-inflicted, 2026-07-09). While replacing three inert
// `verify*Gone` presence reads with dom.observe.visible, I changed each step's
// PRIMITIVE but left the workflow `output` reading the old primitive's fields:
//
//   'archived': $not($exists(steps.verifyListGone.output.clickable_center.x))
//
// dom.observe.visible emits {matches, match_count} and never emits
// clickable_center. JSONata resolves the missing path to undefined, $exists()
// returns false, $not() returns true — so `archived` was CONSTANT TRUE. Three
// actions, three constant fields, in the very commit that removed the
// constant-true postconditions. The workflow engine has no schema tying a
// primitive to its output shape, so nothing caught it.
//
// This is a type error in a dynamically-typed data language. Encode the shape.

import { auditPrimitiveOutputFields } from "../src/audit.mjs";

test("audit flags an output reading a field the step's primitive never emits", () => {
  const map = {
    tools: [
      {
        name: "bad.list.archive",
        workflow: {
          steps: [
            { id: "verifyGone", primitive: "dom.observe.visible", args: { selector: "[data-testid='list-name']" } },
          ],
          output: "{% { 'archived': $not($exists(steps.verifyGone.output.clickable_center.x)) } %}",
        },
      },
    ],
  };
  const hit = auditPrimitiveOutputFields(map).find((f) => f.code === "unknown_primitive_output_field");
  assert(hit, "expected an unknown_primitive_output_field finding");
  assert.equal(hit.severity, "high");
  assert.equal(hit.evidence.primitive, "dom.observe.visible");
  assert.equal(hit.evidence.field, "clickable_center");
});

test("audit accepts an output reading a field the primitive does emit", () => {
  const map = {
    tools: [
      {
        name: "ok.list.archive",
        workflow: {
          steps: [
            { id: "verifyGone", primitive: "dom.observe.visible", args: { selector: "[data-testid='list-name']" } },
          ],
          output: "{% { 'archived': steps.verifyGone.output.match_count = 0 } %}",
        },
      },
    ],
  };
  assert.deepEqual(auditPrimitiveOutputFields(map), []);
});

test("audit flags a retry_until reading a field the primitive never emits", () => {
  const map = {
    tools: [
      {
        name: "bad.retry",
        workflow: {
          steps: [
            {
              id: "watch",
              primitive: "dom.observe.visible",
              args: { selector: "x" },
              retry_until: "{% $exists(steps.watch.output.clickable_center.x) %}",
              max_attempts: 3,
            },
          ],
        },
      },
    ],
  };
  assert(auditPrimitiveOutputFields(map).some((f) => f.code === "unknown_primitive_output_field"));
});

test("audit ignores primitives whose output shape is not modelled", () => {
  const map = {
    tools: [
      {
        name: "ok.unmodelled",
        workflow: {
          steps: [{ id: "s", primitive: "overlay.menu.hide" }],
          output: "{% { 'x': steps.s.output.whatever } %}",
        },
      },
    ],
  };
  assert.deepEqual(auditPrimitiveOutputFields(map), []);
});

// AP-1, found by the Phase-9 anti-pattern search of
// investigations/trello-delete-confirm-anchor-and-silent-noop-family.md.
//
// "Bind the container, not the control." A locator whose only anchor is a wrapper
// plus a bare tag — `[data-testid='popover'] button`, `[role='dialog'] button`,
// `.window button` — identifies nothing. It resolves to whatever happens to be
// first inside that container, and it dies silently the moment the wrapper is
// renamed. Both happened: trello.card.delete's confirm scoped to a popover that
// does not exist, and trello.list.archive's DESTRUCTIVE pointer.click has no text
// on its target at all.
//
// 23 such controls across 5 maps at the time this rule was written.
//
// A `text_contains` (or an equivalent identity on the control) downgrades it: the
// control is then at least named. Without one, on a mutating primitive, it is
// "click the first thing in the box."

import { auditContainerBoundControls } from "../src/audit.mjs";

test("audit flags a mutation bound only to a container and a bare tag", () => {
  const map = {
    tools: [
      {
        name: "bad.list.archive",
        workflow: {
          steps: [
            { id: "clickArchive", primitive: "pointer.click",
              args: { locator: { selector: "[data-testid='popover'] button" } } },
          ],
        },
      },
    ],
  };
  const hit = auditContainerBoundControls(map).find((f) => f.code === "container_bound_control");
  assert(hit, "expected a container_bound_control finding");
  assert.equal(hit.severity, "high", "a mutation with no target identity is high severity");
  assert.equal(hit.evidence.has_control_identity, false);
});

test("audit flags a container-bound read at lower severity", () => {
  const map = {
    tools: [
      {
        name: "bad.read",
        workflow: {
          steps: [
            { id: "findThing", primitive: "locator.element_info",
              args: { locator: { selector: "[role='dialog'] button" } } },
          ],
        },
      },
    ],
  };
  const hit = auditContainerBoundControls(map).find((f) => f.code === "container_bound_control");
  assert(hit);
  assert.equal(hit.severity, "medium", "a read cannot mutate, so it is less severe");
});

test("audit accepts a container scope when the control itself is anchored", () => {
  const map = {
    tools: [
      {
        name: "ok.confirm",
        workflow: {
          steps: [
            { id: "findConfirm", primitive: "locator.element_info",
              args: { locator: { selector: "[data-testid='popover-confirm-button'], section[role='dialog'] button",
                                 text_contains: "Delete" } } },
          ],
        },
      },
    ],
  };
  assert.deepEqual(auditContainerBoundControls(map), []);
});

test("audit accepts a bare container-scoped selector that carries text_contains", () => {
  const map = {
    tools: [
      {
        name: "ok.textscoped",
        workflow: {
          steps: [
            { id: "find", primitive: "locator.element_info",
              args: { locator: { selector: "[role='dialog'] button", text_contains: "Archive" } } },
          ],
        },
      },
    ],
  };
  const hits = auditContainerBoundControls(map);
  assert.equal(hits.length, 1, "still worth flagging, but as low severity");
  assert.equal(hits[0].severity, "low");
  assert.equal(hits[0].evidence.has_control_identity, true);
});

// A broad selector almost never ships alone. It ships as the LAST ALTERNATIVE of a
// comma-list, because an author pairs a hopeful testid with a desperate fallback:
//
//     "[data-testid='card-back-delete-button'], button"
//
// isBroadSelector matched the whole string against /^button(\[...\])?$/, so the comma-list
// never matched and the detector stayed silent on every real occurrence. Its only test used
// a synthetic bare `button`, which is precisely the input that cannot expose the defect.
//
// This is not academic. On live Trello (2026-07-09), with a card modal open and the archive
// popover absent, `[role='dialog'] button` + text_contains "Delete" resolved to exactly one
// element: the card's <button aria-label="Delete checklist">. trello.card.delete's clickDelete
// carries on_error:null and would have clicked it — destroying the checklist, sparing the card,
// and reporting success. See investigations/trello-delete-confirm-anchor-and-silent-noop-family.md.
//
// A comma-list is an OR. Its breadth is the breadth of its broadest alternative.
test("broad_selector fires on a broad alternative hiding inside a comma-list", () => {
  const map = {
    tools: [
      {
        name: "trello.card.delete",
        workflow: {
          version: 1,
          steps: [
            {
              id: "clickArchive",
              primitive: "pointer.click",
              args: {},
              settle_after: {
                locator: {
                  selector: "[data-testid='card-back-delete-button'], button",
                  text_contains: "Delete",
                },
              },
            },
            {
              id: "findDeleteButton",
              primitive: "locator.element_info",
              args: {
                locator: {
                  selector:
                    "[data-testid='card-back-delete-card-button'], [data-testid='card-back-delete-button'], [role='dialog'] button",
                  text_contains: "Delete",
                },
              },
            },
          ],
        },
      },
    ],
  };

  const findings = auditBroadSelectors(map);
  const contexts = findings.map((f) => f.context);

  // Both must fire: one hides `button`, the other hides `[role='dialog'] button`.
  assert.equal(findings.length, 2, `expected 2 findings, got ${findings.length}: ${JSON.stringify(contexts)}`);
  assert.ok(contexts.some((c) => c.includes("settle_after")), "the settle_after locator must be audited too");
  for (const f of findings) assert.equal(f.code, "broad_selector");
});

// A comma-list of exclusively narrow alternatives must stay silent. `[role='dialog']` and
// `.window` are Trello's new and old modal shells — mutually exclusive, never both present.
// A detector that flags these floods the author with noise and gets ignored, which is a worse
// outcome than a false negative on a rule nobody reads.
test("broad_selector stays silent on a comma-list of narrow alternatives", () => {
  const map = {
    tools: [
      {
        name: "trello.card.checklist.read",
        workflow: {
          version: 1,
          steps: [
            {
              id: "assertCardModal",
              primitive: "locator.text_content",
              args: { locator: { selector: "[data-testid='card-back-name'], [role='dialog'][aria-label], .window" } },
            },
            {
              id: "scoped",
              primitive: "locator.element_info",
              args: { locator: { selector: "[data-testid='popover'] button" } },
            },
          ],
        },
      },
    ],
  };

  assert.deepEqual(auditBroadSelectors(map), []);
});

// A tag with a unique identity attribute is the NARROWEST thing an author can write, and
// exactly what the authoring skill asks for. The original regex accepted `button[<anything>]`
// as broad, so it flagged `button[data-testid='create-board-submit-button']`. Flagging the
// recommended pattern teaches authors the detector is noise, and a muted detector takes its
// true positives with it — a false positive here costs more than a false negative.
test("broad_selector does not flag a tag bound to a unique identity attribute", () => {
  const narrow = [
    "button[data-testid='create-board-submit-button']",
    "input[data-testid='create-board-title-input']",
    "button[aria-label='Actions']",
    "a[href*='/issue/ACT-111/']",
    // and the recommended testid-plus-labelled-fallback shape:
    "[data-testid='card-back-actions-button'], button[aria-label='Actions']",
  ];
  for (const selector of narrow) {
    const map = { tools: [{ name: "t", workflow: { version: 1, steps: [
      { id: "s", primitive: "pointer.click", args: { locator: { selector } } }] } }] };
    assert.deepEqual(auditBroadSelectors(map), [], `must not flag ${selector}`);
  }
});

// ...while a presence/role/state predicate does NOT narrow, so it stays broad.
test("broad_selector still flags a tag bound only to a role or state predicate", () => {
  const broad = ["button[disabled]", "button[type='submit']", "input[required]"];
  for (const selector of broad) {
    const map = { tools: [{ name: "t", workflow: { version: 1, steps: [
      { id: "s", primitive: "pointer.click", args: { locator: { selector } } }] } }] };
    assert.equal(auditBroadSelectors(map).length, 1, `must flag ${selector}`);
  }
});

// The audit reported findings and exited 0 — on the Trello map (44 broad_selector findings)
// and on a map whose ONLY step is a destructive broad-selector click. A gate that always
// succeeds is not a gate; it is a report with an opinion.
//
// This is the same defect as the ones the audit itself hunts, one altitude up:
//   the map     verifyItem's `verified` was hardcoded false and never read
//   the engine  a timed-out settle_after was recorded into the summary and never checked
//   the audit   broad_selector could not see the shape violations actually take
//   the CLI     exits 0 regardless
// "A step that cannot fail is not a check" is true of the checker too.
//
// --fail-on is OPT-IN. The corpus carries 129 real findings today; a default-fail would break
// every existing workflow, and a gate you must disable to get work done is a gate that stays
// disabled. Opt-in lets a release pipeline turn it on where it counts.
test("audit CLI exits non-zero when --fail-on is set and findings meet the severity", async () => {
  const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");
  const target = path.join(fixturesRoot, "bad-map");
  await assert.rejects(
    () => execFileAsync(process.execPath, [cli, "audit", target, "--fail-on", "medium"], { cwd: path.resolve(".") }),
    (error) => {
      assert.ok(error.code > 0, `expected a non-zero exit, got ${error.code}`);
      // the report must still reach stdout — a gate that swallows its evidence is useless
      assert.ok(JSON.parse(error.stdout).findings.length > 0, "the findings must still be printed");
      return true;
    },
  );
});

test("audit CLI still exits zero without --fail-on, and when nothing meets the severity", async () => {
  const cli = path.resolve("tools/actions-json-pipeline/bin/actions-json.js");
  const target = path.join(fixturesRoot, "bad-map");
  const opts = { cwd: path.resolve(".") };
  // no flag -> report only, exit 0 (backwards compatible)
  await execFileAsync(process.execPath, [cli, "audit", target], opts);
  // a severity above anything present -> clean exit
  await execFileAsync(process.execPath, [cli, "audit", target, "--fail-on", "critical"], opts);
});

// KNOWN-ANSWER TEST, both directions, for auditFallbacksShareDeadScope.
//
// The rule exists because `trello.card.delete.findDeleteButton` carried three selector
// fallbacks, all scoped inside `[data-testid='popover']` — a container Trello removed.
// Three fallbacks that cannot fail independently are one selector. Verified live on
// 2026-07-10 by an INDEPENDENT instrument (browser.extract_elements on the real page):
// that scope matches zero elements.
//
// RED   must fire, and name the step.
// GREEN must stay silent on `[role='dialog']`, which is correct authoring and appears
//       ten times across the shipped maps. Without this direction the rule would be a
//       structural pattern, and it would delete working selectors.
test("audit fires on fallbacks that all share a dead scope, and only on those", () => {
  const deadScope = {
    tools: [
      {
        name: "trello.card.delete",
        workflow: {
          steps: [
            {
              id: "findDeleteButton",
              primitive: "locator.element_info",
              args: {
                locator: {
                  selector:
                    "[data-testid='popover'] [data-testid='card-back-delete-card-button'], [data-testid='popover'] [data-testid='card-back-delete-button'], [data-testid='popover'] button",
                },
              },
            },
          ],
        },
      },
    ],
  };

  const liveScope = {
    tools: [
      {
        name: "github.repo.file.create_pr",
        workflow: {
          steps: [
            {
              id: "findMessageInput",
              primitive: "locator.element_info",
              args: { locator: { selector: "[role='dialog'] textarea, [role='dialog'] input[type='text']" } },
            },
          ],
        },
      },
    ],
  };

  // A single-branch selector under the dead scope is NOT this defect: it has no
  // fallbacks to be falsely reassured by. The rule must not fire, or it would
  // duplicate every other dead-selector finding and drown its own signal.
  const singleBranch = {
    tools: [
      {
        name: "trello.list.archive",
        workflow: {
          steps: [
            {
              id: "clickArchiveList",
              primitive: "pointer.click",
              args: { locator: { selector: "[data-testid='popover'] button" } },
            },
          ],
        },
      },
    ],
  };

  const red = auditFallbacksShareDeadScope(deadScope);
  assert.equal(red.length, 1, "RED: must fire on fallbacks sharing a dead scope");
  assert.equal(red[0].code, "fallbacks_share_a_dead_scope");
  assert.equal(red[0].action, "trello.card.delete");
  assert.match(red[0].context, /findDeleteButton/);
  assert.equal(red[0].evidence.shared_scope, "[data-testid='popover']");
  assert.equal(red[0].evidence.branch_count, 3);

  assert.deepEqual(auditFallbacksShareDeadScope(liveScope), [], "GREEN: [role='dialog'] is correct authoring");
  assert.deepEqual(auditFallbacksShareDeadScope(singleBranch), [], "GREEN: one branch is not a fallback list");

  // Fault injection: prove the RED assertion above can still fail. A self-test whose
  // red branch cannot go red is not a check — it is decoration that passes forever.
  const rescoped = JSON.parse(JSON.stringify(deadScope));
  rescoped.tools[0].workflow.steps[0].args.locator.selector = rescoped.tools[0].workflow.steps[0].args.locator.selector.replaceAll(
    "[data-testid='popover']",
    "[role='dialog']",
  );
  assert.deepEqual(
    auditFallbacksShareDeadScope(rescoped),
    [],
    "fault injection: swapping the dead scope for a live one must silence the rule",
  );
});

test("auditFallbacksShareDeadScope is wired into runAudit", async () => {
  // A rule absent from runAudit is dead code that passes its own unit test forever.
  const context = await loadPipelineTarget(path.join(fixturesRoot, "bad-map"));
  const report = runAudit(context);
  assert.ok(Array.isArray(report.findings), "runAudit returns findings");
  // The rule must be REACHABLE, not merely exported. Feed runAudit a map it must flag.
  const injected = runAudit({
    ...context,
    map: {
      tools: [
        {
          name: "probe.dead_scope",
          workflow: {
            steps: [
              {
                id: "findThing",
                primitive: "locator.element_info",
                args: { locator: { selector: "[data-testid='popover'] a, [data-testid='popover'] button" } },
              },
            ],
          },
        },
      ],
    },
  });
  assert.ok(
    injected.findings.some((f) => f.code === "fallbacks_share_a_dead_scope"),
    "runAudit must surface the rule; declared is not reachable",
  );
});
