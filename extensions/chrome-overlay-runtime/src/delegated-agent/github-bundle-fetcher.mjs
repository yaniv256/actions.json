import {
  gitBlobSha,
  validateDelegatedBundleSnapshot,
} from "./bundle-schema.mjs";
import {
  DELEGATED_POLICY_LIMITS,
  normalizeRepositoryPath,
  parseCanonicalGitHubBlobUrl,
  validateGitHubRedirectUrl,
} from "./delegated-policy.mjs";

const successCache = new Map();

class FetchProblem extends Error {
  constructor(problem, { retryable = false } = {}) {
    super(problem.message);
    this.problem = problem;
    this.retryable = retryable;
  }
}

function problem(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function invalid(problems) {
  const unique = new Map();
  for (const item of problems) unique.set(`${item.code}\n${item.path}\n${item.message}`, item);
  const ordered = [...unique.values()].sort((left, right) =>
    String(left.path).localeCompare(String(right.path)) || left.code.localeCompare(right.code));
  return { ok: false, kind: "invalid_bundle", retryable: false, problems: ordered };
}

function retrievalFailure(problemValue) {
  return { ok: false, kind: "retrieval_error", retryable: true, problems: [problemValue] };
}

function responseProblem(response, path) {
  const rateLimited = response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  if (rateLimited) {
    return new FetchProblem(
      problem("github_rate_limited", path, "GitHub rate limited delegated bundle retrieval.", { status: response.status }),
      { retryable: true },
    );
  }
  const retryable = response.status >= 500;
  return new FetchProblem(
    problem(
      retryable ? "github_unavailable" : "github_http_error",
      path,
      `GitHub returned HTTP ${response.status} while retrieving the delegated bundle.`,
      { status: response.status },
    ),
    { retryable },
  );
}

async function fetchWithSafeRedirects(fetchImpl, initialUrl, path) {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        headers: {
          accept: current.startsWith("https://api.github.com/")
            ? "application/vnd.github+json"
            : "application/octet-stream",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (error) {
      throw new FetchProblem(
        problem("github_network_error", path, "GitHub retrieval failed due to a network error.", { cause: String(error?.message ?? error) }),
        { retryable: true },
      );
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    let next;
    try {
      next = new URL(location, current).href;
    } catch {
      throw new FetchProblem(problem("unsafe_redirect", path, "GitHub returned a malformed redirect."));
    }
    if (!validateGitHubRedirectUrl(next)) {
      throw new FetchProblem(problem("unsafe_redirect", path, "GitHub redirect left the exact GitHub host allowlist.", { location: next }));
    }
    current = next;
  }
  throw new FetchProblem(problem("redirect_limit", path, "GitHub retrieval exceeded the redirect limit."));
}

async function fetchJson(fetchImpl, url, path) {
  const response = await fetchWithSafeRedirects(fetchImpl, url, path);
  if (!response.ok) throw responseProblem(response, path);
  try {
    return await response.json();
  } catch {
    throw new FetchProblem(problem("github_response_invalid", path, "GitHub returned invalid JSON."));
  }
}

function rawUrl(proposal, filePath) {
  const path = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.repo)}/${proposal.commitSha}/${path}`;
}

async function readResponseBytesCapped(response, byteCap, path) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new FetchProblem(problem("blob_stream_unavailable", path, "Raw GitHub response cannot be read through a bounded stream."));
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (total + chunk.byteLength > byteCap) {
        await reader.cancel("delegated blob byte cap exceeded");
        throw new FetchProblem(problem("blob_stream_limit_exceeded", path, "Raw GitHub blob exceeded the hard streaming byte cap.", {
          limit: byteCap,
          observedAtLeast: total + chunk.byteLength,
        }));
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchTreeBlob(fetchImpl, proposal, treeEntry, filePath, byteCap) {
  const response = await fetchWithSafeRedirects(fetchImpl, rawUrl(proposal, filePath), `$.files.${filePath}`);
  if (!response.ok) throw responseProblem(response, `$.files.${filePath}`);
  const bytes = await readResponseBytesCapped(response, byteCap, `$.files.${filePath}`);
  return {
    path: filePath,
    mode: treeEntry.mode,
    type: treeEntry.type,
    blobSha: treeEntry.sha,
    size: treeEntry.size,
    mediaType: response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream",
    bytes,
  };
}

function directManifestPaths(manifest) {
  const paths = [];
  for (const action of Array.isArray(manifest?.actions) ? manifest.actions : []) {
    paths.push({ path: action?.map, from: "$.actions.map" });
  }
  for (const skill of Array.isArray(manifest?.skills) ? manifest.skills : []) {
    paths.push({ path: skill?.path, from: "$.skills.path" });
  }
  return paths;
}

function mapDeclaredPaths(mapPath, map) {
  const declarations = Array.isArray(map?.x_actions?.files) ? map.x_actions.files : [];
  const parent = mapPath.split("/");
  parent.pop();
  return declarations.map((declaration) => ({
    path: [...parent, declaration?.path].filter(Boolean).join("/"),
    from: `$.maps.${mapPath}.x_actions.files`,
  }));
}

async function retrieveSnapshot({ proposal, sourceOrigin, fetchImpl }) {
  const repositoryApi = `https://api.github.com/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.repo)}`;
  const commit = await fetchJson(fetchImpl, `${repositoryApi}/git/commits/${proposal.commitSha}`, "$.github.commit");
  if (commit?.sha !== proposal.commitSha) {
    return invalid([problem("github_commit_substituted", "$.github.commit.sha", "GitHub resolved a commit different from the exact proposed commit.", {
      expected: proposal.commitSha,
      actual: commit?.sha,
    })]);
  }
  const treeSha = commit?.tree?.sha;
  if (!/^[0-9a-f]{40}$/.test(String(treeSha ?? ""))) {
    return invalid([problem("github_tree_invalid", "$.github.commit.tree.sha", "GitHub commit did not resolve to a full tree SHA.")]);
  }
  const treeResponse = await fetchJson(fetchImpl, `${repositoryApi}/git/trees/${treeSha}?recursive=1`, "$.github.tree");
  if (treeResponse?.truncated === true) {
    return invalid([problem("github_tree_truncated", "$.github.tree.truncated", "GitHub truncated the recursive tree response; package completeness cannot be proven.")]);
  }
  if (treeResponse?.sha !== treeSha || !Array.isArray(treeResponse?.tree)) {
    return invalid([problem("github_tree_invalid", "$.github.tree", "GitHub returned a substituted or malformed tree response.")]);
  }
  const treeByPath = new Map();
  const duplicateTreePaths = [];
  for (const entry of treeResponse.tree) {
    if (typeof entry?.path !== "string") continue;
    const normalized = entry.path.normalize("NFC");
    if (treeByPath.has(normalized)) {
      duplicateTreePaths.push(problem("package_duplicate_path", `$.github.tree.${entry.path}`, "Git tree contains duplicate paths after canonical normalization."));
    } else {
      treeByPath.set(normalized, entry);
    }
  }
  if (duplicateTreePaths.length) return invalid(duplicateTreePaths);

  const fetched = new Map();
  const closureProblems = [];
  const reservations = new Map();
  let reservedBytes = 0;
  let actualBytes = 0;
  let resourceCeilingExceeded = false;
  function reserveDeclared(rawPath, from) {
    let filePath;
    try {
      filePath = normalizeRepositoryPath(rawPath);
    } catch {
      return null;
    }
    if (reservations.has(filePath)) return reservations.get(filePath);
    const entry = treeByPath.get(filePath.normalize("NFC"));
    const reservation = { filePath, entry, allowed: true, from };
    reservations.set(filePath, reservation);
    if (reservations.size > DELEGATED_POLICY_LIMITS.maxFiles) {
      closureProblems.push(problem("package_file_limit", from, "Declared package closure exceeds the file limit.", {
        limit: DELEGATED_POLICY_LIMITS.maxFiles,
        actual: reservations.size,
      }));
      reservation.allowed = false;
      resourceCeilingExceeded = true;
    }
    if (!entry) {
      closureProblems.push(problem("missing_tree_entry", from, `Declared package file ${filePath} is missing from the exact commit tree.`));
      reservation.allowed = false;
      return reservation;
    }
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      closureProblems.push(problem("tree_size_invalid", from, `Declared package file ${filePath} has a missing or invalid Git tree size.`));
      reservation.allowed = false;
    } else if (entry.size > DELEGATED_POLICY_LIMITS.maxFileBytes) {
      closureProblems.push(problem("package_file_too_large", from, `Declared package file ${filePath} exceeds the per-file byte limit.`, {
        limit: DELEGATED_POLICY_LIMITS.maxFileBytes,
        actual: entry.size,
      }));
      reservation.allowed = false;
    } else if (reservedBytes + entry.size > DELEGATED_POLICY_LIMITS.maxBundleBytes) {
      closureProblems.push(problem("package_bundle_too_large", from, "Declared package closure exceeds the aggregate byte limit.", {
        limit: DELEGATED_POLICY_LIMITS.maxBundleBytes,
        actual: reservedBytes + entry.size,
      }));
      reservation.allowed = false;
      resourceCeilingExceeded = true;
    } else {
      reservedBytes += entry.size;
    }
    if (entry.type === "commit" || entry.mode === "160000") {
      closureProblems.push(problem("package_submodule", from, `Declared package file ${filePath} is a Git submodule, not a regular blob.`));
      reservation.allowed = false;
    } else if (entry.mode === "120000") {
      closureProblems.push(problem("package_symlink", from, `Declared package file ${filePath} is a Git symlink, not a regular blob.`));
      reservation.allowed = false;
    } else if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      closureProblems.push(problem("package_not_regular_blob", from, `Declared package file ${filePath} is not a regular Git blob.`));
      reservation.allowed = false;
    }
    return reservation;
  }
  async function fetchDeclared(rawPath, from) {
    const reservation = reserveDeclared(rawPath, from);
    if (!reservation) return null;
    const { filePath, entry } = reservation;
    if (fetched.has(filePath)) return fetched.get(filePath);
    if (!reservation.allowed) return null;
    let file;
    try {
      file = await fetchTreeBlob(
        fetchImpl,
        proposal,
        entry,
        filePath,
        Math.min(DELEGATED_POLICY_LIMITS.maxFileBytes, DELEGATED_POLICY_LIMITS.maxBundleBytes - actualBytes),
      );
    } catch (error) {
      if (!(error instanceof FetchProblem) || error.retryable) throw error;
      closureProblems.push(error.problem);
      return null;
    }
    actualBytes += file.bytes.byteLength;
    const actualBlobSha = await gitBlobSha(file.bytes);
    if (actualBlobSha !== entry.sha) {
      closureProblems.push(problem("blob_sha_mismatch", `$.files.${filePath}`, "Retrieved blob bytes do not match the Git tree blob SHA.", {
        expected: entry.sha,
        actual: actualBlobSha,
      }));
      file.treeBlobSha = entry.sha;
      file.blobSha = actualBlobSha;
    }
    if (file.bytes.byteLength !== entry.size) {
      closureProblems.push(problem("blob_size_mismatch", `$.files.${filePath}`, "Git tree size does not match retrieved blob bytes.", {
        expected: entry.size,
        actual: file.bytes.byteLength,
      }));
      file.treeSize = entry.size;
      file.size = file.bytes.byteLength;
    }
    fetched.set(filePath, file);
    return file;
  }

  const manifestFile = await fetchDeclared(proposal.manifestPath, "$.proposal.manifestPath");
  if (!manifestFile) return invalid(closureProblems);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes));
  } catch (error) {
    return invalid([...closureProblems, problem("package_json_invalid", "$.manifest", `Delegated manifest is not valid UTF-8 JSON: ${error.message}`)]);
  }
  const directPaths = directManifestPaths(manifest);
  const actionMapPaths = new Set();
  directPaths.forEach((declared) => reserveDeclared(declared.path, declared.from));
  if (!resourceCeilingExceeded) {
    for (const declared of directPaths) {
      let normalized = null;
      try { normalized = normalizeRepositoryPath(declared.path); } catch { /* validator reports malformed declarations */ }
      const file = await fetchDeclared(declared.path, declared.from);
      if (file && normalized && normalized.endsWith("actions.json")) actionMapPaths.add(normalized);
    }
  }
  for (const mapPath of actionMapPaths) {
    const mapFile = fetched.get(mapPath);
    let map;
    try {
      map = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(mapFile.bytes));
    } catch {
      continue;
    }
    const mapPaths = mapDeclaredPaths(mapPath, map);
    mapPaths.forEach((declared) => reserveDeclared(declared.path, declared.from));
    if (!resourceCeilingExceeded) {
      for (const declared of mapPaths) {
        await fetchDeclared(declared.path, declared.from);
      }
    }
  }
  const validation = await validateDelegatedBundleSnapshot({
    proposal,
    sourceOrigin,
    resolvedCommitSha: commit.sha,
    treeSha,
    files: [...fetched.values()],
  });
  if (validation.ok && closureProblems.length === 0) return validation;
  return invalid([...closureProblems, ...(validation.problems ?? [])]);
}

