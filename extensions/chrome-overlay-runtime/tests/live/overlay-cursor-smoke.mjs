// Self-driven live smoke for overlay.cursor.point (U8, the ghost cursor).
//
// Loads the real unpacked extension in Chromium, drives the same
// chrome.tabs.sendMessage path used by bridge actions, and asserts the things
// only a real browser can settle:
//   - a REAL layout engine computes the target rect, and a REAL
//     document.elementFromPoint arbitrates the hit-test
//   - a genuine position:sticky header actually paints over a target that is
//     comfortably inside the viewport (the documented failure), so the
//     occlusion branch fires against real paint order rather than a stub
//   - the ghost cursor element is really in the DOM at the hit-tested point
//   - a real off-screen target is really scrolled into view before drawing
//   - the actions.json overlay pill, mounted for real, is named as the
//     occluder when it covers the target
//
// The node test (tests/overlay-cursor-point.test.mjs) drives the same shipped
// factory against an injected fake DOM: it settles the DECISION logic. It
// cannot settle paint order, sticky positioning, or real layout — that is what
// this smoke is for.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDescendantsShareProcessGroup,
  createPhaseReporter,
  runWithInheritedProcessGroup,
  superviseLiveSmoke,
} from "./support/live-smoke-supervisor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.ACTIONS_JSON_EXTENSION_DIR
  ? path.resolve(process.env.ACTIONS_JSON_EXTENSION_DIR)
  : path.resolve(HERE, "../..");
const SMOKE_TIMEOUT_MS = Number.parseInt(process.env.ACTIONS_JSON_SMOKE_TIMEOUT_MS || "60000", 10);

function contentScriptFromProductionLoader() {
  const source = fs.readFileSync(path.join(EXT, "src/background.js"), "utf8");
  const injectContent = source.match(
    /const injectContent\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\};\s*\n\s*const connectClaimedTab/,
  )?.[1];
  const contentScript = injectContent?.match(/\bfiles:\s*\[\s*["']([^"']+)["']\s*\]/)?.[1];
  if (!contentScript) {
    throw new Error("Could not derive the content script from the production injectContent loader.");
  }
  return contentScript;
}

const CONTENT_SCRIPT = contentScriptFromProductionLoader();

// The fixture is built so each assertion has a known answer:
//   #plain        - unobstructed, comfortably in the viewport   -> must succeed
//   #under-sticky - in the viewport, but a real sticky header    -> must report
//                   paints over its centre                          occlusion
//   #far-below    - 4000px down, off screen                     -> must scroll
const FIXTURE = `<!doctype html>
<title>Ghost cursor smoke</title>
<style>
  body { margin: 0; font: 14px system-ui; }
  #sticky {
    position: fixed; top: 0; left: 0; right: 0; height: 200px;
    background: #223; color: #fff; z-index: 5;
  }
  #plain { position: absolute; top: 320px; left: 80px; width: 160px; height: 44px; }
  /* Sits at y=100, squarely underneath the 200px sticky header, yet is
     unambiguously inside the viewport - the documented failure shape. */
  #under-sticky { position: absolute; top: 90px; left: 80px; width: 160px; height: 40px; }
  #far-below { position: absolute; top: 4000px; left: 80px; width: 160px; height: 40px; }
  #spacer { height: 5000px; }
</style>
<div id="sticky">sticky header</div>
<button id="plain" data-testid="plain-target">Plain target</button>
<button id="under-sticky" data-testid="occluded-target">Under the sticky header</button>
<button id="far-below" data-testid="far-target">Far below the fold</button>
<div id="spacer"></div>
`;

const withDeadline = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const closeServer = async (server) => {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  await withDeadline(closed, 5_000, "ghost cursor fixture server close");
};

