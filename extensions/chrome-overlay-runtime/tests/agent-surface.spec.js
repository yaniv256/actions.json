const { test, expect } = require("@playwright/test");
const fs = require("fs/promises");
const path = require("path");

const extensionRoot = path.join(__dirname, "..");

async function routeExtensionAssets(page) {
  await page.route("https://actions-json.test/**", async (route) => {
    const url = new URL(route.request().url());
    const relativePath = url.pathname === "/" ? "agent-surface.html" : url.pathname.slice(1);
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

async function openAgentTab(page) {
  await page.evaluate(() => {
    document.querySelector("#agentPanel").hidden = false;
    document.querySelector("#configPanel").hidden = true;
  });
}

async function openConfigTab(page) {
  await page.evaluate(() => {
    document.querySelector("#agentPanel").hidden = true;
    document.querySelector("#configPanel").hidden = false;
  });
}

test("Protoface avatar stage is absent from the ordinary hosted-agent surface", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.chrome = {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: {
        local: {
          async get(key) { return typeof key === "string" ? { [key]: window.__actionsJsonStorage[key] } : { ...window.__actionsJsonStorage }; },
          async set(values) { Object.assign(window.__actionsJsonStorage, values); },
          async remove(key) { delete window.__actionsJsonStorage[key]; },
        },
      },
      tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; } },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await expect(page.locator("#protofaceStage")).toHaveCount(1);
  await expect(page.locator("#protofaceStage")).toBeHidden();
});

test("Protoface overlay falls back to voice while keeping the hosted agent live", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.route("https://broker.example/protoface/session-token", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "demo broker offline" }),
  }));
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__actionsJsonStorage = {
      ACTIONS_JSON_PROTOFACE_SETTINGS_V1: {
        enabled: true,
        brokerUrl: "https://broker.example/protoface/session-token",
        avatarId: "av_demo",
      },
    };
    window.chrome = {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: {
        local: {
          async get(key) { return typeof key === "string" ? { [key]: window.__actionsJsonStorage[key] } : { ...window.__actionsJsonStorage }; },
          async set(values) { Object.assign(window.__actionsJsonStorage, values); },
          async remove(key) { delete window.__actionsJsonStorage[key]; },
        },
      },
      tabs: {
        async query() { return [{ id: 101, url: "https://example.test/" }]; },
        async sendMessage() { return { ok: true }; },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&avatar=protoface");
  await expect(page.locator("#protofaceStage")).toBeVisible();
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();

  await expect(page.locator("#protofaceStatus")).toHaveText("Voice-only fallback");
  await expect(page.locator("#agentState")).toHaveText("Live");
  await expect(page.locator("#transcript")).toContainText("Voice session started");
});

test("Protoface credentials can be saved directly without refilling secret inputs", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.chrome = {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: {
        local: {
          async get(key) { return typeof key === "string" ? { [key]: window.__actionsJsonStorage[key] } : { ...window.__actionsJsonStorage }; },
          async set(values) { Object.assign(window.__actionsJsonStorage, values); },
          async remove(key) { delete window.__actionsJsonStorage[key]; },
        },
      },
      tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; } },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");
  await page.locator("#protofaceConnectionMode").selectOption("direct");
  await expect(page.locator("#protofaceDirectCredentialFields")).toBeVisible();
  await expect(page.locator("#protofaceBrokerFields")).toBeHidden();
  await page.locator("#protofaceApiKey").fill("pf_secret_1234567890");
  await page.locator("#livekitUrl").fill("wss://demo.livekit.cloud");
  await page.locator("#livekitApiKey").fill("APIabcdef123456");
  await page.locator("#livekitApiSecret").fill("livekit-secret-1234567890");
  await page.locator("#saveProtofaceCredentials").click();

  await expect(page.locator("#protofaceCredentialStatus")).toContainText("manual");
  await expect(page.locator("#protofaceApiKey")).toHaveValue("");
  await expect(page.locator("#livekitApiSecret")).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_PROTOFACE_CREDENTIALS_V1?.source)).toBe("manual");

  await page.locator("#clearProtofaceCredentials").click();
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("not configured");
  await expect.poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_PROTOFACE_CREDENTIALS_V1)).toBeUndefined();
});

test("saving direct Protoface credentials also persists the visible avatar configuration", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.__protofaceConfigurationWrites = 0;
    window.chrome = {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: {
        local: {
          async get(key) { return typeof key === "string" ? { [key]: window.__actionsJsonStorage[key] } : { ...window.__actionsJsonStorage }; },
          async set(values) {
            if (values.ACTIONS_JSON_PROTOFACE_CREDENTIALS_V1) {
              window.__protofaceConfigurationWrites += 1;
              await new Promise((resolve) => setTimeout(resolve, 75));
            }
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) { delete window.__actionsJsonStorage[key]; },
        },
      },
      tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; } },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");
  await page.locator("#protofaceEnabled").check();
  await page.locator("#protofaceConnectionMode").selectOption("direct");
  await page.locator("#protofaceAvatarId").fill("av_demo");
  await page.locator("#protofaceApiKey").fill("pf_secret_1234567890");
  await page.locator("#livekitUrl").fill("wss://demo.livekit.cloud");
  await page.locator("#livekitApiKey").fill("APIabcdef123456");
  await page.locator("#livekitApiSecret").fill("livekit-secret-1234567890");
  await page.locator("#saveProtofaceCredentials").click();

  await expect(page.locator("#saveProtofaceCredentials")).toBeDisabled();
  await expect(page.locator("#saveProtofaceSettings")).toBeDisabled();
  await expect(page.locator("#protofaceEnabled")).toBeDisabled();
  await expect(page.locator("#protofaceApiKey")).toBeDisabled();

  await expect.poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_PROTOFACE_SETTINGS_V1)).toEqual({
    enabled: true,
    connectionMode: "direct",
    brokerUrl: "http://127.0.0.1:3000/api/protoface/session-token",
    avatarId: "av_demo",
  });
  await expect(page.locator("#protofaceEnabled")).toBeChecked();
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("manual");
  await expect(page.locator("#protofaceSettingsStatus")).toContainText("Reopen the actions.json overlay to use Protoface");
  await expect(page.locator("#saveProtofaceCredentials")).toBeEnabled();
  await expect(page.locator("#protofaceEnabled")).toBeEnabled();
  await expect(page.locator("#protofaceApiKey")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__protofaceConfigurationWrites)).toBe(1);
});

test("Protoface credential settings report every missing field and sidecar source", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {
      ACTIONS_JSON_PROTOFACE_CREDENTIALS_V1: {
        protofaceApiKey: "pf-sidecar-secret",
        livekitUrl: "wss://sidecar.livekit.cloud/",
        livekitApiKey: "sidecar-key",
        livekitApiSecret: "sidecar-secret",
        source: "sidecar",
      },
    };
    window.chrome = {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: {
        local: {
          async get(key) { return typeof key === "string" ? { [key]: window.__actionsJsonStorage[key] } : { ...window.__actionsJsonStorage }; },
          async set(values) { Object.assign(window.__actionsJsonStorage, values); },
          async remove(key) { delete window.__actionsJsonStorage[key]; },
        },
      },
      tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; } },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("sidecar");
  await page.locator("#protofaceConnectionMode").selectOption("direct");
  await page.locator("#saveProtofaceCredentials").click();
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("Protoface API key");
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("LiveKit URL");
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("LiveKit API key");
  await expect(page.locator("#protofaceCredentialStatus")).toContainText("LiveKit API secret");
  await expect(page.locator("#protofaceSettingsStatus")).toContainText("Credentials and avatar settings were not saved");
  await expect(page.locator("#protofaceSettingsStatus")).toHaveAttribute("data-error", "true");
});

