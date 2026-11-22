import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadPrimitiveDictionary,
  primitiveCatalogForHost,
  primitiveManifestMetadata,
} from "../src/primitives/dictionary-loader.mjs";
import { primitiveError, primitiveSuccess } from "../src/primitives/result-envelope.mjs";

test("shared loader returns stable primitive catalogs for extension and embed hosts", async () => {
  const dictionary = await loadPrimitiveDictionary();
  const extensionCatalog = primitiveCatalogForHost(dictionary, "extension");
  const embedCatalog = primitiveCatalogForHost(dictionary, "embed");

  assert.equal(dictionary.version, 1);
  assert.equal(dictionary.stage, 1);
  assert.deepEqual(
    extensionCatalog.map((primitive) => primitive.name),
    embedCatalog.map((primitive) => primitive.name),
  );
  // The projection is now a formatter over the resolver rather than a second
  // authority engine, so it also reports which layer decided and whether the
  // answer came from live host state or from the dictionary's adapters. The
  // support values are unchanged.
  // Indexed BY NAME, not by position. `catalog[0]` asserted against a sorted
  // list, so any new namespace sorting before `browser.*` broke a test about
  // browser.screenshot -- which is what #344's `database.*` primitives did
  // (43 -> 45, and `database` sorts first). The resolver was right and the
  // expectation was stale, but the failure named the wrong subject. Fixing the
  // index rather than the position, because bumping it to [2] just relocates
  // the fragility to the next namespace anyone adds.
  const byName = (catalog, name) => {
    const found = catalog.find((primitive) => primitive.name === name);
    assert.ok(found, `${name} is not in the catalog (${catalog.length} entries)`);
    return found;
  };

  assert.deepEqual(byName(extensionCatalog, "browser.screenshot"), {
    name: "browser.screenshot",
    version: 1,
    stage: 1,
    support: "supported",
    reason: null,
    capability_class: "privileged",
    portable: false,
    summary: "Capture a true rendered screenshot where the host has browser-level authority.",
    decided_by: "provider_registration",
    authority_source: "dictionary_adapters",
  });
  // NOTE for review: the reason here changed from `capability_unavailable` to
  // `namespace_unavailable`, and this is a semantic change rather than a
  // cosmetic one.
  //
  // Under the #335 ruling the two are different diagnoses with different
  // remediation. No embed provider registers any `browser.*` primitive, so the
  // namespace is genuinely absent -- which makes `namespace_unavailable` the
  // more accurate answer and the one whose remediation ("activate a provider")
  // is at least addressable. But it IS a change to a previously asserted
  // value, so it is flagged here rather than absorbed silently. Support is
  // unchanged: 41 supported for extension, 17 for embed, matching the adapters
  // exactly on every primitive.
  assert.deepEqual(byName(embedCatalog, "browser.screenshot"), {
    name: "browser.screenshot",
    version: 1,
    stage: 1,
    support: "unsupported",
    reason: "namespace_unavailable",
    capability_class: "privileged",
    portable: false,
    summary: "Capture a true rendered screenshot where the host has browser-level authority.",
    decided_by: "host_state",
    authority_source: "dictionary_adapters",
  });

  // The guard that matters more than either exact reason: the formatter must
  // reproduce the adapters' support verdict for every primitive on both hosts.
  for (const host of ["extension", "embed"]) {
    const projected = primitiveCatalogForHost(dictionary, host);
    const fromAdapters = dictionary.primitives.map(
      (primitive) => primitive.adapters?.[host]?.support ?? "unsupported",
    );
    assert.deepEqual(
      projected.map((primitive) => primitive.support),
      fromAdapters,
      `${host}: formatter must not change any support verdict`,
    );
  }
});

test("shared result envelope formats primitive success and errors", () => {
  assert.deepEqual(
    primitiveSuccess({
      primitive: "page.info",
      adapter: "embed",
      value: { url: "https://example.test", title: "Example" },
    }),
    {
      ok: true,
      primitive: "page.info",
      adapter: "embed",
      value: { url: "https://example.test", title: "Example" },
    },
  );

  assert.deepEqual(
    primitiveError({
      primitive: "browser.screenshot",
      adapter: "embed",
      code: "capability_unavailable",
      message: "Bookmarklet/embed hosts cannot autonomously capture true rendered screenshots.",
      evidence: { required_capability: "browser.screenshot" },
    }),
    {
      ok: false,
      primitive: "browser.screenshot",
      adapter: "embed",
      error: {
        code: "capability_unavailable",
        message: "Bookmarklet/embed hosts cannot autonomously capture true rendered screenshots.",
        recoverable: true,
        evidence: { required_capability: "browser.screenshot" },
      },
    },
  );
});

