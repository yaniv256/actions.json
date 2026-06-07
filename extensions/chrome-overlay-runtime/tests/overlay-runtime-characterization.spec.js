const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const contentScriptPath = path.join(__dirname, "../src/content.js");
const backgroundScriptPath = path.join(__dirname, "../src/background.js");

function backgroundScriptForBrowserTest() {
  return fs.readFileSync(backgroundScriptPath, "utf8")
    .replace(
      /^import \{\n  listSiteActionsFromBundle,\n  resolveSiteActionFromBundle,\n  siteBlockedPrimitiveNamesFromBundle,\n\} from "\.\/agent\/local-actions-catalog\.mjs";\nimport \{\n  buildRealtimeToolCatalog,\n  filterRealtimeToolsForBlockedPrimitives,\n\} from "\.\/agent\/realtime-tool-catalog\.mjs";\n\n/,
      "",
    );
}

async function addBackgroundScript(page) {
  await page.evaluate(() => {
    window.listSiteActionsFromBundle = window.listSiteActionsFromBundle || (() => []);
    window.siteBlockedPrimitiveNamesFromBundle = window.siteBlockedPrimitiveNamesFromBundle || (() => []);
    window.filterRealtimeToolsForBlockedPrimitives = window.filterRealtimeToolsForBlockedPrimitives || ((tools) => tools);
    window.buildRealtimeToolCatalog = window.buildRealtimeToolCatalog || (() => [
      {
        type: "function",
        name: "actions.site",
        description: "List or call current-site actions.",
        parameters: { type: "object", additionalProperties: false },
      },
      {
        type: "function",
        name: "pointer.click",
        description: "Click a point.",
        parameters: { type: "object", additionalProperties: false },
      },
    ]);
    window.resolveSiteActionFromBundle = window.resolveSiteActionFromBundle || (() => ({
      ok: false,
      error: {
        code: "unknown_action",
        message: "Requested site action is not declared in browser-local actions.json storage.",
      },
    }));
  });
  await page.addScriptTag({ content: backgroundScriptForBrowserTest() });
}

async function installRuntime(page, manifestOverride) {
  await page.addInitScript(() => {
    window.__actionsJsonMessages = [];
    window.__actionsJsonRuntimeListeners = [];
    window.__actionsJsonStorage = {};
    window.chrome = {
      runtime: {
        getURL(path) {
          return `https://actions-json.test/${path}`;
        },
        sendMessage(message, callback) {
          window.__actionsJsonMessages.push({ type: "chrome_runtime_message", message });
          if (typeof window.__actionsJsonRuntimeMessageHandler === "function") {
            Promise.resolve(window.__actionsJsonRuntimeMessageHandler(message))
              .then((response) => callback(response))
              .catch((error) => callback({ ok: false, error: error.message || String(error) }));
            return;
          }
          callback({
            ok: true,
            dataUrl: window.__actionsJsonScreenshotDataUrl ||
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAEACAIAAADTED8xAAAIKElEQVR4nO3WMQ0AAAjDMMC/58ONgiY5sJGupJOd3QAA+BsAAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIEOC3AAbAAAG6VFbNAAAAAElFTkSuQmCC",
          });
        },
        onMessage: {
          addListener(listener) {
            window.__actionsJsonRuntimeListeners.push(listener);
          },
        },
      },
      storage: {
        local: {
          get(keys, callback) {
            if (Array.isArray(keys)) {
              callback(Object.fromEntries(keys.map((key) => [key, window.__actionsJsonStorage[key]])));
              return;
            }
            if (typeof keys === "string") {
              callback({ [keys]: window.__actionsJsonStorage[keys] });
              return;
            }
            callback({ ...window.__actionsJsonStorage });
          },
          set(values, callback) {
            Object.assign(window.__actionsJsonStorage, values);
            callback?.();
          },
        },
      },
    };
    window.WebSocket = class FakeWebSocket extends EventTarget {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        window.__actionsJsonWebSockets = window.__actionsJsonWebSockets || [];
        window.__actionsJsonWebSockets.push(this);
        window.__actionsJsonWebSocket = this;
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }

      send(raw) {
        window.__actionsJsonMessages.push(JSON.parse(raw));
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    };
  });
  await page.route("https://actions-json.test/actions/overlay.actions.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(manifestOverride || {
        tools: [
          { name: "overlay.open", input_schema: { type: "object" } },
          { name: "overlay.close", input_schema: { type: "object" } },
          { name: "browser.screenshot", input_schema: { type: "object" } },
          { name: "storage.import_bundle", input_schema: { type: "object" } },
          { name: "storage.list", input_schema: { type: "object" } },
        ],
      }),
    })
  );
  await page.goto("data:text/html,<main><h1>Test surface</h1></main>");
  await page.addScriptTag({ path: contentScriptPath });
}

async function connectRuntime(page) {
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);
}

async function callRuntimeAction(page, callId, name, args = {}) {
  await page.evaluate(({ callId, name, args }) => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: callId,
          name,
          arguments: args,
        }),
      })
    );
  }, { callId, name, args });
}

async function actionOutput(page, callId) {
  return page.evaluate((id) =>
    window.__actionsJsonMessages.find(
      (item) => item.type === "action_call_output" && item.call_id === id
    ) || null,
  callId);
}

test("PR3 overlay.open creates an overlay host and returns an overlay id", async ({ page }) => {
  await installRuntime(page);

  const result = await page.evaluate(() =>
    window.actionsJsonOverlay.openHtml({
      title: "Characterization Overlay",
      html: "<section><h2>Overlay body</h2><script>window.__scriptRan = true;</script></section>",
      width: 640,
      height: 480,
    })
  );

  expect(result.ok).toBe(true);
  expect(result.overlay_id).toMatch(/^overlay-/);
  await expect(page.locator("#__actions_json_overlay_runtime_host")).toHaveAttribute(
    "data-overlay-id",
    result.overlay_id
  );
  await expect(
    page.locator("#__actions_json_overlay_runtime_host").evaluate((host) =>
      host.shadowRoot.querySelector(".overlay-title").textContent
    )
  ).resolves.toBe("Characterization Overlay");
  await expect(
    page.locator("#__actions_json_overlay_runtime_host").evaluate((host) =>
      host.shadowRoot.querySelector(".overlay-body").textContent
    )
  ).resolves.toContain("Overlay body");
  await expect(page.evaluate(() => window.__scriptRan === true)).resolves.toBe(false);
});