test("side panel saves a redacted key and controls a mocked hosted session", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {};
    window.__actionsJsonRuntimeMessages = [];
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonRuntimeMessages.push({ tabId, ...message });
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  await expect(page.locator("#agentState")).toHaveText("Blocked");
  await expect(page.locator("#startAgent")).toBeDisabled();

  await openConfigTab(page);
  await expect(page.locator("#bridgeUrl")).toHaveValue("ws://127.0.0.1:17345/extension");
  await expect(page.locator("#configPanel")).toHaveAttribute("aria-label", "Settings");
  await expect(page.locator("#voiceSelect")).toHaveValue("cedar");
  await page.locator("#voiceSelect").selectOption("cedar");
  await expect(page.locator("#voiceStatus")).toHaveText("Voice saved: cedar.");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_REALTIME_VOICE))
    .toBe("cedar");
  await expect(page.locator("#vadMode")).toHaveValue("server_vad");
  await page.locator("#vadMode").selectOption("semantic_vad");
  await page.locator("#vadEagerness").selectOption("low");
  await page.locator("#vadInterruptResponse").setChecked(false);
  await expect(page.locator("#vadStatus")).toHaveText("Turn detection saved: semantic_vad.");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_REALTIME_TURN_DETECTION))
    .toEqual({
      mode: "semantic_vad",
      threshold: 0.5,
      silenceDurationMs: 800,
      eagerness: "low",
      interruptResponse: false,
    });

  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();

  await expect(page.locator("#keySummary")).toHaveText("OpenAI key configured: sk-proj...3456");
  await expect(page.locator("body")).not.toContainText("agent-surface-secret");
  await expect(page.locator("#startAgent")).toBeEnabled();
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "idle");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Start voice");

  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "live");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Session live");
  await expect(page.locator("#targetSummary")).toContainText("gpt-realtime-2.1 voice session connected");
  await expect(page.locator("#transcript")).toContainText("Voice session started");
  await expect(page.locator("#memoryStatus")).toHaveText("Memory: 3 events.");
  const sessionUpdate = await page.evaluate(() =>
    window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0].events.find(
      (event) => event.type === "session.update",
    ),
  );
  expect(sessionUpdate.session.audio.output.voice).toBe("cedar");
  expect(sessionUpdate.session.audio.input.turn_detection).toEqual({
    type: "semantic_vad",
    eagerness: "low",
    create_response: true,
    interrupt_response: false,
  });

  await page.locator("#stopAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Stopped");
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "idle");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Start voice");
  await expect(page.locator("#targetSummary")).toContainText("Session stopped");
  await expect(page.locator("#memoryStatus")).toHaveText("Memory: 4 events.");
});

test("side panel renders the selected top-level overlay tab from the URL", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.chrome = {
      storage: {
        local: {
          async get() {
            return {};
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [];
        },
        sendMessage() {
          throw new Error("sendMessage should not be called without an active tab");
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  await expect(page.locator("#agentPanel")).toBeVisible();
  await expect(page.locator("#configPanel")).toBeHidden();
  await expect(page.locator("#startAgent")).toBeVisible();
  await expect(page.locator("#transcript")).toBeVisible();
  await expect(page.locator("#agentTab")).toHaveCount(0);
  await expect(page.locator("#configTab")).toHaveCount(0);

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");

  await expect(page.locator("#agentPanel")).toBeHidden();
  await expect(page.locator("#configPanel")).toBeVisible();
  await expect(page.locator("#apiKey")).toBeVisible();
  await expect(page.locator("#bridgeUrl")).toBeVisible();
  await expect(page.locator("#memoryStatus")).toBeVisible();
});

test("side panel refreshes the agent tab when the OpenAI key changes in another panel", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.__actionsJsonStorageListeners = [];
    window.chrome = {
      storage: {
        onChanged: {
          addListener(listener) {
            window.__actionsJsonStorageListeners.push(listener);
          },
        },
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            const changes = {};
            for (const [key, newValue] of Object.entries(values)) {
              changes[key] = {
                oldValue: window.__actionsJsonStorage[key],
                newValue,
              };
            }
            Object.assign(window.__actionsJsonStorage, values);
            for (const listener of window.__actionsJsonStorageListeners) {
              listener(changes, "local");
            }
          },
          async remove(key) {
            const oldValue = window.__actionsJsonStorage[key];
            delete window.__actionsJsonStorage[key];
            for (const listener of window.__actionsJsonStorageListeners) {
              listener({ [key]: { oldValue, newValue: undefined } }, "local");
            }
          },
        },
      },
      tabs: {
        async query() {
          return [];
        },
        sendMessage() {
          throw new Error("sendMessage should not be called without an active tab");
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  await expect(page.locator("#startAgent")).toBeDisabled();
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Add key first");

  await page.evaluate(async () => {
    await window.chrome.storage.local.set({
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-agent-surface-secret-value-123456",
    });
  });

  await expect(page.locator("#keySummary")).toHaveText("OpenAI key configured: sk-proj...3456");
  await expect(page.locator("#agentState")).toHaveText("Ready");
  await expect(page.locator("#startAgent")).toBeEnabled();
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Start voice");
});

test("side panel loads hosted realtime tools from the bridge before starting voice", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    };
    window.__actionsJsonRuntimeMessages = [];
    window.__actionsJsonBridgeFetches = [];
    window.fetch = async (url, options = {}) => {
      window.__actionsJsonBridgeFetches.push({ url: String(url), options });
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/list") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              tools: [
                {
                  name: "browser.screenshot",
                  description: "Capture the visible tab through the bridge.",
                  input_schema: {
                    type: "object",
                    properties: { format: { type: "string", enum: ["png", "jpeg"] } },
                    additionalProperties: false,
                  },
                },
              ],
            });
          },
          async json() {
            return {
              tools: [
                {
                  name: "browser.screenshot",
                  description: "Capture the visible tab through the bridge.",
                  input_schema: {
                    type: "object",
                    properties: { format: { type: "string", enum: ["png", "jpeg"] } },
                    additionalProperties: false,
                  },
                },
              ],
            };
          },
        };
      }
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/call") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              ok: true,
              call_id: "bridge-screenshot-call",
              output: {
                ok: true,
                primitive: "browser.screenshot",
                data_url: "data:image/png;base64,abc123",
                mime_type: "image/png",
              },
            });
          },
          async json() {
            return {
              ok: true,
              call_id: "bridge-screenshot-call",
              output: {
                ok: true,
                primitive: "browser.screenshot",
                data_url: "data:image/png;base64,abc123",
                mime_type: "image/png",
              },
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          throw new Error("hosted realtime calls should go through the bridge");
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  const sessionUpdate = await page.evaluate(() =>
    window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0].events.find(
      (event) => event.type === "session.update",
    ),
  );
  expect(sessionUpdate.session.tools).toHaveLength(1);
  expect(sessionUpdate.session.tools[0]).toMatchObject({
    type: "function",
    name: "browser_screenshot",
  });
  expect(sessionUpdate.session.tools[0].description).toContain(
    "Capture the visible tab through the bridge.",
  );
  expect(sessionUpdate.session.tools[0].parameters.properties.format).toEqual({
    type: "string",
    enum: ["png", "jpeg"],
  });
  await expect(page.locator("#transcript")).toContainText("Tools ready: 1 bridge actions.");

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    await transport.onEvent({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "browser.screenshot",
            call_id: "call-screenshot",
            arguments: JSON.stringify({
              format: "png",
              policy_exception_report: {
                kind: "generic",
                intended_tool: "browser.screenshot",
                actions_json_path: "none",
                reason: "Characterization test exercises the direct bridge tool path.",
              },
            }),
          },
        ],
      },
    });
  });
  await expect
    .poll(() => page.evaluate(() =>
      window.__actionsJsonBridgeFetches
        .filter((call) => call.url === "http://127.0.0.1:17345/mcp/tools/call").length,
    ))
    .toBeGreaterThan(0);
  await expect(page.locator("#transcript")).not.toContainText("Tool:");

  const bridgeCall = await page.evaluate(() =>
    window.__actionsJsonBridgeFetches
      .filter((call) => call.url === "http://127.0.0.1:17345/mcp/tools/call")
      .map((call) => JSON.parse(call.options.body))[0],
  );
  expect(bridgeCall).toEqual({
    name: "browser.screenshot",
    target_url_contains: "https://example.test/",
    arguments: {
      format: "png",
      quality: 60,
      max_width: 960,
      max_height: 960,
      max_kilobytes: 180,
      capture_timeout_ms: 10000,
    },
  });
  const sentEvents = await page.evaluate(() => window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0].events);
  expect(sentEvents).toContainEqual({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-screenshot",
      output: JSON.stringify({
        ok: true,
        call_id: "bridge-screenshot-call",
        output: {
          ok: true,
          primitive: "browser.screenshot",
          mime_type: "image/png",
          image: {
            delivered_as: "input_image",
            mime_type: "image/png",
            image_bytes: null,
          },
        },
      }),
    },
  });
  expect(sentEvents).toContainEqual({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Screenshot captured for browser.screenshot call call-screenshot.",
        },
        {
          type: "input_image",
          image_url: "data:image/png;base64,abc123",
        },
      ],
    },
  });
});

