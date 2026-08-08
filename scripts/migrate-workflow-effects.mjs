#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OBSERVATION = /^(?:locator\.|a11y\.(?:query|tree)$|browser\.(?:extract_elements|screenshot)$|storage\.read_file$|transfer\.read$|projection\.(?:navigate|search)$)/;
const CLEANUP = /^(?:overlay\.menu\.hide$|transfer\.clear$)/;
const READINESS = /^(?:viewport\.|overlay\.|cursor\.|pointer\.move|browser\.(?:activate|claim))/;
const MUTATION = /^(?:pointer\.(?:click|drag)$|keyboard\.press$|text\.(?:insert|select)$|clipboard\.paste$|transfer\.(?:write|insert)$)/;
const VERIFY_ID = /(?:verify|verification|postcondition|assert|confirm|readAfter|readResult|checkResult)/i;
const CLEANUP_ID = /(?:cleanup|hideOverlay|dismiss|closePopover|closeMenu|restoreBase)/i;
const IRREVERSIBLE = /(?:^|[._-])(?:delete|permanent(?:ly)?_?remove|destroy)(?:$|[._-])/i;
const MUTATION_STEP = /(?:submit|save|commit|create|addItem|remove|archive|confirm|delete|drag|matchingLabel|targetOption|apply|complete|uncomplete|rename|setValue|selectOption)/i;

function classify(actionName, step) {
  const primitive = String(step.primitive || "");
  const identity = `${actionName || ""}.${step.id || ""}`;
  if (VERIFY_ID.test(step.id || "") && OBSERVATION.test(primitive)) return "verification";
  if (CLEANUP.test(primitive) || CLEANUP_ID.test(step.id || "")) return "cleanup";
  if (IRREVERSIBLE.test(identity) && MUTATION.test(primitive)) return "irreversible_mutation";
  if (primitive === "pointer.drag" || primitive.startsWith("text.") || primitive.startsWith("transfer.")) return "reversible_mutation";
  if (MUTATION.test(primitive)) return MUTATION_STEP.test(step.id || "") ? "reversible_mutation" : "readiness";
  if (READINESS.test(primitive)) return "readiness";
  return "observation";
}

function migrateDocument(document) {
  let changed = 0;
  let steps = 0;
  const visited = new WeakSet();
  const migratedWorkflows = new WeakSet();
  function walk(value, actionName = null) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, actionName);
      return;
    }
    const nextAction = typeof value.name === "string" ? value.name : actionName;
    const workflow = value.workflow?.steps ? value.workflow : (Array.isArray(value.steps) ? value : null);
    if (workflow && !migratedWorkflows.has(workflow)) {
      migratedWorkflows.add(workflow);
      for (const step of workflow.steps) {
        if (!step || typeof step !== "object" || typeof step.primitive !== "string") continue;
        steps += 1;
        if (typeof step.effect !== "string") {
          step.effect = classify(nextAction, step);
          changed += 1;
        }
        if (step.after_each && typeof step.after_each === "object" && typeof step.after_each.primitive === "string") {
          steps += 1;
          if (typeof step.after_each.effect !== "string") {
            step.after_each.effect = classify(nextAction, { ...step.after_each, id: `${step.id || "step"}.after_each` });
            changed += 1;
          }
        }
      }
      for (let discoveryIndex = 0; discoveryIndex < workflow.steps.length; discoveryIndex += 1) {
        const discovery = workflow.steps[discoveryIndex];
        if (!discovery?.id || !/^(?:locator\.|a11y\.query$|projection\.(?:navigate|search)$)/.test(discovery.primitive || "")) continue;
        for (let effectIndex = discoveryIndex + 1; effectIndex < workflow.steps.length; effectIndex += 1) {
          const effect = workflow.steps[effectIndex];
          if (!/mutation$/.test(effect?.effect || "")) continue;
          if (!JSON.stringify(effect).includes(`steps.${discovery.id}.output`)) continue;
          const existing = effect.target_guards ?? (effect.target_guard ? [effect.target_guard] : []);
          if (!existing.some((guard) => guard.source_step === discovery.id)) {
            effect.target_guards = [...existing, { source_step: discovery.id, candidate_count: 1 }];
            delete effect.target_guard;
            changed += 1;
          }
          break;
        }
      }
    }
    for (const child of Object.values(value)) walk(child, nextAction);
  }
  walk(document);
  return { changed, steps };
}

async function actionMaps(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === "actions.json") output.push(target);
    }
  }
  await visit(root);
  return output.sort();
}

export async function migrateWorkflowEffects(root, { write = false } = {}) {
  const files = await actionMaps(path.resolve(root));
  const report = { root: path.resolve(root), files: files.length, steps: 0, changed: 0, changed_files: [] };
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const document = JSON.parse(source);
    const result = migrateDocument(document);
    report.steps += result.steps;
    report.changed += result.changed;
    if (result.changed > 0) {
      report.changed_files.push(path.relative(report.root, file).split(path.sep).join("/"));
      if (write) {
        const indent = /^([ \t]+)"/m.exec(source)?.[1] || "  ";
        await writeFile(file, `${JSON.stringify(document, null, indent)}\n`);
      }
    }
  }
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const roots = args.filter((arg) => arg !== "--write");
  if (roots.length !== 1) {
    console.error("Usage: node scripts/migrate-workflow-effects.mjs [--write] <storage-root>");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await migrateWorkflowEffects(roots[0], { write }), null, 2));
  }
}
