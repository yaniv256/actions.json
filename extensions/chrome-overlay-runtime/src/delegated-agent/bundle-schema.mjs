import {
  DELEGATED_POLICY_LIMITS,
  canonicalizeDelegatedOrigin,
  canonicalizePathPrefix,
  normalizeRepositoryPath,
  validateDelegatedPrimitiveUse,
  validateOutputSchema,
  validatePackageFile,
} from "./delegated-policy.mjs";

export const DELEGATED_BUNDLE_PROTOCOL = "actions.json.website-agent/v1";
export const DELEGATED_APPROVAL_SCHEMA_VERSION = 1;

export const DELEGATED_BUNDLE_MANIFEST_SCHEMA = deepFreeze({
  $id: "https://actions.json/schemas/website-agent-v1.json",
  type: "object",
  required: ["protocol", "agent", "targets", "actions", "skills", "data_sharing"],
  additionalProperties: false,
  properties: {
    protocol: { const: DELEGATED_BUNDLE_PROTOCOL },
    agent: {
      type: "object",
      required: ["id", "name", "source_origins"],
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$" },
        name: { type: "string", minLength: 1 },
        source_origins: { type: "array", minItems: 1, items: { type: "string", format: "uri" } },
      },
    },
    targets: {
      type: "array",
      maxItems: DELEGATED_POLICY_LIMITS.maxTargets,
      items: {
        type: "object",
        required: ["id", "origin", "path_prefixes"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          origin: { type: "string", format: "uri" },
          path_prefixes: { type: "array", minItems: 1, maxItems: DELEGATED_POLICY_LIMITS.maxPathPrefixesPerTarget, items: { type: "string" } },
        },
      },
    },
    actions: {
      type: "array",
      maxItems: DELEGATED_POLICY_LIMITS.maxActions,
      items: {
        type: "object",
        required: ["name", "map", "target_ids", "effect"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          map: { type: "string", minLength: 1 },
          target_ids: { type: "array", minItems: 1, items: { type: "string" } },
          effect: { enum: ["read", "write"] },
          timeout_ms: { type: "integer", minimum: DELEGATED_POLICY_LIMITS.minTimeoutMs, maximum: DELEGATED_POLICY_LIMITS.maxTimeoutMs },
        },
      },
    },
    skills: {
      type: "array",
      maxItems: DELEGATED_POLICY_LIMITS.maxFiles,
      items: {
        type: "object",
        required: ["path", "purpose"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
          purpose: { type: "string", minLength: 1 },
        },
      },
    },
    data_sharing: {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: { summary: { type: "string", minLength: 1 } },
    },
  },
});

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

function problem(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalStableSerialize(value) {
  const ancestors = new Set();
  function serialize(item) {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
      return JSON.stringify(Object.is(item, -0) ? 0 : item);
    }
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new TypeError("Canonical JSON cannot contain cycles.");
      ancestors.add(item);
      const result = `[${item.map((entry) => {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new TypeError("Canonical JSON cannot contain unsupported array values.");
        }
        return serialize(entry);
      }).join(",")}]`;
      ancestors.delete(item);
      return result;
    }
    if (isPlainObject(item)) {
      if (ancestors.has(item)) throw new TypeError("Canonical JSON cannot contain cycles.");
      ancestors.add(item);
      const entries = Object.keys(item).sort().map((key) => {
        const entry = item[key];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new TypeError("Canonical JSON cannot contain unsupported object values.");
        }
        return `${JSON.stringify(key)}:${serialize(entry)}`;
      });
      ancestors.delete(item);
      return `{${entries.join(",")}}`;
    }
    throw new TypeError("Canonical JSON supports only JSON values.");
  }
  return serialize(value);
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestHex(algorithm, bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required for delegated bundle validation.");
  }
  return bytesToHex(await globalThis.crypto.subtle.digest(algorithm, bytes));
}

export async function gitBlobSha(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const prefix = textEncoder.encode(`blob ${data.byteLength}\0`);
  const framed = new Uint8Array(prefix.byteLength + data.byteLength);
  framed.set(prefix);
  framed.set(data, prefix.byteLength);
  return digestHex("SHA-1", framed);
}

export async function sha256Hex(bytes) {
  const data = typeof bytes === "string" ? textEncoder.encode(bytes) : bytes;
  return digestHex("SHA-256", data);
}

function delegatedBundlePayload({ manifest, inventory, files }) {
  return {
    kind: "ValidatedDelegatedBundlePayload",
    schemaVersion: DELEGATED_APPROVAL_SCHEMA_VERSION,
    manifest,
    inventory,
    files,
  };
}

