import { parseStoragePath, siteHostMatchesPage } from "../storage-bundle.mjs";

export const EXTENSION_STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";

function safeInputSchema(tool) {
  return tool?.input_schema && typeof tool.input_schema === "object"
    ? tool.input_schema
    : { type: "object", additionalProperties: false };
}

function storageBundleEntries(bundle) {
  if (Array.isArray(bundle?.entries)) {
    return bundle.entries
      .filter((entry) => typeof entry?.path === "string")
      .map((entry) => ({
        path: entry.path,
        text: String(entry.content ?? entry.text ?? ""),
      }));
  }
  if (bundle?.files && typeof bundle.files === "object") {
    return Object.entries(bundle.files).map(([path, file]) => ({
      path,
      text: String(file?.text ?? ""),
    }));
  }
  return [];
}

function entrySizeBytes(entry) {
  return new TextEncoder().encode(String(entry?.text ?? "")).length;
}

function parseFrontMatter(text) {
  const source = String(text || "");
  if (!source.startsWith("---\n")) return {};
  const end = source.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = source.slice(4, end).trim();
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return fields;
}

function canonicalSiblingPath(mapPath, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    return null;
  }
  if (normalized.startsWith("scopes/")) return normalized;
  const parts = String(mapPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return [...parts, normalized].join("/");
}

function declaredFilesForMap(mapPath, map) {
  const declarations = Array.isArray(map?.x_actions?.files) ? map.x_actions.files : [];
  return declarations
    .filter((declaration) => declaration && typeof declaration === "object")
    .map((declaration) => {
      const relativePath = String(declaration.path || "").replace(/\\/g, "/");
      const path = canonicalSiblingPath(mapPath, relativePath);
      if (!path) return null;
      return {
        id: typeof declaration.id === "string" && declaration.id ? declaration.id : null,
        path,
        relative_path: relativePath,
        kind: typeof declaration.kind === "string" && declaration.kind ? declaration.kind : "reference",
        title: typeof declaration.title === "string" && declaration.title ? declaration.title : null,
        description: typeof declaration.description === "string" && declaration.description ? declaration.description : null,
        read_when: typeof declaration.read_when === "string" && declaration.read_when ? declaration.read_when : null,
      };
    })
    .filter(Boolean);
}

function isSkillFile(file) {
  return file.kind === "skill" || /(^|\/)SKILL\.md$/i.test(file.path);
}

function isOperationalSiteMap(parsed) {
  const parts = String(parsed?.sitePath || "").split("/").filter(Boolean);
  return parts.at(-1) === "actions.json" && !parts.includes("proof");
}

export function loadSiteActionMapsFromBundle(bundle, pageUrl) {
  const maps = [];
  for (const entry of storageBundleEntries(bundle)) {
    const parsed = parseStoragePath(entry.path);
    if (!parsed || !isOperationalSiteMap(parsed) || !siteHostMatchesPage(parsed.siteHost, pageUrl)) {
      continue;
    }
    try {
      const map = JSON.parse(entry.text);
      if (map?.protocol === "actions.json" && Array.isArray(map.tools)) {
        maps.push({ path: entry.path, parsed, map });
      }
    } catch {
      // Invalid maps are ignored here; storage import remains the validation surface.
    }
  }
  return maps;
}

export function listSiteActionsFromBundle(bundle, pageUrl, targetUrlContains = pageUrl) {
  const actions = [];
  for (const { map } of loadSiteActionMapsFromBundle(bundle, pageUrl)) {
    for (const tool of map.tools) {
      const name = tool?.name;
      if (typeof name !== "string" || !name) {
        continue;
      }
      const bindingTarget = tool.x_actions?.binding?.target_url_contains;
      if (
        typeof bindingTarget === "string" &&
        targetUrlContains &&
        !String(targetUrlContains).includes(bindingTarget) &&
        !bindingTarget.includes(String(targetUrlContains))
      ) {
        continue;
      }
      actions.push({
        name,
        description: tool.description || null,
        input_schema: safeInputSchema(tool),
        target_url_contains: bindingTarget || null,
      });
    }
  }
  return actions;
}

export function listSiteStorageFilesFromBundle(bundle, pageUrl) {
  const entries = storageBundleEntries(bundle);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const files = [];
  const skills = [];
  for (const { path: mapPath, map } of loadSiteActionMapsFromBundle(bundle, pageUrl)) {
    for (const file of declaredFilesForMap(mapPath, map)) {
      const entry = byPath.get(file.path);
      if (!entry) continue;
      const item = {
        ...file,
        size_bytes: entrySizeBytes(entry),
      };
      files.push(item);
      if (isSkillFile(item)) {
        skills.push({
          id: item.id,
          path: item.path,
          relative_path: item.relative_path,
          kind: "skill",
          description: item.description,
          read_when: item.read_when,
          front_matter: parseFrontMatter(entry.text),
        });
      }
    }
  }
  return { files, skills };
}