test("side panel describes local tool fallback without failure wording when bridge tools are unreachable", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-agent-surface-secret-value-123456",
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    };
    window.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/list") {
        throw new Error("Failed to fetch");
      }
      if (String(url) === "https://actions-json.test/actions/overlay.actions.json") {
        return {
          ok: true,
          async json() {
            return {
              primitive_dictionary: {
                primitives: [
                  {
                    name: "browser.screenshot",
                    summary: "Capture a screenshot.",
                    portable: false,
                    adapters: { extension: { support: "supported" } },
                    input_schema: { type: "object", additionalProperties: false },
                  },
                ],
              },
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
        async sendMessage() {
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://acme.example/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });
  await page.route("https://actions-json.test/**", async (route) => {
    const url = new URL(route.request().url());
    const relativePath = url.pathname === "/" ? "agent-surface.html" : url.pathname.slice(1);
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
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await page.locator("#startAgent").click();

  await expect(page.locator("#transcript")).toContainText("extension-local actions");
  await expect(page.locator("#transcript")).not.toContainText("Bridge tools unavailable");
  await expect(page.locator("#transcript")).not.toContainText("Failed to fetch");
});

test("side panel suppresses browser.run_javascript from hosted tools when the current site blocks page eval", async ({
  page,
}) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {
      bridgeUrl: "ws://127.0.0.1:17345/extension",
      actionsJsonStorageBundle: {
        protocol: "actions.json.storage.bundle",
        entries: [
          {
            path: "scopes/private/sites/example.test/home/actions.json",
            content: JSON.stringify({
              protocol: "actions.json",
              requires: {
                primitive_dictionary: {
                  blocked_primitives: ["browser.run_javascript", "debug.run_javascript"],
                },
              },
              tools: [],
            }),
          },
        ],
      },
    };
    window.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/list") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              tools: [
                { name: "browser.screenshot", description: "Screenshot", input_schema: { type: "object" } },
                { name: "browser.run_javascript", description: "Page eval", input_schema: { type: "object" } },
                { name: "debug.run_javascript", description: "Debugger eval", input_schema: { type: "object" } },
              ],
            });
          },
          async json() {
            return {
              tools: [
                { name: "browser.screenshot", description: "Screenshot", input_schema: { type: "object" } },
                { name: "browser.run_javascript", description: "Page eval", input_schema: { type: "object" } },
                { name: "debug.run_javascript", description: "Debugger eval", input_schema: { type: "object" } },
              ],
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    window.chrome = {
      runtime: {
        async sendMessage() {
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  const sessionUpdate = await page.evaluate(() =>
    window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0].events.find(
      (event) => event.type === "session.update",
    ),
  );
  const toolNames = sessionUpdate.session.tools.map((tool) => tool.name);
  expect(toolNames).toEqual(["browser_screenshot", "debug_run_javascript"]);
  await expect(page.locator("#transcript")).toContainText(
    "Tools ready: 2 bridge actions.",
  );
});

test("side panel starts production voice through the durable extension session host", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-agent-surface-secret-value-123456",
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    };
    window.__actionsJsonRuntimeMessages = [];
    window.__actionsJsonRuntimeListeners = [];
    window.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/list") {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              tools: [
                {
                  name: "actions.site",
                  description: "List or call current-site actions.",
                  input_schema: { type: "object", additionalProperties: false },
                },
              ],
            });
          },
          async json() {
            return {
              tools: [
                {
                  name: "actions.site",
                  description: "List or call current-site actions.",
                  input_schema: { type: "object", additionalProperties: false },
                },
              ],
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    window.__actionsJsonVisibleMicGrantRequests = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia(constraints) {
          window.__actionsJsonVisibleMicGrantRequests += 1;
          window.__actionsJsonVisibleMicGrantConstraints = constraints;
          return {
            getTracks() {
              return [
                {
                  stop() {
                    window.__actionsJsonVisibleMicGrantStopped = true;
                  },
                },
              ];
            },
          };
        },
      },
    });
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          if (message.type === "actions-json:agent-session-start") {
            queueMicrotask(() => {
              for (const listener of window.__actionsJsonRuntimeListeners) {
                listener({
                  type: "actions-json:agent-session-event",
                  event: {
                    type: "response.output_audio_transcript.done",
                    transcript: "Durable session stayed alive.",
                  },
                  state: { status: "connected", model: "gpt-realtime-2.1", error: null },
                });
              }
            });
            return {
              ok: true,
              state: { status: "connected", model: "gpt-realtime-2.1", error: null },
            };
          }
          if (message.type === "actions-json:agent-session-stop") {
            return {
              ok: true,
              state: { status: "stopped", model: "gpt-realtime-2.1", error: null },
            };
          }
          return { ok: true };
        },
        onMessage: {
          addListener(listener) {
            window.__actionsJsonRuntimeListeners.push(listener);
          },
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://acme.example/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await expect(page.locator("#startAgent")).toBeEnabled();
  await page.locator("#startAgent").click();

  await expect(page.locator("#agentState")).toHaveText("Live");
  await expect(page.locator("#transcript")).toContainText("Voice session started");
  await expect(page.locator("#transcript")).toContainText("Agent: Durable session stayed alive.");

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonVisibleMicGrantRequests))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonVisibleMicGrantConstraints))
    .toEqual({ audio: true });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonVisibleMicGrantStopped))
    .toBe(true);

  const startMessage = await page.evaluate(() =>
    window.__actionsJsonRuntimeMessages.find((message) => message.type === "actions-json:agent-session-start"),
  );
  expect(startMessage).toMatchObject({
    type: "actions-json:agent-session-start",
    textOnly: false,
    tools: [
      {
        type: "function",
        name: "actions.site",
        description: "List or call current-site actions.",
        parameters: { type: "object", additionalProperties: false },
      },
    ],
  });
});

test("side panel refreshes durable session state on load so stop stays available after reopening", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonRuntimeMessages = [];
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          if (message.type === "actions-json:agent-session-state") {
            return {
              ok: true,
              state: { status: "connected", model: "gpt-realtime-2.1", error: null, inputMuted: true, outputMuted: true },
            };
          }
          return { ok: true };
        },
        onMessage: {
          addListener() {},
        },
      },
      storage: {
        local: {
          async get(key) {
            if (key === "ACTIONS_JSON_OPENAI_API_KEY") {
              return { ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-agent-surface-secret-value-123456" };
            }
            if (key === "bridgeUrl") {
              return { bridgeUrl: "ws://127.0.0.1:17345/extension" };
            }
            return {};
          },
          async set() {},
          async remove() {},
        },
        onChanged: {
          addListener() {},
        },
      },
      tabs: {
        async query() {
          return [];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  await expect(page.locator("#agentState")).toHaveText("Live");
  await expect(page.locator("#startAgent")).toBeDisabled();
  await expect(page.locator("#stopAgent")).toBeEnabled();
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Session live");
  await expect(page.locator("#muteMic")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#muteSpeaker")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#muteMic")).toHaveClass(/is-muted/);
  await expect(page.locator("#muteSpeaker")).toHaveClass(/is-muted/);
  await expect(page.locator("#muteMic")).toHaveCSS("color", "rgb(182, 64, 64)");
  await expect(page.locator("#muteSpeaker")).toHaveCSS("color", "rgb(182, 64, 64)");
  await expect(page.locator("#targetSummary")).toContainText("gpt-realtime-2.1 voice session connected");
});

test("side panel sends typed agent prompts through the transcript composer", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-agent-surface-secret-value-123456",
    };
    window.chrome = {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
        onChanged: {
          addListener() {},
        },
      },
      tabs: {
        async query() {
          return [];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  await page.locator("#agentTextInput").fill("Find the Trello demo card");
  await page.locator("#sendAgentText").click();
  await expect(page.locator("#transcript")).toContainText("User: Find the Trello demo card");

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    const responseCreate = transport.events.filter((event) => event.type === "response.create").at(-1);
    await transport.onEvent({
      type: "response.created",
      response: { id: "resp_text_input" },
    });
    await transport.onEvent({
      type: "response.output_text.done",
      response_id: "resp_text_input",
      text: "Found the Trello demo card in In Progress.",
    });
    window.__lastTextResponseCreate = responseCreate;
  });

  await expect(page.locator("#transcript")).toContainText("Agent: Found the Trello demo card in In Progress.");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#transcript > div"))
          .map((line) => line.textContent)
          .filter((text) => text === "Agent: Found the Trello demo card in In Progress.").length
      )
    )
    .toBe(1);
  await expect(page.locator("#agentTextInput")).toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => window.__lastTextResponseCreate?.response?.output_modalities))
    .toEqual(["text"]);
});

