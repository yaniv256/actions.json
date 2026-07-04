import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeProofPackage(context, options = {}) {
  const packageName = safePackageName(options.packageName || timestampName());
  const proofDir = path.join(context.siteFolder, "proof", packageName);
  await fs.mkdir(proofDir, { recursive: true });

  const manifest = {
    protocol: "actions.json.proof-package",
    version: "0.1.0",
    map_path: context.mapPath,
    site_folder: context.siteFolder,
    package_dir: proofDir,
    files: [],
  };

  await copyIntoPackage(manifest, context.mapPath, proofDir, "actions.json", "tested map");
  await writeJsonIntoPackage(manifest, proofDir, "score-report.json", options.scoreReport || null, "readiness score report");
  await writeJsonIntoPackage(
    manifest,
    proofDir,
    "accepted-gaps.json",
    { accepted_gaps: Array.isArray(options.ledger?.accepted_gaps) ? options.ledger.accepted_gaps : [] },
    "accepted audit gaps ledger",
  );

  if (options.taskListPath) {
    await copyIntoPackage(manifest, options.taskListPath, proofDir, "task-list.json", "validated task list");
  }
  if (options.actionLogPath) {
    await copyIntoPackage(manifest, options.actionLogPath, proofDir, "action-log.json", "action execution log");
  }
  if (options.failuresPath) {
    await copyIntoPackage(manifest, options.failuresPath, proofDir, "failures-fixes.json", "failures and fixes summary");
  }

  const screenshotManifest = options.screenshotsPath
    ? validateScreenshotManifest(JSON.parse(await fs.readFile(path.resolve(options.screenshotsPath), "utf8")))
    : { screenshots: [] };
  await writeJsonIntoPackage(manifest, proofDir, "screenshots.json", screenshotManifest, "important screenshot manifest");

  manifest.files.push({
    path: path.join(proofDir, "manifest.json"),
    relative_path: "manifest.json",
    purpose: "proof package manifest",
    source: "generated",
  });
  await fs.writeFile(path.join(proofDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    ok: true,
    package_dir: proofDir,
    manifest_path: path.join(proofDir, "manifest.json"),
    file_count: manifest.files.length,
    manifest,
  };
}

function validateScreenshotManifest(input) {
  const screenshots = Array.isArray(input?.screenshots) ? input.screenshots : [];
  return {
    screenshots: screenshots.map((screenshot, index) => {
      if (typeof screenshot?.path !== "string" || !screenshot.path) {
        throw new Error(`Screenshot entry ${index} must include path.`);
      }
      if (typeof screenshot?.purpose !== "string" || !screenshot.purpose) {
        throw new Error(`Screenshot entry ${index} must include purpose.`);
      }
      return {
        path: screenshot.path,
        purpose: screenshot.purpose,
        source: typeof screenshot.source === "string" ? screenshot.source : null,
        captured_at: typeof screenshot.captured_at === "string" ? screenshot.captured_at : null,
      };
    }),
  };
}

async function copyIntoPackage(manifest, sourcePath, proofDir, fileName, purpose) {
  const target = path.join(proofDir, fileName);
  await fs.copyFile(path.resolve(sourcePath), target);
  manifest.files.push({
    path: target,
    relative_path: fileName,
    purpose,
    source: path.resolve(sourcePath),
  });
}

async function writeJsonIntoPackage(manifest, proofDir, fileName, value, purpose, options = {}) {
  const target = path.join(proofDir, fileName);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (options.includeInManifest === false) return;
  manifest.files.push({
    path: target,
    relative_path: fileName,
    purpose,
    source: "generated",
  });
}

function safePackageName(input) {
  const name = String(input || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Unsafe proof package name: ${input}`);
  }
  return name;
}

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
