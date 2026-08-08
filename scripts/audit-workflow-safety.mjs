#!/usr/bin/env node
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_EFFECTS = new Set([
  "observation",
  "readiness",
  "cleanup",
  "reversible_mutation",
  "irreversible_mutation",
  "verification",
]);

const MUTATION_EFFECTS = new Set(["reversible_mutation", "irreversible_mutation"]);
const DISCOVERY_PRIMITIVE = /^(?:locator\.|a11y\.query$|projection\.(?:navigate|search)$)/;
const LEGACY_EFFECT_PRIMITIVE = /^(?:pointer\.click$|keyboard\.press$|text\.(?:insert|select)$|clipboard\.paste$|transfer\.write$)/;
const UNIQUENESS_GATE = /(?:\b(?:candidate|match|result)_count\b["']?\s*(?::|=|==|===)\s*1\b|\b(?:unique|exact_match)\b|\b(?:node|target|resolved|opaque)_ref\b)/i;
const STEP_REFERENCE = (id) => new RegExp(`\\bsteps\\.${escapeRegex(id)}\\.output\\b`);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stableText = (value) => JSON.stringify(value ?? null);

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function relativeMapPath(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : file;
}

function parseSubmodulePaths(source) {
  return source.split(/\r?\n/)
    .map((line) => /^\s*path\s*=\s*(.+?)\s*$/.exec(line)?.[1])
    .filter(Boolean);
}

async function enumerateActionMaps(root, addCoverageFinding) {
  const files = [];
  const visited = new Set();

  async function visit(directory) {
    let canonical;
    try {
      canonical = await realpath(directory);
      if (visited.has(canonical)) return;
      visited.add(canonical);
    } catch (error) {
      addCoverageFinding("directory_unreadable", directory, error.message);
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      addCoverageFinding("directory_unreadable", directory, error.message);
      return;
    }

    const gitmodules = entries.find((entry) => entry.isFile() && entry.name === ".gitmodules");
    if (gitmodules) {
      try {
        const source = await readFile(path.join(directory, gitmodules.name), "utf8");
        for (const declaredPath of parseSubmodulePaths(source)) {
          const submodule = path.resolve(directory, declaredPath);
          if (!(await exists(submodule)) || !(await exists(path.join(submodule, ".git")))) {
            addCoverageFinding("submodule_uninitialized", submodule, "declared submodule has no initialized .git metadata");
          }
        }
      } catch (error) {
        addCoverageFinding("gitmodules_unreadable", path.join(directory, gitmodules.name), error.message);
      }
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(target)).isDirectory()) await visit(target);
        } catch (error) {
          addCoverageFinding("symlink_unreadable", target, error.message);
        }
      } else if (entry.isFile() && entry.name === "actions.json") {
        files.push(target);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function collectWorkflows(document) {
  const workflows = [];
  const visitedObjects = new WeakSet();
  const visitedWorkflows = new WeakSet();

  function walk(value, context = {}) {
    if (!value || typeof value !== "object" || visitedObjects.has(value)) return;
    visitedObjects.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, { ...context, index }));
      return;
    }

    const name = typeof value.name === "string" ? value.name : context.action;
    if (isObject(value.workflow) && Array.isArray(value.workflow.steps) && !visitedWorkflows.has(value.workflow)) {
      visitedWorkflows.add(value.workflow);
      workflows.push({ action: name ?? "<unnamed-action>", workflow: value.workflow });
    }
    if (Array.isArray(value.steps) && ("expression_language" in value || "version" in value) && !visitedWorkflows.has(value)) {
      visitedWorkflows.add(value);
      workflows.push({ action: name ?? context.action ?? "<unnamed-workflow>", workflow: value });
    }
    for (const nested of Object.values(value)) walk(nested, { action: name ?? context.action });
  }

  walk(document);
  return workflows;
}

function hasUniquenessGate(steps, discoveryIndex, effectIndex) {
  const discoveryId = steps[discoveryIndex]?.id;
  const effect = steps[effectIndex];
  const guards = effect?.target_guards ?? (effect?.target_guard ? [effect.target_guard] : []);
  if (guards.some((guard) => guard?.source_step === discoveryId && guard?.candidate_count === 1)) return true;
  return UNIQUENESS_GATE.test(stableText(steps.slice(discoveryIndex, effectIndex + 1)));
}