export function readSiteStorageFileFromBundle(bundle, pageUrl, { id, path, max_bytes: maxBytes } = {}) {
  if ((id && path) || (!id && !path)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "storage.read_file requires exactly one of id or path.",
      },
    };
  }
  const catalog = listSiteStorageFilesFromBundle(bundle, pageUrl);
  const declared = id
    ? catalog.files.filter((file) => file.id === id)
    : catalog.files.filter((file) => file.path === path);
  if (declared.length > 1) {
    return {
      ok: false,
      error: {
        code: "storage_file_ambiguous_id",
        message: "Multiple storage files matched the requested id.",
      },
    };
  }
  if (declared.length === 0) {
    return {
      ok: false,
      error: {
        code: "storage_file_not_found",
        message: "No declared storage file matched the request.",
      },
    };
  }
  const file = declared[0];
  const entry = storageBundleEntries(bundle).find((candidate) => candidate.path === file.path);
  if (!entry) {
    return {
      ok: false,
      error: {
        code: "storage_file_not_found",
        message: "The declared storage file is not present in the loaded bundle.",
      },
    };
  }
  const bytes = entrySizeBytes(entry);
  const limit = Number.isInteger(maxBytes) ? Math.max(1, maxBytes) : 64_000;
  const encoded = new TextEncoder().encode(entry.text);
  const truncated = encoded.length > limit;
  const text = truncated ? new TextDecoder().decode(encoded.slice(0, limit)) : entry.text;
  return {
    ok: true,
    value: {
      path: file.path,
      relative_path: file.relative_path,
      id: file.id,
      kind: file.kind,
      mime_type: file.path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain",
      bytes,
      truncated,
      front_matter: parseFrontMatter(entry.text),
      text,
    },
  };
}

function primitivePolicy(map) {
  return map?.requires?.primitive_dictionary && typeof map.requires.primitive_dictionary === "object"
    ? map.requires.primitive_dictionary
    : {};
}

export function siteBlockedPrimitiveNamesFromBundle(bundle, pageUrl) {
  const blocked = new Set();
  for (const { map } of loadSiteActionMapsFromBundle(bundle, pageUrl)) {
    const blockedPrimitives = primitivePolicy(map).blocked_primitives;
    if (!Array.isArray(blockedPrimitives)) {
      continue;
    }
    for (const primitiveName of blockedPrimitives) {
      if (typeof primitiveName === "string" && primitiveName) {
        blocked.add(primitiveName);
      }
    }
  }
  return Array.from(blocked);
}

function mergeObjectValues(base, overlay) {
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    base = {};
  }
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    overlay = {};
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = merged[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      merged[key] = mergeObjectValues(baseValue, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function findSiteActionEntry(bundle, pageUrl, actionName) {
  for (const { map } of loadSiteActionMapsFromBundle(bundle, pageUrl)) {
    const tool = map.tools.find((candidate) => candidate?.name === actionName);
    if (tool) {
      return { map, tool };
    }
  }
  return null;
}

function findStatePostcondition(map, actionName) {
  const projections = Array.isArray(map?.state_projections) ? map.state_projections : [];
  for (const projection of projections) {
    const postcondition = projection?.postconditions?.[actionName];
    if (postcondition && typeof postcondition === "object" && !Array.isArray(postcondition)) {
      return {
        projection_name: typeof postcondition.projection === "string" ? postcondition.projection : projection.name,
        definition: postcondition,
      };
    }
  }
  return null;
}

export function resolveSiteActionFromBundle(bundle, pageUrl, { action, arguments: args = {} } = {}) {
  const entry = findSiteActionEntry(bundle, pageUrl, action);
  if (!entry) {
    return {
      ok: false,
      error: {
        code: "unknown_action",
        message: "Requested site action is not declared in browser-local actions.json storage.",
      },
    };
  }
  const { map, tool } = entry;
  const postcondition = findStatePostcondition(map, tool.name);
  const staticOutput = tool.x_actions?.static_output;
  if (staticOutput !== undefined) {
    return {
      ok: true,
      static_output: staticOutput,
    };
  }
  if (tool.workflow && typeof tool.workflow === "object" && !Array.isArray(tool.workflow)) {
    return {
      ok: true,
      workflow: {
        action_name: tool.name,
        definition: tool.workflow,
        input: args,
        ...(postcondition ? { postcondition } : {}),
      },
    };
  }
  const handler = tool.x_actions?.handler;
  if (typeof handler !== "string" || !handler) {
    return {
      ok: false,
      error: {
        code: "unsupported_execution_mode",
        message: `Stored action ${action} does not declare a primitive handler.`,
      },
    };
  }
  const bindingArgs = tool.x_actions?.binding?.arguments || {};
  const targetUrlContains = tool.x_actions?.binding?.target_url_contains || pageUrl;
  return {
    ok: true,
    resolved: {
      name: handler,
      arguments: mergeObjectValues(bindingArgs, args),
      target_url_contains: targetUrlContains,
      ...(postcondition ? { postcondition } : {}),
    },
  };
}
