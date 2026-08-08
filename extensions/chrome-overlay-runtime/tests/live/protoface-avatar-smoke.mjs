// Self-driven live smoke for the experimental Protoface overlay. It loads the
// real unpacked extension in Chromium and proves that extension storage selects
// the avatar URL, the visible extension page renders the stage, the pinned
// browser bundle imports successfully, and disabling the setting restores the
// ordinary URL. It deliberately does not claim a live avatar session; that gate
// requires real Protoface and LiveKit credentials in the broker environment.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "../..");
const SETTING_KEY = "ACTIONS_JSON_PROTOFACE_SETTINGS_V1";
const CREDENTIAL_KEY = "ACTIONS_JSON_PROTOFACE_CREDENTIALS_V1";

async function sendWhenReady(extensionPage, tabId, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await extensionPage.evaluate(
        ([id, payload]) => new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(id, payload, (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          });
        }),
        [tabId, message],
      );
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Content-script receiver did not become ready: ${lastError?.message || lastError}`);
}

async function main() {
  execFileSync("node", [path.join(EXT, "esbuild.a11y.mjs")], { stdio: "inherit" });
  execFileSync("node", [path.join(EXT, "esbuild.protoface.mjs")], { stdio: "inherit" });

  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Protoface smoke</title><h1>Fixture</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "protoface-avatar-smoke-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });

  let passed = false;
  try {
    console.log("Protoface smoke: Chromium launched");
    const serviceWorker = context.serviceWorkers()[0]
      || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    console.log("Protoface smoke: extension service worker ready");
    const configPage = await context.newPage();
    await configPage.goto(`chrome-extension://${extensionId}/agent-surface.html?tab=config`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    console.log("Protoface smoke: settings page ready");
    await configPage.locator("#protofaceEnabled").check();
    await configPage.locator("#protofaceConnectionMode").selectOption("direct");
    await configPage.locator("#protofaceAvatarId").fill("av_stock_001");
    await configPage.locator("#protofaceApiKey").fill("smoke-only-placeholder");
    await configPage.locator("#livekitUrl").fill("wss://livekit.example/");
    await configPage.locator("#livekitApiKey").fill("smoke-only-key");
    await configPage.locator("#livekitApiSecret").fill("smoke-only-secret");
    await configPage.locator("#saveProtofaceCredentials").click();
    await configPage.locator("#protofaceSettingsStatus").filter({
      hasText: "Reopen the actions.json overlay to use Protoface",
    }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("Protoface smoke: combined settings save confirmed");

    const persistedConfiguration = await configPage.evaluate(
      ([settingKey, credentialKey]) => new Promise((resolve, reject) => {
        chrome.storage.local.get([settingKey, credentialKey], (stored) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(stored);
        });
      }),
      [SETTING_KEY, CREDENTIAL_KEY],
    );
    if (!persistedConfiguration[SETTING_KEY]?.enabled) {
      throw new Error("Saving credentials did not preserve the enabled Protoface setting.");
    }
    if (persistedConfiguration[CREDENTIAL_KEY]?.source !== "manual") {
      throw new Error("Saving credentials did not persist the manual credential source.");
    }
    console.log("Protoface smoke: both storage records verified");

    const page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    console.log("Protoface smoke: fixture page ready");
    const tabId = await configPage.evaluate((url) => new Promise((resolve, reject) => {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(tabs.find((tab) => tab.url === url)?.id ?? null);
      });
    }), fixtureUrl);
    console.log("Protoface smoke: fixture tab resolved");
    if (tabId === null) throw new Error("Fixture tab was not visible to the extension.");

    await configPage.evaluate(
      (id) => new Promise((resolve, reject) => {
        chrome.scripting.executeScript({ target: { tabId: id }, files: ["src/content.js"] }, (result) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      }),
      tabId,
    );
    console.log("Protoface smoke: content runtime injected");

    const opened = await sendWhenReady(configPage, tabId, { type: "actions-json:open-menu-overlay" });
    if (!opened?.ok) throw new Error(`Could not open agent overlay: ${JSON.stringify(opened)}`);
    console.log("Protoface smoke: overlay open acknowledged");
    await page.waitForFunction(() => (
      document.querySelector("#__actions_json_menu_overlay_host")
        ?.shadowRoot?.querySelector("iframe[title='actions.json agent']")
    ), null, { timeout: 10_000 });
    console.log("stored settings:", persistedConfiguration[SETTING_KEY]);
    console.log("initial iframe:", await page.evaluate(() => (
      document.querySelector("#__actions_json_menu_overlay_host")
        ?.shadowRoot?.querySelector("iframe[title='actions.json agent']")?.src || ""
    )));
    await page.waitForFunction(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const source = host?.shadowRoot?.querySelector("iframe[title='actions.json agent']")?.src || "";
      return source.includes("avatar=protoface");
    }, null, { timeout: 10_000 });
    console.log("Protoface smoke: avatar query selected");
    const selectedUrl = await page.evaluate(() => (
      document.querySelector("#__actions_json_menu_overlay_host")
        ?.shadowRoot?.querySelector("iframe[title='actions.json agent']")?.src || ""
    ));

    const avatarUrl = `chrome-extension://${extensionId}/agent-surface.html?surface=overlay&tab=agent&avatar=protoface`;
    await configPage.goto(avatarUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await configPage.locator("#protofaceStage").waitFor({ state: "visible", timeout: 10_000 });
    console.log("Protoface smoke: avatar stage visible");
    const bundleContract = await configPage.evaluate(async () => {
      const module = await import(chrome.runtime.getURL("dist/protoface-client-bundle.mjs"));
      return typeof module.ProtofaceClient;
    });

    await configPage.evaluate(([key]) => new Promise((resolve, reject) => {
      chrome.storage.local.set({
        [key]: {
          enabled: false,
          connectionMode: "direct",
          brokerUrl: "http://127.0.0.1:3000/api/protoface/session-token",
          avatarId: "av_stock_001",
        },
      }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    }), [SETTING_KEY]);
    await configPage.evaluate(
      (id) => new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(id, { type: "actions-json:close-overlay" }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      }),
      tabId,
    );
    await page.waitForFunction(() => !document.querySelector("#__actions_json_menu_overlay_host"), null, { timeout: 10_000 });
    await configPage.evaluate(
      (id) => new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(id, { type: "actions-json:open-menu-overlay" }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      }),
      tabId,
    );
    await page.waitForFunction(() => {
      const host = document.querySelector("#__actions_json_menu_overlay_host");
      const source = host?.shadowRoot?.querySelector("iframe[title='actions.json agent']")?.src || "";
      return source.length > 0 && !source.includes("avatar=protoface");
    }, null, { timeout: 10_000 });
    const ordinaryUrl = await page.evaluate(() => (
      document.querySelector("#__actions_json_menu_overlay_host")
        ?.shadowRoot?.querySelector("iframe[title='actions.json agent']")?.src || ""
    ));

    passed = selectedUrl.includes("avatar=protoface")
      && bundleContract === "function"
      && !ordinaryUrl.includes("avatar=protoface");
    console.log(JSON.stringify({ selectedUrl, bundleContract, ordinaryUrl, passed }));
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (!passed) throw new Error("Protoface live smoke did not satisfy its contract.");
  console.log("LIVE PROTOFACE SMOKE PASS ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