export function serializeValidatedDelegatedBundle(bundle) {
  if (!bundle || bundle.kind !== "ValidatedDelegatedBundle") {
    throw new TypeError("A ValidatedDelegatedBundle is required.");
  }
  return textEncoder.encode(canonicalStableSerialize(delegatedBundlePayload(bundle)));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonFile(file, path, problems) {
  if (!file) return null;
  try {
    return JSON.parse(textDecoder.decode(file.bytes));
  } catch (error) {
    problems.push(problem("package_json_invalid", path, `Package JSON is invalid: ${error.message}`));
    return null;
  }
}

function inferMediaType(filePath) {
  if (filePath.endsWith(".json")) return "application/json";
  if (/\.md$/i.test(filePath)) return "text/markdown";
  return "text/plain";
}

function joinRepositoryPath(basePath, relativePath) {
  const base = basePath.split("/");
  base.pop();
  return normalizeRepositoryPath([...base, relativePath].filter(Boolean).join("/"));
}

export function validateInputSchema(schema, path = "$.input_schema") {
  const problems = [];
  const seen = new Set();
  const commonKeywords = ["type", "title", "description", "default", "enum", "const"];
  const typeKeywords = {
    object: ["properties", "required", "additionalProperties", "minProperties", "maxProperties"],
    array: ["items", "minItems", "maxItems", "uniqueItems"],
    string: ["minLength", "maxLength", "pattern", "format"],
    number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    boolean: [],
    null: [],
  };
  function walk(node, nodePath, depth, root = false) {
    if (!isPlainObject(node)) {
      problems.push(problem(root ? "input_schema_missing" : "input_schema_invalid", nodePath, "Input schema nodes must be objects."));
      return;
    }
    if (seen.has(node)) {
      problems.push(problem("input_schema_cycle", nodePath, "Input schema cannot be cyclic."));
      return;
    }
    seen.add(node);
    if (depth > 8) {
      problems.push(problem("input_schema_too_deep", nodePath, "Input schema exceeds the maximum nesting depth."));
      seen.delete(node);
      return;
    }
    const type = node.type;
    if (!Object.hasOwn(typeKeywords, type) || (root && type !== "object")) {
      problems.push(problem("input_schema_invalid", nodePath, root
        ? "Delegated tool input_schema must have type object."
        : "Input schema must declare one supported JSON type."));
      seen.delete(node);
      return;
    }
    const allowed = new Set([...commonKeywords, ...typeKeywords[type]]);
    for (const keyword of Object.keys(node)) {
      if (!allowed.has(keyword)) {
        problems.push(problem("input_schema_keyword_forbidden", `${nodePath}.${keyword}`, `Input schema keyword ${keyword} is not allowed for type ${type}.`));
      }
    }
    if (type === "object") {
      if (node.additionalProperties !== false) {
        problems.push(problem("input_arbitrary_properties", nodePath, "Input objects must set additionalProperties to false."));
      }
      if (!isPlainObject(node.properties)) {
        problems.push(problem("input_object_properties_missing", `${nodePath}.properties`, "Input objects must declare properties."));
      } else {
        const entries = Object.entries(node.properties);
        if (entries.length > 64) {
          problems.push(problem("input_property_limit", `${nodePath}.properties`, "Input object exceeds the property limit.", { limit: 64, actual: entries.length }));
        }
        for (const [name, child] of entries) walk(child, `${nodePath}.properties.${name}`, depth + 1);
        if (node.required !== undefined) {
          if (!Array.isArray(node.required) || new Set(node.required).size !== node.required.length || node.required.some((name) => !Object.hasOwn(node.properties, name))) {
            problems.push(problem("input_required_invalid", `${nodePath}.required`, "Input required fields must be unique declared property names."));
          }
        }
      }
    } else if (type === "array") {
      if (!Number.isInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > 1_000) {
        problems.push(problem("input_array_unbounded", nodePath, "Input arrays must declare maxItems no greater than 1000."));
      }
      if (!isPlainObject(node.items)) {
        problems.push(problem("input_array_items_missing", `${nodePath}.items`, "Input arrays must declare one item schema."));
      } else {
        walk(node.items, `${nodePath}.items`, depth + 1);
      }
    } else if (type === "string") {
      if (!Array.isArray(node.enum) && (!Number.isInteger(node.maxLength) || node.maxLength < 0 || node.maxLength > DELEGATED_POLICY_LIMITS.maxResultBytes)) {
        problems.push(problem("input_string_unbounded", nodePath, "Input strings must declare a bounded maxLength or enum."));
      }
    } else if (type === "number" || type === "integer") {
      const bounded = Array.isArray(node.enum) || (Number.isFinite(node.minimum) && Number.isFinite(node.maximum));
      if (!bounded) problems.push(problem("input_number_unbounded", nodePath, "Input numbers must declare finite minimum and maximum bounds or enum."));
    }
    seen.delete(node);
  }
  walk(schema, path, 0, true);
  return problems;
}

function reportUnknownProperties(value, allowed, code, path, problems) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push(problem(code, `${path}.${key}`, `Property ${key} is not allowed by the delegated manifest protocol.`));
    }
  }
}

