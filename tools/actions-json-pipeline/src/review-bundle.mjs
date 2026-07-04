import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeReviewBundle(context, options = {}) {
  const proofManifest = await loadProofManifest(options.proofPackagePath, options.draft);
  const bundleName = safeBundleName(options.bundleName || timestampName());
  const bundleDir = path.join(context.siteFolder, "review", bundleName);
  await fs.mkdir(bundleDir, { recursive: true });

  const candidateFiles = [
    fileEntry(context.mapPath, "tested map", "map"),
    ...context.declaredFiles
      .filter((file) => file.exists)
      .map((file) => fileEntry(file.path, `declared ${file.kind}`, file.kind)),
  ];
  const manifest = {
    protocol: "actions.json.review-bundle",
    version: "0.1.0",
    site_folder: context.siteFolder,
    bundle_dir: bundleDir,
    approval_boundary: "review-only; no shared or public storage writes performed",
    draft: options.draft === true,
    redaction: {
      status: options.redactionStatus || "incomplete",
    },
    attribution: {
      status: options.attributionStatus || "incomplete",
    },
    candidate_files: candidateFiles,
    proof: proofManifest
      ? {
          manifest_path: proofManifest.path,
          package_dir: proofManifest.package_dir || path.dirname(proofManifest.path),
          files: Array.isArray(proofManifest.files) ? proofManifest.files : [],
        }
      : null,
    blocked_writes: ["scopes/shared", "scopes/public"],
  };

  const manifestPath = path.join(bundleDir, "review-manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    ok: true,
    bundle_dir: bundleDir,
    manifest_path: manifestPath,
    manifest,
  };
}

async function loadProofManifest(proofPackagePath, draft) {
  if (!proofPackagePath) {
    if (draft) return null;
    throw new Error("promotion-prep requires --proof <proof-package-dir-or-manifest> unless --draft is set.");
  }
  const resolved = path.resolve(proofPackagePath);
  const stats = await fs.stat(resolved);
  const manifestPath = stats.isDirectory() ? path.join(resolved, "manifest.json") : resolved;
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  return {
    ...manifest,
    path: manifestPath,
  };
}

function fileEntry(filePath, purpose, kind) {
  return {
    path: path.resolve(filePath),
    purpose,
    kind,
  };
}

function safeBundleName(input) {
  const name = String(input || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Unsafe review bundle name: ${input}`);
  }
  return name;
}

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