test("hosted agent action calls are not accepted as a content-script bridge bypass", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "page.info", input_schema: { type: "object" } },
    ],
  });

  const response = await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    let answered = false;
    const result = listener(
      {
        type: "actions-json:hosted-action-call",
        name: "page.info",
        arguments: {},
      },
      {},
      () => {
        answered = true;
      },
    );
    return { result, answered };
  });

  expect(response).toEqual({ result: false, answered: false });
  expect(await page.evaluate(() => window.__actionsJsonMessages.filter((item) => item.type === "action_call_output").length)).toBe(0);
});

test("runtime.session.log returns the extension-local hosted agent log through the bridge action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "runtime.session.log", input_schema: { type: "object" } },
    ],
  });
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:agent-session-log") {
        return { ok: false, error: `Unexpected message ${message.type}` };
      }
      return {
        ok: true,
        log: {
          ok: true,
          visitorId: "local-agent-test",
          eventCount: 2,
          events: [
            { type: "transcript", role: "user", text: "Can you take a screenshot?" },
            { type: "error", code: "tool_failed", message: "Screenshot failed" },
          ],
        },
      };
    };
  });
  await connectRuntime(page);

  await callRuntimeAction(page, "call-session-log", "runtime.session.log", { limit: 20 });

  await expect
    .poll(() => actionOutput(page, "call-session-log"))
    .toMatchObject({
      type: "action_call_output",
      call_id: "call-session-log",
      output: {
        ok: true,
        primitive: "runtime.session.log",
        adapter: "extension",
        value: {
          visitorId: "local-agent-test",
          eventCount: 2,
          events: [
            { type: "transcript", role: "user", text: "Can you take a screenshot?" },
            { type: "error", code: "tool_failed", message: "Screenshot failed" },
          ],
        },
      },
    });
});

test("extension menu opens top-level Agent and Settings tabs in the page overlay shell", async ({ page }) => {
  await installRuntime(page);
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        { type: "actions-json:open-menu-overlay" },
        {},
        resolve
      )
    );
  });

  const menu = page.locator("#__actions_json_menu_overlay_host");
  await expect(menu).toHaveCount(1);
  await expect(menu.locator("iframe").first()).toHaveAttribute(
    "src",
    "https://actions-json.test/sidepanel.html?surface=overlay&tab=agent"
  );
  await expect(menu.locator("[data-tab='agent']")).toHaveAttribute("aria-selected", "true");
  await expect(menu.locator("[data-tab='config']")).toHaveText("Settings");
  await expect(menu.locator("[data-panel='agent']")).toHaveClass(/active/);
  await expect(menu.locator("[data-tab='status']")).toHaveCount(0);

  await menu.locator("[data-tab='config']").click();
  await expect(menu.locator("[data-tab='config']")).toHaveAttribute("aria-selected", "true");
  await expect(menu.locator("[data-panel='config']")).toHaveClass(/active/);
  await expect(menu.locator("iframe").nth(1)).toHaveAttribute(
    "src",
    "https://actions-json.test/sidepanel.html?surface=overlay&tab=config"
  );

  await menu.locator("[data-minimize]").click();
  await expect(menu.locator("[data-minimize]")).toBeVisible();
  await expect(menu.locator("[data-tab='agent']")).toBeHidden();
  await expect(menu.locator("[data-tab='config']")).toBeHidden();
  await expect(menu.locator("[data-close]")).toBeHidden();
  await expect
    .poll(() => menu.evaluate((node) => Math.round(node.getBoundingClientRect().width)))
    .toBeLessThanOrEqual(48);
});

test("runtime reconnects when the bridge WebSocket closes", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonMessages.filter((item) => item.type === "runtime_ready").length))
    .toBe(1);

  await page.evaluate(() => window.__actionsJsonWebSocket.close());

  await expect
    .poll(
      () => page.evaluate(() => window.__actionsJsonWebSockets.length),
      { timeout: 3000 }
    )
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonMessages.filter((item) => item.type === "runtime_ready").length))
    .toBe(2);
});

test("runtime reconnect preserves an already-open menu overlay without rebuilding it", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
    await new Promise((resolve) =>
      listener({ type: "actions-json:open-menu-overlay" }, {}, resolve)
    );
    const host = document.querySelector("#__actions_json_menu_overlay_host");
    host.dataset.reconnectMarker = "same-host";
    host.shadowRoot.querySelector("[data-tab='config']").click();
  });

  await page.evaluate(() => window.__actionsJsonWebSocket.close());

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonWebSockets.length), { timeout: 3000 })
    .toBe(2);
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() =>
      document.querySelector("#__actions_json_menu_overlay_host")?.dataset.reconnectMarker
    ))
    .toBe("same-host");
  await expect
    .poll(() => page.evaluate(() =>
      document
        .querySelector("#__actions_json_menu_overlay_host")
        ?.shadowRoot
        ?.querySelector("[data-tab='config']")
        ?.getAttribute("aria-selected")
    ))
    .toBe("true");
});

test("runtime relays bookmarklet protocol messages over the extension bridge", async ({ page }) => {
  await installRuntime(page);
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve,
      ),
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonRelayMessages = [];
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.source === "ajex" &&
        event.data?.direction === "extension-to-page"
      ) {
        window.__actionsJsonRelayMessages.push(event.data.item);
      }
    });
    window.postMessage(
      {
        source: "ajbm",
        direction: "page-to-extension",
        item: {
          type: "runtime_ready",
          runtime_id: "bookmarklet-test",
          runtime_key: "bookmarklet:https://example.test",
          authorization_id: null,
          extension_version: "bookmarklet-test",
          url: location.href,
          manifest: { tools: [{ name: "storage.list", input_schema: { type: "object" } }] },
        },
      },
      "*",
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.some(
          (item) => item.type === "runtime_ready" && item.runtime_id === "bookmarklet-test",
        ),
      ),
    )
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          runtime_id: "bookmarklet-test",
          call_id: "relay-call",
          name: "storage.list",
          arguments: {},
        }),
      }),
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonRelayMessages.some(
          (item) => item.type === "action_call" && item.call_id === "relay-call",
        ),
      ),
    )
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonRelayMessages = [];
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.source === "ajex" &&
        event.data?.direction === "extension-to-page"
      ) {
        window.__actionsJsonRelayMessages.push(event.data.item);
      }
    });
    window.postMessage(
      {
        source: "ajbm",
        direction: "page-to-extension",
        item: {
          type: "action_call_output",
          runtime_id: "bookmarklet-test",
          call_id: "relay-call",
          output: { ok: true },
        },
      },
      "*",
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.some(
          (item) => item.type === "action_call_output" && item.runtime_id === "bookmarklet-test",
        ),
      ),
    )
    .toBe(true);
});

