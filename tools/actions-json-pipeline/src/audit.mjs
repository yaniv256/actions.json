import { applyAcceptedGapLedger } from "./ledger.mjs";

const MUTATING_PRIMITIVE_PATTERN = /^(pointer|keyboard|input|form|clipboard)\./;
// Primitives that ERROR rather than return-empty when the target is absent:
// locator.element_info raises target_not_found / target_not_actionable, and
// locator.wait_for raises timeout. They therefore cannot observe absence, and
// inside a retry_until loop they abort attempt 1 unless on_error is "continue".
const ERROR_ON_ABSENCE_PATTERN = /^locator\./;
// Step ids whose declared intent is "the thing is gone".
const ABSENCE_INTENT_PATTERN = /(gone|removed|deleted|closed|dismissed|cleared|absent)$/i;
const BROAD_SELECTORS = new Set([
  "a",
  "body",
  "button",
  "div",
  "form",
  "html",
  "input",
  "main",
  "span",
  ".modal",
  "[aria-modal='true']",
  "[aria-modal=\"true\"]",
  "[role='dialog']",
  "[role=\"dialog\"]",
]);

export function runAudit(context, { ledger = null } = {}) {
  const findings = [
    ...auditBroadSelectors(context.map),
    ...auditWeakPostconditions(context.map),
    ...auditStateMachineWorkflowShape(context.map),
    ...auditSilentNoOpSteps(context.map),
    ...auditGoalAssertingSettle(context.map),
    ...auditFallbacksShareDeadScope(context.map),
    ...auditPrimitiveOutputFields(context.map),
    ...auditContainerBoundControls(context.map),
    ...auditMissingDeclaredFiles(context.declaredFiles),
  ];
  const { findings: overlaidFindings, staleEntries } = applyAcceptedGapLedger(findings, ledger);
  return {
    ok: true,
    map_path: context.mapPath,
    site_folder: context.siteFolder,
    summary: summarizeFindings(overlaidFindings, staleEntries),
    findings: overlaidFindings,
    stale_ledger_entries: staleEntries,
  };
}

export function auditBroadSelectors(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    for (const item of selectorEntries(tool)) {
      if (!isBroadSelector(item.selector)) continue;
      findings.push(
        finding({
          id: `broad-selector:${tool.name}:${item.path.join(".")}`,
          code: "broad_selector",
          severity: "medium",
          action: tool.name,
          context: item.path.join("."),
          evidence: { selector: item.selector },
          message: `Action ${tool.name} uses broad selector ${JSON.stringify(item.selector)}.`,
          recommendation: "Scope the selector to a stable site-specific container or data attribute.",
        }),
      );
    }
  }
  return findings;
}

export function auditWeakPostconditions(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    if (!isMutatingWorkflow(tool)) continue;
    const postcondition = findStatePostcondition(map, tool.name);
    if (!postcondition) {
      findings.push(
        finding({
          id: `weak-postcondition:${tool.name}:missing`,
          code: "missing_postcondition",
          severity: "high",
          action: tool.name,
          context: "state_projections.postconditions",
          evidence: { workflow: tool.name },
          message: `Mutating workflow ${tool.name} has no state postcondition.`,
          recommendation: "Add an identity-bound postcondition that verifies the mutation through a state projection.",
        }),
      );
      continue;
    }
    if (isConstantTruePostcondition(postcondition.definition)) {
      findings.push(
        finding({
          id: `weak-postcondition:${tool.name}:constant-true`,
          code: "weak_postcondition",
          severity: "high",
          action: tool.name,
          context: "state_projections.postconditions",
          evidence: { projection: postcondition.projection_name, verify: postcondition.definition.verify },
          message: `Mutating workflow ${tool.name} uses a constant-true postcondition.`,
          recommendation: "Replace the constant expression with a check over changed state and user input.",
        }),
      );
    }
  }
  return findings;
}

