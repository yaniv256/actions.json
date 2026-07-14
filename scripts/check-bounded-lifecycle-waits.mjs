#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const calleeName = (node) => {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  return null;
};

const walk = (node, visit) => {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit));
    else if (value && typeof value === "object" && typeof value.type === "string") walk(value, visit);
  }
};

const functionName = (node, source) => {
  if (node.id?.name) return node.id.name;
  return source.slice(node.start, Math.min(node.end, node.start + 80)).split("\n", 1)[0].trim();
};

export function findUnboundedAnimationFrameWaits(sources) {
  const findings = [];
  for (const [file, source] of sources) {
    const ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: true,
    });
    walk(ast, (node) => {
      if (!FUNCTION_TYPES.has(node.type)) return;
      const calls = new Set();
      let createsPromise = false;
      walk(node.body, (child) => {
        if (child.type === "CallExpression") calls.add(calleeName(child.callee));
        if (child.type === "NewExpression" && calleeName(child.callee) === "Promise") createsPromise = true;
      });
      if (!createsPromise || !calls.has("requestAnimationFrame")) return;
      if (calls.has("setTimeout") || calls.has("timeout")) return;
      findings.push({
        file,
        line: node.loc?.start?.line ?? null,
        function: functionName(node, source),
        code: "unbounded_animation_frame_wait",
      });
    });
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    "extensions/chrome-overlay-runtime/src/content.js",
    "extensions/chrome-overlay-runtime/src/background.js",
    "runtime/actions-json-runtime/bookmarklet/storage-bookmarklet.js",
  ];
  const sources = new Map(await Promise.all(files.map(async (file) => [
    file,
    await readFile(path.join(repo, file), "utf8"),
  ])));
  const findings = findUnboundedAnimationFrameWaits(sources);
  if (findings.length) {
    console.error(JSON.stringify({ ok: false, findings }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checked_files: files.length, findings: [] }));
}