test("runtime reinjection preserves existing bridge connection and relayed bookmarklet state", async ({ page }) => {
  await installRuntime(page);
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve,
      ),
    );
  });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonMessages.find((item) => item.type === "runtime_ready")?.runtime_id))
    .toMatch(/^actions-json-runtime-/);

  const firstRuntimeId = await page.evaluate(
    () => window.__actionsJsonMessages.find((item) => item.type === "runtime_ready").runtime_id,
  );

  await page.evaluate(() => {
    window.__actionsJsonRelayMessages = [];
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.source === "ajex" &&
        event.data?.direction === "extension-to-page"
      ) {
        window.__actionsJsonRelayMessages.push(event.data.item);
      }
    });
    window.postMessage(
      {
        source: "ajbm",
        direction: "page-to-extension",
        item: {
          type: "runtime_ready",
          runtime_id: "bookmarklet-test",
          runtime_key: "bookmarklet:https://example.test",
          extension_version: "bookmarklet-test",
          url: location.href,
        },
      },
      "*",
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__actionsJsonMessages.some((item) => item.runtime_id === "bookmarklet-test")),
    )
    .toBe(true);
  const readyCountBeforeReinject = await page.evaluate(
    () => window.__actionsJsonMessages.filter((item) => item.type === "runtime_ready").length,
  );

  await page.addScriptTag({ path: contentScriptPath });

  expect(await page.evaluate(() => window.__actionsJsonRuntimeListeners.length)).toBe(1);
  expect(await page.evaluate(() => window.__actionsJsonWebSockets.length)).toBe(1);
  expect(
    await page.evaluate(() => window.__actionsJsonMessages.find((item) => item.type === "runtime_ready").runtime_id),
  ).toBe(firstRuntimeId);
  expect(
    await page.evaluate(() => window.__actionsJsonMessages.filter((item) => item.type === "runtime_ready").length),
  ).toBe(readyCountBeforeReinject);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "runtime_status",
        }),
      }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonRelayMessages.some((item) => item.type === "runtime_status" && item.runtime_id === "bookmarklet-test"),
      ),
    )
    .toBe(true);
});

test("runtime re-announces relayed bookmarklets after bridge reconnect", async ({ page }) => {
  await installRuntime(page);
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve,
      ),
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.postMessage(
      {
        source: "ajbm",
        direction: "page-to-extension",
        item: {
          type: "runtime_ready",
          runtime_id: "bookmarklet-test",
          runtime_key: "bookmarklet:https://example.test",
          authorization_id: null,
          extension_version: "bookmarklet-test",
          url: location.href,
          manifest: { tools: [{ name: "storage.list", input_schema: { type: "object" } }] },
        },
      },
      "*",
    );
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__actionsJsonMessages.filter(
            (item) => item.type === "runtime_ready" && item.runtime_id === "bookmarklet-test",
          ).length,
      ),
    )
    .toBe(1);

  await page.evaluate(() => window.__actionsJsonWebSocket.close());
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonWebSockets.length), { timeout: 3000 })
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__actionsJsonMessages.filter(
            (item) => item.type === "runtime_ready" && item.runtime_id === "bookmarklet-test",
          ).length,
      ),
    )
    .toBe(2);
});

test("PR3 launcher click reopens the overlay and emits the launcher DOM event", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonMessages.some((item) => item.type === "runtime_ready")))
    .toBe(true);

  const result = await page.evaluate(() =>
    window.actionsJsonOverlay.openHtml({
      title: "Launcher Overlay",
      html: "<p>Launcher body</p>",
      launcher: {
        id: "test-launcher",
        label: "Open test overlay",
        selector: "h1",
        text_equals: "Test surface",
      },
    })
  );

  expect(result.launchers).toHaveLength(1);
  await page.evaluate(() => window.actionsJsonOverlay.close());
  await expect(page.locator("#__actions_json_overlay_runtime_host")).toHaveCount(0);
  await page.locator("[data-actions-json-overlay-launcher='test-launcher']").click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "dom_event" && item.event === "actions-json:overlay-launcher-opened"
        )
      )
    )
    .toMatchObject({
      type: "dom_event",
      event: "actions-json:overlay-launcher-opened",
      name: "actions-json:overlay-launcher-opened",
      event_id: expect.stringMatching(/^dom-event-/),
      url: expect.stringContaining("data:text/html"),
      payload: { launcher_id: "test-launcher" },
      observed_at: expect.stringMatching(/T.*Z$/),
    });
});

test("browser.screenshot returns a visible-tab data URL through the action path", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    const image = context.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      const pixel = i / 4;
      image.data[i] = (pixel * 13) % 256;
      image.data[i + 1] = (pixel * 29) % 256;
      image.data[i + 2] = (pixel * 47) % 256;
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    window.__actionsJsonScreenshotDataUrl = canvas.toDataURL("image/png");
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "screenshot-call",
          name: "browser.screenshot",
          arguments: { format: "jpeg", quality: 70, max_kilobytes: 8, max_width: 320, delay_ms: 5 },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "screenshot-call"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        data_url: expect.stringMatching(/^data:image\/jpeg;base64,/),
        mime_type: "image/jpeg",
        image_bytes: expect.any(Number),
        encoded: {
          width: expect.any(Number),
          height: expect.any(Number),
          quality: expect.any(Number),
          resized: true,
        },
        viewport: {
          width: 1280,
          height: 720,
        },
      },
    });

  await expect(
    page.evaluate(() => {
      const item = window.__actionsJsonMessages.find(
        (message) => message.type === "chrome_runtime_message" && message.message?.type === "actions-json:capture-visible-tab"
      );
      return item?.message;
    })
  ).resolves.toMatchObject({
    type: "actions-json:capture-visible-tab",
    format: "jpeg",
    quality: 70,
    delayMs: 0,
  });

  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "action_call_output" && item.call_id === "screenshot-call"
      )?.output?.image_bytes
    )
  ).resolves.toBeLessThanOrEqual(8 * 1024);
});

test("browser.screenshot returns a structured error when background capture does not respond", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = () => new Promise(() => {});
  });

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "screenshot-timeout-call",
          name: "browser.screenshot",
          arguments: { capture_timeout_ms: 25 },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_error" && item.call_id === "screenshot-timeout-call"
        )
      )
    )
    .toMatchObject({
      error: {
        code: "handler_failed",
        message: expect.stringContaining("timed out"),
      },
    });
});