export function auditStateMachineWorkflowShape(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    if (!isMutatingWorkflow(tool)) continue;

    if (!hasOverlayInvariant(tool.workflow)) {
      findings.push(
        finding({
          id: `state-machine:${tool.name}:overlay-invariant`,
          code: "missing_overlay_invariant",
          severity: "high",
          action: tool.name,
          context: "workflow.steps",
          evidence: { workflow: tool.name },
          message: `Mutating workflow ${tool.name} does not neutralize the actions overlay before pointer/input interaction.`,
          recommendation: "Add an overlay.menu.hide step before the first mutation or declare workflow.x_state_machine.overlay_safe when pointer interaction cannot be affected by the overlay.",
        }),
      );
    }

    if (!hasRequiredStateAssertion(tool.workflow)) {
      findings.push(
        finding({
          id: `state-machine:${tool.name}:required-state-assertion`,
          code: "missing_required_state_assertion",
          severity: "high",
          action: tool.name,
          context: "workflow.x_state_machine.requires_state",
          evidence: { requires_state: tool.workflow?.x_state_machine?.requires_state },
          message: `Mutating workflow ${tool.name} declares a required state but does not mechanically assert it before mutation.`,
          recommendation: "Add a pre-mutation locator.wait_for, locator.element_info, or locator.text_content step that proves the required route/modal/editor surface and target identity before any pointer or text mutation.",
        }),
      );
    }

    if (hasProseOnlyPrecondition(tool)) {
      findings.push(
        finding({
          id: `state-machine:${tool.name}:prose-precondition-without-state-assertion`,
          code: "prose_precondition_without_state_assertion",
          severity: "high",
          action: tool.name,
          context: "description",
          evidence: { description: tool.description },
          message: `Mutating workflow ${tool.name} documents a precondition in prose but does not declare workflow.x_state_machine.requires_state.`,
          recommendation: "Move prose-only preconditions into workflow.x_state_machine.requires_state and add an early locator assertion that proves the required surface before mutation.",
        }),
      );
    }

    for (const step of tool.workflow.steps || []) {
      if (hasBrittleViewportGeometry(step)) {
        findings.push(
          finding({
            id: `state-machine:${tool.name}:${step.id}:brittle-viewport-geometry`,
            code: "brittle_viewport_geometry",
            severity: "high",
            action: tool.name,
            context: `workflow.steps.${step.id}`,
            evidence: {
              args: step.args,
            },
            message: `Workflow ${tool.name} step ${step.id} selects a target with viewport geometry constants instead of semantic readiness.`,
            recommendation: "Replace magic bounding_box coordinate filters with a scoped locator or a prior state-specific candidate action that verifies the exact control identity.",
          }),
        );
      }

      if (isAmbientTextInsert(step)) {
        findings.push(
          finding({
            id: `state-machine:${tool.name}:${step.id}:ambient-text-insert`,
            code: "ambient_text_insert",
            severity: "high",
            action: tool.name,
            context: `workflow.steps.${step.id}`,
            evidence: {
              args: step.args,
            },
            message: `Workflow ${tool.name} step ${step.id} inserts text into ambient focus instead of a verified editable target.`,
            recommendation: "Pass an explicit target locator to text.insert, or add a readiness primitive that proves the focused element is the intended editable control.",
          }),
        );
      }

      if (hasAmbiguousEditableTarget(step)) {
        findings.push(
          finding({
            id: `state-machine:${tool.name}:${step.id}:ambiguous-editable-target`,
            code: "ambiguous_editable_target",
            severity: "high",
            action: tool.name,
            context: `workflow.steps.${step.id}`,
            evidence: {
              args: step.args,
            },
            message: `Workflow ${tool.name} step ${step.id} can insert text into a generic editable surface instead of the intended editor body.`,
            recommendation: "Target a semantically identified editable surface such as an aria-label, placeholder, data-testid, role-specific editor body, or a prior verified editor handle. Do not fall back from a body editor to any textarea/contenteditable in the modal.",
          }),
        );
      }

      if (hasRetryConditionMismatch(step)) {
        findings.push(
          finding({
            id: `state-machine:${tool.name}:${step.id}:retry-condition-mismatch`,
            code: "retry_condition_mismatch",
            severity: "medium",
            action: tool.name,
            context: `workflow.steps.${step.id}`,
            evidence: {
              retry_until: step.retry_until,
              after_each: step.after_each,
            },
            message: `Workflow ${tool.name} retry step ${step.id} waits for a broader condition than retry_until checks.`,
            recommendation: "Make after_each wait for the same logical target-control readiness condition as retry_until, including visible text or state context.",
          }),
        );
      }
    }

    if (!hasMutationReadiness(tool.workflow)) {
      findings.push(
        finding({
          id: `state-machine:${tool.name}:mutation-readiness`,
          code: "missing_mutation_readiness",
          severity: "high",
          action: tool.name,
          context: "workflow.steps",
          evidence: { workflow: tool.name },
          message: `Mutating workflow ${tool.name} does not prove target-control readiness before mutation.`,
          recommendation: "Resolve a specific target control with locator.element_info or a11y.query before pointer/input mutation, then click geometry from that readiness step.",
        }),
      );
    }
  }
  return findings;
}

export function auditMissingDeclaredFiles(declaredFiles = []) {
  return declaredFiles
    .filter((file) => file.exists === false)
    .map((file) =>
      finding({
        id: `missing-file:${file.relativePath}`,
        code: "missing_declared_file",
        severity: "high",
        action: null,
        context: "x_actions.files",
        evidence: { path: file.path, relative_path: file.relativePath, kind: file.kind },
        message: `Declared ${file.kind} file is missing: ${file.relativePath}.`,
        recommendation: "Create the declared file or remove the declaration from x_actions.files.",
      }),
    );
}

