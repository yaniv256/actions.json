import { promises as fs } from "node:fs";
import path from "node:path";

export async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

export async function loadActionMap(mapPath) {
  const absolutePath = path.resolve(mapPath);
  const map = await readJsonFile(absolutePath);
  if (map?.protocol !== "actions.json" || !Array.isArray(map.tools)) {
    throw new Error(`Not an actions.json map: ${absolutePath}`);
  }

  const siteFolder = path.dirname(absolutePath);
  return {
    map,
    mapPath: absolutePath,
    siteFolder,
    declaredFiles: declaredFilesForMap(siteFolder, map),
  };
}

export function declaredFilesForMap(siteFolder, map) {
  const declarations = Array.isArray(map?.x_actions?.files) ? map.x_actions.files : [];
  return declarations
    .filter((declaration) => declaration && typeof declaration === "object")
    .map((declaration) => declaredFileFromEntry(siteFolder, declaration));
}

export function resolveDeclaredSiblingPath(siteFolder, relativePath) {
  const input = String(relativePath || "").replace(/\\/g, "/");
  if (!input || input.includes("\0") || path.isAbsolute(input)) {
    throw new Error(`Unsafe declared file path: ${relativePath}`);
  }

  const parts = input.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe declared file path: ${relativePath}`);
  }

  const base = path.resolve(siteFolder);
  const target = path.resolve(base, input);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe declared file path: ${relativePath}`);
  }
  return target;
}

function declaredFileFromEntry(siteFolder, declaration) {
  const relativePath = String(declaration.path || "");
  const filePath = resolveDeclaredSiblingPath(siteFolder, relativePath);
  return {
    id: nonEmptyString(declaration.id),
    path: filePath,
    relativePath,
    kind: nonEmptyString(declaration.kind) || "reference",
    title: nonEmptyString(declaration.title),
    description: nonEmptyString(declaration.description),
    readWhen: nonEmptyString(declaration.read_when),
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value ? value : null;
}
