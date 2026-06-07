const { test, expect } = require("@playwright/test");
const fs = require("fs/promises");
const path = require("path");

const extensionRoot = path.join(__dirname, "..");

async function routeExtensionAssets(page) {
  await page.route("https://actions-json.test/**", async (route) => {
    const url = new URL(route.request().url());
    const relativePath = url.pathname === "/" ? "popup.html" : url.pathname.slice(1);
    const filePath = path.join(extensionRoot, relativePath);
    const contentType = filePath.endsWith(".html")
      ? "text/html"
      : filePath.endsWith(".mjs") || filePath.endsWith(".js")
        ? "text/javascript"
        : "text/plain";
    await route.fulfill({
      contentType,
      body: await fs.readFile(filePath),
    });
  });
}

async function installPopupHarness(page) {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonRuntimeMessages = [];
    window.__actionsJsonTabMessages = [];
    window.__actionsJsonPopupClosed = false;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          return {
            getTracks() {
              return [{ stop() {} }];
            },
          };
        },
      },
    });
    window.close = () => {
      window.__actionsJsonPopupClosed = true;
    };
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          if (message.type === "actions-json:agent-session-state") {
            return {
              ok: true,
              state: window.__actionsJsonInitialVoiceState || {
                status: "connected",
                model: "gpt-realtime-2",
                error: null,
                inputMuted: false,
              },
            };
          }
          if (message.type === "actions-json:authorize-tab") {
            return { ok: true, runtimeKey: "chrome-tab:101" };
          }
          if (message.type === "actions-json:agent-session-start") {
            return {
              ok: true,
              state: { status: "connected", model: "gpt-realtime-2", error: null, inputMuted: false },
            };
          }
          if (message.type === "actions-json:agent-session-mute") {
            return {
              ok: true,
              state: { status: "connected", model: "gpt-realtime-2", error: null, inputMuted: true },
            };
          }
          return {
            ok: true,
            state: { status: "stopped", model: "gpt-realtime-2", error: null, inputMuted: false },
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (key === "bridgeUrl") {
              return { bridgeUrl: "ws://127.0.0.1:17345/extension" };
            }
            return {};
          },
          async set(values) {
            window.__actionsJsonStored = { ...(window.__actionsJsonStored || {}), ...values };
          },
        },
      },
      tabs: {
        async create(createProperties) {
          window.__actionsJsonCreatedTab = createProperties;
          return { id: 202, ...createProperties };
        },
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonTabMessages.push({ tabId, ...message });
          return { ok: true };
        },
      },
    };
  });
}

test("popup opens the actions.json menu, removes close overlay, and closes itself", async ({ page }) => {
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#authorize")).toHaveText("Take control of this tab");
  await expect(page.locator("#closeOverlay")).toHaveCount(0);
  await page.locator("#openMenu").click();

  const runtimeMessages = await page.evaluate(() => window.__actionsJsonRuntimeMessages);
  expect(runtimeMessages).toContainEqual({
    type: "actions-json:authorize-tab",
    tabId: 101,
    bridgeUrl: "ws://127.0.0.1:17345/extension",
  });
  expect(await page.evaluate(() => window.__actionsJsonTabMessages)).toEqual([
    { tabId: 101, type: "actions-json:open-menu-overlay" },
  ]);
  expect(await page.evaluate(() => window.__actionsJsonPopupClosed)).toBe(true);
});

test("popup opens storage tools in a top-level extension tab", async ({ page }) => {
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  await page.locator("#openStorageTools").click();

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonCreatedTab))
    .toEqual({ url: "https://actions-json.test/sidepanel.html?tab=config&surface=top-level" });
  expect(await page.evaluate(() => window.__actionsJsonPopupClosed)).toBe(true);
});

test("popup exposes direct durable voice session controls", async ({ page }) => {
  await installPopupHarness(page);
  await page.addInitScript(() => {
    window.__actionsJsonInitialVoiceState = {
      status: "disconnected",
      model: "gpt-realtime-2",
      error: null,
      inputMuted: false,
    };
  });
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#voiceState")).toContainText("Disconnected");
  await expect(page.locator("#startVoice")).toBeEnabled();
  await expect(page.locator("#muteVoice")).toBeDisabled();
  await expect(page.locator("#stopVoice")).toBeEnabled();

  await page.locator("#startVoice").click();
  await expect(page.locator("#voiceState")).toContainText("Live");
  await expect(page.locator("#muteVoice")).toBeEnabled();
  await page.locator("#muteVoice").click();
  await page.locator("#stopVoice").click();

  const runtimeMessages = await page.evaluate(() => window.__actionsJsonRuntimeMessages);
  expect(runtimeMessages.map((message) => message.type)).toEqual([
    "actions-json:agent-session-state",
    "actions-json:agent-session-start",
    "actions-json:agent-session-mute",
    "actions-json:agent-session-close",
  ]);
  expect(runtimeMessages[1]).toMatchObject({ textOnly: false });
  expect(runtimeMessages[2]).toMatchObject({ muted: true });
});
