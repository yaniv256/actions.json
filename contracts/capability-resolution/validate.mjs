// Corpus loading and schema validation for the capability contract.
//
// The validator is Ajv's Draft 2020-12 entrypoint. An earlier revision of this
// file grew a hand-rolled engine with a keyword-coverage assertion, which was
// itself wrong: it listed `patternProperties` as supported while `validate()`
// never applied it, so a document with a violating property validated clean.
// The guard asserted its own correctness rather than testing it -- exactly the
// failure it existed to prevent, one level up. A schema engine on a
// security-relevant path is not the place for a bespoke implementation.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020");

/**
 * One compiler for every contract schema. `strict` is on so a misspelled or
 * unapplied keyword is an error at compile time rather than a silently
 * permissive validation at run time.
 */
export function createValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  return {
    // Register a schema by $id so cross-file $refs resolve. The boundary
    // schemas reference each other -- a resolved catalog contains resolutions,
    // a corpus contains vector cases -- so they must be compiled as one set.
    add(schema) {
      if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      return this;
    },
    compile: (schema) => ajv.compile(schema),
    // Validate against a schema object or a registered $id. Recompiling an
    // already-registered schema is an Ajv error, so a registered one is looked
    // up rather than compiled again.
    validate(value, schema) {
      const id = typeof schema === "string" ? schema : schema.$id;
      const check = (id && ajv.getSchema(id)) || ajv.compile(schema);
      return check(value) ? [] : (check.errors ?? []).map((error) => ({
        path: error.instancePath || "/",
        message: `${error.keyword}: ${error.message}`,
      }));
    },
  };
}

const shared = createValidator();
export const validate = (value, schema) => shared.validate(value, schema);

/**
 * Load the corpus and DEREFERENCE every document it names.
 *
 * The previous asset test validated the corpus's shape and never resolved its
 * document references, so both paths could point outside the repository and
 * the suite stayed green. A validator that does not dereference what it
 * validates proves the document is well formed, not that it refers to
 * anything.
 */
export async function loadCorpus({ repoRoot }) {
  const corpusUrl = new URL("host-resolution.vectors.json", import.meta.url);
  const corpus = JSON.parse(await readFile(corpusUrl, "utf8"));

  if (corpus.path_base !== "repository_root") {
    throw new Error(`corpus path_base must be "repository_root", got ${corpus.path_base}`);
  }

  const documents = {};
  for (const [name, descriptor] of Object.entries(corpus.documents)) {
    const absolute = new URL(descriptor.path, repoRoot);
    let raw;
    try {
      raw = await readFile(absolute, "utf8");
    } catch (error) {
      throw new Error(`corpus document "${name}" does not resolve: ${descriptor.path} (${error.code})`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`corpus document "${name}" is not valid JSON: ${error.message}`);
    }

    const pointed = descriptor.pointer ? applyPointer(parsed, descriptor.pointer, name) : parsed;

    // Prefer the document's own declared kind. Where the artifact predates
    // `kind`, the corpus must name a compatibility opener explicitly -- the
    // kind is never inferred from field shape.
    let opened;
    const declared = declaredKind(pointed);
    if (declared) {
      if (descriptor.declared_kind && declared !== descriptor.declared_kind) {
        throw new Error(
          `corpus document "${name}" declares kind ${declared} but the corpus expects ${descriptor.declared_kind}`,
        );
      }
      opened = { kind: declared, value: pointed, host: pointed.host ?? null };
    } else if (descriptor.compatibility_open_as) {
      opened = openLegacyArtifact(pointed, { as: descriptor.compatibility_open_as });
      if (descriptor.declared_kind && opened.kind !== descriptor.declared_kind) {
        throw new Error(
          `corpus document "${name}" opened as ${descriptor.compatibility_open_as} yields ${opened.kind}`,
        );
      }
    } else {
      throw new Error(
        `corpus document "${name}" carries no kind and names no compatibility_open_as; ` +
          "the kind is never inferred from field shape",
      );
    }

    documents[name] = { descriptor, value: opened.value, kind: opened.kind, host: opened.host };
  }

  return { corpus, documents };
}

function applyPointer(document, pointer, name) {
  if (!pointer.startsWith("/")) throw new Error(`corpus document "${name}": pointer must start with "/"`);
  return pointer
    .slice(1)
    .split("/")
    .reduce((node, part) => {
      if (node === undefined || node === null) {
        throw new Error(`corpus document "${name}": pointer ${pointer} does not resolve`);
      }
      return node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, document);
}

/**
 * Read a document's DECLARED kind.
 *
 * New contract documents must carry `kind`. There is deliberately no fallback
 * that guesses from field shape: an earlier revision inferred canonical vs
 * legacy from the presence of `support` and `adapters` and then compared that
 * guess to the corpus descriptor, which is the field-shape dispatch §2.4 says
 * is removed -- the corpus metadata was supplying the discriminator the
 * document lacked.
 */
export function declaredKind(document) {
  const kind = document?.kind;
  if (typeof kind !== "string" || kind.length === 0) return null;
  return kind;
}

/**
 * A NAMED compatibility descriptor for artifacts that predate `kind`.
 *
 * This is not kind detection and is not called that. The caller states which
 * legacy artifact it is opening, and this checks the document is consistent
 * with that claim -- failing closed when it is not. The corpus names these
 * explicitly, so nothing infers.
 */
export function openLegacyArtifact(document, { as }) {
  if (as === "legacy_flat") {
    if (typeof document?.host !== "string" || document.host.length === 0) {
      throw new Error("legacy_flat artifact does not declare its host");
    }
    const flat = document.primitives.some((entry) => typeof entry.support === "string");
    if (!flat) throw new Error("artifact opened as legacy_flat carries no flat support");
    return { kind: "legacy_flat", host: document.host, value: document };
  }
  if (as === "canonical_pre_kind") {
    const flat = document.primitives.filter((entry) => typeof entry.support === "string");
    if (flat.length > 0) {
      throw new Error(
        `artifact opened as canonical carries flat support on: ${flat.map((e) => e.name).join(", ")}`,
      );
    }
    return { kind: "canonical", host: null, value: document };
  }
  throw new Error(`unknown legacy artifact type "${as}"`);
}