test("manifest schemas come from the selected provider descriptor", async () => {
  const dictionary = await loadPrimitiveDictionary();
  const primitive = "pointer.click";
  const canonical = dictionary.primitives.find((entry) => entry.name === primitive);
  const input_schema = structuredClone(canonical.input_schema);
  input_schema.properties.provider_only = { type: "boolean" };
  const hostState = {
    host: "embed",
    revision: "rev-provider-schema",
    installation_id: "installation-1",
    principal_id: "principal-1",
    authority_mode: "caller_rights",
    namespaces: {
      pointer: {
        provider: "embed-provider",
        registrations: {
          "embed-provider": {
            implements: [primitive],
            descriptors: {
              [primitive]: {
                summary: "Provider-specific pointer click.",
                input_schema,
                extensions: {
                  input: {
                    provider_only: { authority: "additional_policy", effect: "same_as_primitive" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const manifest = primitiveManifestMetadata(dictionary, "embed", {
    includeSchemas: true,
    hostState,
  });
  const projected = manifest.primitives.find((entry) => entry.name === primitive);
  assert.equal(projected.support, "supported");
  assert.equal(projected.summary, "Provider-specific pointer click.");
  assert.deepEqual(projected.input_schema, input_schema);

  const readPrimitive = "database.page.read";
  const canonicalRead = dictionary.primitives.find((entry) => entry.name === readPrimitive);
  const readManifest = primitiveManifestMetadata(dictionary, "embed", {
    includeSchemas: true,
    hostState: {
      ...hostState,
      namespaces: {
        database: {
          provider: "database-provider",
          registrations: {
            "database-provider": { implements: [readPrimitive] },
          },
        },
      },
    },
  });
  const projectedRead = readManifest.primitives.find((entry) => entry.name === readPrimitive);
  assert.deepEqual(projectedRead.output_schema, canonicalRead.output_schema);
});

test("bookmarklet and extension manifests expose shared primitive dictionary metadata", async () => {
  const dictionary = await loadPrimitiveDictionary();
  const extensionManifest = JSON.parse(
    await readFile(
      new URL("../../../extensions/chrome-overlay-runtime/actions/overlay.actions.json", import.meta.url),
      "utf8",
    ),
  );
  const bookmarkletSource = await readFile(
    new URL("../bookmarklet/storage-bookmarklet.js", import.meta.url),
    "utf8",
  );
  const bookmarkletMetadataMatch = bookmarkletSource.match(
    /(const objectInputSchema = \{ type: "object" \};[\s\S]*?const primitiveDictionaryMetadata = [\s\S]*?;)\n\n  const existing =/,
  );
  const expectedExtensionMetadata = primitiveManifestMetadata(dictionary, "extension", { includeSchemas: true });
  const expectedExtensionNames = new Set(
    expectedExtensionMetadata.primitives.map((primitive) => primitive.name),
  );
  const extensionCanonicalMetadata = {
    ...extensionManifest.primitive_dictionary,
    primitives: extensionManifest.primitive_dictionary.primitives.filter((primitive) =>
      expectedExtensionNames.has(primitive.name),
    ),
  };
  const extensionExtraPrimitives = extensionManifest.primitive_dictionary.primitives.filter(
    (primitive) => !expectedExtensionNames.has(primitive.name),
  );

  assert.deepEqual(
    extensionCanonicalMetadata,
    expectedExtensionMetadata,
  );
  assert.ok(extensionExtraPrimitives.length > 0, "extension should declare extension-only primitives");
  for (const primitive of extensionExtraPrimitives) {
    assert.equal(primitive.support, "supported", `${primitive.name} should be supported`);
    assert.equal(typeof primitive.summary, "string", `${primitive.name} should include summary`);
    assert.equal(primitive.input_schema?.type, "object", `${primitive.name} should include an object schema`);
  }
  assert.ok(bookmarkletMetadataMatch, "bookmarklet should declare primitiveDictionaryMetadata");
  const bookmarkletMetadata = Function(`${bookmarkletMetadataMatch[1]}; return primitiveDictionaryMetadata;`)();
  assert.deepEqual(
    bookmarkletMetadata,
    primitiveManifestMetadata(dictionary, "embed"),
  );
  assert.match(bookmarkletSource, /primitive_dictionary: primitiveDictionaryMetadata/);
});