test("side panel streams assistant deltas into one live transcript line", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {};
    window.chrome = {
      runtime: {
        async sendMessage() {
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    await transport.onEvent({ type: "response.created" });
    await transport.onEvent({ type: "response.output_audio_transcript.delta", delta: "Hi" });
    await transport.onEvent({ type: "response.output_audio_transcript.delta", delta: " there" });
    await transport.onEvent({ type: "response.output_audio_transcript.delta", delta: "!" });
    await transport.onEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Hi there!",
    });
  });

  await expect(page.locator("#transcript")).toContainText("Agent: Hi there!");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#transcript > div"))
          .map((line) => line.textContent)
          .filter((text) => text.startsWith("Agent:"))
      )
    )
    .toEqual(["Agent: Hi there!"]);

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    await transport.onEvent({ type: "conversation.item.input_audio_transcription.delta", delta: "What" });
    await transport.onEvent({ type: "conversation.item.input_audio_transcription.delta", delta: " can you see?" });
  });

  await expect(page.locator("#transcript")).toContainText("User: What can you see?");

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    await transport.onEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "What can you see?",
    });
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#transcript > div"))
          .map((line) => line.textContent)
          .filter((text) => text.startsWith("User:"))
      )
    )
    .toEqual(["User: What can you see?"]);

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    await transport.onEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item: {
        content: [
          {
            type: "input_audio",
            transcript: "What website is this?",
          },
        ],
      },
    });
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#transcript > div"))
          .map((line) => line.textContent)
          .filter((text) => text.startsWith("User:"))
      )
    )
    .toEqual(["User: What can you see?", "User: What website is this?"]);
});

test("side panel keeps a spoken user turn before assistant output even when final transcription arrives late", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {};
    window.chrome = {
      runtime: {
        async sendMessage() {
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    await transport.onEvent({ type: "input_audio_buffer.speech_started" });
    await transport.onEvent({ type: "response.created" });
    await transport.onEvent({ type: "response.output_audio_transcript.delta", delta: "The headline is visible." });
    await transport.onEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "What is the headline?",
    });
    await transport.onEvent({
      type: "response.output_audio_transcript.done",
      transcript: "The headline is visible.",
    });
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#transcript > div"))
          .map((line) => line.textContent)
          .filter((text) => text.startsWith("User:") || text.startsWith("Agent:"))
      )
    )
    .toEqual(["User: What is the headline?", "Agent: The headline is visible."]);
});

test("side panel transcript sticks to bottom only while the user is already at the bottom", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_EXPOSE_FAKE_REALTIME_FACTORY = true;
    window.__actionsJsonStorage = {};
    window.chrome = {
      runtime: {
        async sendMessage() {
          return {
            ok: true,
            runtimeKey: "chrome-tab:101",
            authorizationId: "authorization-test",
            agentGroupId: "extension:default",
            chromeTabGroupId: 202,
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") return { [key]: window.__actionsJsonStorage[key] };
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.setViewportSize({ width: 340, height: 360 });
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    for (let index = 0; index < 20; index += 1) {
      await transport.onEvent({
        type: "response.output_audio_transcript.done",
        transcript: `Line ${index}`,
      });
    }
    const transcript = document.querySelector("#transcript");
    transcript.scrollTop = transcript.scrollHeight;
  });
  const bottomAfterPinnedAppend = await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    const transcript = document.querySelector("#transcript");
    await transport.onEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Pinned append",
    });
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  });
  expect(bottomAfterPinnedAppend).toBeLessThan(24);

  const scrollTopAfterUnpinnedAppend = await page.evaluate(async () => {
    const transport = window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0];
    const transcript = document.querySelector("#transcript");
    transcript.scrollTop = 0;
    await transport.onEvent({
      type: "response.output_audio_transcript.done",
      transcript: "Unpinned append",
    });
    return transcript.scrollTop;
  });
  expect(scrollTopAfterUnpinnedAppend).toBe(0);
});

test("side panel keeps the bridge authorization flow available", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.__actionsJsonRuntimeMessages = [];
    window.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:17345/runtimes") {
        return {
          ok: true,
          async json() {
            return {
              runtimes: [{ runtime_id: "actions-json-runtime-authorization-test" }],
            };
          },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          return {
            ok: true,
            runtimeKey: `chrome-tab:${message.tabId}`,
            authorizationId: "authorization-agent-surface",
            agentGroupId: "extension:default",
            chromeTabGroupId: 303,
            runtimeId: "actions-json-runtime-authorization-test",
          };
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 404, url: "https://amazon.test/" }];
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonRuntimeMessages.push({ tabId, ...message });
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");
  await openConfigTab(page);
  await page.locator("#bridgeUrl").fill("ws://127.0.0.1:17345/extension");
  await page.locator("#authorizeBridge").click();

  await expect(page.locator("#bridgeStatus")).toHaveText(
    "Connected and verified. Runtime actions-json-runtime-authorization-test is registered.",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonRuntimeMessages.find((message) => message.type === "actions-json:authorize-tab"),
      ),
    )
    .toEqual({
      type: "actions-json:authorize-tab",
      tabId: 404,
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    });
});

test("side panel loads and writes a shared actions.json storage folder", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.__actionsJsonFolderWrites = [];
    const files = {
      "sites/acme.example/home/actions.json": JSON.stringify({
        protocol: "actions.json",
        tools: [{ name: "acme.site.map", description: "Map", input_schema: { type: "object" } }],
      }),
    };
    function directoryHandle(prefix = "") {
      return {
        kind: "directory",
        name: prefix ? prefix.split("/").at(-1) : "actions.json.storage.shared.acme",
        async *entries() {
          const directNames = new Set();
          for (const path of Object.keys(files)) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length).replace(/^\//, "");
            const [name, ...remaining] = rest.split("/");
            if (!name || directNames.has(name)) continue;
            directNames.add(name);
            const childPath = prefix ? `${prefix}/${name}` : name;
            if (remaining.length === 0) {
              yield [name, fileHandle(childPath)];
            } else {
              yield [name, directoryHandle(childPath)];
            }
          }
        },
        async getDirectoryHandle(name, options = {}) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          if (!options.create && !Object.keys(files).some((path) => path === childPath || path.startsWith(`${childPath}/`))) {
            const error = new Error("Not found");
            error.name = "NotFoundError";
            throw error;
          }
          return directoryHandle(childPath);
        },
        async getFileHandle(name) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          return fileHandle(childPath);
        },
      };
    }
    function fileHandle(path) {
      return {
        kind: "file",
        async getFile() {
          const text = files[path] || "";
          return {
            size: text.length,
            lastModified: 123,
            async text() {
              return text;
            },
          };
        },
        async createWritable() {
          return {
            async write(text) {
              files[path] = String(text);
              window.__actionsJsonFolderWrites.push({ path, text: String(text) });
            },
            async close() {},
          };
        },
      };
    }
    window.showDirectoryPicker = async () => directoryHandle();
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 505, url: "https://acme.example/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");
  await openConfigTab(page);
  await page.locator("#loadStorageFolder").click();
  await expect(page.locator("#storageFolderStatus")).toContainText("Uploaded 1 file(s)");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.actionsJsonStorageBundle.entries[0].path))
    .toBe("scopes/shared/acme/sites/acme.example/home/actions.json");

  await page.locator("#writeStorageFolder").click();
  await expect(page.locator("#storageFolderStatus")).toContainText("Downloaded 1 file(s)");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonFolderWrites[0].path))
    .toBe("sites/acme.example/home/actions.json");
});

