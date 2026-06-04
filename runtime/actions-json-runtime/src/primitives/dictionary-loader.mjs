import { readFile } from "node:fs/promises";

import { describePrimitiveCapability } from "./capability-descriptor.mjs";
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

export function primitiveCatalogForHost(dictionary, host) {
  return dictionary.primitives.map((primitive) => {
    const capability = describePrimitiveCapability(dictionary, {
      primitive: primitive.name,
      host,
    });
    return {
      name: primitive.name,
      version: primitive.version,
      stage: primitive.stage,
      support: capability.support,
      reason: capability.reason,
      capability_class: primitive.capability_class,
      portable: primitive.portable,
      summary: primitive.summary,
    };
  });
}

export function primitiveManifestMetadata(dictionary, host) {
  return {
    version: dictionary.version,
    stage: dictionary.stage,
    host,
    primitives: primitiveCatalogForHost(dictionary, host).map((primitive) => ({
      name: primitive.name,
      support: primitive.support,
      reason: primitive.reason,
      capability_class: primitive.capability_class,
      portable: primitive.portable,
    })),
  };
}