test("background screenshot focuses the sender window before visible-tab capture", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundCalls = [];
    window.chrome = {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "test-version" };
        },
        onInstalled: {
          addListener() {},
        },
        onMessage: {
          addListener(listener) {
            window.__actionsJsonBackgroundMessageListener = listener;
          },
        },
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
        },
      },
      scripting: {
        async executeScript() {},
      },
      tabGroups: {
        async get(id) {
          return { id };
        },
        async update() {},
      },
      tabs: {
        async get(id) {
          return { id, windowId: 77, url: "https://www.amazon.com/gp/video/storefront" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {},
        update(tabId, props, callback) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.update", tabId, props });
          callback?.();
        },
        captureVisibleTab(windowId, options, callback) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.captureVisibleTab", windowId, options });
          callback("data:image/png;base64,AAAA");
        },
      },
      windows: {
        update(windowId, props, callback) {
          window.__actionsJsonBackgroundCalls.push({ method: "windows.update", windowId, props });
          callback?.();
        },
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Background test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:capture-visible-tab",
              format: "png",
              delayMs: 0,
            },
            {
              tab: {
                id: 123,
                windowId: 77,
                url: "https://www.amazon.com/gp/video/storefront",
              },
            },
            resolve
          );
        })
    )
  ).resolves.toMatchObject({ ok: true, dataUrl: "data:image/png;base64,AAAA" });

  await expect(page.evaluate(() => window.__actionsJsonBackgroundCalls)).resolves.toEqual([
    { method: "windows.update", windowId: 77, props: { focused: true } },
    { method: "tabs.update", tabId: 123, props: { active: true } },
    { method: "tabs.captureVisibleTab", windowId: 77, options: { format: "png" } },
  ]);
});

test("background session log handler returns stored agent memory without dynamic import", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {
      ACTIONS_JSON_AGENT_MEMORY_V1: {
        visitorId: "local-agent-test",
        events: [
          { type: "transcript", role: "user", text: "Navigate to Generative Specification." },
          { type: "tool", name: "actions.site", ok: false, summary: "Navigation blocked" },
        ],
      },
    };
    window.chrome = {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "test-version" };
        },
        onInstalled: {
          addListener() {},
        },
        onMessage: {
          addListener(listener) {
            window.__actionsJsonBackgroundMessageListener = listener;
          },
        },
      },
      storage: {
        local: {
          async get(key) {
            return { [key]: window.__actionsJsonStorage[key] };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
        },
      },
      scripting: {
        async executeScript() {},
      },
      tabGroups: {
        async get(id) {
          return { id };
        },
        async update() {},
      },
      tabs: {
        async get(id) {
          return { id, windowId: 77, url: "https://pragmaworks.dev/start" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {},
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Background log test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:agent-session-log",
              limit: 10,
            },
            {},
            resolve
          );
        })
    )
  ).resolves.toMatchObject({
    ok: true,
    log: {
      ok: true,
      visitorId: "local-agent-test",
      eventCount: 2,
      events: [
        { type: "transcript", role: "user", text: "Navigate to Generative Specification." },
        { type: "tool", name: "actions.site", ok: false, summary: "Navigation blocked" },
      ],
    },
  });
});

test("storage import and list use Chrome local storage through the action path", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "storage-import",
          name: "storage.import_bundle",
          arguments: {
            bundle: {
              protocol: "actions.json.storage.bundle",
              version: 1,
              synced_at_ms: 123,
              entries: [
                {
                  path: "scopes/private/sites/example.com/actions.json",
                  content_type: "application/json",
                  content: "{\"protocol\":\"actions.json\"}",
                },
              ],
            },
          },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "storage-import"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        entry_count: 1,
      },
    });

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "storage-list",
          name: "storage.list",
          arguments: {},
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "storage-list"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        entry_count: 1,
        paths: ["scopes/private/sites/example.com/actions.json"],
      },
    });

  await expect(
    page.evaluate(() => window.__actionsJsonStorage.actionsJsonStorageBundle.entries[0].path)
  ).resolves.toBe("scopes/private/sites/example.com/actions.json");
});

test("browser.extract_elements extracts declared fields from a scoped item set", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "overlay.open", input_schema: { type: "object" } },
      { name: "browser.extract_elements", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <main>
      <section aria-label="Kids and family">
        <h2>Kids and family</h2>
        <a href="/gp/video/detail/KIDS1" aria-label="Paddington 2">
          <img alt="Paddington 2" src="https://images.example.test/paddington.jpg">
        </a>
      </section>
      <section aria-label="Inspired by what you've watched">
        <h2>Inspired by what you've watched</h2>
        <div class="row-strip">
          <a href="/gp/video/detail/BERMUDA" aria-label="Monsters of the Bermuda Triangle">
            <img alt="Monsters of the Bermuda Triangle" src="https://images.example.test/bermuda.jpg">
          </a>
          <a href="/gp/video/detail/ASIA" aria-label="Asia">
            <img alt="Asia" src="https://images.example.test/asia.jpg">
          </a>
        </div>
      </section>
    </main>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "extract-elements",
          name: "browser.extract_elements",
          arguments: {
            scope: {
              selectors: ["h1", "h2", "h3", "h4", "[role='heading']"],
              text_equals: "Inspired by what you've watched",
              root_strategy: "nearest_ancestor_containing_items",
              max_ancestor_depth: 4,
            },
            item_selector: "a[href*='/gp/video/detail/']",
            fields: [
              { name: "title", selector: ":scope, img", attributes: ["aria-label", "alt", "title", "text"] },
              { name: "url", selector: ":scope", attributes: ["href"] },
              { name: "latest_cover_url", selector: "img", attributes: ["currentSrc", "src"] },
            ],
          },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "extract-elements"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        item_count: 2,
        items: [
          {
            title: "Monsters of the Bermuda Triangle",
            url: expect.stringContaining("/gp/video/detail/BERMUDA"),
            latest_cover_url: "https://images.example.test/bermuda.jpg",
          },
          {
            title: "Asia",
            url: expect.stringContaining("/gp/video/detail/ASIA"),
            latest_cover_url: "https://images.example.test/asia.jpg",
          },
        ],
      },
    });
});

