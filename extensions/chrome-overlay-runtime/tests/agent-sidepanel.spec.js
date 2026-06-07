const { test, expect } = require("@playwright/test");
const fs = require("fs/promises");
const path = require("path");

const extensionRoot = path.join(__dirname, "..");

async function routeExtensionAssets(page) {
  await page.route("https://actions-json.test/**", async (route) => {
    const url = new URL(route.request().url());
    const relativePath = url.pathname === "/" ? "sidepanel.html" : url.pathname.slice(1);
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
            groupId: 202,
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");

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

  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
  await page.locator("#saveKey").click();

  await expect(page.locator("#keySummary")).toHaveText("OpenAI key configured: sk-proj...3456");
  await expect(page.locator("body")).not.toContainText("sidepanel-secret");
  await expect(page.locator("#startAgent")).toBeEnabled();
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "idle");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Start voice");

  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");
  await expect(page.locator("#startAgent")).toHaveAttribute("data-voice-state", "live");
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Voice live");
  await expect(page.locator("#targetSummary")).toContainText("gpt-realtime-2 voice session connected");
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");

  await expect(page.locator("#agentPanel")).toBeVisible();
  await expect(page.locator("#configPanel")).toBeHidden();
  await expect(page.locator("#startAgent")).toBeVisible();
  await expect(page.locator("#transcript")).toBeVisible();
  await expect(page.locator("#agentTab")).toHaveCount(0);
  await expect(page.locator("#configTab")).toHaveCount(0);

  await page.goto("https://actions-json.test/sidepanel.html?tab=config");

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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");

  await expect(page.locator("#startAgent")).toBeDisabled();
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Add key first");

  await page.evaluate(async () => {
    await window.chrome.storage.local.set({
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-sidepanel-secret-value-123456",
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
            groupId: 202,
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
  await page.locator("#saveKey").click();
  await openAgentTab(page);
  await page.locator("#startAgent").click();
  await expect(page.locator("#agentState")).toHaveText("Live");

  const sessionUpdate = await page.evaluate(() =>
    window.__ACTIONS_JSON_FAKE_REALTIME_FACTORY.transports[0].events.find(
      (event) => event.type === "session.update",
    ),
  );
  expect(sessionUpdate.session.tools).toEqual([
    {
      type: "function",
      name: "browser_screenshot",
      description: "Capture the visible tab through the bridge.",
      parameters: {
        type: "object",
        properties: { format: { type: "string", enum: ["png", "jpeg"] } },
        additionalProperties: false,
      },
    },
  ]);
  await expect(page.locator("#transcript")).toContainText("Bridge tools loaded: browser.screenshot.");

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
            arguments: JSON.stringify({ format: "png" }),
          },
        ],
      },
    });
  });
  await expect(page.locator("#transcript")).toContainText("Tool: browser.screenshot started.");
  await expect(page.locator("#transcript")).toContainText("Tool: browser.screenshot completed.");

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
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-sidepanel-secret-value-123456",
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
            groupId: 202,
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
          return [{ id: 101, url: "https://pragmaworks.dev/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });
  await page.route("https://actions-json.test/**", async (route) => {
    const url = new URL(route.request().url());
    const relativePath = url.pathname === "/" ? "sidepanel.html" : url.pathname.slice(1);
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
  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await page.locator("#startAgent").click();

  await expect(page.locator("#transcript")).toContainText("Using extension-local tools");
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
            groupId: 202,
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
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
    "Bridge tools loaded: browser.screenshot, debug.run_javascript.",
  );
});

test("side panel starts production voice through the durable extension session host", async ({ page }) => {
  await routeExtensionAssets(page);
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-sidepanel-secret-value-123456",
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    };
    window.__actionsJsonRuntimeMessages = [];
    window.__actionsJsonRuntimeListeners = [];
    window.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:17345/mcp/tools/list") {
        return {
          ok: true,
          status: 200,
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
                  state: { status: "connected", model: "gpt-realtime-2", error: null },
                });
              }
            });
            return {
              ok: true,
              state: { status: "connected", model: "gpt-realtime-2", error: null },
            };
          }
          if (message.type === "actions-json:agent-session-stop") {
            return {
              ok: true,
              state: { status: "stopped", model: "gpt-realtime-2", error: null },
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
          return [{ id: 101, url: "https://pragmaworks.dev/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
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
              state: { status: "connected", model: "gpt-realtime-2", error: null, inputMuted: false },
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
              return { ACTIONS_JSON_OPENAI_API_KEY: "sk-proj-sidepanel-secret-value-123456" };
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");

  await expect(page.locator("#agentState")).toHaveText("Live");
  await expect(page.locator("#startAgent")).toBeDisabled();
  await expect(page.locator("#stopAgent")).toBeEnabled();
  await expect(page.locator("#voiceLauncherLabel")).toHaveText("Voice live");
  await expect(page.locator("#targetSummary")).toContainText("gpt-realtime-2 voice session connected");
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
            groupId: 202,
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
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
            groupId: 202,
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
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
          return { ok: true, runtimeKey: "chrome-tab:101", authorizationId: "authorization-test", groupId: 202 };
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
  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
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
    window.chrome = {
      runtime: {
        async sendMessage(message) {
          window.__actionsJsonRuntimeMessages.push(message);
          return {
            ok: true,
            runtimeKey: `chrome-tab:${message.tabId}`,
            authorizationId: "authorization-sidepanel",
            groupId: 303,
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=config");
  await openConfigTab(page);
  await page.locator("#bridgeUrl").fill("ws://127.0.0.1:17345/extension");
  await page.locator("#authorizeBridge").click();

  await expect(page.locator("#bridgeStatus")).toHaveText("Authorized and connecting.");
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
      "sites/pragmaworks.dev/home/actions.json": JSON.stringify({
        protocol: "actions.json",
        tools: [{ name: "pragmaworks.site.map", description: "Map", input_schema: { type: "object" } }],
      }),
    };
    function directoryHandle(prefix = "") {
      return {
        kind: "directory",
        name: prefix ? prefix.split("/").at(-1) : "actions.json.storage.shared.pragmaworks",
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
          return [{ id: 505, url: "https://pragmaworks.dev/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/sidepanel.html?tab=config");
  await openConfigTab(page);
  await page.locator("#loadStorageFolder").click();
  await expect(page.locator("#storageFolderStatus")).toContainText("Uploaded 1 file(s)");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.actionsJsonStorageBundle.entries[0].path))
    .toBe("scopes/shared/pragmaworks/sites/pragmaworks.dev/home/actions.json");

  await page.locator("#writeStorageFolder").click();
  await expect(page.locator("#storageFolderStatus")).toContainText("Downloaded 1 file(s)");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonFolderWrites[0].path))
    .toBe("sites/pragmaworks.dev/home/actions.json");
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
          return [{ id: 505, url: "https://pragmaworks.dev/" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/sidepanel.html?tab=config&surface=overlay");
  await openConfigTab(page);
  await page.locator("#loadStorageFolder").click();

  await expect(page.locator("#storageFolderStatus")).toContainText("Opened top-level Settings for folder access");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonCreatedTab))
    .toEqual({ url: "https://actions-json.test/sidepanel.html?tab=config&surface=top-level" });
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
      "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/actions.json": JSON.stringify({
        protocol: "actions.json",
        tools: [{ name: "pragmaworks.site.map", description: "Map", input_schema: { type: "object" } }],
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
          return [{ id: 909, url: "https://actions-json.test/sidepanel.html?tab=config&surface=top-level" }];
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
  });

  await page.goto("https://actions-json.test/sidepanel.html?tab=config&surface=top-level");
  await openConfigTab(page);
  await page.locator("#loadStorageFolder").click();

  await expect(page.locator("#storageFolderStatus")).toContainText("Uploaded 3 file(s)");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.actionsJsonStorageBundle.entries.map((entry) => entry.path)))
    .toEqual([
      "storage.json",
      "scopes/private/sites/amazon.com/prime-video/actions.json",
      "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/actions.json",
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");
  await openConfigTab(page);
  await page.locator("#apiKey").fill("sk-proj-sidepanel-secret-value-123456");
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

  await page.goto("https://actions-json.test/sidepanel.html?tab=agent");

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

  await page.goto("https://actions-json.test/sidepanel.html?tab=config");
  await openConfigTab(page);
  await expect(page.locator("#memoryStatus")).toHaveText("Memory: 1 event.");

  await page.locator("#clearMemory").click();

  await expect(page.locator("#memoryStatus")).toHaveText("Memory cleared.");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_AGENT_MEMORY_V1))
    .toBeUndefined();
});
