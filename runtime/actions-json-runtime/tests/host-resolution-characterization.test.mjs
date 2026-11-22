// Characterization of the host-resolution defect described in #335.
//
// These tests PIN BEHAVIOUR THAT IS WRONG. They are not a compatibility
// contract: every assertion marked CURRENT DEFECT is expected to change when
// the resolver lands, and the vector file records what it must change to.
//
// The reason to pin a defect rather than describe it: "the host argument is
// ignored" is a claim, and a claim about a projection that looks host-sensitive
// is exactly the kind that survives review by sounding reasonable. An assertion
// that 76 === 76 fails the day someone fixes it, which is the point.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRealtimeToolCatalog } from "../../../extensions/chrome-overlay-runtime/src/agent/realtime-tool-catalog.mjs";

const canonicalUrl = new URL("../src/primitives/dictionary.v1.json", import.meta.url);
const packagedUrl = new URL(
  "../../../extensions/chrome-overlay-runtime/actions/overlay.actions.json",
  import.meta.url,
);
const vectorsUrl = new URL("../../../contracts/capability-resolution/host-resolution.vectors.json", import.meta.url);

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const names = (dictionary, host) =>
  buildRealtimeToolCatalog({ dictionary, host }).map((tool) => tool.name);

const vectorById = (vectors, id) => {
  const found = vectors.vectors.find((vector) => vector.id === id);
  assert.ok(found, `vector ${id} missing from the corpus`);
  return found;
};

test("CURRENT DEFECT: packaged dictionary ignores the host selector", async () => {
  const packaged = (await readJson(packagedUrl)).primitive_dictionary;

  const asExtension = names(packaged, "extension");
  const asEmbed = names(packaged, "embed");

  assert.deepEqual(
    asEmbed,
    asExtension,
    "packaged catalogs currently agree across hosts; if this now differs, the resolver has landed and this characterization should be replaced by the target vector",
  );

  const vector = vectorById(await readJson(vectorsUrl), "packaged-host-selector-ignored");
  assert.equal(asExtension.length, vector.observed_today.catalog_size.extension);
  assert.equal(asEmbed.length, vector.observed_today.catalog_size.embed);

  // The consequence, stated as tools rather than as a count: an embed host is
  // offered browser and transfer authority it cannot possibly honour. Every one
  // of these calls would fail at runtime, and the agent would report the failure
  // as the app being broken rather than as its own overreach.
  for (const primitive of vector.observed_today.embed_receives_privileged) {
    assert.ok(
      asEmbed.includes(primitive),
      `expected the defect to advertise ${primitive} to an embed host`,
    );
  }
});

test("canonical dictionary does distinguish hosts", async () => {
  const canonical = await readJson(canonicalUrl);

  const asExtension = names(canonical, "extension");
  const asEmbed = names(canonical, "embed");

  assert.notDeepEqual(
    asEmbed,
    asExtension,
    "the canonical dictionary carries per-host adapters and must not collapse",
  );

  // A positive control on both sides. Without it, "embed has fewer tools" is
  // also consistent with embed resolving to nothing at all, which would be a
  // different bug wearing the same numbers.
  assert.ok(asExtension.includes("browser.open_tab"), "extension should keep browser authority");
  assert.ok(!asEmbed.includes("browser.open_tab"), "embed must not receive browser authority");
  assert.ok(asEmbed.includes("overlay.open"), "embed should keep its own privileged overlay surface");
  assert.ok(asEmbed.includes("pointer.click"), "embed should keep portable DOM primitives");
});

test("CURRENT DEFECT: the packaged document declares a host that no resolver reads", async () => {
  const packaged = (await readJson(packagedUrl)).primitive_dictionary;
  const vector = vectorById(await readJson(vectorsUrl), "packaged-declares-host-but-code-ignores-it");

  // Half one: the declaration is present.
  assert.equal(
    packaged.host,
    vector.observed_today.document_declares_host,
    "packaged dictionary should declare the host whose authority it encodes",
  );

  // Half two: it is ignored. Projecting the extension-declared document as
  // "embed" succeeds and yields extension authority, which is what reading the
  // declaration would prevent. Pinning both halves matters -- a fix that reads
  // the field without acting on it would satisfy half one alone.
  const projectedAsEmbed = names(packaged, "embed");
  assert.ok(
    projectedAsEmbed.includes("browser.open_tab"),
    "an extension-declared document currently projects as embed without objection",
  );
});

// The corpus's own well-formedness now lives in capability-contract-assets,
// which schema-validates it and dereferences its documents. Keeping a weaker
// duplicate here would report green on a corpus that test rejects.