function collectWorkflowProblems(value, path, problems, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectWorkflowProblems(item, `${path}[${index}]`, problems, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === "primitive" || (key === "handler" && typeof child === "string")) {
      problems.push(...validateDelegatedPrimitiveUse(child, childPath));
    }
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
    if (/^(?:script|javascript|policy_exception|policy_exception_report|dynamic_load|load_file|include|includes|import|module)$/.test(normalizedKey)) {
      problems.push(problem("workflow_field_forbidden", childPath, `Workflow field ${key} is forbidden for delegated execution.`));
    }
    collectWorkflowProblems(child, childPath, problems, seen);
  }
}

function validateWritePostcondition(map, actionName, path) {
  const problems = [];
  const projections = Array.isArray(map?.state_projections) ? map.state_projections : [];
  const declarations = projections
    .filter((projection) => isPlainObject(projection?.postconditions) && Object.hasOwn(projection.postconditions, actionName))
    .map((projection) => projection.postconditions[actionName]);
  if (declarations.length === 0) {
    return [problem("write_postcondition_missing", path, "Write actions require an independently readable state postcondition.")];
  }
  if (declarations.length !== 1 || !isPlainObject(declarations[0]) || Object.keys(declarations[0]).length === 0) {
    return [problem("write_postcondition_invalid", path, "Write action postcondition must be one concrete verifier declaration.")];
  }
  const declaration = declarations[0];
  const projection = projections.find((candidate) => candidate?.name === declaration.projection);
  if (!projection) {
    problems.push(problem("write_postcondition_projection_unknown", `${path}.projection`, "Write postcondition must reference a declared state projection."));
  } else if (!isPlainObject(projection.snapshot) || !["dom", "a11y"].includes(projection.snapshot.source)) {
    problems.push(problem("write_postcondition_projection_unreadable", `${path}.projection`, "Write postcondition projection must have an independently readable DOM or accessibility snapshot."));
  }
  let forbiddenPrimitive = false;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value.primitive === "string") forbiddenPrimitive = true;
    Object.values(value).forEach(visit);
  };
  visit(declaration.verify);
  if (forbiddenPrimitive) {
    problems.push(problem("write_postcondition_primitive_forbidden", `${path}.verify`, "Postcondition verifiers cannot execute mutation or runtime primitives."));
  }
  const verify = declaration.verify;
  if (!isPlainObject(verify) || verify.language !== "jsonata" || typeof verify.expression !== "string" || !verify.expression.trim() ||
      Object.keys(verify).some((key) => !["language", "expression"].includes(key))) {
    problems.push(problem("write_postcondition_verifier_invalid", `${path}.verify`, "Postcondition verifier must be a structured JSONata language/expression object."));
  }
  return problems;
}