test("side panel opens top-level settings for folder access when embedded in the page overlay", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_FORCE_FILE_PICKER_SUBFRAME = true;
    window.__actionsJsonStorage = {};
    window.__actionsJsonShowDirectoryPickerCalled = false;
    window.showDirectoryPicker = async () => {
      window.__actionsJsonShowDirectoryPickerCalled = true;
      throw new Error("showDirectoryPicker should not be called in an embedded overlay");
    };
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async create(createProperties) {
          window.__actionsJsonCreatedTab = createProperties;
          return { id: 606, ...createProperties };
        },
        async query() {
          return [{ id: 505, url: "https://acme.example/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config&surface=overlay");
  await openConfigTab(page);
  await page.locator("#loadStorageFolder").click();

  await expect(page.locator("#storageFolderStatus")).toContainText("Opened top-level Settings for folder access");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonCreatedTab))
    .toEqual({ url: "https://actions-json.test/agent-surface.html?tab=config&surface=top-level" });
  expect(await page.evaluate(() => window.__actionsJsonShowDirectoryPickerCalled)).toBe(false);
});

test("top-level settings loads the whole selected storage repo instead of filtering by the active tab URL", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    const files = {
      ".DS_Store": "mac metadata",
      "storage.json": JSON.stringify({ protocol: "actions.json.storage" }),
      "scopes/private/sites/amazon.com/prime-video/actions.json": JSON.stringify({
        protocol: "actions.json",
        tools: [{ name: "amazon.continue_watching.scan", description: "Scan", input_schema: { type: "object" } }],
      }),
      "scopes/shared/acme/sites/acme.example/home/actions.json": JSON.stringify({
        protocol: "actions.json",
        tools: [{ name: "acme.site.map", description: "Map", input_schema: { type: "object" } }],
      }),
    };
    function directoryHandle(prefix = "") {
      return {
        kind: "directory",
        name: prefix ? prefix.split("/").at(-1) : "actions.json.storage",
        async *entries() {
          const directNames = new Set();
          for (const path of Object.keys(files)) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length).replace(/^\//, "");
            const [name, ...remaining] = rest.split("/");
            if (!name || directNames.has(name)) continue;
            directNames.add(name);
            const childPath = prefix ? `${prefix}/${name}` : name;
            if (remaining.length === 0) {
              yield [name, fileHandle(childPath)];
            } else {
              yield [name, directoryHandle(childPath)];
            }
          }
        },
        async getDirectoryHandle(name, options = {}) {
          const childPath = prefix ? `${prefix}/${name}` : name;
          if (!options.create && !Object.keys(files).some((path) => path === childPath || path.startsWith(`${childPath}/`))) {
            const error = new Error("Not found");
            error.name = "NotFoundError";
            throw error;
          }
          return directoryHandle(childPath);
        },
      };
    }
    function fileHandle(path) {
      return {
        kind: "file",
        async getFile() {
          const text = files[path] || "";
          return {
            size: text.length,
            lastModified: 123,
            async text() {
              return text;
            },
          };
        },
      };
    }
    window.showDirectoryPicker = async () => directoryHandle();
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 909, url: "https://actions-json.test/agent-surface.html?tab=config&surface=top-level" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config&surface=top-level");
  await openConfigTab(page);
  await page.locator("#loadStorageFolder").click();

  await expect(page.locator("#storageFolderStatus")).toContainText("Uploaded 3 file(s)");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.actionsJsonStorageBundle.entries.map((entry) => entry.path)))
    .toEqual([
      "storage.json",
      "scopes/private/sites/amazon.com/prime-video/actions.json",
      "scopes/shared/acme/sites/acme.example/home/actions.json",
    ]);
});

test("side panel reports denied microphone permission before starting transport", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_MICROPHONE_PERMISSION_STATE = "denied";
    window.__actionsJsonStorage = {};
    window.chrome = {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await expect(page.locator("#startAgent")).toBeEnabled();
  await page.locator("#startAgent").click();

  await expect(page.locator("#agentState")).toHaveText("Error");
  await expect(page.locator("#startAgent")).toBeEnabled();
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "error");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Retry voice");
  await expect(page.locator("#targetSummary")).toContainText("Microphone permission dismissed or blocked");
  await expect(page.locator("#credentialStatus")).toContainText("Chrome microphone settings");
  await expect(page.locator("#transcript")).toContainText("Microphone permission: denied.");
});

test("side panel recovers when microphone permission prompt is dismissed", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_FAKE_REALTIME_CONNECT_ERROR = {
      name: "NotAllowedError",
      message: "Permission dismissed",
    };
    window.__ACTIONS_JSON_MICROPHONE_PERMISSION_STATE = "prompt";
    window.__actionsJsonStorage = {};
    window.chrome = {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://example.test/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await expect(page.locator("#startAgent")).toBeEnabled();
  await page.locator("#startAgent").click();

  await expect(page.locator("#agentState")).toHaveText("Error");
  await expect(page.locator("#startAgent")).toBeEnabled();
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "error");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Retry voice");
  await expect(page.locator("#targetSummary")).toContainText("Microphone permission dismissed or blocked");
  await expect(page.locator("#credentialStatus")).toContainText("choose Allow");
  await expect(page.locator("#transcript")).toContainText("Microphone permission: prompt.");
});

test("side panel remains usable in a very narrow column", async ({ page }) => {
  await page.setViewportSize({ width: 180, height: 720 });
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.chrome = {
      storage: {
        local: {
          async get() {
            return {};
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove() {},
        },
      },
      tabs: {
        async query() {
          return [];
        },
        sendMessage() {
          throw new Error("sendMessage should not be called without an active tab");
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  await openConfigTab(page);
  await expect(page.locator("#bridgeUrl")).toBeVisible();
  await expect(page.locator("#apiKey")).toBeVisible();
  await openAgentTab(page);
  await expect(page.locator("#startAgent")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test("side panel lets the user clear extension-local agent memory", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {
      ACTIONS_JSON_AGENT_MEMORY_V1: {
        visitorId: "local-agent-test",
        events: [{ type: "transcript", text: "previous context" }],
      },
    };
    window.chrome = {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
          async remove(key) {
            delete window.__actionsJsonStorage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [];
        },
        sendMessage() {
          throw new Error("sendMessage should not be called without an active tab");
        },
      },
    };
  });

  await page.goto("https://actions-json.test/agent-surface.html?tab=config");
  await openConfigTab(page);
  await expect(page.locator("#memoryStatus")).toHaveText("Memory: 1 event.");

  await page.locator("#clearMemory").click();

  await expect(page.locator("#memoryStatus")).toHaveText("Memory cleared.");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_AGENT_MEMORY_V1))
    .toBeUndefined();
});

// ---------------------------------------------------------------------------
// U4 — the resting pill, in a real browser.
//
// These are the assertions node CANNOT make honestly. The pill's state/colour
// LOGIC is proved exhaustively in tests/agent-surface-pill.test.mjs against
// src/agent/pill-presentation.mjs; what is left is whether the CSS those
// decisions feed actually resolves in a rendering engine:
//   * does the pill appear on surface=overlay and stay away otherwise;
//   * does --pill-hue reach a computed BORDER and not a computed BACKGROUND;
//   * does the transcript really stop being the resting state.
// A computed style is a browser fact. Asserting it in node would be fiction.
// ---------------------------------------------------------------------------

function stubChrome() {
  window.__actionsJsonStorage = {};
  window.__overlayDisclosureMessages = [];
  window.__actionsJsonRuntimeListeners = [];
  window.addEventListener("message", (event) => {
    if (event.data?.type === "actions-json:overlay-disclosure") {
      window.__overlayDisclosureMessages.push(event.data);
    }
  });
  window.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { window.__actionsJsonRuntimeListeners.push(listener); },
      },
      async sendMessage() { return { ok: true }; },
      getURL(path) { return `https://actions-json.test/${path}`; },
    },
    storage: {
      local: {
        async get(key) {
          return typeof key === "string"
            ? { [key]: window.__actionsJsonStorage[key] }
            : { ...window.__actionsJsonStorage };
        },
        async set(values) { Object.assign(window.__actionsJsonStorage, values); },
        async remove(key) { delete window.__actionsJsonStorage[key]; },
      },
      onChanged: { addListener() {} },
    },
    tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; } },
  };
}

