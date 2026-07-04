import { applyAcceptedGapLedger } from "./ledger.mjs";

const MUTATING_PRIMITIVE_PATTERN = /^(pointer|keyboard|input|form|clipboard)\./;
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
          recommendation: "Resolve a specific target control with locator.element_info before pointer/input mutation, then click geometry from that readiness step.",
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

function finding(fields) {
  return {
    status: "open",
    ...fields,
  };
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

function isBroadSelector(selector) {
  const normalized = String(selector || "").trim().replace(/\s+/g, " ");
  if (BROAD_SELECTORS.has(normalized)) return true;
  return /^button(\[[^\]]+\])?$/.test(normalized) || /^input(\[[^\]]+\])?$/.test(normalized);
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
      return source?.primitive === "locator.element_info" && isSpecificMutationLocator(source?.args?.locator);
    });
    if (!hasReadyTarget) return false;
  }
  return true;
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