test("browser.extract_elements extracts items when scope and items are sibling blocks", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "browser.extract_elements", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <main>
      <div class="row-header">
        <h2>Fantasy and Sci-Fi</h2>
        <a href="/gp/video/storefront/fantasy">See more</a>
      </div>
      <div class="row-strip">
        <a href="/gp/video/detail/ROHIRRIM" aria-label="The Lord of the Rings: The War of the Rohirrim">
          <img alt="The Lord of the Rings: The War of the Rohirrim" src="https://images.example.test/rohirrim.jpg">
        </a>
        <a href="/gp/video/detail/HOBBIT" aria-label="The Hobbit">
          <img alt="The Hobbit" src="https://images.example.test/hobbit.jpg">
        </a>
      </div>
    </main>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "extract-sibling-elements",
          name: "browser.extract_elements",
          arguments: {
            scope: {
              selectors: ["h2"],
              text_equals: "Fantasy and Sci-Fi",
              root_strategy: "nearest_ancestor_containing_items",
              max_ancestor_depth: 4,
            },
            item_selector: "a[href*='/gp/video/detail/']",
            fields: [
              { name: "title", selector: ":scope, img", attributes: ["aria-label", "alt", "title", "text"] },
              { name: "url", selector: ":scope", attributes: ["href"] },
              { name: "latest_cover_url", selector: "img", attributes: ["currentSrc", "src"] },
            ],
          },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "extract-sibling-elements"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        items: [
          {
            title: "The Lord of the Rings: The War of the Rohirrim",
            url: expect.stringContaining("/gp/video/detail/ROHIRRIM"),
          },
          {
            title: "The Hobbit",
            url: expect.stringContaining("/gp/video/detail/HOBBIT"),
          },
        ],
      },
    });
});

test("browser.extract_elements uses actions.json field rules for image-backed items", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "browser.extract_elements", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <main>
      <h2>Fantasy and Sci-Fi</h2>
      <div class="row-strip">
        <div role="button" aria-label="Nausicaä Of The Valley Of The Wind">
          <img alt="Nausicaä Of The Valley Of The Wind" src="https://images.example.test/nausicaa.jpg">
        </div>
        <div role="button" aria-label="The Wind Rises">
          <img alt="The Wind Rises" src="https://images.example.test/wind-rises.jpg">
        </div>
      </div>
    </main>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "extract-image-elements",
          name: "browser.extract_elements",
          arguments: {
            scope: {
              selectors: ["h2"],
              text_equals: "Fantasy and Sci-Fi",
              root_strategy: "nearest_ancestor_containing_items",
              max_ancestor_depth: 4,
            },
            item_selector: "[role='button']",
            fields: [
              { name: "title", selector: ":scope, img", attributes: ["aria-label", "alt"] },
              { name: "url", selector: ":scope, a[href]", attributes: ["href"] },
              { name: "latest_cover_url", selector: "img", attributes: ["currentSrc", "src"] },
            ],
          },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "extract-image-elements"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        items: [
          {
            title: "Nausicaä Of The Valley Of The Wind",
            url: "",
            latest_cover_url: "https://images.example.test/nausicaa.jpg",
          },
          {
            title: "The Wind Rises",
            url: "",
            latest_cover_url: "https://images.example.test/wind-rises.jpg",
          },
        ],
      },
    });
});

test("browser.run_javascript executes declared JavaScript with arguments", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "browser.run_javascript", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <main>
      <h2>Outstanding dramas</h2>
      <div class="strip" style="display:flex; gap:12px; width:320px; overflow-x:auto;">
        <a href="/gp/video/detail/ONE" style="display:block; min-width:220px;">One</a>
        <a href="/gp/video/detail/TWO" style="display:block; min-width:220px;">Two</a>
        <a href="/gp/video/detail/THREE" style="display:block; min-width:220px;">Three</a>
      </div>
    </main>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "run-declared-javascript",
          name: "browser.run_javascript",
          arguments: {
            args: {
              selector: ".strip",
              left: 260,
            },
            source: `
              const target = document.querySelector(args.selector);
              if (!target) throw new Error("target not found");
              const before = { left: target.scrollLeft, top: target.scrollTop };
              target.scrollBy({ left: args.left, top: 0, behavior: "instant" });
              await new Promise((resolve) => setTimeout(resolve, 50));
              const after = { left: target.scrollLeft, top: target.scrollTop };
              return { before, after, moved: after.left !== before.left };
            `,
          },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "run-declared-javascript"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        result: {
          before: { left: 0 },
          after: { left: expect.any(Number) },
          moved: true,
        },
      },
    });

  await expect(
    page.evaluate(() => document.querySelector(".strip").scrollLeft)
  ).resolves.toBeGreaterThan(0);

});

test("viewport.scroll scrolls a scoped carousel horizontally through the extension action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "viewport.scroll", input_schema: { type: "object" } },
      { name: "browser.extract_elements", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <main>
      <section class="row">
        <h2>Continue watching</h2>
        <div class="strip" style="display:flex; gap:12px; width:320px; overflow-x:auto;">
          <a href="/gp/video/detail/ONE" style="display:block; min-width:220px;">One</a>
          <a href="/gp/video/detail/TWO" style="display:block; min-width:220px;">Two</a>
          <a href="/gp/video/detail/THREE" style="display:block; min-width:220px;">Three</a>
          <a href="/gp/video/detail/FOUR" style="display:block; min-width:220px;">Four</a>
        </div>
      </section>
    </main>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await callRuntimeAction(page, "scroll-continue-watching", "viewport.scroll", {
    delta_x: 260,
    delta_y: 0,
    scope: {
      selectors: ["h1", "h2", "h3", "[role='heading']"],
      text_equals: "Continue watching",
      root_strategy: "nearest_ancestor_containing_items",
      max_ancestor_depth: 4,
    },
    item_selector: "a[href*='/gp/video/detail/']",
  });

  const secondScrollStartedAt = Date.now();
  await callRuntimeAction(page, "scroll-continue-watching-again", "viewport.scroll", {
    delta_x: 260,
    delta_y: 0,
    scope: {
      selectors: ["h1", "h2", "h3", "[role='heading']"],
      text_equals: "Continue watching",
      root_strategy: "nearest_ancestor_containing_items",
      max_ancestor_depth: 4,
    },
    item_selector: "a[href*='/gp/video/detail/']",
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "scroll-continue-watching"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        primitive: "viewport.scroll",
        adapter: "extension",
        value: {
          moved: true,
          target: "element",
          diagnostics: {
            viewport: {
              width: expect.any(Number),
              height: expect.any(Number),
              scroll_x: expect.any(Number),
              scroll_y: expect.any(Number),
            },
            target_element: {
              tag_name: "h2",
              text: "Continue watching",
              before: expect.any(Object),
              after: expect.any(Object),
            },
            scroll_target: {
              kind: "element",
              before: expect.any(Object),
              after: expect.any(Object),
            },
          },
        },
      },
    });

  await expect(
    page.evaluate(() => document.querySelector(".strip").scrollLeft)
  ).resolves.toBeGreaterThan(0);

  await expect
    .poll(() => actionOutput(page, "scroll-continue-watching-again"))
    .toMatchObject({
      output: {
        ok: true,
        primitive: "viewport.scroll",
        adapter: "extension",
        value: {
          moved: true,
          target: "element",
          rate_limit_wait_ms: expect.any(Number),
        },
      },
    });
  expect(Date.now() - secondScrollStartedAt).toBeGreaterThanOrEqual(450);
  const secondOutput = await actionOutput(page, "scroll-continue-watching-again");
  expect(secondOutput.output.value.rate_limit_wait_ms).toBeGreaterThanOrEqual(400);

  const extractStartedAt = Date.now();
  await callRuntimeAction(page, "extract-after-scrolls", "browser.extract_elements", {
    scope: {
      selectors: ["h1", "h2", "h3", "[role='heading']"],
      text_equals: "Continue watching",
      root_strategy: "nearest_ancestor_containing_items",
      max_ancestor_depth: 4,
    },
    item_selector: "a[href*='/gp/video/detail/']",
    fields: [
      { name: "title", selector: ":scope", attribute: "text" },
      { name: "url", selector: ":scope", attributes: ["href"] },
    ],
  });
  await expect
    .poll(() => actionOutput(page, "extract-after-scrolls"))
    .toMatchObject({
      output: {
        ok: true,
      },
    });
  expect(Date.now() - extractStartedAt).toBeLessThan(250);
});

