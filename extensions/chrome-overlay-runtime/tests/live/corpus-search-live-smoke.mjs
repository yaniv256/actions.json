// Self-driven live proof for corpus.search. Loads the REAL unpacked MV3
// extension in a Chromium this script launches, seeds a vector artifact into the
// real chrome.storage.local, and drives the REAL executeLocalHostedToolCall
// dispatch — the same seam the hosted agent reaches.
//
// This is an agent-side release gate: prove
// it yourself before asking a human to install anything. Unit tests cannot cover
// what this covers:
//
//   1. MODULE RESOLUTION IN A LIVE SERVICE WORKER. background.js imports three
//      new .mjs modules. If any is missing from the packaged file list, the MV3
//      worker goes INERT with no visible error — no build failure, no test
//      failure, just an extension that installs and does nothing. Node's test
//      runner resolves from the source tree and would never see it.
//   2. Reading a >64KB bundle entry, past the budget that the model-facing
//      reader silently truncates at.
//   3. The refusal contract surviving the real dispatch envelope.
//
// No OpenAI key and no network: the embedder is injected. This proves the
// PLUMBING is live, not that the embeddings API works.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const INDEX_PATH = "scopes/public/sites/example.com/vectors.json";

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// A corpus deliberately larger than the 64,000-byte reader budget, so a loader
// that went through readSiteStorageFileFromBundle would silently lose its tail.
function buildLargeIndex() {
  const docs = [
    { id: "add-layer-masks", vector: [1, 0] },
    { id: "rotate-or-flip-images", vector: [0, 1] },
  ];
  for (let i = 0; i < 3000; i += 1) {
    docs.push({ id: `filler-${i}`, vector: [0.5, 0.5] });
  }
  return { schema_version: 1, model: "text-embedding-3-small", dimensions: 2, docs };
}

async function main() {
  execFileSync("node", [path.join(EXT, "esbuild.a11y.mjs")], { stdio: "inherit" });
  execFileSync("node", [path.join(EXT, "esbuild.protoface-broker.mjs")], { stdio: "inherit" });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-search-live-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });

  try {
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });

    let hookReady = false;
    for (let attempt = 0; attempt < 60 && !hookReady; attempt += 1) {
      hookReady = await worker.evaluate(() => Boolean(self.__corpusSearchTest)).catch(() => false);
      if (!hookReady) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // THE headline assertion. A worker whose module graph failed to resolve
    // never reaches this line, which is precisely the failure that ships
    // silently.
    check("the MV3 service worker resolved every corpus module and booted", hookReady);
    if (!hookReady) throw new Error("corpus.search live-test hook did not load");

    const index = buildLargeIndex();
    const text = JSON.stringify(index);
    check("fixture exceeds the 64KB reader budget", text.length > 64_000, `${text.length} bytes`);

    await worker.evaluate(
      ({ p, t }) => self.__corpusSearchTest.seedBundle({ entries: [{ path: p, content: t }] }),
      { p: INDEX_PATH, t: text },
    );

    // 1. Ranking against the real >64KB artifact in real chrome.storage.local,
    //    with a known query vector so no OpenAI key is needed. A loader that
    //    went through the model-facing reader would have lost the tail of this
    //    table.
    const hit = await worker.evaluate(
      ({ p }) => self.__corpusSearchTest.rankWithVector({ index_path: p, vector: [1, 0], limit: 3 }),
      { p: INDEX_PATH },
    );
    check(
      "a query ranks correctly against the >64KB index read from live storage",
      hit?.ok === true && hit?.results?.[0]?.id === "add-layer-masks",
      JSON.stringify(hit?.results?.slice(0, 1) ?? hit?.error ?? hit),
    );

    // 2. A missing index_path must be REFUSED, naming the requirement.
    const noPath = await worker.evaluate(() => self.__corpusSearchTest.call({ query: "x" }));
    check(
      "a missing index_path is refused, not defaulted",
      noPath?.ok === false && /index_path/i.test(noPath?.error?.message ?? ""),
      noPath?.error?.code ?? "",
    );

    // 3. A missing artifact must degrade WITH the hedge — never an empty success.
    const missing = await worker.evaluate(() => self.__corpusSearchTest.call({
      query: "anything",
      index_path: "scopes/public/sites/example.com/absent.json",
    }));
    const missingValue = missing?.output?.value;
    check(
      "a missing artifact degrades with an explicit refusal instruction",
      missing?.ok === true
        && missingValue?.confident === false
        && /do not answer from your own knowledge/i.test(missingValue?.instruction ?? ""),
      missingValue?.degraded?.code ?? JSON.stringify(missing?.error ?? {}),
    );

    // 4. No OpenAI key is configured in this fresh profile, so the real embedder
    //    path must ALSO degrade loudly rather than returning nothing.
    const noKey = await worker.evaluate(
      ({ p }) => self.__corpusSearchTest.call({ query: "real embed path", index_path: p }),
      { p: INDEX_PATH },
    );
    const noKeyValue = noKey?.output?.value;
    check(
      "a missing OpenAI key degrades loudly instead of returning no matches",
      noKey?.ok === true
        && noKeyValue?.confident === false
        && /do not answer from your own knowledge/i.test(noKeyValue?.instruction ?? ""),
      noKeyValue?.degraded?.code ?? "",
    );
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} live checks passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