// "Bind the container, not the control." A selector whose only anchor is a
// wrapper plus a bare tag identifies nothing: it resolves to whatever happens to
// be first inside that container, and it dies silently the moment the wrapper is
// renamed. Containers are the least stable thing in a component-framework app —
// `[data-testid='popover']` matched ZERO elements on trello.com while the map
// bound six controls to it, one of them a destructive pointer.click.
// The trailing part is "any element of a generic KIND" — a bare tag, or a bare
// role like [role='menuitem'] / [role='option'] / [role='button']. A role with no
// accessible name is exactly as anonymous as `button`: it means "the first one".
const CONTAINER_SCOPE = /^\s*(\[data-testid='[^']*(popover|dialog|modal|window|container)[^']*'\]|\[role='dialog'\]|\[role='menu'\]|\.window|\.js-react-root|\[class\*='popover'\]|\[aria-modal[^\]]*\])\s+(button|input|a|div|span|textarea|li|\[role='(menuitem|option|button|link|tab|checkbox)'\])\s*$/;

export function auditContainerBoundControls(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    for (const step of tool.workflow?.steps ?? []) {
      const locator = step?.args?.locator;
      const selector = locator?.selector;
      if (!step?.id || typeof selector !== "string") continue;

      // A selector is a comma-separated alternative list. It is container-bound
      // only when EVERY alternative is a bare container scope — one alternative
      // that anchors the control itself (a testid, an aria-label) rescues it.
      const alternatives = selector.split(",").map((part) => part.trim()).filter(Boolean);
      if (alternatives.length === 0 || !alternatives.every((alt) => CONTAINER_SCOPE.test(alt))) continue;

      // ANY identity on the control rescues it, not just text_contains. Locators
      // in the wild also carry `text_equals` — which is STRONGER, not weaker.
      // A rule that checks one key and concludes "no identity" invites a
      // destructive "fix": replacing text_equals:"Archive this list" with
      // text_contains:"Archive" would also match "Archive all cards in this list".
      // False positives on a rule that prompts edits are worse than false negatives.
      const identityKeys = ["text_equals", "text_contains", "aria_label", "title"];
      const hasText = identityKeys.some(
        (key) => typeof locator[key] === "string" && locator[key].length > 0,
      );
      const mutates = MUTATING_PRIMITIVE_PATTERN.test(String(step.primitive || ""));
      const severity = hasText ? "low" : mutates ? "high" : "medium";

      findings.push(
        finding({
          id: `container-bound:${tool.name}:${step.id}`,
          code: "container_bound_control",
          severity,
          action: tool.name,
          context: `workflow.steps.${step.id}.args.locator`,
          evidence: { primitive: step.primitive, selector, has_control_identity: hasText, mutates },
          message: mutates && !hasText
            ? `${tool.name}.${step.id} MUTATES a control identified only by its container (${selector}); it clicks whatever is first inside, and resolves nothing at all once the wrapper is renamed.`
            : `${tool.name}.${step.id} binds a control by its container (${selector}) rather than by the control's own identity.`,
          recommendation: "Anchor the control itself — its data-testid, aria-label, or role+accessible name — and keep the container only as a fallback scope. Containers are renamed silently; a role is a standardised contract.",
        }),
      );
    }
  }
  return findings;
}

// The workflow engine has no schema linking a primitive to its output shape, so
// `steps.x.output.<field>` on a primitive that never emits <field> resolves to
// undefined — and JSONata's $exists()/$not() quietly turn that into a plausible
// boolean. Swapping a step's primitive without updating its consumers therefore
// yields a CONSTANT postcondition that no test notices.
//
// Only primitives whose success payload was read from the runtime source are
// modelled; every other primitive is ignored. A guard that guesses is worse than
// no guard. (extensions/chrome-overlay-runtime/src/content.js)
const PRIMITIVE_OUTPUT_FIELDS = new Map([
  // primitiveSuccess("dom.observe.visible", { matches, match_count })
  ["dom.observe.visible", new Set(["matches", "match_count"])],
  // primitiveSuccess("locator.wait_for", { matched, state, elapsed_ms })
  ["locator.wait_for", new Set(["matched", "state", "elapsed_ms"])],
  // primitiveSuccess("locator.text_content", { locator, text })
  ["locator.text_content", new Set(["locator", "text"])],
]);