test("extension implements advertised point and input primitives", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "pointer.move", input_schema: { type: "object" } },
      { name: "pointer.double_click", input_schema: { type: "object" } },
      { name: "pointer.drag", input_schema: { type: "object" } },
      { name: "text.insert", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <button
      data-testid="double-target"
      style="position:absolute;left:120px;top:100px;width:120px;height:44px"
      ondblclick="document.body.dataset.doubleClicked = 'yes'"
    >Double</button>
    <div
      data-testid="drag-target"
      style="position:absolute;left:120px;top:180px;width:80px;height:44px;background:#ddd"
      onpointerdown="document.body.dataset.dragStarted = 'yes'"
    >Drag</div>
    <input
      data-testid="text-target"
      style="position:absolute;left:120px;top:260px;width:180px;height:36px"
      oninput="document.body.dataset.inputValue = this.value"
    />
  `);

  await connectRuntime(page);

  await callRuntimeAction(page, "extension-pointer-move", "pointer.move", { x: 180, y: 122, duration_ms: 0 });
  await expect.poll(() => actionOutput(page, "extension-pointer-move")).toMatchObject({
    output: {
      ok: true,
      primitive: "pointer.move",
      adapter: "extension",
      value: { x: 180, y: 122 },
    },
  });
  await expect(page.evaluate(() => document.querySelector("#actions-json-ghost-pointer")?.style.left)).resolves.toBe("180px");

  await callRuntimeAction(page, "extension-pointer-double", "pointer.double_click", { x: 180, y: 122 });
  await expect.poll(() => actionOutput(page, "extension-pointer-double")).toMatchObject({
    output: {
      ok: true,
      primitive: "pointer.double_click",
      adapter: "extension",
      value: { double_clicked: true, x: 180, y: 122 },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.doubleClicked)).resolves.toBe("yes");

  await callRuntimeAction(page, "extension-pointer-drag", "pointer.drag", {
    from: { x: 160, y: 202 },
    to: { x: 240, y: 222 },
    duration_ms: 0,
  });
  await expect.poll(() => actionOutput(page, "extension-pointer-drag")).toMatchObject({
    output: {
      ok: true,
      primitive: "pointer.drag",
      adapter: "extension",
      value: { dragged: true },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.dragStarted)).resolves.toBe("yes");

  await page.locator("[data-testid='text-target']").focus();
  await callRuntimeAction(page, "extension-text-insert", "text.insert", { text: "hello extension" });
  await expect.poll(() => actionOutput(page, "extension-text-insert")).toMatchObject({
    output: {
      ok: true,
      primitive: "text.insert",
      adapter: "extension",
      value: { inserted: true, inserted_length: 15 },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='text-target']").value)).resolves.toBe("hello extension");
});

test("extension implements page, DOM, locator text, wait, and keyboard primitives", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "page.info", input_schema: { type: "object" } },
      { name: "dom.observe.visible", input_schema: { type: "object" } },
      { name: "dom.list_sections", input_schema: { type: "object" } },
      { name: "dom.snapshot_text", input_schema: { type: "object" } },
      { name: "locator.text_content", input_schema: { type: "object" } },
      { name: "locator.wait_for", input_schema: { type: "object" } },
      { name: "keyboard.press", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <title>Extension Observation Fixture</title>
    <main>
      <button data-testid="visible-action" onkeydown="document.body.dataset.key = event.key">Observe Me</button>
      <p class="copy">Visible text snapshot target</p>
      <section data-testid="standard-carousel" style="margin-top: 40px; height: 160px">
        <h2>Top picks</h2>
        <article><a href="/gp/video/detail/one">First</a></article>
      </section>
      <section data-testid="standard-carousel" style="margin-top: 900px; height: 160px">
        <h2>Continue watching</h2>
        <article><a href="/gp/video/detail/two">Second</a></article>
        <article><a href="/gp/video/detail/three">Third</a></article>
      </section>
    </main>
  `);

  await connectRuntime(page);

  await callRuntimeAction(page, "extension-page-info", "page.info");
  await expect.poll(() => actionOutput(page, "extension-page-info")).toMatchObject({
    output: {
      ok: true,
      primitive: "page.info",
      adapter: "extension",
      value: { title: "Extension Observation Fixture" },
    },
  });

  await callRuntimeAction(page, "extension-dom-observe", "dom.observe.visible", {
    selector: "button",
    text_contains: "Observe",
  });
  await expect.poll(() => actionOutput(page, "extension-dom-observe")).toMatchObject({
    output: {
      ok: true,
      primitive: "dom.observe.visible",
      adapter: "extension",
      value: {
        match_count: 1,
        matches: [expect.objectContaining({ tag_name: "button", text: "Observe Me" })],
      },
    },
  });

  await callRuntimeAction(page, "extension-dom-list-sections", "dom.list_sections", {
    selector: "section[data-testid='standard-carousel']",
    heading_selector: "h2",
    item_selector: "article",
  });
  await expect.poll(() => actionOutput(page, "extension-dom-list-sections")).toMatchObject({
    output: {
      ok: true,
      primitive: "dom.list_sections",
      adapter: "extension",
      value: {
        section_count: 2,
        sections: [
          expect.objectContaining({ heading: "Top picks", item_count: 1 }),
          expect.objectContaining({ heading: "Continue watching", item_count: 2 }),
        ],
      },
    },
  });
  const extensionSections = (await actionOutput(page, "extension-dom-list-sections")).output.value.sections;
  expect(extensionSections[1].scroll_y).toBeGreaterThan(extensionSections[0].scroll_y);
  expect(extensionSections[1].visible).toBe(false);

  await callRuntimeAction(page, "extension-dom-snapshot", "dom.snapshot_text", {
    selector: "main",
    max_chars: 200,
  });
  await expect.poll(() => actionOutput(page, "extension-dom-snapshot")).toMatchObject({
    output: {
      ok: true,
      primitive: "dom.snapshot_text",
      adapter: "extension",
      value: {
        text: "Observe Me Visible text snapshot target Top picks First Continue watching Second Third",
        truncated: false,
      },
    },
  });

  await callRuntimeAction(page, "extension-locator-text", "locator.text_content", {
    locator: { selector: "[data-testid='visible-action']" },
  });
  await expect.poll(() => actionOutput(page, "extension-locator-text")).toMatchObject({
    output: {
      ok: true,
      primitive: "locator.text_content",
      adapter: "extension",
      value: { text: "Observe Me" },
    },
  });

  await callRuntimeAction(page, "extension-locator-wait", "locator.wait_for", {
    locator: { text_equals: "Observe Me" },
    state: "visible",
    timeout_ms: 100,
  });
  await expect.poll(() => actionOutput(page, "extension-locator-wait")).toMatchObject({
    output: {
      ok: true,
      primitive: "locator.wait_for",
      adapter: "extension",
      value: { matched: true, state: "visible" },
    },
  });

  await page.locator("[data-testid='visible-action']").focus();
  await callRuntimeAction(page, "extension-keyboard-press", "keyboard.press", { key: "Enter" });
  await expect.poll(() => actionOutput(page, "extension-keyboard-press")).toMatchObject({
    output: {
      ok: true,
      primitive: "keyboard.press",
      adapter: "extension",
      value: { pressed: true, key: "Enter", fidelity: "page_level" },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.key)).resolves.toBe("Enter");
});

