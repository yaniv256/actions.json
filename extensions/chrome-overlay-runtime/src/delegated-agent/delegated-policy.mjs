const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const DELEGATED_POLICY_LIMITS = Object.freeze({
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxBundleBytes: 2 * 1024 * 1024,
  maxActions: 128,
  maxTargets: 32,
  maxPathPrefixesPerTarget: 64,
  maxResultBytes: 64 * 1024,
  maxStoredBundlesBytes: 32 * 1024 * 1024,
  defaultTimeoutMs: 60_000,
  minTimeoutMs: 5_000,
  maxTimeoutMs: 180_000,
});

export const DELEGATED_PRIMITIVE_ALLOWLIST = Object.freeze([
  "a11y.query",
  "a11y.tree",
  "cursor.move_to",
  "dom.focus",
  "dom.list_sections",
  "dom.observe.attributes",
  "dom.observe.visible",
  "dom.snapshot_text",
  "keyboard.press",
  "keyboard.press_gated",
  "locator.element_info",
  "locator.text_content",
  "locator.value",
  "locator.wait_for",
  "marker.query",
  "pointer.click",
  "pointer.double_click",
  "pointer.drag",
  "pointer.hover",
  "pointer.move",
  "pointer.move_to",
  "page.info",
  "text.insert",
  "text.select",
  "text.type",
  "viewport.scroll",
]);
const delegatedPrimitiveAllowlist = new Set(DELEGATED_PRIMITIVE_ALLOWLIST);

const FORBIDDEN_REDIRECT_HOSTS = new Set();
export const GITHUB_FETCH_HOSTS = Object.freeze([
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
] );
const githubFetchHosts = new Set(GITHUB_FETCH_HOSTS);

const FORBIDDEN_FILE_EXTENSIONS = /\.(?:7z|a|apk|app|bin|bz2|class|com|cpl|css|dmg|dll|dylib|ear|elf|exe|gz|htm|html|img|iso|jar|js|jsx|mjs|cjs|msi|o|pdf|php|pyc|rar|scr|so|svg|tar|tgz|ts|tsx|war|wasm|webp|xz|zip)$/i;
const SENSITIVE_OUTPUT_TOKENS = new Set([
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "header",
  "headers",
  "html",
  "image",
  "images",
  "media",
  "password",
  "screenshot",
  "screenshots",
  "secret",
  "storage",
  "token",
]);
const FORBIDDEN_PRIMITIVE = /(?:^|\.)(?:bridge|debug)(?:\.|$)|run_javascript|javascript|open_tab|policy_exception|dynamic(?:\.|_)?load|eval/i;
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;
const ENCODED_SLASH_BACKSLASH_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|2f|5c|7f)/i;

function problem(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function rejectNestedPathEncoding(rawSegment) {
  let segment = rawSegment;
  for (let depth = 0; depth < 32; depth += 1) {
    if (ENCODED_SLASH_BACKSLASH_CONTROL.test(segment)) {
      throw new TypeError("Path contains an encoded slash, backslash, or control character.");
    }
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError("Path contains malformed percent encoding.");
    }
    if (decoded === segment) {
      if (segment === "." || segment === "..") {
        throw new TypeError("Path traversal is not allowed.");
      }
      if (segment.normalize("NFC") !== segment) {
        throw new TypeError("Path must use canonical Unicode normalization.");
      }
      return segment;
    }
    if (CONTROL_OR_BACKSLASH.test(decoded) || decoded.includes("/")) {
      throw new TypeError("Path contains an encoded slash, backslash, or control character.");
    }
    segment = decoded;
  }
  throw new TypeError("Path contains excessively nested percent encoding.");
}

export function normalizeRepositoryPath(value) {
  const raw = assertString(value, "Repository path");
  if (raw.startsWith("/") || raw.endsWith("/") || raw.includes("//") || CONTROL_OR_BACKSLASH.test(raw)) {
    throw new TypeError("Repository path must be canonical and repository-relative.");
  }
  const normalized = raw.split("/").map(rejectNestedPathEncoding).join("/");
  if (!normalized || normalized !== normalized.normalize("NFC")) {
    throw new TypeError("Repository path must use canonical Unicode normalization.");
  }
  return normalized;
}