export function auditPrimitiveOutputFields(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    const steps = tool.workflow?.steps;
    if (!Array.isArray(steps)) continue;

    const modelled = new Map();
    for (const step of steps) {
      const fields = PRIMITIVE_OUTPUT_FIELDS.get(String(step?.primitive || ""));
      if (fields && step.id) modelled.set(step.id, { fields, primitive: step.primitive });
    }
    if (modelled.size === 0) continue;

    // Every expression that can read a step's output: the workflow output, plus
    // each step's `when` / `retry_until` / args.
    const expressions = [["workflow.output", tool.workflow.output]];
    for (const step of steps) {
      if (!step?.id) continue;
      for (const key of ["when", "retry_until"]) {
        if (typeof step[key] === "string") expressions.push([`workflow.steps.${step.id}.${key}`, step[key]]);
      }
      if (step.args) expressions.push([`workflow.steps.${step.id}.args`, JSON.stringify(step.args)]);
    }

    for (const [context, expression] of expressions) {
      if (typeof expression !== "string") continue;
      for (const match of expression.matchAll(/steps\.([A-Za-z0-9_]+)\.output\.([A-Za-z0-9_]+)/g)) {
        const [, stepId, field] = match;
        const entry = modelled.get(stepId);
        if (!entry || entry.fields.has(field)) continue;
        findings.push(
          finding({
            id: `primitive-output:${tool.name}:${stepId}:${field}`,
            code: "unknown_primitive_output_field",
            severity: "high",
            action: tool.name,
            context,
            evidence: { step: stepId, primitive: entry.primitive, field, emits: [...entry.fields] },
            message: `${tool.name} reads steps.${stepId}.output.${field}, but ${entry.primitive} never emits ${field} (it emits ${[...entry.fields].join(", ")}). The path resolves to undefined, so any $exists()/$not() around it is a constant.`,
            recommendation: `Read a field ${entry.primitive} actually emits. For dom.observe.visible, absence is match_count = 0.`,
          }),
        );
      }
    }
  }
  return findings;
}

// Three ways a workflow reports success while mutating nothing. Each of these
// shipped in a mature, previously-audited map: every offending step had a unique
// stable anchor and a verify step, so the anchor and postcondition audits passed
// it. What they share is that NOTHING FAILS when the step is wrong.
// A `settle_after` is a postcondition for THE STEP'S OWN SURFACE: "this step is not finished until
// X is on the page." Surface readiness never depends on the CALLER'S DATA. So a settle_after whose
// locator interpolates a workflow INPUT into `text_contains` is not asserting readiness at all —
// it is re-asserting the workflow's GOAL, which a later verify step owns.
//
// That distinction is not cosmetic. Since a timed-out settle_after became FATAL (engine change
// 6a3903f), a goal-assertion in a settle turns a SUCCESSFUL workflow into a loud false failure.
//
// Measured, 2026-07-09: `trello.card.create`'s `submitCard` (a keyboard.press in the composer)
// settled on `[data-testid='card-name'] text_contains {% input.title %}` — the new card ON THE
// BOARD, a surface that step never touched. New cards land at the BOTTOM of the list, off-screen
// (Backlog: scrollHeight 1468 vs clientHeight 718; 9 of 17 rendered cards in viewport), and a
// settle_after resolves through a VISIBILITY-FILTERED locator. It could never see the card.
// `verifyCardPresent` (dom.observe.visible + retry_until) already owned that check and passed.
// Result: card.create reported ok:false on EVERY success, and a full day was spent investigating a
// wedge that does not exist.
//
// Deliberately narrow. An earlier, broader form of this rule ("a later step resolves the same
// locator") fired 14x on the corpus with 2 true positives — the other 12 were the CORRECT pattern
// (settle until a control exists, then act on it), and acting on them would have deleted the
// settles that guard the wrong-mutation family. Detector false positives are worse than false
// negatives: they prompt a wrong edit.
export function auditGoalAssertingSettle(map) {
  const findings = [];
  const INPUT_INTERPOLATION = /\{%[^%]*\binput\./;

  for (const tool of mapTools(map)) {
    const steps = tool.workflow?.steps;
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      const locator = step?.settle_after?.locator;
      if (!step?.id || !locator) continue;

      const goalFields = Object.entries(locator).filter(
        ([key, value]) => /^text_(contains|equals)$/.test(key) && typeof value === "string" && INPUT_INTERPOLATION.test(value),
      );
      if (goalFields.length === 0) continue;

      findings.push(
        finding({
          id: `goal-settle:${tool.name}:${step.id}`,
          code: "settle_after_asserts_goal_not_surface",
          severity: "high",
          action: tool.name,
          context: `workflow.steps.${step.id}.settle_after.locator`,
          evidence: { primitive: step.primitive, locator, goal_fields: Object.fromEntries(goalFields) },
          message: `${tool.name}.${step.id}'s settle_after matches on the CALLER'S DATA (${goalFields.map(([k]) => k).join(", ")} interpolates an input). Surface readiness never depends on the caller's data — this settle asserts the workflow's GOAL, not that the step finished. A timed-out settle_after is FATAL, so on any surface where the target is off-screen or virtualised this fails a workflow that SUCCEEDED.`,
          recommendation: `Delete it and let the workflow's verify step own the goal (dom.observe.visible + retry_until reports absence without erroring), or narrow the settle to a surface THIS step creates — the composer closing, the popover opening.`,
        }),
      );
    }
  }
  return findings;
}