test("dom.list_sections treats viewport-edge sections as not visible", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "dom.list_sections", input_schema: { type: "object" } },
    ],
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.setContent(`
    <main>
      <section
        data-testid="edge-section"
        style="position:absolute; top:600px; left:0; width:300px; height:120px"
      >
        <h2>Just below viewport</h2>
      </section>
    </main>
  `);
  await connectRuntime(page);

  await callRuntimeAction(page, "extension-dom-list-edge-section", "dom.list_sections", {
    selector: "section[data-testid='edge-section']",
    heading_selector: "h2",
  });

  await expect.poll(() => actionOutput(page, "extension-dom-list-edge-section")).toMatchObject({
    output: {
      ok: true,
      primitive: "dom.list_sections",
      adapter: "extension",
      value: {
        section_count: 1,
        viewport_height: 600,
        sections: [
          expect.objectContaining({
            heading: "Just below viewport",
            top: 600,
            visible: false,
          }),
        ],
      },
    },
  });
});

test("debug.run_javascript delegates arbitrary evaluation to the privileged background fallback", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "debug.run_javascript", input_schema: { type: "object" } },
    ],
  });

  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:debug-evaluate") {
        return { ok: false, error: `unexpected message ${message.type}` };
      }
      return {
        ok: true,
        result: {
          echoedArgs: message.args,
          expressionIncludesSource: message.source.includes("document.querySelectorAll"),
        },
        url: "https://www.amazon.com/gp/video/storefront",
        execution: {
          adapter: "extension",
          capability_class: "debug",
          transport: "chrome.debugger",
        },
      };
    };
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "debug-run-javascript-call",
          name: "debug.run_javascript",
          arguments: {
            args: { heading: "Continue watching" },
            source: `
              return Array.from(document.querySelectorAll("h2"))
                .map((node) => node.textContent.trim())
                .filter(Boolean);
            `,
          },
        }),
      })
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === "debug-run-javascript-call"
        )
      )
    )
    .toMatchObject({
      output: {
        ok: true,
        result: {
          echoedArgs: { heading: "Continue watching" },
          expressionIncludesSource: true,
        },
        execution: {
          adapter: "extension",
          capability_class: "debug",
          transport: "chrome.debugger",
        },
      },
    });

  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find((item) => item.type === "chrome_runtime_message")?.message
    )
  ).resolves.toMatchObject({
    type: "actions-json:debug-evaluate",
    args: { heading: "Continue watching" },
  });
});

test("root attachments declaration installs an overlay launcher", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "overlay.open", input_schema: { type: "object" } },
      { name: "overlay.close", input_schema: { type: "object" } },
    ],
    attachments: [
      {
        id: "issue-execution-path",
        kind: "overlay_launcher",
        target: {
          selectors: ["h1"],
          text_equals: "Test surface",
        },
        affordance: {
          label: "Execution path",
          title: "Open execution path",
          placement: "afterend",
          max_instances: 1,
          opens: {
            tool: "overlay.open",
            arguments: {
              title: "Attachment overlay",
              html: "<p>Opened from a root attachment</p>",
            },
          },
        },
      },
    ],
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });

  await expect(page.locator("[data-actions-json-overlay-launcher='issue-execution-path']")).toHaveText(
    "Execution path"
  );
  await page.locator("[data-actions-json-overlay-launcher='issue-execution-path']").click();

  await expect(
    page.locator("#__actions_json_overlay_runtime_host").evaluate((host) =>
      host.shadowRoot.querySelector(".overlay-body").textContent
    )
  ).resolves.toContain("Opened from a root attachment");
});

test("overlay.register_launcher installs a launcher without opening the overlay", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "overlay.open", input_schema: { type: "object" } },
      { name: "overlay.register_launcher", input_schema: { type: "object" } },
      { name: "overlay.close", input_schema: { type: "object" } },
    ],
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "register-launcher",
          name: "overlay.register_launcher",
          arguments: {
            title: "Continue Watching Categories",
            html: "<p>Categories body</p>",
            launchers: [
              {
                id: "prime-video-continue-watching",
                label: "Categories",
                selectors: ["h1"],
                text_equals: "Test surface",
                placement: "afterend",
                max_instances: 1,
              },
            ],
          },
        }),
      })
    );
  });

  await expect(page.locator("#__actions_json_overlay_runtime_host")).toHaveCount(0);
  await expect(page.locator("[data-actions-json-overlay-launcher='prime-video-continue-watching']")).toHaveText(
    "Categories"
  );
  const output = await readExtensionActionOutput(page, "register-launcher");
  expect(output).toMatchObject({
    ok: true,
    launchers: [
      {
        launcher_id: "prime-video-continue-watching",
        placement: "afterend",
        target_text: "Test surface",
      },
    ],
  });
});