test("the overlay surface rests on the pill, not on the transcript", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await expect(page.locator("#agentPill")).toBeVisible();
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "resting");
  await expect(page.locator("#agentPillToggle")).toHaveRole("button");
  await expect(page.locator("#agentPillToggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#overlayStartAgent")).toBeVisible();
  await expect(page.locator("#overlayStartAgent")).toBeEnabled();
  await expect(page.locator("#overlayStartAgent")).toHaveText("Open settings");
  await expect(page.locator("#agentPillAction")).toHaveText("Ready");
  await expect(page.locator(".agent-controls")).toBeHidden();
  // The whole point of the unit: the transcript is a thing you OPEN, not the
  // resting state. A voice user already heard it.
  await expect(page.locator(".agent-conversation")).toBeHidden();
  await expect(page.locator("#agentPillAction")).toHaveText(/\S/);
  await expect
    .poll(() => page.evaluate(() => window.__overlayDisclosureMessages.at(-1)?.state))
    .toBe("resting");

  await page.locator("#agentPill").hover();
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "controls");
  await expect(page.locator(".agent-controls")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__overlayDisclosureMessages.at(-1)?.state))
    .toBe("controls");

  await page.mouse.move(200, 300);
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "resting");
  await expect(page.locator(".agent-controls")).toBeHidden();

  await page.locator("#agentPillToggle").focus();
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "controls");
  await page.evaluate(() => document.activeElement?.blur());
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "resting");

  await page.locator("#agentPill").hover();
  await page.locator("#agentPillToggle").click();
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "opened");
  await expect(page.locator("#agentPillToggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".agent-conversation")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Cost" })).toBeVisible();
  await page.getByRole("tab", { name: "Cost" }).click();
  await expect(page.locator("#agentCostPanel")).toBeVisible();
  await expect(page.locator(".agent-conversation")).toBeHidden();
  await page.getByRole("tab", { name: "Transcript" }).click();
  await expect(page.locator(".agent-conversation")).toBeVisible();
  for (const control of await page.locator(".agent-controls button:visible").all()) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  await expect
    .poll(() => page.evaluate(() => window.__overlayDisclosureMessages.at(-1)?.state))
    .toBe("opened");

  await page.keyboard.press("Escape");
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "resting");
  await expect(page.locator(".agent-conversation")).toBeHidden();
  await expect(page.locator("#agentPillToggle")).toBeFocused();
});

test("Living Capsule controls fit the 340 by 128 overlay without document overflow", async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 128 });
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await page.locator("#agentPill").hover();
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "controls");
  await expect(page.locator(".agent-pill-signal")).toBeVisible();

  const geometry = await page.evaluate(() => ({
    viewportHeight: document.documentElement.clientHeight,
    documentHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
  }));
  expect(geometry).toEqual({
    viewportHeight: 128,
    documentHeight: 128,
    bodyHeight: 128,
  });
});

test("Living Capsule resting surface fits its host without clipping or vertical overflow", async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 76 });
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "resting");
  const geometry = await page.evaluate(() => {
    const pill = document.querySelector("#agentPill").getBoundingClientRect();
    return {
      viewportHeight: document.documentElement.clientHeight,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      pillTop: pill.top,
      pillBottom: pill.bottom,
      pillFullyVisible: pill.top >= 0 && pill.bottom <= document.documentElement.clientHeight,
      verticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  });
  expect(geometry).toEqual({
    viewportHeight: 76,
    documentHeight: 76,
    bodyHeight: 74,
    pillTop: 10,
    pillBottom: 64,
    pillFullyVisible: true,
    verticalOverflow: false,
  });
});

test("the Living Capsule receives live microphone envelopes across the extension broadcast channel", async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 76 });
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await page.evaluate(() => {
    const channel = new BroadcastChannel("actions-json-agent-amplitude-v1");
    channel.postMessage({
      type: "envelope",
      audioAvailable: true,
      input: 0.58,
      output: 0,
      at: Date.now(),
    });
    channel.close();
  });

  await expect(page.locator("#agentPill")).toHaveAttribute("data-audio", "measuring");
  await expect(page.locator(".agent-pill-wave canvas")).toBeVisible();
  await expect.poll(() => page.locator(".agent-pill-wave canvas").evaluate(
    (canvas) => canvas.width > 0 && canvas.height > 0,
  )).toBe(true);
});

test("the production offscreen publisher drives the visible waveform when paint frames are unavailable", async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 76 });
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await page.evaluate(async () => {
    window.requestAnimationFrame = () => 99;
    window.cancelAnimationFrame = () => {};
    const { createAmplitudeEnvelopePublisher } = await import(
      "/src/agent/amplitude-envelope.mjs"
    );
    const analyser = {
      fftSize: 256,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData(target) {
        target.fill(0.45);
      },
      disconnect() {},
    };
    const context = {
      state: "running",
      createAnalyser: () => analyser,
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      async close() {},
    };
    const track = {
      addEventListener() {},
      removeEventListener() {},
    };
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    };
    const channel = new BroadcastChannel("actions-json-agent-amplitude-v1");
    const publisher = createAmplitudeEnvelopePublisher({
      audioContextFactory: () => context,
      intervalMs: 20,
      publish(message) {
        channel.postMessage(message);
      },
    });
    publisher.attachInput(stream);
    window.__waveformSchedulerProbe = { publisher, channel };
  });

  await expect(page.locator("#agentPill")).toHaveAttribute("data-audio", "measuring");
  await expect(page.locator(".agent-pill-wave canvas")).toBeVisible();
  await expect.poll(() => page.locator(".agent-pill-wave canvas").evaluate(
    (canvas) => canvas.width > 0 && canvas.height > 0,
  )).toBe(true);

  await page.evaluate(async () => {
    await window.__waveformSchedulerProbe.publisher.stop();
    window.__waveformSchedulerProbe.channel.close();
    delete window.__waveformSchedulerProbe;
  });
});

test("the compact Living Capsule keeps the real waveform visible instead of replacing it with a dot", async ({ page }) => {
  await page.setViewportSize({ width: 42, height: 42 });
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await expect(page.locator(".agent-pill-signal")).toBeVisible();
  await expect(page.locator(".agent-pill-wave")).toBeVisible();
  await expect(page.locator(".agent-pill-wave canvas")).toBeVisible();
  await expect(page.locator("#agentPillDot")).toHaveCount(0);
  await expect(page.locator("#agentPillAction")).toBeHidden();
  const waveBox = await page.locator(".agent-pill-wave canvas").boundingBox();
  expect(waveBox?.height).toBeGreaterThanOrEqual(36);

  await page.evaluate(() => {
    for (const listener of window.__actionsJsonRuntimeListeners) {
      listener({
        type: "actions-json:agent-audio-amplitude",
        amplitude: { type: "envelope", input: 0.02, output: 0, at: Date.now() },
      });
    }
  });
  await expect(page.locator("#agentPill")).toHaveAttribute("data-audio", "measuring");
});

test("overlay disclosure is keyboard operable and preserves the live status words", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  const toggle = page.locator("#agentPillToggle");
  await toggle.focus();
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "controls");
  await expect(page.locator("#agentPillAction")).toHaveText(/\S/);

  await page.keyboard.press("Enter");
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "opened");
  await page.keyboard.press("Escape");
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "resting");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#agentPanel")).toHaveAttribute("data-disclosure", "opened");
});