// A comma-separated fallback list is not robustness when every branch is scoped
// inside the SAME ancestor. It fails as a unit: if the ancestor is gone, all three
// "fallbacks" match nothing, together, silently.
//
// This is the shape that hid `trello.card.delete` for a day. Trello moved the
// confirmation off its popover component, so `[data-testid='popover']` matches zero
// elements. `findConfirmDelete` was rebound. Its sibling `findDeleteButton` was not —
// and its three fallbacks all read
//     [data-testid='popover'] a, [data-testid='popover'] b, [data-testid='popover'] button
// which looks defensive and is one selector wearing three hats. Nobody noticed, because
// the step that failed loudly got fixed and the step that had not failed yet did not.
//
// KNOWN_DEAD_SCOPES holds only prefixes CORROBORATED against the live DOM by an
// independent instrument (browser.extract_elements), never inferred from a fixture.
// A generic scope like `[role='dialog']` is correct authoring and must stay silent:
// ten such steps exist across the maps and none is a defect.
//
// Measured on the real corpus, both directions: 3 fires, all true (card.delete twice,
// list.archive once — the second was an UNKNOWN defect in a destructive action); 10
// clean non-fires on live `[role='dialog']`/`main` scopes. Zero false positives in 3
// fires bounds the FPR at 63.2% (exact, 95%), not at zero. Treat this as a positive
// oracle: when it fires, believe it. Its silence clears nothing.
const KNOWN_DEAD_SCOPES = new Set(["[data-testid='popover']"]);

function selectorBranches(selector) {
  const branches = [];
  let depth = 0;
  let current = "";
  for (const character of selector) {
    if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      branches.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) branches.push(current.trim());
  return branches;
}

function sharedScopePrefix(branches) {
  if (branches.length < 2) return null;
  const heads = branches.map((branch) => branch.split(" ")[0]);
  const allSameHead = heads.every((head) => head === heads[0]);
  const anyDescendant = branches.some((branch) => branch.includes(" "));
  return allSameHead && anyDescendant ? heads[0] : null;
}

export function auditFallbacksShareDeadScope(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    const steps = tool.workflow?.steps;
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      const selector = step?.args?.locator?.selector;
      if (!step?.id || typeof selector !== "string" || !selector.includes(",")) continue;

      const branches = selectorBranches(selector);
      const prefix = sharedScopePrefix(branches);
      if (!prefix || !KNOWN_DEAD_SCOPES.has(prefix)) continue;

      findings.push(
        finding({
          id: `dead-scope:${tool.name}:${step.id}`,
          code: "fallbacks_share_a_dead_scope",
          severity: "high",
          action: tool.name,
          context: `workflow.steps.${step.id}.args.locator.selector`,
          evidence: { primitive: step.primitive, selector, shared_scope: prefix, branch_count: branches.length },
          message: `${tool.name}.${step.id} has ${branches.length} selector fallbacks and EVERY ONE is scoped inside \`${prefix}\`, which matches zero elements on the live page. This is one selector, not ${branches.length}: the fallbacks cannot fail independently, so they all miss together and the step reports target_not_found with no hint that its container is the problem.`,
          recommendation: `Rebind to the control's real identity — a testid you have RESOLVED, else its accessible name, else text_equals — and drop the dead scope. Then grep the whole map for \`${prefix}\`: a container that died in one step died in all of them, and the fix usually lands only on the step that failed loudly.`,
        }),
      );
    }
  }
  return findings;
}

