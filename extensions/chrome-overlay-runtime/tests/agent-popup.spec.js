const { test, expect } = require("@playwright/test");
const fs = require("fs/promises");
const path = require("path");

const extensionRoot = path.join(__dirname, "..");

// Imported, not retyped. If the pill's table renames "Listening" or repaints it,
// these assertions follow it — which is the whole point of the shared
// vocabulary. A literal string here would let the two surfaces drift silently.
const pillPresentationPromise = import("../src/agent/pill-presentation.mjs");

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
    window.__actionsJsonOptionsPageOpened = 0;
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
    // A real key/value store so the overlay-settings round trip (read defaults,
    // toggle, persist, re-read) is exercised rather than stubbed to a constant.
    window.__actionsJsonStored = {};
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
        async openOptionsPage() {
          window.__actionsJsonOptionsPageOpened += 1;
        },
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          if (message.type === "actions-json:agent-session-state") {
            return {
              ok: true,
              state: window.__actionsJsonInitialVoiceState || {
                status: "connected",
                model: "gpt-realtime-2.1",
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
              state: { status: "connected", model: "gpt-realtime-2.1", error: null, inputMuted: false },
            };
          }
          if (message.type === "actions-json:agent-session-mute") {
            return {
              ok: true,
              state: { status: "connected", model: "gpt-realtime-2.1", error: null, inputMuted: true },
            };
          }
          return {
            ok: true,
            state: { status: "stopped", model: "gpt-realtime-2.1", error: null, inputMuted: false },
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (key === "bridgeUrl") {
              return { bridgeUrl: "ws://127.0.0.1:17345/extension" };
            }
            if (typeof key === "string") {
              return key in window.__actionsJsonStored
                ? { [key]: window.__actionsJsonStored[key] }
                : {};
            }
            return { ...window.__actionsJsonStored };
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

test("popup is a designed surface, not a portal to another surface's viewport", async ({ page }) => {
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  // The defect U7 exists to remove: a 360px window wrapping a 430px iframe of
  // a screen built for a different viewport.
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("#openStorageTools")).toHaveCount(0);
  // The seven accordions belong on the options page now.
  await expect(page.locator("details")).toHaveCount(0);
});

test("All settings opens the options page in a real tab", async ({ page }) => {
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  await page.locator("#allSettings").click();

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonOptionsPageOpened))
    .toBe(1);
});

test("popup exposes direct durable voice session controls", async ({ page }) => {
  await installPopupHarness(page);
  await page.addInitScript(() => {
    window.__actionsJsonInitialVoiceState = {
      status: "disconnected",
      model: "gpt-realtime-2.1",
      error: null,
      inputMuted: false,
    };
  });
  const { PILL_STATE_TOKENS } = await pillPresentationPromise;
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#sessionState")).toHaveText(PILL_STATE_TOKENS.idle.label);
  await expect(page.locator("#startVoice")).toBeEnabled();
  await expect(page.locator("#muteVoice")).toBeDisabled();
  await expect(page.locator("#stopVoice")).toBeEnabled();

  await page.locator("#startVoice").click();
  await expect(page.locator("#sessionState")).toHaveText(PILL_STATE_TOKENS.listening.label);
  await expect(page.locator("#muteVoice")).toBeEnabled();
  await page.locator("#muteVoice").click();
  await page.locator("#stopVoice").click();

  const runtimeMessages = await page.evaluate(() => window.__actionsJsonRuntimeMessages);
  // Filter to the session channel: the popup also probes for website-agent
  // proposals on open, and that unrelated message races the session traffic.
  const sessionMessages = runtimeMessages.filter((message) =>
    message.type.startsWith("actions-json:agent-session-"),
  );
  expect(sessionMessages.map((message) => message.type)).toEqual([
    "actions-json:agent-session-state",
    "actions-json:agent-session-start",
    "actions-json:agent-session-mute",
    "actions-json:agent-session-close",
  ]);
  expect(sessionMessages[1]).toMatchObject({ textOnly: false });
  expect(sessionMessages[2]).toMatchObject({ muted: true });
});

test("popup warns and disables take-control on a Chrome internal page", async ({ page }) => {
  await installPopupHarness(page);
  await page.addInitScript(() => {
    window.chrome.tabs.query = async () => [
      { id: 555, url: "chrome://extensions/" },
    ];
  });
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#tabNotice")).toBeVisible();
  await expect(page.locator("#tabNotice")).toContainText("internal page");
  await expect(page.locator("#authorize")).toBeDisabled();
  await expect(page.locator("#openMenu")).toBeDisabled();
});