test("the visible overlay action starts one durable voice session and names pending state", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-agent-surface-secret-value-123456",
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    };
    window.__actionsJsonRuntimeMessages = [];
    window.__actionsJsonRuntimeListeners = [];
    window.__resolveOverlayStart = null;
    window.__delayCredentialRead = false;
    window.__resolveCredentialRead = null;
    window.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/list") {
        return {
          ok: true,
          status: 200,
          async text() { return JSON.stringify({ tools: [] }); },
          async json() { return { tools: [] }; },
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    });
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          if (message.type === "actions-json:agent-session-start") {
            return await new Promise((resolve) => {
              window.__resolveOverlayStart = () => resolve({
                ok: true,
                state: { status: "connected", model: "gpt-realtime-2.1", error: null },
              });
            });
          }
          return { ok: true };
        },
        onMessage: {
          addListener(listener) { window.__actionsJsonRuntimeListeners.push(listener); },
        },
      },
      storage: {
        local: {
          async get(key) {
            if (window.__delayCredentialRead) {
              await new Promise((resolve) => {
                window.__resolveCredentialRead = resolve;
              });
            }
            return typeof key === "string"
              ? { [key]: window.__actionsJsonStorage[key] }
              : { ...window.__actionsJsonStorage };
          },
          async set(values) { Object.assign(window.__actionsJsonStorage, values); },
          async remove(key) { delete window.__actionsJsonStorage[key]; },
        },
        onChanged: { addListener() {} },
      },
      tabs: {
        async query() { return [{ id: 101, url: "https://acme.example/" }]; },
        async sendMessage() { return { ok: true }; },
      },
    };
  });
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  const start = page.locator("#overlayStartAgent");
  await expect(start).toBeEnabled();
  await expect(start).toHaveText("Start voice");
  await expect(page.locator(':text-is("Start voice"):visible')).toHaveCount(1);
  await expect(page.locator("#agentPillAction")).toHaveText("Ready");
  await page.evaluate(() => {
    window.__delayCredentialRead = true;
    document.querySelector("#overlayStartAgent").click();
    document.querySelector("#startAgent").click();
  });
  await expect
    .poll(() => page.evaluate(() => typeof window.__resolveCredentialRead))
    .toBe("function");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonRuntimeMessages.filter(
      (message) => message.type === "actions-json:agent-session-start",
    ).length))
    .toBe(0);
  await page.evaluate(() => {
    window.__delayCredentialRead = false;
    window.__resolveCredentialRead();
  });
  await expect(start).toBeDisabled();
  await expect(start).toHaveText("Connecting");
  await start.click({ force: true });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonRuntimeMessages.filter(
      (message) => message.type === "actions-json:agent-session-start",
    ).length))
    .toBe(1);

  await page.evaluate(() => window.__resolveOverlayStart());
  await expect(page.locator("#agentPillAction")).toHaveText("Session live");
  await expect(page.locator("#stopAgent")).toBeEnabled();
});

test("thinking has a visible ring spinner and amplitude messages retain their nested subtype", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await page.evaluate(() => {
    for (const listener of window.__actionsJsonRuntimeListeners) {
      listener({
        type: "actions-json:agent-session-event",
        event: { type: "response.created" },
      });
    }
  });
  await expect(page.locator("#agentPill")).toHaveAttribute("data-state", "thinking");
  await expect(page.locator("#agentPillAction")).toHaveText("Thinking");
  await expect.poll(() => page.locator(".agent-pill-signal").evaluate(
    (element) => getComputedStyle(element, "::after").animationName,
  )).toBe("agent-pill-progress-spin");

  await page.evaluate(() => {
    for (const listener of window.__actionsJsonRuntimeListeners) {
      listener({
        type: "actions-json:agent-audio-amplitude",
        amplitude: { type: "envelope", input: 0.65, output: 0.2, at: Date.now() },
      });
    }
  });
  await expect(page.locator("#agentPill")).toHaveAttribute("data-audio", "measuring");
});

test("overlay missing-key and microphone failures stay visible and actionable", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.addInitScript(() => {
    window.__ACTIONS_JSON_USE_FAKE_REALTIME = true;
    window.__ACTIONS_JSON_MICROPHONE_PERMISSION_STATE = "denied";
  });
  await page.goto(
    "https://actions-json.test/agent-surface.html?surface=overlay&tab=agent&parentOrigin=https%3A%2F%2Factions-json.test",
  );

  await page.locator("#overlayStartAgent").click();
  await expect(page.locator("#configPanel")).toBeVisible();
  await expect(page.locator("#apiKey")).toBeFocused();

  await page.locator("#apiKey").fill("sk-proj-agent-surface-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#overlayStartAgent").click();
  await expect(page.locator("#overlayStartAgent")).toHaveText("Retry voice");
  await expect(page.locator("#overlayStartAgent")).toBeEnabled();
  await expect(page.locator("#agentPillAction")).toHaveText("Voice error");
  await expect(page.locator("#targetSummary")).toContainText("Microphone permission dismissed or blocked");
});

test("the pill stays out of the side-panel surface", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  // Known-answer counterpart to the test above: if the pill were always shown,
  // that test would pass for the wrong reason.
  await expect(page.locator("#agentPill")).toBeHidden();
  await expect(page.locator(".agent-conversation")).toBeVisible();
});

test("state hue reaches the computed border and never the computed background", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChrome);
  await page.goto("https://actions-json.test/agent-surface.html?surface=overlay&tab=agent");
  await expect(page.locator("#agentPill")).toBeVisible();

  const sampled = await page.evaluate(async () => {
    const { PILL_STATE_TOKENS, ACTIVITY_STATES } =
      await import("https://actions-json.test/src/agent/pill-presentation.mjs");
    const pill = document.querySelector("#agentPill");
    const out = [];
    for (const state of ACTIVITY_STATES) {
      // Drive the DOM exactly the way the presenter's surface does.
      pill.dataset.state = state;
      for (const property of ["--pill-hue", "--pill-rim"]) {
        pill.style.setProperty(property, PILL_STATE_TOKENS[state].hue);
      }
      // The pill deliberately TRANSITIONS border-color (Live Activities: animate
      // the change, don't swap the element). While a transition is in flight
      // getComputedStyle reports the interpolated colour, not the target — read
      // it too early and every state reports the previous state's hue, which is
      // exactly how this assertion first failed. Let the transition finish.
      await pill.getAnimations().map((animation) => animation.finished).reduce(
        (chain, done) => chain.then(() => done.catch(() => {})),
        Promise.resolve(),
      );
      const computed = getComputedStyle(pill);
      out.push({
        state,
        borderColor: computed.borderTopColor,
        backgroundColor: computed.backgroundColor,
      });
    }
    return out;
  });

  const backgrounds = new Set();
  const borders = new Set();
  for (const row of sampled) {
    backgrounds.add(row.backgroundColor);
    borders.add(row.borderColor);
  }
  // Containment, as the engine actually resolved it: the body colour is the
  // same neutral for every state, while the border tracks the state.
  expect(backgrounds.size, `pill background varied by state: ${[...backgrounds]}`).toBe(1);
  expect(borders.size, `pill border did not vary by state: ${[...borders]}`).toBe(sampled.length);
});

// ---------------------------------------------------------------------------
// U9 — the developer-mode Debug tab.
//
// WHAT LIVES HERE vs WHAT LIVES IN NODE
// -------------------------------------
// The outcome classification, the status_details extraction and truncation, the
// unread-dot bookkeeping and the empty state are all decided in
// src/agent/debug-log-presentation.mjs and asserted exhaustively in
// tests/agent-surface-debug-tab.test.mjs. None of that needs a browser.
//
// These four specs assert the things a node test genuinely cannot:
//   * that the tab is ABSENT FROM A REAL DOCUMENT with devMode off — a fact
//     about agent-surface.js, which touches `document` at import time and cannot be
//     imported into node at all;
//   * that the three outcome states resolve to three different COMPUTED
//     colours, which only a layout engine can answer;
//   * that clicking the real tab clears the real dot;
//   * that flipping the stored preference mounts the tab without a reload.
// ---------------------------------------------------------------------------