export function auditSilentNoOpSteps(map) {
  const findings = [];
  for (const tool of mapTools(map)) {
    const steps = tool.workflow?.steps;
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      const stepId = step?.id;
      if (!stepId) continue;
      const primitive = String(step.primitive || "");

      // 1. A REQUIRED mutation gated on its own target silently skips itself.
      //    `when` is a branch you are willing not to take; if the step must run,
      //    a missing target is a failure, not a branch.
      if (MUTATING_PRIMITIVE_PATTERN.test(primitive) && step.when && step.on_error !== "continue") {
        const gatesOn = referencedStepIds(step.when);
        const coordinateSources = referencedStepIds(step.args);
        const selfGates = gatesOn.filter((id) => coordinateSources.includes(id));
        if (selfGates.length > 0 && !isInvertedGuard(step.when)) {
          findings.push(
            finding({
              id: `silent-no-op:${tool.name}:${stepId}:self-skipping-mutation`,
              code: "self_skipping_mutation",
              severity: "high",
              action: tool.name,
              context: `workflow.steps.${stepId}`,
              evidence: { primitive, when: step.when, gates_on: selfGates, on_error: step.on_error ?? null },
              message: `Required mutation ${tool.name}.${stepId} is gated on its own target (${selfGates.join(", ")}); a matched-but-unclickable control makes it silently skip while the workflow reports success.`,
              recommendation: "Drop the self-referential `when` and set on_error: \"stop\". Gate on a DIFFERENT element only for idempotency (an inverted `$exists(x) ? false : true` guard, or a container precondition).",
            }),
          );
        }
      }

      // 2. A retry loop is armed by on_error:"continue". An attempt whose
      //    primitive errors aborts the workflow on attempt 1 otherwise — and
      //    locator.* errors on exactly the states being retried for
      //    (target_not_found, target_not_actionable). Exhaustion still hard-fails
      //    via workflow_retry_exhausted, which ignores on_error.
      if (step.retry_until !== undefined && ERROR_ON_ABSENCE_PATTERN.test(primitive) && step.on_error !== "continue") {
        findings.push(
          finding({
            id: `silent-no-op:${tool.name}:${stepId}:disarmed-retry-loop`,
            code: "disarmed_retry_loop",
            severity: "medium",
            action: tool.name,
            context: `workflow.steps.${stepId}`,
            evidence: { primitive, retry_until: step.retry_until, max_attempts: step.max_attempts ?? null, on_error: step.on_error ?? null },
            message: `Retry step ${tool.name}.${stepId} can never retry: ${primitive} errors on target_not_found/target_not_actionable, and on_error is not "continue", so the workflow aborts on attempt 1.`,
            recommendation: "Set on_error: \"continue\" to arm the loop. Exhausting max_attempts still hard-fails the workflow via workflow_retry_exhausted, which cannot be swallowed.",
          }),
        );
      }

      // 3a. `state: "hidden"` is not implemented; locator.wait_for resolves only
      //     when the element IS found, so a hidden-wait is exactly inverted.
      for (const state of hiddenStateEntries(step)) {
        findings.push(
          finding({
            id: `silent-no-op:${tool.name}:${stepId}:unsupported-hidden-state:${state.path}`,
            code: "unsupported_hidden_state",
            severity: "high",
            action: tool.name,
            context: `workflow.steps.${stepId}.${state.path}`,
            evidence: { primitive, path: state.path, state: "hidden" },
            message: `${tool.name}.${stepId} waits for state "hidden", which the runtime does not implement: locator.wait_for succeeds only when the element is found, so this resolves while the element is VISIBLE and times out once it is gone.`,
            recommendation: "Assert absence with dom.observe.visible + retry_until `match_count = 0` (it returns success with match_count: 0 and never errors on no-match).",
          }),
        );
      }

      // 3b. A `*gone`/`*removed` check implemented as a presence read that cannot
      //     fail certifies nothing in EITHER direction: absent -> the error is
      //     swallowed; present -> the read succeeds. Both report success.
      if (ABSENCE_INTENT_PATTERN.test(stepId) && step.on_error === "continue" && ERROR_ON_ABSENCE_PATTERN.test(primitive)) {
        findings.push(
          finding({
            id: `silent-no-op:${tool.name}:${stepId}:inverted-absence-check`,
            code: "inverted_absence_check",
            severity: "high",
            action: tool.name,
            context: `workflow.steps.${stepId}`,
            evidence: { primitive, on_error: step.on_error },
            message: `${tool.name}.${stepId} claims to verify absence but is a presence read that cannot fail: if the object is gone ${primitive} errors and on_error "continue" swallows it; if it is still there the read succeeds. Both outcomes report success.`,
            recommendation: "Use dom.observe.visible with retry_until `match_count = 0` and max_attempts; exhaustion hard-fails, which positively asserts absence.",
          }),
        );
      }
    }
  }
  return findings;
}

function finding(fields) {
  return {
    status: "open",
    ...fields,
  };
}

// Collect `steps.<id>.output...` references out of any expression or args tree.
function referencedStepIds(value) {
  const ids = new Set();
  const walk = (node) => {
    if (typeof node === "string") {
      for (const match of node.matchAll(/steps\.([A-Za-z0-9_]+)\.output/g)) ids.add(match[1]);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const nested of Object.values(node)) walk(nested);
  };
  walk(value);
  return [...ids];
}

// `$exists(x) ? false : true` means "act only if x is ABSENT" — an idempotency
// guard, the opposite of a self-skip. Do not flag it.
function isInvertedGuard(expression) {
  return /\?\s*false\s*:\s*true/.test(String(expression || ""));
}

function hiddenStateEntries(step) {
  const entries = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && node.state === "hidden") entries.push({ path: path.join(".") || "state" });
    for (const [key, nested] of Object.entries(node)) {
      if (key === "id" || key === "primitive") continue;
      walk(nested, [...path, key]);
    }
  };
  walk(step.settle_after, ["settle_after"]);
  walk(step.args, ["args"]);
  walk(step.after_each, ["after_each"]);
  return entries;
}

function mapTools(map) {
  return Array.isArray(map?.tools) ? map.tools.filter((tool) => tool?.name) : [];
}

function selectorEntries(value, path = []) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => selectorEntries(item, [...path, String(index)]));
  }

  const entries = [];
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (key === "selector" && typeof nested === "string") {
      entries.push({ selector: nested, path: nestedPath });
    } else {
      entries.push(...selectorEntries(nested, nestedPath));
    }
  }
  return entries;
}

