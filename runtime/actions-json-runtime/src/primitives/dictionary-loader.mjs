import { readFile } from "node:fs/promises";

import { resolveCapability } from "./capability-resolver.mjs";
import { validatePrimitiveDictionary } from "./dictionary-schema.mjs";

const DEFAULT_DICTIONARY_URL = new URL("./dictionary.v1.json", import.meta.url);

export async function loadPrimitiveDictionary({ url = DEFAULT_DICTIONARY_URL } = {}) {
  const dictionary = JSON.parse(await readFile(url, "utf8"));
  const validation = validatePrimitiveDictionary(dictionary);
  if (!validation.valid) {
    const summary = validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    throw new Error(`Invalid primitive dictionary: ${summary}`);
  }
  return dictionary;
}

/**
 * Project the dictionary for a host.
 *
 * This is a FORMATTER over `resolveCapability`, not a second authority engine.
 * It previously called `describePrimitiveCapability` without forwarding
 * `context`, so the one context-aware path was dropped here and inherited by
 * `primitiveManifestMetadata` -- two of the three projections could not see
 * runtime state at all.
 *
 * `hostState` is optional only for the legacy shape, where the caller is
 * asking what the dictionary's `adapters` say rather than what a live
 * installation grants. When it is absent this reports adapter-derived support
 * and says so via `authority_source`, so a caller cannot mistake a static
 * projection for a resolved one.
 */
export function primitiveCatalogForHost(
  dictionary,
  host,
  { hostState = null, callContext = {}, includeSchemas = false } = {},
) {
  const state = hostState ?? legacyHostStateFromAdapters(dictionary, host);

  return dictionary.primitives.map((primitive) => {
    const resolved = resolveCapability({
      dictionary,
      hostState: state,
      primitive: primitive.name,
      callContext,
    });
    return {
      name: primitive.name,
      version: primitive.version,
      stage: primitive.stage,
      support: resolved.support,
      reason: resolved.reason,
      capability_class: primitive.capability_class,
      portable: primitive.portable,
      summary: resolved.descriptor?.summary ?? primitive.summary,
      ...(includeSchemas
        ? {
            input_schema: resolved.descriptor?.input_schema,
            ...(resolved.descriptor?.output_schema === undefined
              ? {}
              : { output_schema: resolved.descriptor.output_schema }),
          }
        : {}),
      decided_by: resolved.decided_by,
      authority_source: hostState ? "host_state" : "dictionary_adapters",
    };
  });
}

/**
 * Derive a host state from the dictionary's `adapters`, for callers that have
 * no live installation.
 *
 * This is the compatibility path and it is explicit rather than implicit: the
 * adapters ARE a registration claim in the migration window, so turning them
 * into one is honest, whereas silently granting whatever the dictionary
 * mentions is the fail-open this contract exists to remove.
 */
function legacyHostStateFromAdapters(dictionary, host) {
  const namespaces = {};
  for (const primitive of dictionary.primitives) {
    if (primitive.adapters?.[host]?.support !== "supported") continue;
    const namespace = primitive.name.includes(".")
      ? primitive.name.slice(0, primitive.name.indexOf("."))
      : primitive.name;
    namespaces[namespace] ??= {
      provider: `legacy-adapters:${host}`,
      registrations: { [`legacy-adapters:${host}`]: { implements: [] } },
    };
    namespaces[namespace].registrations[`legacy-adapters:${host}`].implements.push(primitive.name);
  }
  return {
    host,
    revision: `legacy-adapters:${host}`,
    principal_id: null,
    compatibility_profile: "dictionary_adapters",
    namespaces,
  };
}

export function primitiveManifestMetadata(
  dictionary,
  host,
  { includeSchemas = false, hostState = null, callContext = {} } = {},
) {
  return {
    version: dictionary.version,
    stage: dictionary.stage,
    host,
    primitives: primitiveCatalogForHost(dictionary, host, {
      hostState,
      callContext,
      includeSchemas,
    }).map((primitive) => ({
      name: primitive.name,
      support: primitive.support,
      reason: primitive.reason,
      capability_class: primitive.capability_class,
      portable: primitive.portable,
      ...(includeSchemas
        ? {
            summary: primitive.summary,
            input_schema: primitive.input_schema,
            ...(primitive.output_schema === undefined
              ? {}
              : { output_schema: primitive.output_schema }),
          }
        : {}),
    })),
  };
}