function validateManifestShape(manifest, sourceOrigin, problems) {
  if (!isPlainObject(manifest)) {
    problems.push(problem("manifest_invalid", "$", "Delegated manifest must be an object."));
    return null;
  }
  const normalized = cloneJson(manifest);
  reportUnknownProperties(
    manifest,
    new Set(["protocol", "agent", "targets", "actions", "skills", "data_sharing"]),
    "manifest_property_unknown",
    "$",
    problems,
  );
  if (manifest.protocol !== DELEGATED_BUNDLE_PROTOCOL) {
    problems.push(problem("manifest_protocol_invalid", "$.protocol", `Manifest protocol must be ${DELEGATED_BUNDLE_PROTOCOL}.`));
  }
  if (!isPlainObject(manifest.agent)) {
    problems.push(problem("agent_invalid", "$.agent", "Manifest agent must be an object."));
  } else {
    reportUnknownProperties(manifest.agent, new Set(["id", "name", "source_origins"]), "agent_property_unknown", "$.agent", problems);
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(String(manifest.agent.id ?? ""))) {
      problems.push(problem("agent_id_invalid", "$.agent.id", "Agent id must be a reverse-DNS-style identifier."));
    }
    if (typeof manifest.agent.name !== "string" || !manifest.agent.name.trim()) {
      problems.push(problem("agent_name_invalid", "$.agent.name", "Agent name must be a non-empty display string."));
    }
    if (!Array.isArray(manifest.agent.source_origins) || manifest.agent.source_origins.length === 0) {
      problems.push(problem("source_origins_missing", "$.agent.source_origins", "Agent must declare at least one source origin."));
    } else {
      const canonicalSources = [];
      manifest.agent.source_origins.forEach((origin, index) => {
        try {
          canonicalSources.push(canonicalizeDelegatedOrigin(origin, { allowLocalhost: true }));
        } catch (error) {
          problems.push(problem("source_origin_invalid", `$.agent.source_origins[${index}]`, error.message));
        }
      });
      let selectedSource = null;
      try {
        selectedSource = canonicalizeDelegatedOrigin(sourceOrigin, { allowLocalhost: true });
      } catch (error) {
        problems.push(problem("selected_source_origin_invalid", "$.source_origin", error.message));
      }
      if (selectedSource && !canonicalSources.includes(selectedSource)) {
        problems.push(problem("source_origin_not_declared", "$.source_origin", "The browser-authenticated source origin is not declared by this agent."));
      }
    }
  }
  if (!Array.isArray(manifest.targets)) {
    problems.push(problem("targets_missing", "$.targets", "Manifest targets must be an array."));
    normalized.targets = [];
  } else if (manifest.targets.length > DELEGATED_POLICY_LIMITS.maxTargets) {
    problems.push(problem("target_limit", "$.targets", "Manifest exceeds the target origin limit.", { limit: DELEGATED_POLICY_LIMITS.maxTargets, actual: manifest.targets.length }));
  }
  const targetIds = new Set();
  for (const [index, target] of (Array.isArray(manifest.targets) ? manifest.targets : []).entries()) {
    const targetPath = `$.targets[${index}]`;
    reportUnknownProperties(target, new Set(["id", "origin", "path_prefixes"]), "target_property_unknown", targetPath, problems);
    if (!isPlainObject(target) || !/^[a-z][a-z0-9_.-]*$/i.test(String(target.id ?? ""))) {
      problems.push(problem("target_id_invalid", `${targetPath}.id`, "Target id must be a stable non-empty identifier."));
    } else if (targetIds.has(target.id)) {
      problems.push(problem("target_id_duplicate", `${targetPath}.id`, "Target ids must be unique."));
    } else {
      targetIds.add(target.id);
    }
    try {
      canonicalizeDelegatedOrigin(target?.origin, { allowLocalhost: true });
    } catch (error) {
      problems.push(problem("target_origin_invalid", `${targetPath}.origin`, error.message));
    }
    if (!Array.isArray(target?.path_prefixes) || target.path_prefixes.length === 0) {
      problems.push(problem("target_paths_missing", `${targetPath}.path_prefixes`, "Target must declare at least one path prefix."));
    } else {
      if (target.path_prefixes.length > DELEGATED_POLICY_LIMITS.maxPathPrefixesPerTarget) {
        problems.push(problem("target_path_limit", `${targetPath}.path_prefixes`, "Target exceeds the path-prefix limit.", { limit: DELEGATED_POLICY_LIMITS.maxPathPrefixesPerTarget, actual: target.path_prefixes.length }));
      }
      target.path_prefixes.forEach((prefix, prefixIndex) => {
        try {
          canonicalizePathPrefix(prefix);
        } catch (error) {
          problems.push(problem("target_path_invalid", `${targetPath}.path_prefixes[${prefixIndex}]`, error.message));
        }
      });
    }
  }
  if (!Array.isArray(manifest.actions)) {
    problems.push(problem("actions_missing", "$.actions", "Manifest actions must be an array."));
    normalized.actions = [];
  } else if (manifest.actions.length > DELEGATED_POLICY_LIMITS.maxActions) {
    problems.push(problem("action_limit", "$.actions", "Manifest exceeds the delegated action limit.", { limit: DELEGATED_POLICY_LIMITS.maxActions, actual: manifest.actions.length }));
  }
  const actionNames = new Set();
  for (const [index, action] of (Array.isArray(manifest.actions) ? manifest.actions : []).entries()) {
    const actionPath = `$.actions[${index}]`;
    reportUnknownProperties(action, new Set(["name", "map", "target_ids", "effect", "timeout_ms"]), "action_property_unknown", actionPath, problems);
    if (!isPlainObject(action) || !/^[a-z][a-z0-9_.-]*$/i.test(String(action.name ?? ""))) {
      problems.push(problem("action_name_invalid", `${actionPath}.name`, "Action name must be a non-empty stable identifier."));
    } else if (actionNames.has(action.name)) {
      problems.push(problem("action_name_duplicate", `${actionPath}.name`, "Action names must be unique."));
      problems.push(problem("action_not_found", actionPath, "A duplicated manifest action cannot resolve to exactly one declared action."));
    } else {
      actionNames.add(action.name);
    }
    try {
      normalizeRepositoryPath(action?.map);
    } catch (error) {
      problems.push(problem("action_map_path_invalid", `${actionPath}.map`, error.message));
    }
    if (!Array.isArray(action?.target_ids) || action.target_ids.length === 0) {
      problems.push(problem("action_targets_missing", `${actionPath}.target_ids`, "Action must reference at least one target id."));
    } else {
      for (const [targetIndex, targetId] of action.target_ids.entries()) {
        if (!targetIds.has(targetId)) {
          problems.push(problem("action_target_unknown", `${actionPath}.target_ids[${targetIndex}]`, `Action references unknown target ${targetId}.`));
        }
      }
    }
    if (action?.effect !== "read" && action?.effect !== "write") {
      problems.push(problem("action_effect_invalid", `${actionPath}.effect`, "Action effect must be read or write."));
    }
    const timeout = action?.timeout_ms ?? DELEGATED_POLICY_LIMITS.defaultTimeoutMs;
    if (!Number.isInteger(timeout) || timeout < DELEGATED_POLICY_LIMITS.minTimeoutMs || timeout > DELEGATED_POLICY_LIMITS.maxTimeoutMs) {
      problems.push(problem("action_timeout_invalid", `${actionPath}.timeout_ms`, "Action timeout is outside the delegated policy range.", {
        minimum: DELEGATED_POLICY_LIMITS.minTimeoutMs,
        maximum: DELEGATED_POLICY_LIMITS.maxTimeoutMs,
        actual: timeout,
      }));
    }
    if (normalized.actions?.[index]) normalized.actions[index].timeout_ms = timeout;
  }
  if (!Array.isArray(manifest.skills)) {
    problems.push(problem("skills_missing", "$.skills", "Manifest skills must be an array."));
    normalized.skills = [];
  } else {
    manifest.skills.forEach((skill, index) => {
      reportUnknownProperties(skill, new Set(["path", "purpose"]), "skill_property_unknown", `$.skills[${index}]`, problems);
      try {
        const skillPath = normalizeRepositoryPath(skill?.path);
        if (!/\.md$/i.test(skillPath)) throw new TypeError("Skill review resources must be Markdown files.");
      } catch (error) {
        problems.push(problem("skill_path_invalid", `$.skills[${index}].path`, error.message));
      }
      if (typeof skill?.purpose !== "string" || !skill.purpose.trim()) {
        problems.push(problem("skill_purpose_invalid", `$.skills[${index}].purpose`, "Skill must declare its review purpose."));
      }
    });
  }
  if (!isPlainObject(manifest.data_sharing) || typeof manifest.data_sharing.summary !== "string" || !manifest.data_sharing.summary.trim()) {
    problems.push(problem("data_sharing_invalid", "$.data_sharing", "Manifest must declare a non-empty data-sharing summary."));
  }
  reportUnknownProperties(manifest.data_sharing, new Set(["summary"]), "data_sharing_property_unknown", "$.data_sharing", problems);
  return normalized;
}