// Split a selector list on its TOP-LEVEL commas only. A comma inside brackets
// (`[data-testid="a,b"]`) or parens (`:is(a, b)`) is part of one alternative, not a
// separator; a naive `.split(",")` shreds those and produces nonsense alternatives.
function selectorAlternatives(selector) {
  const source = String(selector || "");
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
}

// A CSS selector list is an OR. Its breadth is the breadth of its BROADEST alternative,
// so a single loose alternative makes the whole locator loose.
//
// This used to test the whole string against /^button…$/, which no real selector matches:
// a broad selector never ships alone, it ships as the last alternative of a comma-list,
// because an author pairs a hopeful testid with a desperate fallback —
//
//     "[data-testid='card-back-delete-button'], button"
//
// so the detector was silent on every real occurrence while passing its own unit test,
// which fed it a synthetic bare `button`. Known-answer testing against real map data,
// not invented data, is what surfaces this class (see the sibling rule in the authoring
// skill: a check that cannot fail is not a check).
//
// Cost of the blind spot, measured on live Trello 2026-07-09: with a card modal open and
// the archive popover absent, `[role='dialog'] button` + text_contains "Delete" resolved
// to exactly one element — the card's <button aria-label="Delete checklist">. Since
// trello.card.delete's clickDelete carries on_error:null it would have clicked it,
// destroying the checklist, sparing the card, and reporting success.
// `button[data-testid='create-board-submit-button']` is a tag plus a UNIQUE IDENTITY —
// the narrowest thing an author can write, and exactly what the authoring skill asks for.
// Flagging it teaches authors that the detector is noise, and a muted detector takes the
// true positives with it. An attribute predicate only fails to narrow when it is a
// presence/role/state check rather than an identity.
const IDENTITY_ATTRIBUTE = /^\[\s*(data-[\w-]+|id|name|href|aria-label|title|placeholder)\s*[~|^$*]?=/;

function isIdentityBound(alternative) {
  const attrs = alternative.match(/\[[^\]]+\]/g) || [];
  return attrs.some((attr) => IDENTITY_ATTRIBUTE.test(attr));
}

function isBroadSelector(selector) {
  return selectorAlternatives(selector).some((alternative) => {
    if (BROAD_SELECTORS.has(alternative)) return true;
    if (isIdentityBound(alternative)) return false;
    if (/^button(\[[^\]]+\])?$/.test(alternative) || /^input(\[[^\]]+\])?$/.test(alternative)) return true;
    // `[role='dialog'] button`, `.window button`, `section[role='dialog'] button`:
    // a bare tag as the final compound of a descendant chain whose only ancestor is a
    // generic role/modal shell. These are "any button anywhere in the dialog", which is
    // what `text_contains` then has to disambiguate — and text_contains NARROWS a
    // candidate set, it does not SCOPE it.
    const descendant = /^(\S+)\s+(button|input|a|div|span)$/.exec(alternative);
    if (descendant && BROAD_SELECTORS.has(descendant[1])) return true;
    if (descendant && /^(\[role=['"](dialog|main)['"]\]|section\[role=['"]dialog['"]\])$/.test(descendant[1])) {
      return true;
    }
    return false;
  });
}

function isMutatingWorkflow(tool) {
  if (!tool?.workflow || typeof tool.workflow !== "object" || !Array.isArray(tool.workflow.steps)) {
    return false;
  }
  return tool.workflow.steps.some((step) => MUTATING_PRIMITIVE_PATTERN.test(String(step?.primitive || "")));
}

function firstMutationIndex(workflow) {
  return (workflow?.steps || []).findIndex((step) => MUTATING_PRIMITIVE_PATTERN.test(String(step?.primitive || "")));
}

function hasOverlayInvariant(workflow) {
  if (workflow?.x_state_machine?.overlay_safe === true) return true;
  const mutationIndex = firstMutationIndex(workflow);
  if (mutationIndex < 0) return true;
  return (workflow.steps || [])
    .slice(0, mutationIndex)
    .some((step) => step?.primitive === "overlay.menu.hide");
}

function hasRetryConditionMismatch(step) {
  if (!step?.retry_until || !step?.after_each) return false;
  const retryUntil = String(step.retry_until);
  const stepLocator = step?.args?.locator || null;
  const afterLocator = step?.after_each?.args?.locator || null;
  if (!afterLocator) return false;

  const stepText = typeof stepLocator?.text_contains === "string" ? stepLocator.text_contains : null;
  const afterText = typeof afterLocator?.text_contains === "string" ? afterLocator.text_contains : null;
  if (stepText && stepText !== afterText) return true;
  if (/\bcandidates\s*\[/.test(retryUntil) && !afterText) return true;
  return false;
}

function hasMutationReadiness(workflow) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step?.primitive !== "pointer.click") continue;
    const referencedStepIds = referencedGeometryStepIds(step.args);
    if (referencedStepIds.length === 0) return false;
    const priorSteps = new Map(steps.slice(0, index).map((candidate) => [candidate.id, candidate]));
    const hasReadyTarget = referencedStepIds.some((stepId) => {
      const source = priorSteps.get(stepId);
      if (source?.primitive === "locator.element_info") {
        return isSpecificMutationLocator(source?.args?.locator);
      }
      return source?.primitive === "a11y.query" && isSpecificA11yTarget(source?.args);
    });
    if (!hasReadyTarget) return false;
  }
  return true;
}