export function parseCanonicalGitHubBlobUrl(value) {
  const raw = assertString(value, "GitHub manifest URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("GitHub manifest URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin + url.pathname !== raw
  ) {
    throw new TypeError("GitHub manifest URL must be a canonical public github.com URL.");
  }
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\/(.+)$/.exec(url.pathname);
  if (!match) {
    throw new TypeError("GitHub manifest URL must use blob/<lowercase-full-commit>/<path>.");
  }
  const [, owner, repo, commitSha, rawPath] = match;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new TypeError("GitHub owner or repository name is invalid.");
  }
  const manifestPath = normalizeRepositoryPath(rawPath);
  return { owner, repo, commitSha, manifestPath };
}

function isIpAddress(hostname) {
  if (hostname.startsWith("[") || hostname.endsWith("]")) return true;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

export function canonicalizeDelegatedOrigin(value, { allowLocalhost = false } = {}) {
  const raw = assertString(value, "Delegated origin");
  if (/[^\x00-\x7f]/.test(raw) || /:\/\/xn--/i.test(raw)) {
    throw new TypeError("Delegated origin cannot use ambiguous Unicode host normalization.");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("Delegated origin is invalid.");
  }
  const localhost = url.hostname === "localhost";
  if (url.protocol !== "https:" && !(allowLocalhost && localhost && url.protocol === "http:")) {
    throw new TypeError("Delegated origin must use HTTPS.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.hostname.includes("*") ||
    url.hostname.includes("/") ||
    isIpAddress(url.hostname) ||
    raw.includes("[") ||
    raw.includes("]")
  ) {
    throw new TypeError("Delegated origin contains a forbidden host, credential, path, query, or fragment.");
  }
  if (url.origin !== raw) {
    throw new TypeError("Delegated origin must be canonical.");
  }
  return url.origin;
}

export function canonicalizePathPrefix(value) {
  const raw = assertString(value, "Path prefix");
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || CONTROL_OR_BACKSLASH.test(raw)) {
    throw new TypeError("Path prefix must be a canonical URL path without query or fragment.");
  }
  if (raw !== "/" && (raw.endsWith("/") || raw.includes("//"))) {
    throw new TypeError("Path prefix must not contain empty path segments.");
  }
  const segments = raw.slice(1).split("/");
  const normalized = segments.map(rejectNestedPathEncoding).join("/");
  return `/${normalized}`;
}

export function isUrlInDelegatedScope(value, target) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  let targetOrigin;
  try {
    targetOrigin = canonicalizeDelegatedOrigin(target?.origin);
  } catch {
    return false;
  }
  if (url.origin !== targetOrigin) return false;
  let candidatePath;
  try {
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    candidatePath = canonicalizePathPrefix(pathname);
  } catch {
    return false;
  }
  const prefixes = target?.path_prefixes ?? target?.pathPrefixes;
  if (!Array.isArray(prefixes)) return false;
  return prefixes.some((prefix) => {
    let canonical;
    try {
      canonical = canonicalizePathPrefix(prefix);
    } catch {
      return false;
    }
    return canonical === "/" || candidatePath === canonical || candidatePath.startsWith(`${canonical}/`);
  });
}

