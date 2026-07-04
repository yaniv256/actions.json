import { promises as fs } from "node:fs";
import path from "node:path";

import { loadActionMap } from "./map-loader.mjs";

export async function loadPipelineTarget(inputPath) {
  if (!inputPath) {
    throw new Error("A map path or site folder path is required.");
  }

  const absolutePath = path.resolve(inputPath);
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats) {
    throw new Error(`Path does not exist: ${absolutePath}`);
  }

  if (stats.isFile()) {
    return withFilePresence(await loadActionMap(absolutePath));
  }
  if (stats.isDirectory()) {
    const mapPath = await findPrimaryMap(absolutePath);
    return withFilePresence(await loadActionMap(mapPath));
  }

  throw new Error(`Unsupported path type: ${absolutePath}`);
}

export async function findPrimaryMap(siteFolder) {
  const direct = path.join(path.resolve(siteFolder), "actions.json");
  if (await exists(direct)) {
    return direct;
  }

  const matches = [];
  await collectActionMaps(path.resolve(siteFolder), matches);
  if (matches.length === 0) {
    throw new Error(`No actions.json map found under ${path.resolve(siteFolder)}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple actions.json maps found under ${path.resolve(siteFolder)}; pass a direct map path.`);
  }
  return matches[0];
}

async function withFilePresence(context) {
  const declaredFiles = await Promise.all(
    context.declaredFiles.map(async (file) => ({
      ...file,
      exists: await exists(file.path),
    })),
  );
  return {
    ...context,
    declaredFiles,
  };
}

async function collectActionMaps(folder, matches) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      await collectActionMaps(entryPath, matches);
    } else if (entry.isFile() && entry.name === "actions.json") {
      matches.push(entryPath);
    }
  }
}

async function exists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}