function isSpecificA11yTarget(args) {
  if (!args || typeof args !== "object") return false;
  return Boolean(args.role && (args.name || args.name_contains));
}

function hasBrittleViewportGeometry(step) {
  const serialized = JSON.stringify(step?.args || {});
  if (!/\.output\.candidates\s*\[/.test(serialized)) return false;
  return /bounding_box\.(?:top|right|bottom|left|width|height)\s*(?:[<>]=?|=)\s*-?\d+(?:\.\d+)?/.test(serialized);
}

function isAmbientTextInsert(step) {
  if (step?.primitive !== "text.insert") return false;
  return !step.args?.target;
}

function hasRequiredStateAssertion(workflow) {
  const required = workflow?.x_state_machine?.requires_state;
  if (!required) return true;
  const mutationIndex = firstMutationIndex(workflow);
  const boundary = mutationIndex < 0 ? workflow?.steps || [] : (workflow?.steps || []).slice(0, mutationIndex);
  return boundary.some((step) => stepAssertsRequiredState(step, required));
}

function hasProseOnlyPrecondition(tool) {
  if (!/\bprecondition\s*:/i.test(String(tool?.description || ""))) return false;
  return !tool?.workflow?.x_state_machine?.requires_state;
}

function stepAssertsRequiredState(step, required) {
  if (!["locator.wait_for", "locator.element_info", "locator.text_content"].includes(step?.primitive)) return false;
  const locator = step?.args?.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) return false;
  if (required.selector && !sameSelectorSet(locator.selector, required.selector)) return false;
  if (required.text_contains && locator.text_contains !== required.text_contains) return false;
  if (required.text_equals && locator.text_equals !== required.text_equals) return false;
  return true;
}

function sameSelectorSet(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  return normalizeSelectorSet(actual) === normalizeSelectorSet(expected);
}

function normalizeSelectorSet(selector) {
  return String(selector)
    .split(",")
    .map((item) => item.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join(", ");
}

function hasAmbiguousEditableTarget(step) {
  if (step?.primitive !== "text.insert") return false;
  const target = step?.args?.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  return isAmbiguousEditableLocator(target);
}

function isAmbiguousEditableLocator(locator) {
  const selector = typeof locator.selector === "string" ? locator.selector : "";
  if (!/\btextarea\b|\[contenteditable=['"]?true['"]?\]/i.test(selector)) return false;
  if (locator.text_contains || locator.text_equals) return false;
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => isGenericEditableSelector(part));
}

function isGenericEditableSelector(selector) {
  if (!/\btextarea\b|\[contenteditable=['"]?true['"]?\]/i.test(selector)) return false;
  return !/aria-label|placeholder|data-testid|name=|role=|ProseMirror|editor|description|comment|checklist|title/i.test(selector);
}

function referencedGeometryStepIds(value) {
  const serialized = JSON.stringify(value || {});
  const ids = new Set();
  for (const match of serialized.matchAll(/steps\.([A-Za-z][A-Za-z0-9_-]*)\.output\.(?:clickable_center|candidates)/g)) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

function isSpecificMutationLocator(locator) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) return false;
  const selector = typeof locator.selector === "string" ? locator.selector.trim() : "";
  if (!selector || isBroadSelector(selector)) return false;
  if (typeof locator.text_contains === "string" && locator.text_contains.trim()) return true;
  return /\[data-testid=/.test(selector) || /\[aria-label=/.test(selector) || /\[role=/.test(selector);
}

function findStatePostcondition(map, actionName) {
  const projections = Array.isArray(map?.state_projections) ? map.state_projections : [];
  for (const projection of projections) {
    const postcondition = projection?.postconditions?.[actionName];
    if (postcondition && typeof postcondition === "object" && !Array.isArray(postcondition)) {
      return {
        projection_name: typeof postcondition.projection === "string" ? postcondition.projection : projection.name,
        definition: postcondition,
      };
    }
  }
  return null;
}

function isConstantTruePostcondition(postcondition) {
  const expression = postcondition?.verify?.expression;
  if (typeof expression !== "string") return false;
  return expression.replace(/^\s*\{%\s*/, "").replace(/\s*%\}\s*$/, "").trim() === "true";
}

function summarizeFindings(findings, staleEntries) {
  const summary = {
    open: 0,
    accepted: 0,
    stale_ledger_entries: staleEntries.length,
    by_severity: {},
  };
  for (const item of findings) {
    summary[item.status] = (summary[item.status] || 0) + 1;
    summary.by_severity[item.severity] = (summary.by_severity[item.severity] || 0) + 1;
  }
  return summary;
}
