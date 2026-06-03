const { test, expect } = require("@playwright/test");
const path = require("path");

const contentScriptPath = path.join(__dirname, "../src/content.js");

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
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
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
  });

  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "action_call_output" && item.call_id === "screenshot-call"
      )?.output?.image_bytes
    )
  ).resolves.toBeLessThanOrEqual(8 * 1024);
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
