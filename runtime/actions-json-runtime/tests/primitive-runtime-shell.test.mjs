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
  assert.deepEqual(extensionCatalog[0], {
    name: "browser.screenshot",
    version: 1,
    stage: 1,
    support: "supported",
    reason: null,
    capability_class: "privileged",
    portable: false,
    summary: "Capture a true rendered screenshot where the host has browser-level authority.",
  });
  assert.deepEqual(embedCatalog[0], {
    name: "browser.screenshot",
    version: 1,
    stage: 1,
    support: "unsupported",
    reason: "capability_unavailable",
    capability_class: "privileged",
    portable: false,
    summary: "Capture a true rendered screenshot where the host has browser-level authority.",
  });
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

  assert.deepEqual(
    extensionManifest.primitive_dictionary,
    primitiveManifestMetadata(dictionary, "extension", { includeSchemas: true }),
  );
  assert.ok(bookmarkletMetadataMatch, "bookmarklet should declare primitiveDictionaryMetadata");
  const bookmarkletMetadata = Function(`${bookmarkletMetadataMatch[1]}; return primitiveDictionaryMetadata;`)();
  assert.deepEqual(
    bookmarkletMetadata,
    primitiveManifestMetadata(dictionary, "embed"),
  );
  assert.match(bookmarkletSource, /primitive_dictionary: primitiveDictionaryMetadata/);
});
