// Self-driven live smoke for overlay.menu.collapse and overlay.menu.expand.
// Loads the real unpacked extension in Chromium, drives the same
// chrome.tabs.sendMessage path used by bridge actions, proves both structured
// outputs, and verifies the visible shadow-DOM affordance and geometry.
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
const SMOKE_TIMEOUT_MS = Number.parseInt(process.env.ACTIONS_JSON_SMOKE_TIMEOUT_MS || "45000", 10);
const TIMEOUT_AFTER_PROFILE_MS = process.env.ACTIONS_JSON_SMOKE_TIMEOUT_AFTER_PROFILE_MS
  ? Number.parseInt(process.env.ACTIONS_JSON_SMOKE_TIMEOUT_AFTER_PROFILE_MS, 10)
  : null;
const HANG_AFTER_LAUNCH = process.env.ACTIONS_JSON_SMOKE_HANG_AFTER_LAUNCH === "1";

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
  await withDeadline(closed, 5_000, "menu collapse fixture server close");
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
      response.end("<!doctype html><title>Menu collapse smoke</title><main><h1>Fixture</h1></main>");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    phase("fixture-listener:ready");
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
    const runDir = process.env.ACTIONS_JSON_SMOKE_RUN_DIR
      || fs.mkdtempSync(path.join(os.tmpdir(), "menu-collapse-smoke-"));
    fs.mkdirSync(runDir, { recursive: true });
    profile = path.join(runDir, "profile");
    fs.mkdirSync(profile, { recursive: true });
    console.log(`menu-collapse-smoke: profile created ${profile}`);
    phase("profile:created");
    if (TIMEOUT_AFTER_PROFILE_MS !== null) {
      await new Promise((resolve) => setTimeout(resolve, TIMEOUT_AFTER_PROFILE_MS));
      throw new Error(`Menu collapse live smoke exceeded ${TIMEOUT_AFTER_PROFILE_MS} milliseconds after profile creation.`);
    }
    phase("browser-launch:start");
    context = await withDeadline(runWithInheritedProcessGroup(
      () => chromium.launchPersistentContext(profile, {
        headless: false,
        timeout: 15_000,
        args: [
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`,
          "--no-first-run",
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
        ],
      }),
    ), 20_000, "Chromium persistent-context launch");
    const ownership = assertDescendantsShareProcessGroup();
    console.log(`menu-collapse-smoke: owned process group=${ownership.pgid} descendants=${ownership.descendantCount}`);
    phase("browser-launch:complete");
    console.log("menu-collapse-smoke: Chromium launched");
    if (HANG_AFTER_LAUNCH) {
      phase("forced-hang:after-launch");
      await new Promise(() => {});
    }
    const serviceWorker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    console.log("menu-collapse-smoke: service worker ready");
    const extensionId = new URL(serviceWorker.url()).host;
    await context.route("https://api.openai.com/**", (route) => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Smoke-test credential rejected as expected." } }),
    }));
    const page = context.pages()[0] || await context.newPage();
    page.on("pageerror", (error) => {
      console.error("menu-collapse-smoke: page error", error);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error("menu-collapse-smoke: page console error", message.text());
      }
    });
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await driver.evaluate(() => chrome.storage.local.set({
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-actions-json-packaged-smoke-not-a-secret",
    }));
    await page.goto(fixtureUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    console.log("menu-collapse-smoke: fixture committed");
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
    console.log("menu-collapse-smoke: content script injection", JSON.stringify(injection));
    if (!injection.ok) throw new Error(`Content script injection failed: ${JSON.stringify(injection)}`);
    const opened = await driver.evaluate(
      (id) => chrome.tabs.sendMessage(id, { type: "actions-json:open-menu-overlay" }),
      tabId,
    );
    if (!opened?.ok) throw new Error(`Could not open menu overlay: ${JSON.stringify(opened)}`);
    console.log("menu-collapse-smoke: overlay opened");

    await page.waitForFunction(() => Boolean(document.querySelector("#__actions_json_menu_overlay_host")), null, {
      timeout: 10_000,
    });
    const agentFrame = page.frames().find((frame) => frame.url().includes("/agent-surface.html"));
    if (!agentFrame) throw new Error("Agent surface iframe did not mount.");
    const freshResting = await page.evaluate(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const rect = host.getBoundingClientRect();
      const iframe = host.shadowRoot.querySelector("iframe");
      iframe.dataset.smokeIdentity = "mounted-once";
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        disclosure: host.dataset.disclosureState,
        barDisplay: getComputedStyle(host.shadowRoot.querySelector(".bar")).display,
        iframeSrc: iframe.src,
        parentOrigin: new URL(iframe.src).searchParams.get("parentOrigin"),
      };
    });
    await agentFrame.locator("#agentPanel[data-disclosure='resting']").waitFor();
    await agentFrame.locator("#agentPill").dispatchEvent("pointerenter");
    await page.waitForFunction(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const rect = host?.getBoundingClientRect();
      return host?.dataset.disclosureState === "controls" && Math.round(rect?.height || 0) === 118;
    });
    const controlsGeometry = await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
      const rect = host.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    await agentFrame.locator("#agentPillToggle").click();
    await page.waitForFunction(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const rect = host?.getBoundingClientRect();
      return host?.dataset.disclosureState === "opened" && Math.round(rect?.height || 0) === 420;
    });
    await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
      host.style.left = "118px";
      host.style.top = "77px";
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.width = "300px";
      host.style.height = "260px";
    });
    const startVoice = agentFrame.locator("#overlayStartAgent");
    await startVoice.waitFor({ state: "visible" });
    const configuredStart = await startVoice.textContent();
    await startVoice.click();
    await agentFrame.locator("#overlayStartAgent").filter({ hasText: "Connecting" }).waitFor();
    const connectingSeen = true;
    await agentFrame.locator("#overlayStartAgent").filter({ hasText: "Retry voice" }).waitFor({
      timeout: 20_000,
    });
    const retryLabel = await startVoice.textContent();
    const voiceActivation = { configuredStart, connectingSeen, retryLabel };

    let callSequence = 0;
    const call = (name) => driver.evaluate(
      ([id, action, sequence]) => chrome.tabs.sendMessage(id, {
        type: "actions-json:execute-action",
        call_id: `smoke-${action}-${sequence}`,
        name: action,
        arguments: {},
      }),
      [tabId, name, ++callSequence],
    );
    const payload = (response) => {
      if (response?.ok !== true || !Object.prototype.hasOwnProperty.call(response, "output")) {
        throw new Error(`Action response violated the runtime envelope: ${JSON.stringify(response)}`);
      }
      return response.output;
    };

    // R6: record where the collapse affordance is BEFORE the press. The
    // collapsed square must land on that point — the shipped build pinned the
    // panel's own top-left instead, so a wide panel collapsed away from the
    // right-edge control the user had just touched.
    const pressedCentre = await page.evaluate(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const rect = host.shadowRoot.querySelector("[data-minimize]").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    const collapsed = payload(await call("overlay.menu.collapse"));
    await page.waitForFunction(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const button = host?.shadowRoot?.querySelector("[data-minimize]");
      const rect = host?.getBoundingClientRect();
      // The control promises EXPANDING and is not a hamburger: ☰ reads as
      // "open a menu" and is what made a live installer believe the overlay
      // had closed.
      return rect?.width === 42
        && rect?.height === 42
        && /expand/i.test(button?.title || "")
        && /expand/i.test(button?.getAttribute("aria-label") || "")
        && button?.textContent?.trim() !== "☰";
    }, null, { timeout: 10_000 });

    // Anchored to the press, still on screen, and the agent iframe is still
    // mounted and rendered so the collapsed square can show a live session.
    const collapsedGeometry = await page.evaluate((centre) => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const rect = host.getBoundingClientRect();
      const iframe = host.shadowRoot.querySelector("iframe");
      const body = host.shadowRoot.querySelector(".body");
      const iframeRect = iframe?.getBoundingClientRect();
      return {
        containsPress: rect.left <= centre.x && rect.right >= centre.x
          && rect.top <= centre.y && rect.bottom >= centre.y,
        onScreen: rect.left >= 0 && rect.top >= 0
          && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
        iframeMounted: Boolean(iframe),
        bodyDisplay: body ? getComputedStyle(body).display : null,
        iframeDisplay: iframe ? getComputedStyle(iframe).display : null,
        iframeWidth: iframeRect?.width ?? 0,
        iframeHeight: iframeRect?.height ?? 0,
      };
    }, pressedCentre);
    console.log("menu-collapse-smoke: collapsed geometry", JSON.stringify(collapsedGeometry));
    const collapsedAgain = payload(await call("overlay.menu.collapse"));
    const collapsedShot = path.join(profile, "collapsed.png");
    await page.screenshot({ path: collapsedShot });

    const expanded = payload(await call("overlay.menu.expand"));
    await page.waitForFunction(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const button = host?.shadowRoot?.querySelector("[data-minimize]");
      const rect = host?.getBoundingClientRect();
      return rect?.width === 300
        && rect?.height === 260
        && /collapse/i.test(button?.title || "")
        && !/menu/i.test(button?.title || "");
    }, null, { timeout: 10_000 });
    const expandedAgain = payload(await call("overlay.menu.expand"));
    const expandedShot = path.join(profile, "expanded.png");
    await page.screenshot({ path: expandedShot });
    await agentFrame.locator("body").press("Escape");
    const restoredResting = await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
      const rect = host.getBoundingClientRect();
      const iframe = host.shadowRoot.querySelector("iframe");
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        disclosure: host.dataset.disclosureState,
        iframeIdentity: iframe.dataset.smokeIdentity,
        iframeSrc: iframe.src,
      };
    });

    const checks = {
      freshResting: freshResting.width === 340
        && freshResting.height === 62
        && freshResting.disclosure === "resting"
        && freshResting.barDisplay === "none"
        && freshResting.parentOrigin === new URL(fixtureUrl).origin,
      controls: controlsGeometry.width === 340
        && controlsGeometry.height === 118,
      collapsed: collapsed?.ok === true
        && collapsed?.collapsed === true
        && collapsed?.geometry?.width === 42
        && collapsed?.geometry?.height === 42,
      // R6 contract: anchored to the press, clamped on screen, and the agent
      // iframe still mounted and rendered so the compact live state remains.
      collapsedPresentation: collapsedGeometry.containsPress === true
        && collapsedGeometry.onScreen === true
        && collapsedGeometry.iframeMounted === true
        && collapsedGeometry.bodyDisplay !== "none"
        && collapsedGeometry.iframeDisplay !== "none"
        && collapsedGeometry.iframeWidth > 0
        && collapsedGeometry.iframeHeight > 0,
      collapseIdempotent: collapsedAgain?.ok === true
        && collapsedAgain?.collapsed === true
        && collapsedAgain?.geometry?.width === 42
        && collapsedAgain?.geometry?.height === 42,
      expanded: expanded?.ok === true
        && expanded?.collapsed === false
        && expanded?.geometry?.width === 300
        && expanded?.geometry?.height === 260,
      expandIdempotent: expandedAgain?.ok === true
        && expandedAgain?.collapsed === false
        && expandedAgain?.geometry?.width === 300
        && expandedAgain?.geometry?.height === 260,
      restored: restoredResting.width === 340
        && restoredResting.height === 62
        && restoredResting.disclosure === "resting",
      iframePreserved: restoredResting.iframeIdentity === "mounted-once"
        && restoredResting.iframeSrc === freshResting.iframeSrc,
      screenshots: fs.statSync(collapsedShot).size > 0
        && fs.statSync(expandedShot).size > 0,
      voiceActivation: voiceActivation.configuredStart === "Start voice"
        && voiceActivation.connectingSeen === true
        && voiceActivation.retryLabel === "Retry voice",
    };
    passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({
      freshResting,
      controlsGeometry,
      collapsed,
      collapsedAgain,
      expanded,
      expandedAgain,
      restoredResting,
      voiceActivation,
      checks,
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
        console.warn("menu-collapse-smoke: context cleanup failed", error);
      }
    }
    try {
      await closeServer(server);
      phase("fixture-listener:closed");
    } catch (error) {
      console.warn("menu-collapse-smoke: server cleanup failed", error);
    }
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
    phase("cleanup:complete");
  }

  if (!passed) throw new Error("Menu collapse live smoke did not satisfy its contract.");
  console.log("LIVE MENU COLLAPSE SMOKE PASS ✓");
  return 0;
}

const runSupervisor = async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "menu-collapse-smoke-run-"));
  try {
    const result = await superviseLiveSmoke({
      scriptPath: fileURLToPath(import.meta.url),
      timeoutMs: SMOKE_TIMEOUT_MS,
      killGraceMs: 3_000,
      env: { ACTIONS_JSON_SMOKE_RUN_DIR: runDir },
    });
    if (result.timedOut) {
      console.error(`Menu collapse live smoke exceeded ${SMOKE_TIMEOUT_MS} milliseconds; last_phase=${result.lastPhase}.`);
      return 124;
    }
    if (result.signal) {
      console.error(`menu-collapse-smoke: worker exited by ${result.signal}; last_phase=${result.lastPhase}`);
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