test("registered launcher restores after content script reload and returned page context", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "overlay.open", input_schema: { type: "object" } },
      { name: "overlay.register_launcher", input_schema: { type: "object" } },
      { name: "overlay.close", input_schema: { type: "object" } },
    ],
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "persisted-register-launcher",
          name: "overlay.register_launcher",
          arguments: {
            title: "Continue Watching Categories",
            html: "<p>Categories body</p>",
            launchers: [
              {
                id: "prime-video-continue-watching",
                label: "Categories",
                selectors: ["h1"],
                text_equals: "Test surface",
                placement: "afterend",
                max_instances: 1,
              },
            ],
          },
        }),
      })
    );
  });
  await readExtensionActionOutput(page, "persisted-register-launcher");

  await page.evaluate(() => {
    window.__actionsJsonOverlayRuntime.disconnect();
    document.querySelector("[data-actions-json-overlay-launcher]")?.remove();
    document.querySelector("main").innerHTML = "<h1>Movie detail</h1>";
  });
  await page.addScriptTag({ path: contentScriptPath });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners.at(-1);
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
    document.querySelector("main").innerHTML = "<h1>Test surface</h1>";
  });

  await expect(page.locator("[data-actions-json-overlay-launcher='prime-video-continue-watching']")).toHaveText(
    "Categories"
  );
});

test("actions.json menu overlay restores after content script reload", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "overlay.open", input_schema: { type: "object" } },
      { name: "overlay.close", input_schema: { type: "object" } },
    ],
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
    await new Promise((resolve) =>
      listener({ type: "actions-json:open-menu-overlay" }, {}, resolve)
    );
  });

  await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
    host.style.left = "118px";
    host.style.top = "77px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.width = "300px";
    host.style.height = "260px";
  });
  await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
    host.shadowRoot.querySelector("[data-tab='config']").click();
    host.shadowRoot.querySelector("[data-minimize]").click();
  });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage["actionsJsonMenuOverlayState.v1"]?.collapsed))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonOverlayRuntime.disconnect();
    document.querySelector("#__actions_json_menu_overlay_host")?.remove();
    document.querySelector("main").innerHTML = "<h1>After navigation</h1>";
  });
  await page.addScriptTag({ path: contentScriptPath });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners.at(-1);
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });

  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCount(1);
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("left", "118px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("top", "77px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("width", "42px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("height", "42px");

  await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
    host.shadowRoot.querySelector("[data-minimize]").click();
  });
  await expect(
    page.locator("#__actions_json_menu_overlay_host").evaluate((host) =>
      host.shadowRoot.querySelector("[data-tab='config']").getAttribute("aria-selected")
    )
  ).resolves.toBe("true");
});

test("locator.element_info center feeds pointer.click through the extension action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "locator.element_info", input_schema: { type: "object" } },
      { name: "pointer.click", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <main>
      <button
        data-testid="target-action"
        style="position:absolute;left:240px;top:180px;width:160px;height:48px"
        onclick="document.body.dataset.clicked = 'yes'; document.body.dataset.clickX = Math.round(event.clientX); document.body.dataset.clickY = Math.round(event.clientY);"
      >Launch sequence</button>
    </main>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__actionsJsonWebSocket)))
    .toBe(true);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "locator-bridge-call",
          name: "locator.element_info",
          arguments: { locator: { text: "Launch sequence" } },
        }),
      })
    );
  });
  const locatorOutput = await readExtensionActionOutput(page, "locator-bridge-call");

  await page.evaluate((point) => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "pointer-click-call",
          name: "pointer.click",
          arguments: point,
        }),
      })
    );
  }, locatorOutput.value.clickable_center);
  const clickOutput = await readExtensionActionOutput(page, "pointer-click-call");

  expect(locatorOutput).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      text: "Launch sequence",
      tag_name: "button",
      bounding_box: { x: 240, y: 180, width: 160, height: 48 },
      clickable_center: { x: 320, y: 204 },
    },
  });
  expect(clickOutput).toMatchObject({
    ok: true,
    primitive: "pointer.click",
    adapter: "extension",
    value: { clicked: true, x: 320, y: 204 },
  });
  await expect(page.evaluate(() => document.body.dataset.clicked)).resolves.toBe("yes");
  await expect(page.evaluate(() => document.body.dataset.clickX)).resolves.toBe("320");
  await expect(page.evaluate(() => document.body.dataset.clickY)).resolves.toBe("204");
});

test("locator.element_info filters selector candidates by text through the extension action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "locator.element_info", input_schema: { type: "object" } }],
  });

  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <section style="position:absolute;left:10px;top:10px;width:700px;height:400px">
      <h2 style="position:absolute;left:20px;top:20px;width:300px;height:40px;margin:0">Drama TV and movies</h2>
      <h2 style="position:absolute;left:20px;top:100px;width:300px;height:40px;margin:0">Continue watching</h2>
    </section>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "locator-selector-text-call",
          name: "locator.element_info",
          arguments: { locator: { selector: "h2", text_equals: "Continue watching" } },
        }),
      })
    );
  });
  const output = await readExtensionActionOutput(page, "locator-selector-text-call");

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      text: "Continue watching",
      tag_name: "h2",
      bounding_box: { x: 30, y: 110, width: 300, height: 40 },
      clickable_center: { x: 180, y: 130 },
    },
  });
});

test("locator.element_info clips clickable center to the visible viewport through the extension action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "locator.element_info", input_schema: { type: "object" } }],
  });

  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <a
      href="#partial"
      data-testid="partial-card"
      style="position:absolute;left:40px;top:-110px;width:220px;height:120px;display:block"
    >Partially visible card</a>
  `);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://127.0.0.1:17345/extension",
          runtimeKey: "test-tab",
          authorizationId: "test-auth",
          extensionVersion: "test",
        },
        {},
        resolve
      )
    );
  });

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "locator-partial-call",
          name: "locator.element_info",
          arguments: { locator: { selector: "[data-testid='partial-card']" } },
        }),
      })
    );
  });
  const output = await readExtensionActionOutput(page, "locator-partial-call");

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      bounding_box: { x: 40, y: -110, width: 220, height: 120 },
      clickable_center: { x: 150, y: 5 },
    },
  });
});

async function readExtensionActionOutput(page, callId) {
  await expect
    .poll(() =>
      page.evaluate((id) =>
        window.__actionsJsonMessages.find(
          (item) => item.type === "action_call_output" && item.call_id === id
        )?.output || null,
      callId)
    )
    .not.toBeNull();
  return page.evaluate((id) =>
    window.__actionsJsonMessages.find(
      (item) => item.type === "action_call_output" && item.call_id === id
    )?.output || null,
  callId);
}
