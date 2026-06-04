export const STORAGE_KEY = "actionsJson.storage.v1";
export const BOOKMARKLET_VERSION = "0.1.5";

export function hostCandidatesFromUrl(url) {
  const host = new URL(url).hostname.toLowerCase();
  const candidates = [host];
  if (host.startsWith("www.")) {
    candidates.push(host.slice(4));
  }
  return candidates;
}

export function relevantStorageProbePaths(url) {
  const hosts = hostCandidatesFromUrl(url);
  const sitePaths = hosts.map((host) => ["sites", host]);
  return {
    rootScopeSitePaths: hosts.flatMap((host) => [
      ["scopes", "private", "sites", host],
      ["scopes", "public", "sites", host],
    ]),
    sharedScopesRoot: ["scopes", "shared"],
    selectedScopeSitePaths: sitePaths,
    hosts,
  };
}

export function selectedSiteFolderPrefix(folderName, url, defaultScope = "private") {
  const normalized = String(folderName || "").toLowerCase();
  if (!hostCandidatesFromUrl(url).includes(normalized)) {
    return null;
  }
  if (defaultScope.startsWith("shared:")) {
    return `scopes/shared/${defaultScope.slice("shared:".length)}/sites/${normalized}`;
  }
  return `scopes/${defaultScope}/sites/${normalized}`;
}

export function siteHostMatchesPage(siteHost, pageUrl) {
  const normalizedSite = String(siteHost || "").toLowerCase();
  if (!normalizedSite) {
    return false;
  }
  return hostCandidatesFromUrl(pageUrl).some(
    (host) => host === normalizedSite || host.endsWith(`.${normalizedSite}`),
  );
}

export function parseStoragePath(inputPath, options = {}) {
  const defaultScope = options.defaultScope || "private";
  const parts = String(inputPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);

  const scopesIndex = parts.indexOf("scopes");
  if (scopesIndex >= 0) {
    return parseScopedParts(parts.slice(scopesIndex + 1));
  }

  const repoScope = scopeFromRepoFolder(parts[0]);
  if (repoScope) {
    const sitesIndex = parts.indexOf("sites");
    if (sitesIndex >= 0) {
      return parseSiteParts(repoScope, parts.slice(sitesIndex));
    }
  }

  if (parts[0] === "private" || parts[0] === "public") {
    return parseSiteParts(parts[0], parts.slice(1));
  }

  if (parts[0] === "shared" && parts[1]) {
    return parseSiteParts(`shared:${parts[1]}`, parts.slice(2));
  }

  if (parts[0] === "sites") {
    return parseSiteParts(defaultScope, parts);
  }

  return null;
}

export function buildRelevantStorageBundle(entries, options = {}) {
  const currentUrl = options.currentUrl;
  if (!currentUrl) {
    throw new Error("currentUrl is required");
  }

  const files = {};
  const rejected = [];
  for (const entry of entries) {
    const parsed = parseStoragePath(entry.path, {
      defaultScope: options.defaultScope,
    });
    if (!parsed || !siteHostMatchesPage(parsed.siteHost, currentUrl)) {
      rejected.push(entry.path);
      continue;
    }

    files[parsed.canonicalPath] = {
      text: entry.text,
      scope: parsed.scope,
      siteHost: parsed.siteHost,
      sitePath: parsed.sitePath,
      originalPath: entry.path,
      size: entry.size ?? entry.text.length,
      lastModified: entry.lastModified ?? null,
    };
  }

  return {
    protocol: "actions.json.storage.browser-bundle",
    version: "0.1.0",
    currentUrl,
    pageHost: new URL(currentUrl).hostname,
    fileCount: Object.keys(files).length,
    files,
    rejected,
  };
}

export function saveStorageBundle(storage, bundle, key = STORAGE_KEY) {
  storage.setItem(key, JSON.stringify(bundle));
}