export function validateOutputSchema(schema, path = "$.output_schema") {
  const problems = [];
  const seen = new Set();
  function walk(node, nodePath, depth) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      problems.push(problem("output_schema_invalid", nodePath, "Output schema nodes must be objects."));
      return;
    }
    if (seen.has(node)) {
      problems.push(problem("output_schema_cycle", nodePath, "Output schema cannot be cyclic."));
      return;
    }
    seen.add(node);
    if (depth > 12) {
      problems.push(problem("output_schema_too_deep", nodePath, "Output schema exceeds the maximum nesting depth."));
      seen.delete(node);
      return;
    }
    const type = node.type;
    if (!new Set(["object", "array", "string", "number", "integer", "boolean", "null"]).has(type)) {
      problems.push(problem("output_schema_type_missing", nodePath, "Output schema must declare one supported JSON type."));
      seen.delete(node);
      return;
    }
    const commonKeywords = ["type", "title", "description", "enum", "const"];
    const typeKeywords = {
      object: ["properties", "required", "additionalProperties", "minProperties", "maxProperties"],
      array: ["items", "minItems", "maxItems", "uniqueItems"],
      string: ["minLength", "maxLength", "pattern", "format"],
      number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
      integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
      boolean: [],
      null: [],
    };
    const allowedKeywords = new Set([...commonKeywords, ...(typeKeywords[type] ?? [])]);
    for (const keyword of Object.keys(node)) {
      if (!allowedKeywords.has(keyword)) {
        problems.push(problem("output_schema_keyword_forbidden", `${nodePath}.${keyword}`, `Output schema keyword ${keyword} is not allowed for type ${type}.`));
      }
    }
    if (type === "object") {
      if (node.additionalProperties !== false) {
        problems.push(problem("output_arbitrary_properties", nodePath, "Output objects must set additionalProperties to false."));
      }
      if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) {
        problems.push(problem("output_object_properties_missing", `${nodePath}.properties`, "Output objects must declare properties."));
      } else {
        for (const [name, child] of Object.entries(node.properties)) {
          const normalizedName = name
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .replace(/[^A-Za-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .toLowerCase();
          const tokens = normalizedName.split("_").filter(Boolean);
          if (tokens.some((token) => SENSITIVE_OUTPUT_TOKENS.has(token)) ||
              (tokens.includes("access") && tokens.includes("token")) ||
              (tokens.includes("runtime") && tokens.includes("id")) ||
              (tokens.includes("extension") && tokens.includes("id")) ||
              (tokens.includes("internal") && tokens.includes("id")) ||
              (tokens.includes("tab") && tokens.includes("id")) ||
              (tokens.includes("browser") && tokens.includes("id")) ||
              (tokens.includes("session") && tokens.includes("id")) ||
              (tokens.includes("policy") && tokens.includes("report"))) {
            problems.push(problem("output_sensitive_field", `${nodePath}.properties.${name}`, `Sensitive output field ${name} is forbidden.`));
          }
          walk(child, `${nodePath}.properties.${name}`, depth + 1);
        }
      }
    } else if (type === "array") {
      if (!Number.isInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > 10_000) {
        problems.push(problem("output_array_unbounded", nodePath, "Output arrays must declare a bounded maxItems."));
      }
      if (!node.items || typeof node.items !== "object" || Array.isArray(node.items)) {
        problems.push(problem("output_array_items_missing", `${nodePath}.items`, "Output arrays must declare one item schema."));
      } else {
        walk(node.items, `${nodePath}.items`, depth + 1);
      }
    } else if (type === "string") {
      if (!Array.isArray(node.enum) && (!Number.isInteger(node.maxLength) || node.maxLength < 0 || node.maxLength > DELEGATED_POLICY_LIMITS.maxResultBytes)) {
        problems.push(problem("output_string_unbounded", nodePath, "Output strings must declare a bounded maxLength or enum."));
      }
    } else if (type === "number" || type === "integer") {
      const bounded = Array.isArray(node.enum) || (Number.isFinite(node.minimum) && Number.isFinite(node.maximum));
      if (!bounded) {
        problems.push(problem("output_number_unbounded", nodePath, "Output numbers must declare finite minimum and maximum bounds or enum."));
      }
    }
    seen.delete(node);
  }
  walk(schema, path, 0);
  return problems;
}

function bytesForFile(file) {
  if (file?.bytes instanceof Uint8Array) return file.bytes;
  if (file?.bytes instanceof ArrayBuffer) return new Uint8Array(file.bytes);
  if (typeof file?.content === "string") return textEncoder.encode(file.content);
  return new Uint8Array();
}