function sortProblems(problems) {
  return problems.sort((left, right) =>
    String(left.path).localeCompare(String(right.path)) || left.code.localeCompare(right.code));
}

function failure(problems) {
  return { ok: false, kind: "invalid_bundle", retryable: false, problems: sortProblems(problems) };
}

export async function validateDelegatedBundleSnapshot(snapshot) {
  const problems = [];
  const proposal = snapshot?.proposal ?? {};
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(proposal.owner ?? ""))) {
    problems.push(problem("github_owner_invalid", "$.proposal.owner", "GitHub owner is invalid."));
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(String(proposal.repo ?? ""))) {
    problems.push(problem("github_repo_invalid", "$.proposal.repo", "GitHub repository is invalid."));
  }
  if (!/^[0-9a-f]{40}$/.test(String(proposal.commitSha ?? ""))) {
    problems.push(problem("github_commit_invalid", "$.proposal.commitSha", "GitHub commit must be a lowercase full 40-character SHA."));
  }
  if (snapshot?.resolvedCommitSha !== proposal.commitSha) {
    problems.push(problem("github_commit_substituted", "$.resolvedCommitSha", "Resolved GitHub commit does not equal the proposed exact commit."));
  }
  if (!/^[0-9a-f]{40}$/.test(String(snapshot?.treeSha ?? ""))) {
    problems.push(problem("github_tree_invalid", "$.treeSha", "Resolved Git tree SHA is invalid."));
  }
  let manifestPath = null;
  try {
    manifestPath = normalizeRepositoryPath(proposal.manifestPath);
  } catch (error) {
    problems.push(problem("manifest_path_invalid", "$.proposal.manifestPath", error.message));
  }

  const rawFiles = Array.isArray(snapshot?.files) ? snapshot.files : [];
  if (rawFiles.length > DELEGATED_POLICY_LIMITS.maxFiles) {
    problems.push(problem("package_file_limit", "$.files", "Package exceeds the declared file limit.", { limit: DELEGATED_POLICY_LIMITS.maxFiles, actual: rawFiles.length }));
  }
  const files = [];
  const filesByPath = new Map();
  const normalizedSeen = new Map();
  let totalBytes = 0;
  for (const [index, candidate] of rawFiles.entries()) {
    const bytes = candidate?.bytes instanceof Uint8Array
      ? candidate.bytes
      : candidate?.bytes instanceof ArrayBuffer
        ? new Uint8Array(candidate.bytes)
        : typeof candidate?.content === "string"
          ? textEncoder.encode(candidate.content)
          : new Uint8Array();
    const file = { ...candidate, bytes, size: Number.isInteger(candidate?.size) ? candidate.size : bytes.byteLength };
    const filePath = `$.files[${index}]`;
    problems.push(...validatePackageFile(file, filePath));
    totalBytes += file.size;
    const normalizedKey = typeof file.path === "string" ? file.path.normalize("NFC") : String(file.path);
    if (normalizedSeen.has(normalizedKey)) {
      problems.push(problem("package_duplicate_path", `${filePath}.path`, "Package contains duplicate paths after canonical normalization.", { first: normalizedSeen.get(normalizedKey) }));
    } else {
      normalizedSeen.set(normalizedKey, file.path);
    }
    let canonicalPath = null;
    try {
      canonicalPath = normalizeRepositoryPath(file.path);
    } catch {
      // validatePackageFile already reports this path defect.
    }
    if (canonicalPath && !filesByPath.has(canonicalPath)) {
      filesByPath.set(canonicalPath, file);
    }
    if (file.size !== bytes.byteLength) {
      problems.push(problem("blob_size_mismatch", filePath, "Git tree size does not match retrieved blob bytes.", { expected: file.size, actual: bytes.byteLength }));
    }
    if (typeof file.blobSha === "string") {
      const actualBlobSha = await gitBlobSha(bytes);
      if (actualBlobSha !== file.blobSha) {
        problems.push(problem("blob_sha_mismatch", filePath, "Retrieved blob bytes do not match the Git tree blob SHA.", { expected: file.blobSha, actual: actualBlobSha }));
      }
    }
    files.push(file);
  }
  if (totalBytes > DELEGATED_POLICY_LIMITS.maxBundleBytes) {
    problems.push(problem("package_bundle_too_large", "$.files", "Package exceeds the decoded bundle byte limit.", { limit: DELEGATED_POLICY_LIMITS.maxBundleBytes, actual: totalBytes }));
  }

  const manifestFile = manifestPath ? filesByPath.get(manifestPath) : null;
  if (manifestPath && !manifestFile) {
    problems.push(problem("manifest_file_missing", "$.proposal.manifestPath", "Manifest file is absent from the resolved Git tree."));
  }
  const manifest = parseJsonFile(manifestFile, "$.manifest", problems);
  const normalizedManifest = manifest ? validateManifestShape(manifest, snapshot?.sourceOrigin, problems) : null;

  const declaredRoles = new Map();
  function declarePath(rawPath, role, path) {
    let canonical;
    try {
      canonical = normalizeRepositoryPath(rawPath);
    } catch (error) {
      problems.push(problem(role === "skill" ? "skill_path_invalid" : "package_reference_invalid", path, error.message));
      return null;
    }
    const existing = declaredRoles.get(canonical);
    if (existing && existing !== role && !(existing === "reference" && role === "skill") && !(existing === "skill" && role === "reference")) {
      problems.push(problem("package_role_conflict", path, `Package path ${canonical} has conflicting roles ${existing} and ${role}.`));
    } else if (!existing || role === "skill") {
      declaredRoles.set(canonical, role);
    }
    return canonical;
  }
  if (manifestPath) declarePath(manifestPath, "manifest", "$.proposal.manifestPath");
  const parsedMaps = new Map();
  if (manifest) {
    for (const [index, action] of (Array.isArray(manifest.actions) ? manifest.actions : []).entries()) {
      const mapPath = declarePath(action?.map, "action-map", `$.actions[${index}].map`);
      if (!mapPath || parsedMaps.has(mapPath)) continue;
      const mapFile = filesByPath.get(mapPath);
      if (!mapFile) {
        problems.push(problem("package_file_missing", `$.actions[${index}].map`, `Declared action map ${mapPath} is absent from the package.`));
        parsedMaps.set(mapPath, null);
      } else {
        parsedMaps.set(mapPath, parseJsonFile(mapFile, `$.maps.${mapPath}`, problems));
      }
    }
    for (const [index, skill] of (Array.isArray(manifest.skills) ? manifest.skills : []).entries()) {
      declarePath(skill?.path, "skill", `$.skills[${index}].path`);
    }
  }

  for (const [mapPath, map] of parsedMaps) {
    if (!map) continue;
    if (map.protocol !== "actions.json" || !Array.isArray(map.tools)) {
      problems.push(problem("action_map_invalid", `$.maps.${mapPath}`, "Action map must use protocol actions.json and declare tools."));
      continue;
    }
    if (mapPath.split("/").includes("proof")) {
      problems.push(problem("package_proof_operational", `$.maps.${mapPath}`, "Proof-package files cannot be used as operational action maps."));
    }
    const declarations = Array.isArray(map?.x_actions?.files) ? map.x_actions.files : [];
    declarations.forEach((declaration, index) => {
      try {
        const declared = joinRepositoryPath(mapPath, declaration?.path);
        const role = declaration?.kind === "skill" ? "skill" : "reference";
        declarePath(declared, role, `$.maps.${mapPath}.x_actions.files[${index}].path`);
      } catch (error) {
        problems.push(problem("package_reference_invalid", `$.maps.${mapPath}.x_actions.files[${index}].path`, error.message));
      }
    });
  }

  const targetsById = new Map((Array.isArray(manifest?.targets) ? manifest.targets : []).map((target) => [target?.id, target]));
  const manifestActionNames = new Set((Array.isArray(manifest?.actions) ? manifest.actions : []).map((action) => action?.name));
  const actionOccurrences = new Map();
  for (const [candidateMapPath, candidateMap] of parsedMaps) {
    for (const candidateTool of (Array.isArray(candidateMap?.tools) ? candidateMap.tools : [])) {
      if (typeof candidateTool?.name !== "string") continue;
      const occurrences = actionOccurrences.get(candidateTool.name) ?? [];
      occurrences.push({ mapPath: candidateMapPath, tool: candidateTool });
      actionOccurrences.set(candidateTool.name, occurrences);
    }
  }
  for (const [index, action] of (Array.isArray(manifest?.actions) ? manifest.actions : []).entries()) {
    let mapPath = null;
    try { mapPath = normalizeRepositoryPath(action?.map); } catch { /* reported above */ }
    const allOccurrences = actionOccurrences.get(action?.name) ?? [];
    if (allOccurrences.length > 1) {
      problems.push(problem("action_name_cross_map_duplicate", `$.actions[${index}].name`, `Action ${String(action?.name)} occurs more than once across declared operational maps.`, {
        maps: allOccurrences.map((occurrence) => occurrence.mapPath).sort(),
      }));
    } else if (allOccurrences.length === 1 && allOccurrences[0].mapPath !== mapPath) {
      problems.push(problem("action_map_membership_mismatch", `$.actions[${index}].map`, `Action ${String(action?.name)} exists only outside its manifest-assigned map.`));
    }
    const map = mapPath ? parsedMaps.get(mapPath) : null;
    if (!map || !Array.isArray(map.tools)) continue;
    const matches = map.tools.filter((tool) => tool?.name === action?.name);
    if (matches.length !== 1) {
      problems.push(problem("action_not_found", `$.actions[${index}]`, `Action ${String(action?.name)} must resolve to exactly one tool in ${mapPath}.`, { matches: matches.length }));
      continue;
    }
    const tool = matches[0];
    const toolPath = `$.maps.${mapPath}.tools.${action.name}`;
    problems.push(...validateInputSchema(tool.input_schema, `${toolPath}.input_schema`));
    if (!isPlainObject(tool.output_schema)) {
      problems.push(problem("output_schema_missing", `${toolPath}.output_schema`, "Delegated tools must declare an output_schema object."));
    } else {
      problems.push(...validateOutputSchema(tool.output_schema, `${toolPath}.output_schema`));
    }
    if (action.effect === "write") {
      problems.push(...validateWritePostcondition(map, action.name, `${toolPath}.postcondition`));
    }
    collectWorkflowProblems(tool.workflow, `${toolPath}.workflow`, problems);
    collectWorkflowProblems(tool.recipe, `${toolPath}.recipe`, problems);
    collectWorkflowProblems(tool.x_actions, `${toolPath}.x_actions`, problems);

    const allowedTargetOrigins = (Array.isArray(action.target_ids) ? action.target_ids : [])
      .map((id) => targetsById.get(id)?.origin)
      .filter(Boolean);
    const mapSite = map.site ?? map?.surface?.origin;
    if (typeof mapSite === "string") {
      let mapOrigin = null;
      try { mapOrigin = canonicalizeDelegatedOrigin(mapSite, { allowLocalhost: true }); } catch (error) {
        problems.push(problem("action_map_site_invalid", `$.maps.${mapPath}.surface.origin`, error.message));
      }
      if (mapOrigin && !allowedTargetOrigins.includes(mapOrigin)) {
        problems.push(problem("action_map_target_mismatch", toolPath, "Action map site binding is outside the action's declared targets."));
      }
    }
    const binding = tool?.x_actions?.binding?.target_url_contains;
    if (typeof binding === "string" && !allowedTargetOrigins.some((origin) => binding === new URL(origin).hostname || binding === origin)) {
      problems.push(problem("action_binding_target_mismatch", `${toolPath}.x_actions.binding.target_url_contains`, "Action binding is outside the action's declared targets."));
    }
  }
  for (const [mapPath, map] of parsedMaps) {
    if (!Array.isArray(map?.tools)) continue;
    for (const tool of map.tools) {
      if (typeof tool?.name === "string" && !manifestActionNames.has(tool.name)) {
        // Neighboring tools remain inaccessible. The code is intentionally the same
        // resolution failure used for a manifest name that cannot be found.
        problems.push(problem("action_not_found", `$.maps.${mapPath}.tools.${tool.name}`, `Map tool ${tool.name} is outside the declared action set.`));
      }
    }
  }

  for (const declaredPath of declaredRoles.keys()) {
    if (!filesByPath.has(declaredPath)) {
      problems.push(problem("package_file_missing", `$.files.${declaredPath}`, `Declared package file ${declaredPath} is absent.`));
    }
  }
  for (const filePath of filesByPath.keys()) {
    if (!declaredRoles.has(filePath)) {
      problems.push(problem("package_undeclared_file", `$.files.${filePath}`, `Package file ${filePath} is not in the explicit transitive closure.`));
    }
  }
  if (problems.length || !normalizedManifest) return failure(problems);

  const inventory = [];
  const storedFiles = [];
  for (const filePath of [...declaredRoles.keys()].sort()) {
    const file = filesByPath.get(filePath);
    const contentSha256 = await sha256Hex(file.bytes);
    let content;
    try {
      content = textDecoder.decode(file.bytes);
    } catch {
      return failure([problem("package_binary", `$.files.${filePath}`, "Binary package content is forbidden.")]);
    }
    inventory.push({
      path: filePath,
      role: declaredRoles.get(filePath),
      blobSha: file.blobSha ?? await gitBlobSha(file.bytes),
      sha256: contentSha256,
      size: file.bytes.byteLength,
      mode: file.mode,
      mediaType: file.mediaType ?? inferMediaType(filePath),
    });
    storedFiles.push({ path: filePath, role: declaredRoles.get(filePath), content });
  }
  const bundleBytes = textEncoder.encode(canonicalStableSerialize(delegatedBundlePayload({
    manifest: normalizedManifest,
    inventory,
    files: storedFiles,
  })));
  const bundleDigest = await sha256Hex(bundleBytes);
  const approvalIdentity = {
    schema_version: DELEGATED_APPROVAL_SCHEMA_VERSION,
    agent_id: normalizedManifest.agent.id,
    source_origin: snapshot.sourceOrigin,
    github_owner: proposal.owner,
    github_repo: proposal.repo,
    full_commit_sha: proposal.commitSha,
    manifest_path: manifestPath,
    canonical_bundle_digest: bundleDigest,
  };
  const approvalId = await sha256Hex(canonicalStableSerialize(approvalIdentity));
  const bundle = deepFreeze({
    kind: "ValidatedDelegatedBundle",
    schemaVersion: DELEGATED_APPROVAL_SCHEMA_VERSION,
    approvalId,
    bundleDigest,
    sourceOrigin: snapshot.sourceOrigin,
    repository: { owner: proposal.owner, repo: proposal.repo },
    commitSha: proposal.commitSha,
    treeSha: snapshot.treeSha,
    manifestPath,
    manifest: normalizedManifest,
    inventory,
    files: storedFiles,
  });
  return { ok: true, bundle, problems: [] };
}