export function loadStorageBundle(storage, key = STORAGE_KEY) {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

export function clearStorageBundle(storage, key = STORAGE_KEY) {
  storage.removeItem(key);
}

export function importStorageSyncBundle(storage, { bundle, currentUrl, defaultScope = "private" } = {}) {
  if (bundle?.protocol !== "actions.json.storage.bundle" || !Array.isArray(bundle.entries)) {
    throw new Error("storage.import_bundle requires an actions.json.storage.bundle");
  }
  const entries = bundle.entries.map((entry) => ({
    path: entry.path,
    text: String(entry.content ?? ""),
    size: entry.bytes ?? String(entry.content ?? "").length,
    lastModified: null,
  }));
  const browserBundle = buildRelevantStorageBundle(entries, {
    currentUrl,
    defaultScope,
  });
  browserBundle.synced_at_ms = bundle.synced_at_ms ?? null;
  browserBundle.imported_at = new Date().toISOString();
  saveStorageBundle(storage, browserBundle);
  return {
    ok: true,
    entry_count: browserBundle.fileCount,
    rejected_count: browserBundle.rejected.length,
    synced_at_ms: browserBundle.synced_at_ms,
  };
}

export function writeTargetsForBundle(bundle) {
  const targets = [];
  for (const [filePath, file] of Object.entries(bundle?.files || {})) {
    assertSafeCanonicalPath(filePath);
    targets.push({
      path: filePath,
      parts: filePath.split("/"),
      text: String(file.text ?? ""),
    });
  }
  return targets;
}

export function formatStorageDiagnostics({
  version = BOOKMARKLET_VERSION,
  storageKey = STORAGE_KEY,
  currentUrl,
  selectedFolderName,
  folderRead = null,
  bundle = null,
  message = null,
} = {}) {
  if (!currentUrl) {
    throw new Error("currentUrl is required");
  }

  const url = new URL(currentUrl);
  const probe = relevantStorageProbePaths(currentUrl);
  const lines = [
    `Bookmarklet version: ${version}`,
    `Storage key: ${storageKey}`,
    `Current host: ${url.hostname}`,
    `Host candidates: ${probe.hosts.join(", ")}`,
  ];

  if (selectedFolderName) {
    lines.push(`Selected folder: ${selectedFolderName}`);
  }
  if (message) {
    lines.push("", message);
  }
  if (folderRead) {
    lines.push("", `Folder read mode: ${folderRead.mode || "root"}`);
    if (folderRead.selectedSitePrefix) {
      lines.push(`Selected-site prefix: ${folderRead.selectedSitePrefix}`);
    }
    lines.push(`Entries read: ${folderRead.entriesRead ?? 0}`);
    lines.push("Probe log:");
    for (const item of folderRead.probes || []) {
      const count =
        item.fileCount === undefined || item.fileCount === null ? "" : ` (${item.fileCount} file(s))`;
      lines.push(`  ${formatProbeStatus(item.status)} ${item.path}${count}`);
    }
    for (const error of folderRead.errors || []) {
      lines.push(`  ERROR ${error.path}: ${error.message}`);
    }
  }

  if (!bundle) {
    lines.push("", "No bundle stored for this browser origin.");
  } else {
    lines.push(
      "",
      `Stored bundle: ${bundle.fileCount} file(s)`,
      `Page host: ${bundle.pageHost}`,
      `Rejected: ${(bundle.rejected || []).length}`,
      "",
      ...Object.keys(bundle.files || {}).sort(),
    );
  }

  return lines.join("\n");
}

function formatProbeStatus(status) {
  if (status === "found") {
    return "FOUND ";
  }
  if (status === "error") {
    return "ERROR ";
  }
  return "missing";
}

function parseScopedParts(parts) {
  const scope = parts[0];
  if (scope === "private" || scope === "public") {
    return parseSiteParts(scope, parts.slice(1));
  }
  if (scope === "shared" && parts[1]) {
    return parseSiteParts(`shared:${parts[1]}`, parts.slice(2));
  }
  return null;
}

function parseSiteParts(scope, parts) {
  if (parts[0] !== "sites" || !parts[1] || parts.length < 3) {
    return null;
  }
  const siteHost = parts[1].toLowerCase();
  const sitePath = parts.slice(2).join("/");
  return {
    scope,
    siteHost,
    sitePath,
    canonicalPath: canonicalPathFor(scope, siteHost, sitePath),
  };
}

function canonicalPathFor(scope, siteHost, sitePath) {
  if (scope.startsWith("shared:")) {
    return `scopes/shared/${scope.slice("shared:".length)}/sites/${siteHost}/${sitePath}`;
  }
  return `scopes/${scope}/sites/${siteHost}/${sitePath}`;
}

function scopeFromRepoFolder(folder) {
  if (!folder) {
    return null;
  }
  if (folder === "actions.json.storage.private") {
    return "private";
  }
  if (folder === "actions.json.storage.public") {
    return "public";
  }
  const sharedPrefix = "actions.json.storage.shared.";
  if (folder.startsWith(sharedPrefix)) {
    return `shared:${folder.slice(sharedPrefix.length)}`;
  }
  return null;
}

function assertSafeCanonicalPath(filePath) {
  const parts = String(filePath || "").split("/");
  if (parts.length < 5 || parts[0] !== "scopes") {
    throw new Error(`Unsafe storage path: ${filePath}`);
  }
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe storage path: ${filePath}`);
  }
}