test("popup keeps take-control enabled on an ordinary website tab", async ({ page }) => {
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#tabNotice")).toBeHidden();
  await expect(page.locator("#authorize")).toBeEnabled();
  await expect(page.locator("#openMenu")).toBeEnabled();
});

test("session state renders the pill's shared vocabulary and its hue, not popup-local strings", async ({ page }) => {
  const { PILL_STATE_TOKENS } = await pillPresentationPromise;
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  // The harness's default session state is `connected` + unmuted.
  await expect(page.locator("#sessionState")).toHaveText(PILL_STATE_TOKENS.listening.label);
  await expect(page.locator("#stateBlock")).toHaveAttribute("data-state", "listening");
  // The hue comes from the shared token table, not a colour typed into the CSS.
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.getElementById("stateBlock").style.getPropertyValue("--state-hue").trim(),
      ),
    )
    .toBe(PILL_STATE_TOKENS.listening.hue);

  // Muting must win over the transport's "connected", and it must use the
  // pill's alarm state rather than a popup-local "(muted)" suffix.
  await page.locator("#muteVoice").click();
  await expect(page.locator("#sessionState")).toHaveText(PILL_STATE_TOKENS.muted.label);
  await expect(page.locator("#stateBlock")).toHaveAttribute("data-state", "muted");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.getElementById("stateBlock").style.getPropertyValue("--state-hue").trim(),
      ),
    )
    .toBe(PILL_STATE_TOKENS.muted.hue);
});

test("show cost meter defaults off on a fresh profile and persists both ways", async ({ page }) => {
  const { OVERLAY_SETTINGS_STORAGE_KEY } = await import(
    "../src/agent/overlay-settings-store.mjs"
  );
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  // Fresh profile: nothing stored, and the toggle reflects the store's default.
  await expect(page.locator("#showCost")).not.toBeChecked();

  await page.locator("#showCost").click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__actionsJsonStored[key]?.showCost,
        OVERLAY_SETTINGS_STORAGE_KEY,
      ),
    )
    .toBe(true);

  // And back off again — a toggle that only ever writes `true` would pass a
  // one-directional check.
  await page.locator("#showCost").click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__actionsJsonStored[key]?.showCost,
        OVERLAY_SETTINGS_STORAGE_KEY,
      ),
    )
    .toBe(false);
});

test("developer mode persists through the shared overlay settings store", async ({ page }) => {
  const { OVERLAY_SETTINGS_STORAGE_KEY } = await import(
    "../src/agent/overlay-settings-store.mjs"
  );
  await installPopupHarness(page);
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#devMode")).not.toBeChecked();
  await page.locator("#devMode").click();

  await expect
    .poll(() =>
      page.evaluate(
        (key) => window.__actionsJsonStored[key]?.devMode,
        OVERLAY_SETTINGS_STORAGE_KEY,
      ),
    )
    .toBe(true);
  // Flipping one toggle must not clobber the other fields of the shared object.
  expect(
    await page.evaluate(
      (key) => window.__actionsJsonStored[key]?.showCost,
      OVERLAY_SETTINGS_STORAGE_KEY,
    ),
  ).toBe(false);
});

test("stored overlay settings are reflected when the popup opens", async ({ page }) => {
  const { OVERLAY_SETTINGS_STORAGE_KEY } = await import(
    "../src/agent/overlay-settings-store.mjs"
  );
  await installPopupHarness(page);
  await page.addInitScript((key) => {
    window.__actionsJsonStored = {
      [key]: { showCost: true, devMode: true, restingCorner: "bottom-right", reducedMotion: "system" },
    };
  }, OVERLAY_SETTINGS_STORAGE_KEY);
  await page.goto("https://actions-json.test/popup.html");

  await expect(page.locator("#showCost")).toBeChecked();
  await expect(page.locator("#devMode")).toBeChecked();
});

test("popup.js keeps the bridge default byte-identical to the other surfaces", async () => {
  const defaultUrl = 'const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";';
  const surfaces = ["popup.js", "agent-surface.js", "background.js", "agent/hosted-tool-executor.mjs"];
  for (const relativePath of surfaces) {
    const source = await fs.readFile(path.join(extensionRoot, "src", relativePath), "utf8");
    expect(source, `${relativePath} must carry the localhost bridge default`).toContain(defaultUrl);
  }
});
