// Self-driven live proof for the maintained projection cache. Loads the real
// unpacked MV3 extension and exercises its chrome.storage.local-backed cache
// through an inert test hook; no bridge, credentials, or human browser needed.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");

async function main() {
  execFileSync("node", [path.join(EXT, "esbuild.a11y.mjs")], { stdio: "inherit" });
  execFileSync("node", [path.join(EXT, "esbuild.protoface-broker.mjs")], { stdio: "inherit" });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "projection-cache-live-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });

  try {
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    let hookReady = false;
    for (let attempt = 0; attempt < 60 && !hookReady; attempt += 1) {
      hookReady = await worker.evaluate(() => Boolean(self.__projectionCacheTest)).catch(() => false);
      if (!hookReady) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!hookReady) throw new Error("projection cache live-test hook did not load");

    const scope = { siteHost: "trello.com", groupId: "live-group", namespace: "trello.cards" };
    const cacheEntry = {
      entity_id: "card-1",
      value: { last_touched_at: "2026-07-20T12:00:00.000Z" },
      content_hash: "sha256:live-card-1",
      observed_at: "2026-07-20T12:00:00.000Z",
      expires_at: "2026-08-01T00:00:00.000Z",
      provenance: "live-smoke",
    };
    await worker.evaluate(
      ({ scope: target, entry }) => self.__projectionCacheTest.upsert({ ...target, entries: [entry] }),
      { scope, entry: cacheEntry },
    );
    const known = await worker.evaluate(
      (target) => self.__projectionCacheTest.read({ ...target, namespaces: [target.namespace] }),
      scope,
    );
    const isolated = await worker.evaluate(
      (target) => self.__projectionCacheTest.read({ ...target, groupId: "other-group", namespaces: [target.namespace] }),
      scope,
    );
    if (known?.[scope.namespace]?.[cacheEntry.entity_id]?.value?.last_touched_at !== cacheEntry.value.last_touched_at) {
      throw new Error(`live cache read mismatch: ${JSON.stringify(known)}`);
    }
    if (Object.keys(isolated).length !== 0) {
      throw new Error(`live cache crossed group boundary: ${JSON.stringify(isolated)}`);
    }

    await worker.evaluate((target) => self.__projectionCacheTest.invalidateNamespace(target), scope);
    const cleared = await worker.evaluate(
      (target) => self.__projectionCacheTest.read({ ...target, namespaces: [target.namespace] }),
      scope,
    );
    if (Object.keys(cleared).length !== 0) {
      throw new Error(`live cache invalidation failed: ${JSON.stringify(cleared)}`);
    }
    console.log("PROJECTION CACHE LIVE SMOKE PASS");
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