function inspectWorkflow({ workflow, action }, mapPath, addFinding, coverage) {
  const steps = workflow.steps;
  coverage.steps += steps.length;

  for (const step of steps) {
    const stepId = typeof step?.id === "string" ? step.id : "<unnamed-step>";
    inspectEffect(step, stepId, mapPath, action, addFinding, coverage);
    if (isObject(step?.after_each) && typeof step.after_each.primitive === "string") {
      coverage.steps += 1;
      inspectEffect(step.after_each, `${stepId}.after_each`, mapPath, action, addFinding, coverage);
    }
  }

  for (let discoveryIndex = 0; discoveryIndex < steps.length; discoveryIndex += 1) {
    const discovery = steps[discoveryIndex];
    if (!DISCOVERY_PRIMITIVE.test(discovery?.primitive ?? "") || typeof discovery.id !== "string") continue;
    const reference = STEP_REFERENCE(discovery.id);
    for (let effectIndex = discoveryIndex + 1; effectIndex < steps.length; effectIndex += 1) {
      const effect = steps[effectIndex];
      const isEffect = MUTATION_EFFECTS.has(effect?.effect)
        || (typeof effect?.effect !== "string" && LEGACY_EFFECT_PRIMITIVE.test(effect?.primitive ?? ""));
      if (!isEffect || !reference.test(stableText(effect))) continue;
      if (!hasUniquenessGate(steps, discoveryIndex, effectIndex)) {
        addFinding({
          code: "discovery_effect_without_uniqueness_gate",
          map_path: mapPath,
          action,
          step: typeof effect.id === "string" ? effect.id : "<unnamed-step>",
          discovery_step: discovery.id,
          primitive: effect.primitive ?? null,
        });
      }
      break;
    }
  }
}

function inspectEffect(step, stepId, mapPath, action, addFinding, coverage) {
  if (!isObject(step) || typeof step.primitive !== "string") return;
  if (typeof step.effect !== "string") {
    addFinding({
      code: "effect_metadata_missing",
      map_path: mapPath,
      action,
      step: stepId,
      primitive: step.primitive,
    });
    return;
  }
  if (!WORKFLOW_EFFECTS.has(step.effect)) {
    addFinding({
      code: "effect_metadata_invalid",
      map_path: mapPath,
      action,
      step: stepId,
      primitive: step.primitive,
      effect: step.effect,
    });
    return;
  }
  coverage.steps_with_valid_effect += 1;
}

export async function auditWorkflowStorageRoots(roots, options = {}) {
  const strict = options.strict === true;
  const maxFindings = Number.isSafeInteger(options.maxFindings) && options.maxFindings >= 0
    ? options.maxFindings
    : 200;
  const requestedRoots = [...new Set(roots.map((root) => path.resolve(root)))].sort();
  const allFindings = [];
  const coverage = {
    complete: true,
    requested_roots: requestedRoots,
    complete_roots: [],
    incomplete_roots: [],
    action_map_files: 0,
    workflows: 0,
    steps: 0,
    steps_with_valid_effect: 0,
  };

  const addFinding = (finding) => allFindings.push(finding);
  for (const root of requestedRoots) {
    let rootIncomplete = false;
    if (!(await exists(root))) {
      addFinding({ code: "root_missing", root, map_path: null, action: null, step: null });
      coverage.incomplete_roots.push(root);
      coverage.complete = false;
      continue;
    }
    const addCoverageFinding = (code, target, detail) => {
      rootIncomplete = true;
      addFinding({ code, root, path: target, detail, map_path: null, action: null, step: null });
    };
    const files = await enumerateActionMaps(root, addCoverageFinding);
    if (files.length === 0) {
      addCoverageFinding("no_action_maps_found", root, "storage root contains no actions.json maps");
    }
    coverage.action_map_files += files.length;
    for (const file of files) {
      const mapPath = relativeMapPath(root, file);
      let document;
      try {
        document = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        addFinding({ code: "map_unreadable", root, map_path: mapPath, action: null, step: null, detail: error.message });
        rootIncomplete = true;
        continue;
      }
      for (const workflow of collectWorkflows(document)) {
        coverage.workflows += 1;
        inspectWorkflow(workflow, mapPath, addFinding, coverage);
      }
    }
    if (rootIncomplete) {
      coverage.complete = false;
      coverage.incomplete_roots.push(root);
    } else {
      coverage.complete_roots.push(root);
    }
  }

  allFindings.sort((left, right) => [left.root ?? "", left.map_path ?? "", left.action ?? "", left.step ?? "", left.code]
    .join("\0").localeCompare([right.root ?? "", right.map_path ?? "", right.action ?? "", right.step ?? "", right.code].join("\0")));
  const byCode = {};
  for (const finding of allFindings) byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  const emitted = allFindings.slice(0, maxFindings);
  return {
    schema_version: 1,
    ok: strict ? allFindings.length === 0 && coverage.complete : true,
    strict,
    coverage,
    counts: {
      findings_total: allFindings.length,
      findings_emitted: emitted.length,
      findings_truncated: allFindings.length - emitted.length,
      by_code: byCode,
    },
    findings: emitted,
  };
}

function usage() {
  return "Usage: node scripts/audit-workflow-safety.mjs [--strict] [--max-findings N] <storage-root> [storage-root ...]";
}

function parseArguments(argv) {
  const roots = [];
  let strict = false;
  let maxFindings = 200;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") strict = true;
    else if (argument === "--max-findings") {
      const value = Number(argv[index += 1]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("--max-findings requires a non-negative integer");
      maxFindings = value;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true, roots, strict, maxFindings };
    } else if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    else roots.push(argument);
  }
  return { help: false, roots, strict, maxFindings };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else if (options.roots.length === 0) {
      console.error(usage());
      process.exitCode = 2;
    } else {
      const report = await auditWorkflowStorageRoots(options.roots, options);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}