export function clearDelegatedBundleFetchCache() {
  successCache.clear();
}

export async function fetchValidatedDelegatedBundle({
  manifestUrl,
  sourceOrigin,
  fetchImpl = globalThis.fetch,
  cache = fetchImpl === globalThis.fetch ? successCache : null,
} = {}) {
  let proposal;
  try {
    proposal = parseCanonicalGitHubBlobUrl(manifestUrl);
  } catch (error) {
    return invalid([problem("proposal_url_invalid", "$.manifest_url", error.message)]);
  }
  if (typeof fetchImpl !== "function") {
    return retrievalFailure(problem("github_network_error", "$.github", "No Fetch implementation is available for GitHub retrieval."));
  }
  const cacheKey = `${sourceOrigin}\n${proposal.owner}/${proposal.repo}\n${proposal.commitSha}\n${proposal.manifestPath}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  try {
    const result = await retrieveSnapshot({ proposal, sourceOrigin, fetchImpl });
    if (result.ok) cache?.set(cacheKey, result);
    return result;
  } catch (error) {
    if (error instanceof FetchProblem) {
      return error.retryable ? retrievalFailure(error.problem) : invalid([error.problem]);
    }
    return retrievalFailure(problem("github_network_error", "$.github", "GitHub retrieval failed unexpectedly.", { cause: String(error?.message ?? error) }));
  }
}
