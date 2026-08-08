import assert from "node:assert/strict";
import test from "node:test";

import { buildCorpusArtifact } from "../src/agent/corpus-build.mjs";

const MODEL = "text-embedding-3-small";

function okResponse(vectors) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: vectors.map((embedding) => ({ embedding })) }),
  };
}

// A corpus source shaped like a real article index: a list of records where one
// field is the id and one or more are the text to embed.
const SOURCE = JSON.stringify({
  articles: [
    { slug: "add-layer-masks", title: "Add layer masks", summary: "mask a layer" },
    { slug: "rotate-or-flip-images", title: "Rotate or flip images", summary: "flip" },
  ],
});

function bundle(entries) {
  return { entries };
}

test("building an artifact embeds the corpus and returns a loadable index", async () => {
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: SOURCE }]),
    sourcePath: "index.json",
    recordsAt: "articles",
    idField: "slug",
    textFields: ["title", "summary"],
    apiKey: "sk-test",
    fetchImpl: async () => okResponse([[1, 0], [0, 1]]),
    dimensions: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.index.schema_version, 1);
  assert.equal(result.index.model, MODEL);
  assert.equal(result.index.dimensions, 2);
  assert.deepEqual(result.index.docs.map((doc) => doc.id), [
    "add-layer-masks",
    "rotate-or-flip-images",
  ]);
  assert.equal(result.documents_embedded, 2);
});

test("the embedded text joins every named field, not just the first", async () => {
  // A corpus embedded on slugs alone reproduces the vocabulary-mismatch bug the
  // whole feature exists to fix: the visitor's words have to match the site's.
  // Titles and summaries are where a visitor's phrasing actually lives.
  let embeddedInput = null;
  await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: SOURCE }]),
    sourcePath: "index.json",
    recordsAt: "articles",
    idField: "slug",
    textFields: ["title", "summary"],
    apiKey: "sk-test",
    fetchImpl: async (_url, init) => {
      embeddedInput = JSON.parse(init.body).input;
      return okResponse([[1, 0], [0, 1]]);
    },
    dimensions: 2,
  });
  assert.match(embeddedInput[0], /Add layer masks/);
  assert.match(embeddedInput[0], /mask a layer/);
});

test("a missing source file is refused, naming the path it looked for", async () => {
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "other.json", content: SOURCE }]),
    sourcePath: "index.json",
    recordsAt: "articles",
    idField: "slug",
    textFields: ["title"],
    apiKey: "sk-test",
    fetchImpl: async () => okResponse([]),
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /not_found/i);
  assert.match(result.error.message, /index\.json/);
});

test("a records path that resolves to nothing is refused, not treated as empty", async () => {
  // "No records at that key" and "the corpus is empty" are different facts, and
  // building an empty index from a typo'd path would ship a table that ranks
  // nothing while looking valid.
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: SOURCE }]),
    sourcePath: "index.json",
    recordsAt: "aritcles", // typo on purpose
    idField: "slug",
    textFields: ["title"],
    apiKey: "sk-test",
    fetchImpl: async () => okResponse([]),
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /aritcles/);
});

test("a record missing the id field is refused, naming its position", async () => {
  const source = JSON.stringify({ articles: [{ title: "no id here" }] });
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: source }]),
    sourcePath: "index.json",
    recordsAt: "articles",
    idField: "slug",
    textFields: ["title"],
    apiKey: "sk-test",
    fetchImpl: async () => okResponse([[1, 0]]),
    dimensions: 2,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /0|first/i, "must locate the offending record");
});

test("an embed failure yields NO artifact rather than a partial one", async () => {
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: SOURCE }]),
    sourcePath: "index.json",
    recordsAt: "articles",
    idField: "slug",
    textFields: ["title"],
    apiKey: "sk-test",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    dimensions: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.index, undefined);
  assert.match(result.error.message, /500/);
});

test("a missing API key is refused before any network call", async () => {
  let called = false;
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: SOURCE }]),
    sourcePath: "index.json",
    recordsAt: "articles",
    idField: "slug",
    textFields: ["title"],
    apiKey: "",
    fetchImpl: async () => {
      called = true;
      return okResponse([]);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.code, /api_key/i);
  assert.equal(called, false);
});

test("a flat array source needs no records path", async () => {
  const flat = JSON.stringify([{ slug: "a", title: "Alpha" }]);
  const result = await buildCorpusArtifact({
    bundle: bundle([{ path: "index.json", content: flat }]),
    sourcePath: "index.json",
    idField: "slug",
    textFields: ["title"],
    apiKey: "sk-test",
    fetchImpl: async () => okResponse([[1, 0]]),
    dimensions: 2,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.index.docs.map((doc) => doc.id), ["a"]);
});