async function runWorker() {
  const phase = createPhaseReporter();
  let server = null;
  let profile = null;
  let context = null;
  let passed = false;
  try {
    phase("fixture-listener:start");
    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(FIXTURE);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    phase("fixture-listener:ready");
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    const runDir = process.env.ACTIONS_JSON_SMOKE_RUN_DIR
      || fs.mkdtempSync(path.join(os.tmpdir(), "overlay-cursor-smoke-"));
    fs.mkdirSync(runDir, { recursive: true });
    profile = path.join(runDir, "profile");
    fs.mkdirSync(profile, { recursive: true });
    phase("profile:created");
    phase("browser-launch:start");
    context = await withDeadline(runWithInheritedProcessGroup(
      () => chromium.launchPersistentContext(profile, {
        headless: false,
        timeout: 15_000,
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
      }),
    ), 20_000, "Chromium persistent-context launch");
    const ownership = assertDescendantsShareProcessGroup();
    console.log(`overlay-cursor-smoke: owned process group=${ownership.pgid} descendants=${ownership.descendantCount}`);
    phase("browser-launch:complete");

    const serviceWorker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    const page = context.pages()[0] || await context.newPage();
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await page.goto(fixtureUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    phase("fixture:committed");

    const tabId = await driver.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === url)?.id ?? null;
    }, fixtureUrl);
    if (tabId === null) throw new Error("Fixture tab was not visible to the extension.");

    const injection = await driver.evaluate(
      ([id, contentScript]) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, timeout: true }), 10_000);
        chrome.scripting.executeScript(
          { target: { tabId: id }, files: [contentScript] },
          (results) => {
            clearTimeout(timer);
            const error = chrome.runtime.lastError?.message || null;
            resolve({ ok: !error, error, result_count: results?.length || 0 });
          },
        );
      }),
      [tabId, CONTENT_SCRIPT],
    );
    if (!injection.ok) throw new Error(`Content script injection failed: ${JSON.stringify(injection)}`);
    phase("content-script:injected");

    let callSequence = 0;
    const call = (name, args) => driver.evaluate(
      ([id, action, actionArgs, sequence]) => chrome.tabs.sendMessage(id, {
        type: "actions-json:execute-action",
        call_id: `cursor-smoke-${sequence}`,
        name: action,
        arguments: actionArgs,
      }),
      [tabId, name, args, ++callSequence],
    );

    // --- fixture self-assertion: prove the fixture really is what it claims,
    // so a vacuous pass fails loudly rather than quietly.
    const fixtureTruth = await page.evaluate(() => {
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      const occluded = rect("#under-sticky");
      const centre = {
        x: occluded.left + occluded.width / 2,
        y: occluded.top + occluded.height / 2,
      };
      return {
        occludedInViewport: occluded.top >= 0 && occluded.bottom <= window.innerHeight,
        // The REAL paint order must put the sticky header on that point.
        hitAtOccludedCentre: document.elementFromPoint(centre.x, centre.y)?.id ?? null,
        farBelowOffScreen: rect("#far-below").top > window.innerHeight,
      };
    });
    console.log("overlay-cursor-smoke: fixture truth", JSON.stringify(fixtureTruth));
    if (!fixtureTruth.occludedInViewport
      || fixtureTruth.hitAtOccludedCentre !== "sticky"
      || !fixtureTruth.farBelowOffScreen) {
      throw new Error(`Fixture did not establish its own preconditions: ${JSON.stringify(fixtureTruth)}`);
    }

    // --- 1. unobstructed target: must succeed AND draw at the hit-tested point
    const plain = await call("overlay.cursor.point", {
      locator: { selector: "#plain" },
    });
    const plainValue = plain?.output?.value ?? plain?.output;
    const cursorAfterPlain = await page.evaluate(() => {
      const pointer = document.getElementById("actions-json-ghost-pointer");
      if (!pointer) return null;
      const rect = pointer.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return {
        point,
        // What does the page ACTUALLY paint at the point we drew on? This is
        // the whole correctness claim, arbitrated by the real hit-tester.
        hitId: document.elementFromPoint(point.x, point.y)?.id ?? null,
        opacity: getComputedStyle(pointer).opacity,
      };
    });
    console.log("overlay-cursor-smoke: plain", JSON.stringify({ plainValue, cursorAfterPlain }));

    // --- 2. real sticky occlusion: must NOT claim success, must name the occluder
    const occluded = await call("overlay.cursor.point", {
      locator: { selector: "#under-sticky" },
    });
    const occludedError = occluded?.output?.error ?? null;
    console.log("overlay-cursor-smoke: occluded", JSON.stringify(occluded?.output));

    // --- 3. off-screen target: must be scrolled into view before drawing
    const far = await call("overlay.cursor.point", {
      locator: { selector: "#far-below" },
    });
    const farValue = far?.output?.value ?? far?.output;
    const farGeometry = await page.evaluate(() => {
      const rect = document.querySelector("#far-below").getBoundingClientRect();
      const pointer = document.getElementById("actions-json-ghost-pointer");
      const pointerRect = pointer?.getBoundingClientRect();
      return {
        targetOnScreen: rect.top >= 0 && rect.bottom <= window.innerHeight,
        pointerOnScreen: pointerRect
          ? pointerRect.top >= 0 && pointerRect.bottom <= window.innerHeight
          : false,
      };
    });
    console.log("overlay-cursor-smoke: far", JSON.stringify({ farValue, farGeometry }));

    // --- 4. the overlay pill itself as occluder. Mount the real overlay and
    // park it over a target, then confirm the primitive blames the pill.
    await driver.evaluate(
      (id) => chrome.tabs.sendMessage(id, { type: "actions-json:open-menu-overlay" }),
      tabId,
    );
    await page.waitForFunction(
      () => Boolean(document.querySelector("#__actions_json_menu_overlay_host")),
      null,
      { timeout: 10_000 },
    );
    const pillCovered = await page.evaluate(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const target = document.querySelector("#plain");
      target.scrollIntoView({ block: "center" });
      const rect = target.getBoundingClientRect();
      // Park the overlay squarely on top of the plain target.
      host.style.left = `${rect.left - 20}px`;
      host.style.top = `${rect.top - 20}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.width = "300px";
      host.style.height = "200px";
      const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(centre.x, centre.y);
      return { hitIsOverlay: Boolean(hit?.closest?.("#__actions_json_menu_overlay_host")) };
    });
    if (!pillCovered.hitIsOverlay) {
      throw new Error("Fixture could not get the overlay pill to cover the target.");
    }
    const pillOccluded = await call("overlay.cursor.point", {
      locator: { selector: "#plain" },
    });
    const pillError = pillOccluded?.output?.error ?? null;
    console.log("overlay-cursor-smoke: pill occlusion", JSON.stringify(pillOccluded?.output));

    const shot = path.join(profile, "cursor.png");
    await page.screenshot({ path: shot });

    passed = plainValue?.ok === true
      && plainValue?.receives_events === true
      && plainValue?.actionability_attested === true
      // The cursor is really in the DOM, visible, and the real hit-tester says
      // the point it occupies belongs to the target we claimed to point at.
      && cursorAfterPlain !== null
      && cursorAfterPlain.opacity !== "0"
      && cursorAfterPlain.hitId === "plain"
      // Real sticky paint order produces a reported occlusion, not a success.
      && occludedError?.code === "target_occluded"
      && occludedError?.evidence?.receives_events === false
      // describe() falls back to the "#id" form when an element carries no
      // aria-label or data-testid, which the sticky header deliberately does not.
      && occludedError?.evidence?.occluded_by?.target_label === "#sticky"
      && occludedError?.evidence?.occluded_by?.is_overlay_pill === false
      // Off-screen target really got scrolled into view before drawing.
      && farValue?.ok === true
      && farValue?.scrolled_into_view === true
      && farGeometry.targetOnScreen === true
      && farGeometry.pointerOnScreen === true
      // The overlay pill is named as the occluder when it is the one in the way.
      && pillError?.code === "target_occluded"
      && pillError?.evidence?.occluded_by?.is_overlay_pill === true
      && fs.statSync(shot).size > 0;

    console.log(JSON.stringify({
      plainValue,
      occludedError,
      farValue,
      pillError,
      visualEvidence: true,
      passed,
    }));
  } finally {
    phase("cleanup:start");
    if (context) {
      try {
        await withDeadline(context.close(), 10_000, "Chromium context close");
        phase("browser-close:complete");
      } catch (error) {
        console.warn("overlay-cursor-smoke: context cleanup failed", error);
      }
    }
    try {
      await closeServer(server);
      phase("fixture-listener:closed");
    } catch (error) {
      console.warn("overlay-cursor-smoke: server cleanup failed", error);
    }
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
    phase("cleanup:complete");
  }

  if (!passed) throw new Error("Ghost cursor live smoke did not satisfy its contract.");
  console.log("LIVE GHOST CURSOR SMOKE PASS ✓");
  return 0;
}

const runSupervisor = async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-cursor-smoke-run-"));
  try {
    const result = await superviseLiveSmoke({
      scriptPath: fileURLToPath(import.meta.url),
      timeoutMs: SMOKE_TIMEOUT_MS,
      killGraceMs: 3_000,
      env: { ACTIONS_JSON_SMOKE_RUN_DIR: runDir },
    });
    if (result.timedOut) {
      console.error(`Ghost cursor live smoke exceeded ${SMOKE_TIMEOUT_MS} milliseconds; last_phase=${result.lastPhase}.`);
      return 124;
    }
    if (result.signal) {
      console.error(`overlay-cursor-smoke: worker exited by ${result.signal}; last_phase=${result.lastPhase}`);
      return 1;
    }
    return Number.isInteger(result.code) ? result.code : 2;
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
};

const entry = process.env.ACTIONS_JSON_LIVE_SMOKE_CHILD === "1"
  ? runWorker().catch((error) => { console.error(error); return 2; })
  : runSupervisor();

entry.then((code) => { process.exitCode = code; });