export function validatePackageFile(file, path = `$.files.${String(file?.path ?? "")}`) {
  const problems = [];
  const bytes = bytesForFile(file);
  const size = Number.isInteger(file?.size) ? file.size : bytes.byteLength;
  let canonicalPath = null;
  try {
    canonicalPath = normalizeRepositoryPath(file?.path);
  } catch (error) {
    problems.push(problem("package_path_invalid", `${path}.path`, error.message));
  }
  if (file?.type === "commit" || file?.mode === "160000") {
    problems.push(problem("package_submodule", path, "Git submodules are forbidden in delegated packages."));
  } else if (file?.mode === "120000") {
    problems.push(problem("package_symlink", path, "Git symlinks are forbidden in delegated packages."));
  } else if (file?.type !== "blob" || (file?.mode !== "100644" && file?.mode !== "100755")) {
    problems.push(problem("package_not_regular_blob", path, "Delegated package entries must be regular Git blobs."));
  }
  if (file?.mode === "100755") {
    problems.push(problem("package_executable", path, "Executable Git blobs are forbidden in delegated packages."));
  }
  if (size > DELEGATED_POLICY_LIMITS.maxFileBytes) {
    problems.push(problem("package_file_too_large", path, "Package file exceeds the per-file byte limit.", { limit: DELEGATED_POLICY_LIMITS.maxFileBytes, actual: size }));
  }
  if (canonicalPath && FORBIDDEN_FILE_EXTENSIONS.test(canonicalPath)) {
    problems.push(problem("package_forbidden_extension", path, "Executable, archive, binary, HTML, JavaScript, and WASM file types are forbidden."));
  }
  if (/^(?:application\/wasm|text\/html|text\/javascript|application\/javascript)/i.test(String(file?.mediaType ?? ""))) {
    problems.push(problem("package_forbidden_media_type", path, "The package file media type is executable or active content."));
  }
  const signature = Array.from(bytes.slice(0, 8));
  const binaryMagic =
    (signature[0] === 0x7f && signature[1] === 0x45 && signature[2] === 0x4c && signature[3] === 0x46) ||
    (signature[0] === 0x4d && signature[1] === 0x5a) ||
    (signature[0] === 0x50 && signature[1] === 0x4b) ||
    (signature[0] === 0x00 && signature[1] === 0x61 && signature[2] === 0x73 && signature[3] === 0x6d);
  let text = null;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    // Reported as binary below.
  }
  if (binaryMagic || text === null || bytes.includes(0)) {
    problems.push(problem("package_binary", path, "Binary package content is forbidden."));
  } else {
    if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      problems.push(problem("package_lfs_pointer", path, "Git LFS pointer indirection is forbidden."));
    }
    if (text.startsWith("#!")) {
      problems.push(problem("package_hidden_executable", path, "Hidden executable payloads are forbidden."));
    }
    if (/<\s*\/?\s*[a-z][^>]*>|\burl\s*\(|javascript\s*:/i.test(text)) {
      problems.push(problem("package_hidden_executable", path, "Active HTML or script payloads are forbidden in delegated package text."));
    }
  }
  return problems;
}

export function validateDelegatedPrimitiveUse(primitive, path = "$.primitive") {
  if (typeof primitive !== "string" || !primitive) {
    return [problem("primitive_invalid", path, "Workflow primitive must be a non-empty string.")];
  }
  if (FORBIDDEN_PRIMITIVE.test(primitive)) {
    return [problem("primitive_forbidden", path, `Primitive ${primitive} is forbidden for delegated execution.`)];
  }
  if (!delegatedPrimitiveAllowlist.has(primitive)) {
    return [problem("primitive_not_allowlisted", path, `Primitive ${primitive} is not in the delegated allowlist.`)];
  }
  return [];
}

export function validateGitHubRedirectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.port && githubFetchHosts.has(url.hostname) && !FORBIDDEN_REDIRECT_HOSTS.has(url.hostname);
}
