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

export function loadSiteActionMapsFromBundle(bundle, pageUrl) {
  const maps = [];
  for (const entry of storageBundleEntries(bundle)) {
    const parsed = parseStoragePath(entry.path);
    if (!parsed || !parsed.sitePath.endsWith("actions.json") || !siteHostMatchesPage(parsed.siteHost, pageUrl)) {
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
  return { ...base, ...overlay };
}

function findSiteAction(bundle, pageUrl, actionName) {
  for (const { map } of loadSiteActionMapsFromBundle(bundle, pageUrl)) {
    const tool = map.tools.find((candidate) => candidate?.name === actionName);
    if (tool) {
      return tool;
    }
  }
  return null;
}

export function resolveSiteActionFromBundle(bundle, pageUrl, { action, arguments: args = {} } = {}) {
  const tool = findSiteAction(bundle, pageUrl, action);
  if (!tool) {
    return {
      ok: false,
      error: {
        code: "unknown_action",
        message: "Requested site action is not declared in browser-local actions.json storage.",
      },
    };
  }
  const staticOutput = tool.x_actions?.static_output;
  if (staticOutput !== undefined) {
    return {
      ok: true,
      static_output: staticOutput,
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
    },
  };
}