// A stub whose storage actually FIRES onChanged, because "the tab reacts to the
// popup's write" is the behaviour under test. The shared stubChrome above has a
// no-op listener, which would make the reactivity spec pass vacuously.
function stubChromeWithLiveStorage(seed) {
  window.__actionsJsonStorage = seed || {};
  window.__actionsJsonChangeListeners = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage() { return { ok: true }; },
      getURL(path) { return `https://actions-json.test/${path}`; },
    },
    storage: {
      local: {
        async get(key) {
          return typeof key === "string"
            ? { [key]: window.__actionsJsonStorage[key] }
            : { ...window.__actionsJsonStorage };
        },
        async set(values) {
          Object.assign(window.__actionsJsonStorage, values);
          const changes = {};
          for (const [key, newValue] of Object.entries(values)) changes[key] = { newValue };
          for (const listener of window.__actionsJsonChangeListeners) listener(changes, "local");
        },
        async remove(key) { delete window.__actionsJsonStorage[key]; },
      },
      onChanged: {
        addListener(listener) { window.__actionsJsonChangeListeners.push(listener); },
      },
    },
    tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; } },
  };
}

const DEBUG_SETTINGS_KEY = "ACTIONS_JSON_OVERLAY_SETTINGS_V1";
const DEBUG_MEMORY_KEY = "ACTIONS_JSON_AGENT_MEMORY_V1";

function debugSeed({ devMode, events = [] }) {
  return {
    [DEBUG_SETTINGS_KEY]: {
      showCost: false,
      devMode,
      restingCorner: "bottom-right",
      reducedMotion: "system",
    },
    [DEBUG_MEMORY_KEY]: { visitorId: "local-agent-spec", events },
  };
}

test("with devMode off the Debug tab is ABSENT from the DOM, not hidden", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChromeWithLiveStorage, debugSeed({ devMode: false }));
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  // The transcript proves the surface actually rendered, so a count of 0 below
  // is absence and not a page that failed to load.
  await expect(page.locator("#transcript")).toHaveCount(1);

  // toHaveCount(0), NOT toBeHidden(). A debug surface that is merely
  // display:none is still in the tree for anything that walks it.
  await expect(page.locator("#debugTab")).toHaveCount(0);
  await expect(page.locator("#debugLog")).toHaveCount(0);
  await expect(page.locator("#debugUnreadDot")).toHaveCount(0);
  await expect(page.locator(".debug-entry")).toHaveCount(0);

  // And nothing in the document mentions it — belt and braces against a node
  // that exists under a different id.
  const mentions = await page.evaluate(() =>
    document.querySelectorAll("[id*='debug' i], [class*='debug-' i]").length);
  expect(mentions).toBe(0);
});

test("with devMode on the Debug tab mounts and renders the session log", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChromeWithLiveStorage, debugSeed({
    devMode: true,
    events: [
      { id: "e1", type: "transcript", role: "user", text: "open the board", timestamp: "2026-07-27T10:00:00.000Z" },
      { id: "e2", type: "tool", name: "pointer.click", ok: true, summary: "clicked Add", timestamp: "2026-07-27T10:00:01.000Z" },
    ],
  }));
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");

  await expect(page.locator("#debugTab")).toHaveCount(1);
  await page.locator("#debugTab").click();
  await expect(page.locator("#debugLog")).toBeVisible();
  await expect(page.locator(".debug-entry")).toHaveCount(2);
  await expect(page.locator(".debug-entry[data-entry-type='transcript']")).toContainText("open the board");
  await expect(page.locator(".debug-entry[data-entry-type='tool']")).toContainText("pointer.click");
});

test("success, failure and indeterminate resolve to three different computed colours", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChromeWithLiveStorage, debugSeed({
    devMode: true,
    events: [
      { id: "ok", type: "tool", name: "pointer.click", ok: true, summary: "clicked", timestamp: "2026-07-27T10:00:00.000Z" },
      {
        id: "bad",
        type: "realtime",
        name: "response.done",
        ok: false,
        summary: "Realtime event response.done did NOT complete (status: failed).",
        timestamp: "2026-07-27T10:00:01.000Z",
        output: {
          status: "failed",
          status_details: {
            type: "failed",
            error: {
              type: "invalid_request_error",
              code: "context_length_exceeded",
              message: "The conversation exceeds the model context window.",
            },
          },
        },
      },
      {
        id: "maybe",
        type: "tool",
        name: "workflow.run",
        ok: false,
        summary: "Verification could not confirm the mutation.",
        timestamp: "2026-07-27T10:00:02.000Z",
        output: { failure_class: "mutation_outcome_indeterminate", retry_safe: false, recoverable: true },
      },
    ],
  }));
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await page.locator("#debugTab").click();
  await expect(page.locator(".debug-entry")).toHaveCount(3);

  // THE REGRESSION GUARD, in the browser: the failed response must not paint
  // like the successful one. If it did, the tab would say "fine" in green and
  // re-create the silence 5f8dc90 fixed.
  const sampled = await page.evaluate(() =>
    [...document.querySelectorAll(".debug-entry")].map((el) => {
      const computed = getComputedStyle(el);
      return {
        outcome: el.dataset.outcome,
        borderColor: computed.borderLeftColor,
        background: computed.backgroundColor,
        word: el.querySelector(".debug-entry-outcome")?.textContent || "",
      };
    }));

  expect(sampled.map((row) => row.outcome)).toEqual(["success", "failure", "indeterminate"]);
  // Three states, three colours, three words. Colour alone would fail a
  // greyscale screenshot pasted into an incident thread.
  expect(new Set(sampled.map((row) => row.borderColor)).size).toBe(3);
  expect(new Set(sampled.map((row) => row.background)).size).toBe(3);
  expect(new Set(sampled.map((row) => row.word)).size).toBe(3);

  // status_details reaches the screen: type, code, and the start of the message.
  const details = page.locator(".debug-entry[data-outcome='failure'] .debug-status-details");
  await expect(details).toHaveCount(1);
  await expect(details).toContainText("invalid_request_error");
  await expect(details).toContainText("context_length_exceeded");
  await expect(details).toContainText("The conversation exceeds");
});

test("an empty log renders an empty state, and the unread dot clears on view", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChromeWithLiveStorage, debugSeed({ devMode: true, events: [] }));
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await page.locator("#debugTab").click();

  // Empty is an EMPTY STATE, not an error.
  await expect(page.locator("[data-debug-empty='true']")).toHaveCount(1);
  await expect(page.locator(".debug-entry")).toHaveCount(0);
  await expect(page.locator("#debugTab")).toHaveAttribute("data-unread", "false");

  // Switch away, then let an error land. The dot must light.
  await page.locator("#transcriptViewTab").click();
  await page.evaluate((key) => window.chrome.storage.local.set({
    [key]: {
      visitorId: "local-agent-spec",
      events: [{ id: "boom", type: "error", code: "no_target", message: "Target not found", timestamp: "2026-07-27T10:00:03.000Z" }],
    },
  }), DEBUG_MEMORY_KEY);
  await expect(page.locator("#debugTab")).toHaveAttribute("data-unread", "true");

  // Viewing clears it.
  await page.locator("#debugTab").click();
  await expect(page.locator("#debugTab")).toHaveAttribute("data-unread", "false");
  await expect(page.locator(".debug-entry[data-outcome='failure']")).toHaveCount(1);
});

test("flipping devMode mounts and unmounts the tab without a reload", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(stubChromeWithLiveStorage, debugSeed({ devMode: false }));
  await page.goto("https://actions-json.test/agent-surface.html?tab=agent");
  await expect(page.locator("#debugTab")).toHaveCount(0);

  // Exactly what src/popup.js writes when the Developer mode checkbox changes.
  await page.evaluate((key) => window.chrome.storage.local.set({
    [key]: { showCost: false, devMode: true, restingCorner: "bottom-right", reducedMotion: "system" },
  }), DEBUG_SETTINGS_KEY);
  await expect(page.locator("#debugTab")).toHaveCount(1);

  // And back off — the nodes are REMOVED, not hidden.
  await page.evaluate((key) => window.chrome.storage.local.set({
    [key]: { showCost: false, devMode: false, restingCorner: "bottom-right", reducedMotion: "system" },
  }), DEBUG_SETTINGS_KEY);
  await expect(page.locator("#debugTab")).toHaveCount(0);
  await expect(page.locator("#debugLog")).toHaveCount(0);
});
