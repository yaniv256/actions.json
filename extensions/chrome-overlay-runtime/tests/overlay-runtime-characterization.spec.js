const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const contentScriptPath = path.join(__dirname, "../src/content.js");
const backgroundScriptPath = path.join(__dirname, "../src/background.js");

function backgroundScriptForBrowserTest() {
  // Browser tests inject the service worker as a classic inline script, so
  // remove every static import regardless of module path or formatting. Keep
  // explicit guards here: a stale loader must fail at the boundary instead of
  // surfacing later as dozens of unrelated listener timeouts.
  const source = fs.readFileSync(backgroundScriptPath, "utf8");
  let inImport = false;
  let removed = 0;
  const body = source
    .split("\n")
    .filter((line) => {
      if (!inImport && /^import\b/.test(line)) {
        removed += 1;
        inImport = !/;\s*$/.test(line);
        return false;
      }
      if (inImport) {
        inImport = !/;\s*$/.test(line);
        return false;
      }
      return true;
    })
    .join("\n");

  if (removed === 0) {
    throw new Error("Browser VM loader did not remove any production ESM imports");
  }
  if (/^import\b/m.test(body)) {
    throw new Error("Browser VM loader leaked a production ESM import");
  }
  const importedBindings = Array.from(
    source.matchAll(/(?:^|\n)import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/g),
  ).flatMap((match) => {
    const clause = match[1].trim();
    if (clause.startsWith("{")) {
      return clause
        .slice(1, -1)
        .split(",")
        .map((name) => name.trim().split(/\s+as\s+/).at(-1))
        .filter(Boolean);
    }
    if (clause.startsWith("* as ")) return [clause.slice(5).trim()];
    return [clause.split(",", 1)[0].trim()].filter(Boolean);
  });
  return { body, importedBindings };
}

async function addBackgroundScript(page) {
  const { body, importedBindings } = backgroundScriptForBrowserTest();
  await page.evaluate(() => {
    window.chrome.debugger = {
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
      ...window.chrome.debugger,
    };
    window.normalizeSiteActionCallArgs = window.normalizeSiteActionCallArgs || ((args = {}) => {
      const rest = args.arguments && typeof args.arguments === "object" ? args.arguments : {};
      const top = args.action || args.action_name || args.name;
      if (top) {
        return { action: top, actionArguments: rest };
      }
      if (typeof rest.action === "string" && rest.action) {
        const { action, ...remaining } = rest;
        return { action, actionArguments: remaining };
      }
      return null;
    });
    window.listSiteActionsFromBundle = window.listSiteActionsFromBundle || (() => []);
    window.listSiteStorageFilesFromBundle = window.listSiteStorageFilesFromBundle || (() => ({ files: [], skills: [] }));
    window.listStateProjectionsFromBundle = window.listStateProjectionsFromBundle || (() => []);
    window.diffStates = window.diffStates || ((before, after) => {
      const beforeCards = before?.board?.lists?.[0]?.cards || [];
      const afterCards = after?.board?.lists?.[0]?.cards || [];
      return afterCards.length > beforeCards.length
        ? [{ op: "add", path: "/board/lists/0/cards/1", value: afterCards[1] }]
        : [];
    });
    window.buildSemanticDeltas = window.buildSemanticDeltas || ((patches) => patches.map((patch) => ({
      type: "patch",
      path: patch.path,
      patch,
    })));
    window.verifyStatePostcondition = window.verifyStatePostcondition || (async () => ({ ok: true }));
    window.readSiteStorageFileFromBundle = window.readSiteStorageFileFromBundle || (() => ({
      ok: true,
      value: {
        id: "skill",
        path: "scopes/private/sites/example.test/SKILL.md",
        kind: "skill",
        mime_type: "text/markdown",
        bytes: 42,
        truncated: false,
        front_matter: { name: "Example Skill" },
        text: "# Example Skill",
      },
    }));
    window.siteBlockedPrimitiveNamesFromBundle = window.siteBlockedPrimitiveNamesFromBundle || (() => []);
    window.filterRealtimeToolsForBlockedPrimitives = window.filterRealtimeToolsForBlockedPrimitives || ((tools) => tools);
    window.BridgeOutputDeliveryQueue = window.BridgeOutputDeliveryQueue || class BridgeOutputDeliveryQueue {
      constructor() {
        this.pending = [];
      }
      deliver(item, send) {
        if (send(item)) return true;
        this.pending.push(item);
        return false;
      }
      flush(send) {
        const remaining = [];
        let sent = 0;
        for (const item of this.pending) {
          if (send(item)) sent += 1;
          else remaining.push(item);
        }
        this.pending = remaining;
        return { sent, remaining: remaining.length, expired: 0 };
      }
    };
    window.ShimTree = window.ShimTree || class ShimTree {};
    window.Announcer = window.Announcer || class Announcer {
      async start() {}
      async stop() {}
    };
    window.normalizeGatedRepeatArgs = window.normalizeGatedRepeatArgs || ((args) => args);
    window.runGatedRepeat = window.runGatedRepeat || (async () => ({ ok: true }));
    window.createChromeScreenshotBrowser = window.createChromeScreenshotBrowser || ((chromeApi) => ({
      focusWindow: (windowId) => new Promise((resolve, reject) => {
        chromeApi.windows.update(windowId, { focused: true }, (value) => {
          if (chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
          else resolve(value);
        });
      }),
      activateTab: (tabId) => new Promise((resolve, reject) => {
        chromeApi.tabs.update(tabId, { active: true }, (value) => {
          if (chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
          else resolve(value);
        });
      }),
      readActiveTab: (windowId) => new Promise((resolve, reject) => {
        chromeApi.tabs.query({ active: true, windowId }, (tabs) => {
          if (chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
          else resolve(tabs?.[0] || null);
        });
      }),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      captureVisibleTab: (windowId, options) => new Promise((resolve, reject) => {
        chromeApi.tabs.captureVisibleTab(windowId, options, (value) => {
          if (chromeApi.runtime.lastError) reject(new Error(chromeApi.runtime.lastError.message));
          else resolve(value);
        });
      }),
    }));
    window.captureTabSurface = window.captureTabSurface || (async (browser, tab, options = {}) => {
      const tabId = Number(tab?.id);
      const windowId = Number(tab?.windowId);
      await browser.focusWindow(windowId);
      await browser.activateTab(tabId);
      const activeTab = await browser.readActiveTab(windowId);
      if (Number(activeTab?.id) !== tabId) {
        return { ok: false, error: { code: "screenshot_target_not_active" } };
      }
      const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0;
      if (delayMs > 0) await browser.delay(delayMs);
      const dataUrl = await browser.captureVisibleTab(windowId, {
        format: options.format === "jpeg" ? "jpeg" : "png",
        quality: Number.isInteger(options.quality) ? options.quality : undefined,
      });
      return {
        ok: true,
        dataUrl,
        surface_identity: "verified_active_tab",
        freshness: "unverified",
        delay_ms_applied: delayMs,
      };
    });
    window.createCloudStore = window.createCloudStore || (() => ({
      appendLine: async () => ({ ok: true }),
      flush: async () => ({ ok: true }),
    }));
    window.reconcileDay = window.reconcileDay || (async () => ({ ok: true }));
    window.agentEventFromSessionEvent = window.agentEventFromSessionEvent || ((event) => event);
    window.DEFAULT_MODEL = window.DEFAULT_MODEL || "test-model";
    window.executeWorkflowAction = window.executeWorkflowAction || (async () => ({
      ok: false,
      error: { code: "workflow_unavailable_in_harness", message: "Workflow executor is not loaded in this harness." },
    }));
    window.TransferBufferError = window.TransferBufferError || class TransferBufferError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
    window.transferInsertValue = window.transferInsertValue || ((rendered) => {
      const text = typeof rendered === "string" ? rendered : String(rendered ?? "");
      return { rendered_text: text, text };
    });
    window.TransferBuffer = window.TransferBuffer || class TransferBuffer {
      write(args) {
        return { id: "test-transfer", label: args.label, format: args.format, value: args.value };
      }
      read(args) {
        return { id: "test-transfer", label: args.label, include_value: !!args.include_value };
      }
      clear() {
        return { cleared: 1 };
      }
      render() {
        return { rendered_text: "test transfer" };
      }
    };
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
  await page.evaluate((names) => {
    const missing = names.filter((name) => !(name in window));
    if (missing.length > 0) {
      throw new Error(`Browser VM loader is missing imported bindings: ${missing.join(", ")}`);
    }
  }, importedBindings);
  await page.addScriptTag({ content: body });
}

async function installRuntime(page, manifestOverride, options = {}) {
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
  await page.goto(options.pageUrl || "data:text/html,<main><h1>Test surface</h1></main>");
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

async function actionError(page, callId) {
  return page.evaluate((id) =>
    window.__actionsJsonMessages.find(
      (item) => item.type === "action_error" && item.call_id === id
    ) || null,
  callId);
}

function overlayReportFrame(page) {
  return page.frameLocator("#__actions_json_overlay_runtime_host iframe[data-overlay-document]");
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
  await expect(overlayReportFrame(page).locator("body")).toContainText("Overlay body");
  await expect(page.evaluate(() => window.__scriptRan === true)).resolves.toBe(false);
});

test("browser.claimed_tabs.list forwards to the extension tab registry", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "browser.claimed_tabs.list", input_schema: { type: "object" } },
    ],
  });
  await connectRuntime(page);
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:claimed-tabs-list") {
        return { ok: false, error: `unexpected message ${message.type}` };
      }
      return {
        ok: true,
        tabs: [
          {
            tab_id: 101,
            runtime_key: "chrome-tab:101",
            title: "LinkedIn Messaging",
            url: "https://www.linkedin.com/messaging/",
            active: false,
          },
        ],
        active_tab_id: 101,
      };
    };
  });

  await callRuntimeAction(page, "claimed-tabs-list", "browser.claimed_tabs.list");

  const result = await actionOutput(page, "claimed-tabs-list");
  expect(result.output).toEqual({
    ok: true,
    tabs: [
      {
        tab_id: 101,
        runtime_key: "chrome-tab:101",
        title: "LinkedIn Messaging",
        url: "https://www.linkedin.com/messaging/",
        active: false,
      },
    ],
    active_tab_id: 101,
  });
  await expect(page.evaluate(() => window.__actionsJsonMessages.some(
    (item) => item?.message?.type === "actions-json:claimed-tabs-list"
  ))).resolves.toBe(true);
});

test("browser.claimed_tabs.activate schedules a claimed tab reconnect through background", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "browser.claimed_tabs.activate", input_schema: { type: "object" } },
    ],
  });
  await connectRuntime(page);
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:claimed-tabs-activate") {
        return { ok: false, error: `unexpected message ${message.type}` };
      }
      return {
        ok: true,
        scheduled: true,
        tab: {
          tab_id: 202,
          runtime_key: "chrome-tab:202",
          title: "Amazon Prime Video",
          url: "https://www.amazon.com/gp/video/storefront/",
          active: true,
        },
      };
    };
  });

  await callRuntimeAction(page, "claimed-tabs-activate", "browser.claimed_tabs.activate", {
    tab_id: 202,
  });

  const result = await actionOutput(page, "claimed-tabs-activate");
  expect(result.output).toEqual({
    ok: true,
    scheduled: true,
    tab: {
      tab_id: 202,
      runtime_key: "chrome-tab:202",
      title: "Amazon Prime Video",
      url: "https://www.amazon.com/gp/video/storefront/",
      active: true,
    },
  });
  await expect(page.evaluate(() => window.__actionsJsonMessages.find(
    (item) => item?.message?.type === "actions-json:claimed-tabs-activate"
  )?.message)).resolves.toEqual({
    type: "actions-json:claimed-tabs-activate",
    tabId: 202,
    reconnectDelayMs: 300,
  });
});

test("overlay.open renders full document CSS in an isolated report iframe", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(() =>
    window.actionsJsonOverlay.openHtml({
      title: "Sandboxed Report",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              html, body {
                height: 100%;
                margin: 0;
                background: rgb(17, 24, 39);
                color: white;
              }
              header {
                display: flex;
                padding: 18px;
                background: rgb(236, 72, 153);
              }
              .topbar {
                display: flex;
                border: 4px solid rgb(34, 197, 94);
              }
            </style>
          </head>
          <body>
            <header class="topbar"><h1>Agent-authored header</h1></header>
            <main><p>Full document CSS should render here.</p></main>
            <script>window.__sandboxScriptRan = true;</script>
          </body>
        </html>
      `,
      width: 640,
      height: 480,
    })
  );

  const host = page.locator("#__actions_json_overlay_runtime_host");
  await expect(host).toHaveCount(1);
  await expect(
    host.evaluate((node) =>
      window.getComputedStyle(node.shadowRoot.querySelector(".overlay-bar")).backgroundColor
    )
  ).resolves.toBe("rgb(24, 32, 44)");

  const reportFrameElement = page.locator("#__actions_json_overlay_runtime_host iframe[data-overlay-document]");
  await expect(reportFrameElement).toHaveAttribute("sandbox", "allow-same-origin");
  const reportFrame = page.frameLocator("#__actions_json_overlay_runtime_host iframe[data-overlay-document]");

  await expect(reportFrame.locator("body")).toHaveCSS("background-color", "rgb(17, 24, 39)");
  await expect(reportFrame.locator("header.topbar")).toBeVisible();
  await expect(reportFrame.locator("header.topbar")).toHaveCSS("display", "flex");
  await expect(reportFrame.locator("header.topbar")).toHaveCSS("border-top-color", "rgb(34, 197, 94)");
  await expect(page.evaluate(() => window.__sandboxScriptRan === true)).resolves.toBe(false);
});

test("overlay.open report iframe styles survive restrictive page CSP", async ({ page }) => {
  await page.route("https://strict-csp-actions-json.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "content-security-policy": "default-src 'self'; frame-src 'none'; child-src 'none'; script-src 'unsafe-inline'",
      },
      body: "<main><h1>Strict CSP surface</h1></main>",
    }),
  );
  await installRuntime(page, undefined, { pageUrl: "https://strict-csp-actions-json.test/" });

  await page.evaluate(() =>
    window.actionsJsonOverlay.openHtml({
      title: "CSP-safe Report",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>body { margin: 0; background: rgb(15, 23, 42); color: white; }</style>
          </head>
          <body><main><h1>CSP-safe iframe report</h1></main></body>
        </html>
      `,
      width: 640,
      height: 480,
    })
  );

  await expect(overlayReportFrame(page).locator("h1")).toHaveText("CSP-safe iframe report");
  await expect(overlayReportFrame(page).locator("body")).toHaveCSS("background-color", "rgb(15, 23, 42)");
});

test("report overlay can download and upload sanitized HTML artifacts", async ({ page }) => {
  await installRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonDownloads = [];
    window.__actionsJsonBlobUrls = new Map();
    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = `blob:actions-json-test-${window.__actionsJsonBlobUrls.size + 1}`;
      window.__actionsJsonBlobUrls.set(url, blob);
      blob.text().then((text) => {
        window.__actionsJsonDownloads.push({ url, text });
      });
      return url;
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function click() {
      window.__actionsJsonLastDownload = {
        href: this.href,
        download: this.download,
      };
    };
    window.__actionsJsonOriginalCreateObjectUrl = originalCreateObjectUrl;
  });

  await page.evaluate(() =>
    window.actionsJsonOverlay.openHtml({
      title: "Beautiful Course Notes",
      html: `
        <!doctype html>
        <html>
          <head>
            <title>Course Artifact</title>
            <style>.slide { color: rgb(124, 58, 237); }</style>
          </head>
          <body>
            <section class="slide"><h2>Slide One</h2><p>Keep this note.</p></section>
            <script>window.__downloadScriptRan = true;</script>
          </body>
        </html>
      `,
      width: 640,
      height: 480,
    })
  );

  const host = page.locator("#__actions_json_overlay_runtime_host");
  await expect(host.locator("[data-download]")).toHaveText("Download");
  await expect(host.locator("[data-upload]")).toHaveText("Upload");
  await host.locator("[data-download]").click();

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonLastDownload))
    .toMatchObject({
      download: "beautiful-course-notes.html",
    });
  const exported = await expect
    .poll(() => page.evaluate(() => window.__actionsJsonDownloads[0]?.text || null))
    .toContain("Slide One");
  expect(exported).toBeUndefined();

  const exportedHtml = await page.evaluate(() => window.__actionsJsonDownloads[0].text);
  expect(exportedHtml).toContain("<!doctype html>");
  expect(exportedHtml).toContain("<title>Beautiful Course Notes</title>");
  expect(exportedHtml).toContain("Keep this note.");
  expect(exportedHtml).toContain(".slide");
  expect(exportedHtml).not.toContain("<script>");
  await expect(page.evaluate(() => window.__downloadScriptRan === true)).resolves.toBe(false);

  await page.evaluate(() => {
    document.querySelector("#__actions_json_overlay_runtime_host").remove();
  });
  const uploadPath = path.join(os.tmpdir(), `actions-json-overlay-upload-${Date.now()}.html`);
  fs.writeFileSync(
    uploadPath,
    '<!doctype html><html><head><title>Uploaded Deck</title></head><body><section><h2>Restored Slide</h2></section><script>window.__uploadScriptRan = true;</script></body></html>',
  );
  try {
    await page.evaluate(() =>
      window.actionsJsonOverlay.openHtml({
        title: "Temporary Shell",
        html: "<section><h2>Temporary</h2></section>",
      })
    );
    await page.locator("#__actions_json_overlay_runtime_host [data-upload-input]").setInputFiles(uploadPath);
    await expect
      .poll(() =>
        page.locator("#__actions_json_overlay_runtime_host").evaluate((node) =>
          node.shadowRoot.querySelector(".overlay-title").textContent
        )
      )
      .toBe("Uploaded Deck");
    await expect(overlayReportFrame(page).locator("body")).toContainText("Restored Slide");
    await expect(page.evaluate(() => window.__uploadScriptRan === true)).resolves.toBe(false);
  } finally {
    fs.rmSync(uploadPath, { force: true });
  }
});

test("overlay.open renders public template with private data from storage bundle", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await callRuntimeAction(page, "template-storage-import", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      entries: [
        {
          path: "scopes/public/sites/linkedin.com/overlays/outreach-radar/template.html",
          content_type: "text/html",
          content: `<!doctype html>
            <html>
              <head><title>Reusable Outreach Template</title></head>
              <body>
                <main id="report">Loading</main>
                <script>
                  const data = JSON.parse(document.querySelector('[data-actions-json-overlay-data]').textContent);
                  document.getElementById('report').innerHTML =
                    '<h1>' + data.title + '</h1><p>Total: ' + data.total + '</p>';
                </script>
              </body>
            </html>`,
        },
        {
          path: "scopes/private/sites/linkedin.com/overlays/outreach-radar/data.json",
          content_type: "application/json",
          content: JSON.stringify({ title: "Private Outreach Radar", total: 10 }),
        },
      ],
    },
  });

  await expect
    .poll(() => actionOutput(page, "template-storage-import"))
    .toMatchObject({ output: { ok: true, entry_count: 2 } });

  await callRuntimeAction(page, "template-open", "overlay.open", {
    title: "LinkedIn Outreach Radar",
    template: {
      scope: "public",
      path: "sites/linkedin.com/overlays/outreach-radar/template.html",
    },
    data: {
      scope: "private",
      path: "sites/linkedin.com/overlays/outreach-radar/data.json",
    },
  });

  await expect
    .poll(() => actionOutput(page, "template-open"))
    .toMatchObject({
      output: {
        ok: true,
        template: {
          scope: "public",
          path: "sites/linkedin.com/overlays/outreach-radar/template.html",
        },
        data: {
          scope: "private",
          path: "sites/linkedin.com/overlays/outreach-radar/data.json",
        },
      },
    });
  await expect(overlayReportFrame(page).locator("h1")).toHaveText("Private Outreach Radar");
  await expect(overlayReportFrame(page).locator("body")).toContainText("Total: 10");

  const sandbox = await page.locator("#__actions_json_overlay_runtime_host iframe[data-overlay-document]").getAttribute("sandbox");
  expect(sandbox).toBe("allow-scripts");
});

test("overlay.open resolves private template data imported with storage-relative paths", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await callRuntimeAction(page, "relative-private-template-import", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      entries: [
        {
          path: "sites/linkedin.com/messaging/overlays/outreach-radar/template.html",
          content_type: "text/html",
          content: `<!doctype html><html><body><h1 id="title"></h1><script>const data = JSON.parse(document.querySelector('[data-actions-json-overlay-data]').textContent); document.getElementById('title').textContent = data.title;</script></body></html>`,
        },
        {
          path: "sites/linkedin.com/messaging/overlays/outreach-radar/data.json",
          content_type: "application/json",
          content: JSON.stringify({ title: "Relative Private Storage Works" }),
        },
      ],
    },
  });
  await expect.poll(() => actionOutput(page, "relative-private-template-import")).toMatchObject({ output: { ok: true } });

  await callRuntimeAction(page, "relative-private-template-open", "overlay.open", {
    title: "LinkedIn Outreach Radar",
    template: {
      scope: "private",
      path: "sites/linkedin.com/messaging/overlays/outreach-radar/template.html",
    },
    data: {
      scope: "private",
      path: "sites/linkedin.com/messaging/overlays/outreach-radar/data.json",
    },
  });

  await expect.poll(() => actionOutput(page, "relative-private-template-open")).toMatchObject({ output: { ok: true } });
  await expect(overlayReportFrame(page).locator("h1")).toHaveText("Relative Private Storage Works");
});

test("bridge hydration storage import fast-forwards per file without overwriting newer local entries", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await callRuntimeAction(page, "local-storage-import", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      entries: [
        {
          path: "scopes/private/sites/trello.com/board/SKILL.md",
          content_type: "text/markdown",
          content: "# Local newer Trello skill\n",
          modified_at_ms: 2000,
        },
      ],
    },
  });
  await expect.poll(() => actionOutput(page, "local-storage-import")).toMatchObject({ output: { ok: true } });

  await callRuntimeAction(page, "bridge-hydration-import", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      x_actions_json_bridge_hydration: true,
      entries: [
        {
          path: "scopes/private/sites/trello.com/board/SKILL.md",
          content_type: "text/markdown",
          content: "# Bridge older Trello skill\n",
          modified_at_ms: 1000,
        },
        {
          path: "scopes/private/sites/trello.com/board/quality-score.md",
          content_type: "text/markdown",
          content: "# Bridge newer score\n",
          modified_at_ms: 3000,
        },
      ],
    },
  });
  await expect.poll(() => actionOutput(page, "bridge-hydration-import")).toMatchObject({
    output: {
      ok: true,
      entry_count: 2,
      merged: true,
      updated_count: 1,
      preserved_count: 1,
    },
  });

  const entries = await page.evaluate(() =>
    Object.fromEntries(
      window.__actionsJsonStorage.actionsJsonStorageBundle.entries.map((entry) => [entry.path, entry.content])
    )
  );
  expect(entries["scopes/private/sites/trello.com/board/SKILL.md"]).toBe("# Local newer Trello skill\n");
  expect(entries["scopes/private/sites/trello.com/board/quality-score.md"]).toBe("# Bridge newer score\n");
});

test("overlay.open resolves shared templates and reports storage reference failures", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await callRuntimeAction(page, "template-storage-import-errors", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      entries: [
        {
          path: "scopes/shared/acme/sites/linkedin.com/overlays/shared/template.html",
          content_type: "text/html",
          content: `<!doctype html><html><body><h1 id="title"></h1><script>const data = JSON.parse(document.querySelector('[data-actions-json-overlay-data]').textContent); document.getElementById('title').textContent = data.title;</script></body></html>`,
        },
        {
          path: "scopes/private/sites/linkedin.com/overlays/shared/data.json",
          content_type: "application/json",
          content: JSON.stringify({ title: "Shared Template Works" }),
        },
        {
          path: "scopes/private/sites/linkedin.com/overlays/shared/broken.json",
          content_type: "application/json",
          content: "{not json",
        },
      ],
    },
  });
  await expect.poll(() => actionOutput(page, "template-storage-import-errors")).toMatchObject({ output: { ok: true } });

  await callRuntimeAction(page, "template-open-shared", "overlay.open", {
    title: "Shared Overlay",
    template: { scope: "shared/acme", path: "sites/linkedin.com/overlays/shared/template.html" },
    data: { scope: "private", path: "sites/linkedin.com/overlays/shared/data.json" },
  });
  await expect(overlayReportFrame(page).locator("h1")).toHaveText("Shared Template Works");

  await callRuntimeAction(page, "template-open-invalid-json", "overlay.open", {
    template: { scope: "shared/acme", path: "sites/linkedin.com/overlays/shared/template.html" },
    data: { scope: "private", path: "sites/linkedin.com/overlays/shared/broken.json" },
  });
  await expect.poll(() => actionError(page, "template-open-invalid-json")).toMatchObject({
    error: {
      code: "handler_failed",
      message: expect.stringContaining("not valid JSON"),
    },
  });

  await callRuntimeAction(page, "template-open-missing", "overlay.open", {
    template: { scope: "public", path: "sites/linkedin.com/overlays/missing/template.html" },
  });
  await expect.poll(() => actionError(page, "template-open-missing")).toMatchObject({
    error: {
      code: "handler_failed",
      message: expect.stringContaining("Overlay template asset not found"),
    },
  });

  await callRuntimeAction(page, "template-open-unknown-scope", "overlay.open", {
    template: { scope: "mystery", path: "sites/linkedin.com/overlays/shared/template.html" },
  });
  await expect.poll(() => actionError(page, "template-open-unknown-scope")).toMatchObject({
    error: {
      code: "handler_failed",
      message: expect.stringContaining("Unknown storage scope"),
    },
  });

  await callRuntimeAction(page, "template-open-unsafe", "overlay.open", {
    template: { scope: "public", path: "../template.html" },
  });
  await expect.poll(() => actionError(page, "template-open-unsafe")).toMatchObject({
    error: {
      code: "handler_failed",
      message: expect.stringContaining("Unsafe storage path"),
    },
  });
});

test("template-driven overlays download and upload standalone bundles into private scope", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonDownloads = [];
    window.__actionsJsonBlobUrls = new Map();
    URL.createObjectURL = (blob) => {
      const url = `blob:actions-json-template-test-${window.__actionsJsonBlobUrls.size + 1}`;
      window.__actionsJsonBlobUrls.set(url, blob);
      blob.text().then((text) => {
        window.__actionsJsonDownloads.push({ url, text });
      });
      return url;
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function click() {
      window.__actionsJsonLastDownload = {
        href: this.href,
        download: this.download,
      };
    };
  });

  await callRuntimeAction(page, "bundle-storage-import", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      entries: [
        {
          path: "scopes/public/sites/linkedin.com/overlays/outreach-radar/template.html",
          content_type: "text/html",
          content: `<!doctype html><html><body><h1 id="title"></h1><script>const data = JSON.parse(document.querySelector('[data-actions-json-overlay-data]').textContent); document.getElementById('title').textContent = data.title;</script></body></html>`,
        },
        {
          path: "scopes/private/sites/linkedin.com/overlays/outreach-radar/data.json",
          content_type: "application/json",
          content: JSON.stringify({ title: "Downloadable Private Data" }),
        },
      ],
    },
  });
  await expect.poll(() => actionOutput(page, "bundle-storage-import")).toMatchObject({ output: { ok: true } });

  await callRuntimeAction(page, "bundle-open", "overlay.open", {
    title: "LinkedIn Outreach Radar",
    template: { scope: "public", path: "sites/linkedin.com/overlays/outreach-radar/template.html" },
    data: { scope: "private", path: "sites/linkedin.com/overlays/outreach-radar/data.json" },
  });
  await expect(overlayReportFrame(page).locator("h1")).toHaveText("Downloadable Private Data");

  await page.locator("#__actions_json_overlay_runtime_host").locator("[data-download]").click();
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonLastDownload))
    .toMatchObject({ download: "linkedin-outreach-radar.html" });

  const downloaded = await expect
    .poll(() => page.evaluate(() => window.__actionsJsonDownloads[0]?.text || null))
    .toContain("actions.json.overlay.bundle");
  expect(downloaded).toBeUndefined();
  const bundleHtml = await page.evaluate(() => window.__actionsJsonDownloads[0].text);
  expect(bundleHtml).toContain("Downloadable Private Data");
  expect(bundleHtml).toContain('"scope":"public"');
  expect(bundleHtml).toContain('"scope":"private"');

  await callRuntimeAction(page, "bundle-storage-replace", "storage.import_bundle", {
    bundle: {
      protocol: "actions.json.storage.bundle",
      version: 1,
      entries: [],
    },
  });
  await expect.poll(() => actionOutput(page, "bundle-storage-replace")).toMatchObject({ output: { ok: true, entry_count: 0 } });

  const uploadPath = path.join(os.tmpdir(), `actions-json-template-bundle-${Date.now()}.html`);
  fs.writeFileSync(uploadPath, bundleHtml);
  try {
    await page.locator("#__actions_json_overlay_runtime_host [data-upload-input]").setInputFiles(uploadPath);
    await expect(overlayReportFrame(page).locator("h1")).toHaveText("Downloadable Private Data");

    await callRuntimeAction(page, "bundle-storage-list", "storage.list", {});
    await expect
      .poll(() => actionOutput(page, "bundle-storage-list"))
      .toMatchObject({
        output: {
          paths: [
            "scopes/private/sites/linkedin.com/overlays/outreach-radar/template.html",
            "scopes/private/sites/linkedin.com/overlays/outreach-radar/data.json",
          ],
        },
      });
  } finally {
    fs.rmSync(uploadPath, { force: true });
  }
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

test("runtime.agent.user_message proxies developer prompts through the bridge action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "runtime.agent.user_message", input_schema: { type: "object" } },
    ],
  });
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:agent-session-user-message") {
        return { ok: false, error: `Unexpected message ${message.type}` };
      }
      return {
        ok: true,
        result: {
          ok: true,
          request_id: "developer-text-test",
          response_mode: "text_only_transcript",
          text: message.text,
        },
      };
    };
  });
  await connectRuntime(page);

  await callRuntimeAction(page, "inject-agent-text", "runtime.agent.user_message", {
    text: "Check the Trello card candidates.",
  });

  await expect
    .poll(() => actionOutput(page, "inject-agent-text"))
    .toMatchObject({
      type: "action_call_output",
      call_id: "inject-agent-text",
      output: {
        ok: true,
        primitive: "runtime.agent.user_message",
        adapter: "extension",
        value: {
          ok: true,
          request_id: "developer-text-test",
          response_mode: "text_only_transcript",
          text: "Check the Trello card candidates.",
        },
      },
    });
  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "chrome_runtime_message" &&
          item.message?.type === "actions-json:agent-session-user-message"
      )?.message
    )
  ).resolves.toMatchObject({
    type: "actions-json:agent-session-user-message",
    text: "Check the Trello card candidates.",
    responseMode: "text_only_transcript",
  });
});

test("runtime.agent.start proxies a text-only hosted session start by default", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "runtime.agent.start", input_schema: { type: "object" } },
    ],
  });
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:agent-session-start") {
        return { ok: false, error: `Unexpected message ${message.type}` };
      }
      return {
        ok: true,
        state: {
          status: "connected",
          model: "gpt-realtime-2.1",
          error: null,
          inputMuted: false,
        },
      };
    };
  });
  await connectRuntime(page);

  await callRuntimeAction(page, "start-agent-text-only", "runtime.agent.start", {});

  await expect
    .poll(() => actionOutput(page, "start-agent-text-only"))
    .toMatchObject({
      type: "action_call_output",
      call_id: "start-agent-text-only",
      output: {
        ok: true,
        primitive: "runtime.agent.start",
        adapter: "extension",
        value: {
          ok: true,
          state: {
            status: "connected",
            model: "gpt-realtime-2.1",
          },
        },
      },
    });
  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "chrome_runtime_message" &&
          item.message?.type === "actions-json:agent-session-start"
      )?.message
    )
  ).resolves.toMatchObject({
    type: "actions-json:agent-session-start",
    textOnly: true,
  });
});

test("runtime.agent.start can explicitly request the microphone voice path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "runtime.agent.start", input_schema: { type: "object" } },
    ],
  });
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => ({
      ok: message.type === "actions-json:agent-session-start",
      state: {
        status: "connected",
        model: "gpt-realtime-2.1",
        error: null,
        inputMuted: false,
      },
    });
  });
  await connectRuntime(page);

  await callRuntimeAction(page, "start-agent-voice", "runtime.agent.start", {
    text_only: false,
  });

  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "chrome_runtime_message" &&
          item.message?.type === "actions-json:agent-session-start"
      )?.message
    )
  ).resolves.toMatchObject({
    type: "actions-json:agent-session-start",
    textOnly: false,
  });
});

test("runtime.agent.stop proxies hosted session stop through the bridge action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "runtime.agent.stop", input_schema: { type: "object" } },
    ],
  });
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:agent-session-stop") {
        return { ok: false, error: `Unexpected message ${message.type}` };
      }
      return {
        ok: true,
        state: {
          status: "stopped",
          model: "gpt-realtime-2.1",
          error: null,
          inputMuted: false,
        },
      };
    };
  });
  await connectRuntime(page);

  await callRuntimeAction(page, "stop-agent-session", "runtime.agent.stop", {});

  await expect
    .poll(() => actionOutput(page, "stop-agent-session"))
    .toMatchObject({
      type: "action_call_output",
      call_id: "stop-agent-session",
      output: {
        ok: true,
        primitive: "runtime.agent.stop",
        adapter: "extension",
        value: {
          ok: true,
          state: {
            status: "stopped",
            model: "gpt-realtime-2.1",
          },
        },
      },
    });
  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "chrome_runtime_message" &&
          item.message?.type === "actions-json:agent-session-stop"
      )?.message
    )
  ).resolves.toMatchObject({
    type: "actions-json:agent-session-stop",
  });
});

test("content runtime renders agent text responses as toast notifications", async ({ page }) => {
  await installRuntime(page);
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:agent-toast",
          text: "I found two candidate cards.",
          request_id: "developer-text-test",
        },
        {},
        resolve
      )
    );
  });

  await expect(page.locator("[data-actions-json-agent-toast]")).toContainText("I found two candidate cards.");
});

test("cost meter lives in the overlay panel and follows collapse", async ({ page }) => {
  await installRuntime(page);

  // Meter update BEFORE the menu exists: cached, applied when the menu opens.
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:cost-meter-update",
          meter: { sessionUsd: 0.42, lastUsd: 0.0031, dayUsd: 1.5, cacheState: "ok" },
        },
        {},
        resolve
      )
    );
  });
  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener({ type: "actions-json:open-menu-overlay" }, {}, resolve)
    );
  });

  const menu = page.locator("#__actions_json_menu_overlay_host");
  const meter = menu.locator("[data-cost-meter]");
  await expect(meter).toContainText("session $0.42");
  await expect(meter).toContainText("last $0.0031");
  await expect(meter).toContainText("today $1.50");
  await expect(meter).toHaveAttribute("data-cache-state", "ok");

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:cost-meter-update",
          meter: { sessionUsd: 0.62, lastUsd: 0.2, dayUsd: 1.7, cacheState: "drain" },
        },
        {},
        resolve
      )
    );
  });
  await expect(meter).toHaveAttribute("data-cache-state", "drain");
  await expect(meter).toContainText("session $0.62");

  // Collapse hides the meter with the body; expand restores it.
  await menu.locator("[data-minimize]").click();
  await expect(meter).toBeHidden();
  await menu.locator("[data-minimize]").click();
  await expect(meter).toBeVisible();
});

test("extension menu opens a single agent pane in the page overlay shell", async ({ page }) => {
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
  await expect(menu.locator("iframe")).toHaveCount(1);
  await expect(menu.locator("iframe").first()).toHaveAttribute(
    "src",
    "https://actions-json.test/sidepanel.html?surface=overlay&tab=agent"
  );
  await expect(menu.locator(".title")).toHaveText("actions.json agent");
  await expect(menu.locator("[data-tab]")).toHaveCount(0);
  await expect(menu.locator("[data-panel='agent']")).toHaveClass(/active/);
  await expect(menu.locator("[data-panel='config']")).toHaveCount(0);

  await menu.locator("[data-minimize]").click();
  await expect(menu.locator("[data-minimize]")).toBeVisible();
  await expect(menu.locator(".title")).toBeHidden();
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

test("HTTPS pages use the extension background bridge socket to avoid mixed content", async ({ page }) => {
  await page.route("https://secure-actions-json.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<main><h1>Secure surface</h1></main>",
    }),
  );
  await installRuntime(page, {
    tools: [
      { name: "page.info", input_schema: { type: "object" } },
    ],
  }, { pageUrl: "https://secure-actions-json.test/" });
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type === "actions-json:bridge-connect") {
        window.__actionsJsonBackgroundBridgeConnect = message;
        return { ok: true, transport_owner: "extension_background" };
      }
      if (message.type === "actions-json:bridge-protocol") {
        window.__actionsJsonBackgroundBridgeProtocol = window.__actionsJsonBackgroundBridgeProtocol || [];
        window.__actionsJsonBackgroundBridgeProtocol.push(message.item);
        return { ok: true, connected: true };
      }
      return { ok: true };
    };
  });

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:connect",
          bridgeUrl: "ws://100.99.150.49:17345/extension",
          runtimeKey: "secure-tab",
          authorizationId: "secure-auth",
          extensionVersion: "test",
        },
        {},
        resolve,
      ),
    );
  });

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonWebSockets?.length || 0))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBackgroundBridgeConnect?.bridgeUrl || null))
    .toBe("ws://100.99.150.49:17345/extension");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBackgroundBridgeConnect?.readyItem?.type || null))
    .toBe("runtime_ready");

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
    await new Promise((resolve) =>
      listener(
        {
          type: "actions-json:bridge-message",
          item: {
            type: "action_call",
            call_id: "secure-page-info",
            name: "page.info",
            arguments: {},
          },
        },
        {},
        resolve,
      ),
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonBackgroundBridgeProtocol?.find(
          (item) => item.type === "action_call_output" && item.call_id === "secure-page-info",
        )?.output?.primitive || null,
      ),
    )
    .toBe("page.info");
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
        ?.querySelector(".title")
        ?.textContent
    ))
    .toBe("actions.json agent");
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
        query(queryInfo, callback) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.query", queryInfo });
          callback([{ id: 123, windowId: 77 }]);
        },
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
    { method: "tabs.query", queryInfo: { active: true, windowId: 77 } },
    {
      method: "tabs.captureVisibleTab",
      windowId: 77,
      options: { format: "png", quality: undefined },
    },
  ]);
});

test("background transfer buffer handles write and read messages", async ({ page }) => {
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
          return { id, windowId: 77, url: "https://linear.app/acme/issue/ACT-1" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {},
        update(_tabId, _props, callback) {
          callback?.();
        },
      },
      windows: {
        update(_windowId, _props, callback) {
          callback?.();
        },
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Background transfer test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:transfer-buffer",
              primitive: "transfer.write",
              arguments: {
                label: "linear-import",
                format: "application/json",
                value: [{ title: "Prepare Trello cards" }],
              },
            },
            {
              tab: {
                id: 321,
                url: "https://linear.app/acme/issue/ACT-1",
              },
              frameId: 0,
            },
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      primitive: "transfer.write",
      adapter: "extension",
      value: {
        label: "linear-import",
        format: "application/json",
      },
    },
  });

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:transfer-buffer",
              primitive: "transfer.read",
              arguments: {
                label: "linear-import",
                include_value: false,
              },
            },
            {},
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      primitive: "transfer.read",
      adapter: "extension",
      value: {
        label: "linear-import",
      },
    },
  });
});

test("background storage.read_file handles read messages", async ({ page }) => {
  await page.addInitScript(() => {
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
          return { id, windowId: 77, url: "https://example.test/" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {},
        update(_tabId, _props, callback) {
          callback?.();
        },
      },
      windows: {
        update(_windowId, _props, callback) {
          callback?.();
        },
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Background storage file test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:storage-read-file",
              pageUrl: "https://example.test/",
              arguments: { id: "skill" },
            },
            {
              tab: {
                id: 1,
                url: "https://example.test/",
              },
            },
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      primitive: "storage.read_file",
      adapter: "extension",
      value: {
        id: "skill",
        path: "scopes/private/sites/example.test/SKILL.md",
        front_matter: { name: "Example Skill" },
      },
    },
  });
});

test("background lists and activates extension-claimed tabs", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundCalls = [];
    window.__actionsJsonStateProjectionCalls = 0;
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OVERLAY_SESSION_STATE: {
        sessions: {
          "actions-json-default": {
            chromeGroupId: 42,
            title: "actions.json",
            activeTabId: 101,
            tabs: {
              101: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-101",
                runtimeKey: "chrome-tab:101",
                url: "https://www.linkedin.com/messaging/",
              },
              202: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-202",
                runtimeKey: "chrome-tab:202",
                url: "https://www.amazon.com/gp/video/storefront/",
              },
            },
          },
        },
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
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
        },
      },
      scripting: {
        async executeScript(details) {
          window.__actionsJsonBackgroundCalls.push({ method: "scripting.executeScript", details });
        },
      },
      tabGroups: {
        async get(id) {
          return { id };
        },
        async update() {},
      },
      tabs: {
        async get(id) {
          if (id === 101) {
            return {
              id,
              windowId: 77,
              title: "LinkedIn Messaging",
              url: "https://www.linkedin.com/messaging/",
              active: false,
            };
          }
          if (id === 202) {
            return {
              id,
              windowId: 88,
              title: "Amazon Prime Video",
              url: "https://www.amazon.com/gp/video/storefront/",
              active: false,
            };
          }
          throw new Error(`missing tab ${id}`);
        },
        async group() {
          return 42;
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.sendMessage", tabId, message });
        },
        async update(tabId, props) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.update", tabId, props });
        },
      },
      windows: {
        async update(windowId, props) {
          window.__actionsJsonBackgroundCalls.push({ method: "windows.update", windowId, props });
        },
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Claimed tab background test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            { type: "actions-json:claimed-tabs-list" },
            {},
            resolve
          );
        })
    )
  ).resolves.toMatchObject({
    ok: true,
    active_tab_id: 101,
    count: 2,
    tabs: [
      expect.objectContaining({
        tab_id: 101,
        runtime_id: null,
        _runtime_key: "chrome-tab:101",
        title: "LinkedIn Messaging",
        url: "https://www.linkedin.com/messaging/",
      }),
      expect.objectContaining({
        tab_id: 202,
        runtime_id: null,
        _runtime_key: "chrome-tab:202",
        title: "Amazon Prime Video",
        url: "https://www.amazon.com/gp/video/storefront/",
      }),
    ],
  });

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:claimed-tabs-activate",
              tabId: 202,
              reconnectDelayMs: 1,
            },
            {},
            resolve
          );
        })
    )
  ).resolves.toMatchObject({
    ok: true,
    scheduled: true,
    reconnect_delay_ms: 1,
    tab: expect.objectContaining({
      tab_id: 202,
      runtime_id: null,
      _runtime_key: "chrome-tab:202",
      active: true,
    }),
  });

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBackgroundCalls))
    .toContainEqual({ method: "tabs.update", tabId: 202, props: { active: true } });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBackgroundCalls))
    .toContainEqual({ method: "windows.update", windowId: 88, props: { focused: true } });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBackgroundCalls))
    .toContainEqual({
      method: "scripting.executeScript",
      details: { target: { tabId: 202 }, files: ["src/content.js"] },
    });
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBackgroundCalls))
    .toContainEqual({
      method: "tabs.sendMessage",
      tabId: 202,
      message: expect.objectContaining({
        type: "actions-json:connect",
        runtimeKey: "chrome-tab:202",
        authorizationId: "auth-202",
      }),
    });
});

test("background hosted agent tools prefer the claimed active tab over the foreground HeyCode tab", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundCalls = [];
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OVERLAY_SESSION_STATE: {
        sessions: {
          "actions-json-default": {
            chromeGroupId: 42,
            title: "actions.json",
            activeTabId: 202,
            tabs: {
              202: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-202",
                runtimeKey: "chrome-tab:202",
                url: "https://trello.com/b/example/actions-json",
              },
            },
          },
        },
      },
      actionsJsonStorageBundle: {
        "scopes/private/sites/trello.com/board/actions.json": {
          tools: [],
        },
      },
    };
    window.listSiteActionsFromBundle = (_bundle, pageUrl, targetUrl) => [
      {
        name: "trello.find_card",
        page_url: pageUrl,
        target_url_contains: targetUrl,
      },
    ];
    window.listStateProjectionsFromBundle = () => [
      {
        name: "trello.board",
        description: "Logical Trello board state.",
        summaries: ["agent_context"],
      },
    ];
    window.listSiteStorageFilesFromBundle = () => ({ files: [], skills: [] });
    window.resolveSiteActionFromBundle = (_bundle, _pageUrl, request) => {
      if (request.action !== "trello.find_card.open") {
        return {
          ok: false,
          error: { code: "unknown_action", message: "Unknown test action." },
        };
      }
      return {
        ok: true,
        workflow: {
          action_name: "trello.find_card.open",
          definition: {
            version: 1,
            expression_language: "jsonata",
            steps: [
              { id: "find", primitive: "locator.element_info", args: {} },
              { id: "click", primitive: "pointer.click", args: {} },
            ],
          },
          input: request.arguments,
        },
      };
    };
    window.executeWorkflowAction = async (request) => {
      window.__actionsJsonBackgroundCalls.push({
        method: "executeWorkflowAction",
        actionName: request.actionName,
        input: request.input,
      });
      return {
        ok: true,
        output: {
          ok: true,
          primitive: "actions.workflow",
          action: request.actionName,
          value: { opened: request.input.title },
        },
        steps: [
          { id: "find", primitive: "locator.element_info", ok: true, duration_ms: 1 },
          { id: "click", primitive: "pointer.click", ok: true, duration_ms: 1 },
        ],
      };
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
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
        },
      },
      tabs: {
        async query(query) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.query", query });
          return [
            {
              id: 99,
              windowId: 9,
              title: "HeyCode",
              url: "https://example.com/app",
              active: true,
            },
          ];
        },
        async get(id) {
          if (id === 202) {
            return {
              id,
              windowId: 88,
              title: "Trello Board",
              url: "https://trello.com/b/example/actions-json",
              active: false,
            };
          }
          throw new Error(`missing tab ${id}`);
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.sendMessage", tabId, message });
          if (message.type === "actions-json:execute-state-projection") {
            window.__actionsJsonStateProjectionCalls = (window.__actionsJsonStateProjectionCalls || 0) + 1;
            const cards = window.__actionsJsonStateProjectionCalls > 1
              ? [{ title: "Demo card" }, { title: "New follow-up card" }]
              : [{ title: "Demo card" }];
            return {
              ok: true,
              output: {
                ok: true,
                projection: message.projection_name,
                state_hash: `test-hash-${window.__actionsJsonStateProjectionCalls}`,
                observed_at: "2026-06-10T00:00:00.000Z",
                state: {
                  board: {
                    lists: [
                      {
                        name: "In Progress",
                        cards,
                      },
                    ],
                  },
                },
              },
              error: null,
            };
          }
          return { ok: true };
        },
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Hosted routing test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              target: "background",
              type: "actions-json:agent-tool-execute",
              call: {
                name: "actions.site",
                call_id: "call-actions-site",
                arguments: { mode: "list" },
              },
            },
            {},
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      call_id: "call-actions-site",
      output: {
        ok: true,
        target_url_contains: "https://trello.com/b/example/actions-json",
        actions: [
          expect.objectContaining({
            name: "trello.find_card",
            page_url: "https://trello.com/b/example/actions-json",
          }),
        ],
        state_projections: [
          {
            name: "trello.board",
            description: "Logical Trello board state.",
            summaries: ["agent_context"],
          },
        ],
      },
    },
  });

  await expect(page.evaluate(() => window.__actionsJsonBackgroundCalls)).resolves.not.toContainEqual({
    method: "tabs.query",
    query: { active: true, currentWindow: true },
  });

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              target: "background",
              type: "actions-json:agent-tool-execute",
              call: {
                name: "actions.site",
                call_id: "call-workflow",
                arguments: {
                  mode: "call",
                  action: "trello.find_card.open",
                  arguments: { title: "Demo card" },
                },
              },
            },
            {},
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      call_id: "call-workflow",
      output: {
        ok: true,
        primitive: "actions.workflow",
        action: "trello.find_card.open",
        value: { opened: "Demo card" },
      },
    },
  });
  await expect(page.evaluate(() => window.__actionsJsonBackgroundCalls)).resolves.toContainEqual({
    method: "executeWorkflowAction",
    actionName: "trello.find_card.open",
    input: { title: "Demo card" },
  });

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              target: "background",
              type: "actions-json:agent-tool-execute",
              call: {
                name: "actions.site",
                call_id: "call-state",
                arguments: {
                  mode: "state_read",
                  projection_name: "trello.board",
                },
              },
            },
            {},
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      call_id: "call-state",
      output: {
        ok: true,
        projection: "trello.board",
        state: {
          board: {
            lists: [
              {
                name: "In Progress",
                cards: [{ title: "Demo card" }],
              },
            ],
          },
        },
      },
    },
  });
  await expect(page.evaluate(() => window.__actionsJsonBackgroundCalls)).resolves.toContainEqual({
    method: "tabs.sendMessage",
    tabId: 202,
    message: expect.objectContaining({
      type: "actions-json:execute-state-projection",
      projection_name: "trello.board",
    }),
  });

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              target: "background",
              type: "actions-json:agent-tool-execute",
              call: {
                name: "actions.site",
                call_id: "call-state-diff",
                arguments: {
                  mode: "state_diff",
                  projection_name: "trello.board",
                },
              },
            },
            {},
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      call_id: "call-state-diff",
      output: {
        ok: true,
        projection: "trello.board",
        baseline: "previous_snapshot",
        patch_format: "json_patch",
        patches: [
          {
            op: "add",
            path: "/board/lists/0/cards/1",
            value: { title: "New follow-up card" },
          },
        ],
        previous_state_hash: "test-hash-1",
        state_hash: "test-hash-2",
      },
    },
  });
});

test("background hosted claimed-tab tools execute against the registry without a page target", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundCalls = [];
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OVERLAY_SESSION_STATE: {
        sessions: {
          "actions-json-default": {
            chromeGroupId: 42,
            title: "actions.json",
            activeTabId: 202,
            tabs: {
              202: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-202",
                runtimeKey: "chrome-tab:202",
                url: "https://trello.com/b/example/actions-json",
              },
            },
          },
        },
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
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
        },
      },
      tabs: {
        async query(query) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.query", query });
          return [
            {
              id: 99,
              windowId: 9,
              title: "HeyCode",
              url: "https://example.com/app",
              active: true,
            },
          ];
        },
        async get(id) {
          if (id === 202) {
            return {
              id,
              windowId: 88,
              title: "Trello Board",
              url: "https://trello.com/b/example/actions-json",
              active: false,
            };
          }
          throw new Error(`missing tab ${id}`);
        },
      },
    };
  });

  await page.goto("data:text/html,<main><h1>Hosted claimed tools test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              target: "background",
              type: "actions-json:agent-tool-execute",
              call: {
                name: "browser.claimed_tabs.list",
                call_id: "call-claimed-tabs",
                arguments: {},
              },
            },
            {},
            resolve,
          );
        }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    result: {
      ok: true,
      call_id: "call-claimed-tabs",
      output: {
        ok: true,
        active_tab_id: 202,
        count: 1,
        tabs: [
          expect.objectContaining({
            tab_id: 202,
            url: "https://trello.com/b/example/actions-json",
          }),
        ],
      },
    },
  });

  await expect(page.evaluate(() => window.__actionsJsonBackgroundCalls)).resolves.not.toContainEqual({
    method: "tabs.query",
    query: { active: true, currentWindow: true },
  });
});

test("background bridge reconnect replays every already-claimed tab", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundCalls = [];
    window.__actionsJsonBridgeSends = [];
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OVERLAY_SESSION_STATE: {
        sessions: {
          "actions-json-default": {
            chromeGroupId: 42,
            title: "actions.json",
            activeTabId: 101,
            tabs: {
              101: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-101",
                runtimeKey: "chrome-tab:101",
                url: "https://www.linkedin.com/messaging/",
              },
              202: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-202",
                runtimeKey: "chrome-tab:202",
                url: "https://trello.com/b/example/actions-json",
              },
            },
          },
        },
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
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
        },
      },
      scripting: {
        async executeScript(details) {
          window.__actionsJsonBackgroundCalls.push({ method: "scripting.executeScript", details });
        },
      },
      tabGroups: {
        async get(id) {
          return { id };
        },
        async update() {},
      },
      tabs: {
        async get(id) {
          if (id === 101) {
            return {
              id,
              windowId: 77,
              title: "LinkedIn Messaging",
              url: "https://www.linkedin.com/messaging/",
              active: true,
            };
          }
          if (id === 202) {
            return {
              id,
              windowId: 88,
              title: "Trello Board",
              url: "https://trello.com/b/example/actions-json",
              active: false,
            };
          }
          throw new Error(`missing tab ${id}`);
        },
        async group() {
          return 42;
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.sendMessage", tabId, message });
          if (message.type === "actions-json:runtime-ready") {
            return {
              ok: true,
              readyItem: {
                type: "runtime_ready",
                runtime_id: `runtime-${tabId}`,
                runtime_key: message.runtimeKey,
                authorization_id: message.authorizationId,
                extension_version: message.extensionVersion,
                url: tabId === 101
                  ? "https://www.linkedin.com/messaging/"
                  : "https://trello.com/b/example/actions-json",
                manifest: { tools: [{ name: "page.info" }] },
              },
            };
          }
          return { ok: true };
        },
      },
      windows: {
        async update() {},
      },
    };
    window.WebSocket = class OpenWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = OpenWebSocket.OPEN;
        window.__actionsJsonBridgeSockets = window.__actionsJsonBridgeSockets || [];
        window.__actionsJsonBridgeSockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }

      send(raw) {
        window.__actionsJsonBridgeSends.push(JSON.parse(raw));
      }

      close() {
        this.readyState = OpenWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    };
  });

  await page.goto("data:text/html,<main><h1>Bridge replay test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:bridge-connect",
              bridgeUrl: "ws://127.0.0.1:17345/extension",
              readyItem: {
                type: "runtime_ready",
                runtime_id: "runtime-101",
                runtime_key: "chrome-tab:101",
                authorization_id: "auth-101",
                extension_version: "test-version",
                url: "https://www.linkedin.com/messaging/",
                manifest: { tools: [{ name: "page.info" }] },
              },
            },
            { tab: { id: 101 } },
            resolve,
          );
        }),
    )
  ).resolves.toMatchObject({ ok: true, transport_owner: "extension_background" });

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBridgeSends.filter((item) => item.type === "runtime_ready")))
    .toEqual([
      expect.objectContaining({
        runtime_id: "runtime-101",
        runtime_key: "chrome-tab:101",
        authorization_id: "auth-101",
        tab: expect.objectContaining({ tab_id: 101, active: true }),
      }),
      expect.objectContaining({
        runtime_id: "runtime-202",
        runtime_key: "chrome-tab:202",
        authorization_id: "auth-202",
        tab: expect.objectContaining({ tab_id: 202, active: false }),
      }),
    ]);
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBridgeSends.find((item) => item.type === "bridge_runtime_replay_summary") || null))
    .toMatchObject({
      claimed_count: 2,
      registered_count: 2,
      removed_count: 0,
      failed_count: 0,
    });
});

test("background bridge reconnect keeps retrying after a failed reconnect attempt", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundCalls = [];
    window.__actionsJsonBridgeSends = [];
    window.__actionsJsonBridgeSockets = [];
    window.__actionsJsonSocketMode = "open";
    window.__actionsJsonStorage = {
      ACTIONS_JSON_OVERLAY_SESSION_STATE: {
        sessions: {
          "actions-json-default": {
            activeTabId: 101,
            tabs: {
              101: {
                bridgeUrl: "ws://127.0.0.1:17345/extension",
                authorizationId: "auth-101",
                runtimeKey: "chrome-tab:101",
                url: "https://trello.com/b/example/actions-json",
              },
            },
          },
        },
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
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
          },
          async set(values) {
            Object.assign(window.__actionsJsonStorage, values);
          },
        },
      },
      scripting: {
        async executeScript(details) {
          window.__actionsJsonBackgroundCalls.push({ method: "scripting.executeScript", details });
        },
      },
      tabGroups: {
        async get(id) {
          return { id };
        },
        async update() {},
      },
      tabs: {
        async get(id) {
          if (id !== 101) throw new Error(`missing tab ${id}`);
          return {
            id,
            windowId: 77,
            title: "Trello Board",
            url: "https://trello.com/b/example/actions-json",
            active: true,
          };
        },
        async group() {
          return 42;
        },
        async sendMessage(tabId, message) {
          window.__actionsJsonBackgroundCalls.push({ method: "tabs.sendMessage", tabId, message });
          if (message.type === "actions-json:runtime-ready") {
            return {
              ok: true,
              readyItem: {
                type: "runtime_ready",
                runtime_id: `runtime-${tabId}`,
                runtime_key: message.runtimeKey,
                authorization_id: message.authorizationId,
                extension_version: message.extensionVersion,
                url: "https://trello.com/b/example/actions-json",
                manifest: { tools: [{ name: "page.info" }] },
              },
            };
          }
          return { ok: true };
        },
      },
      windows: {
        async update() {},
      },
    };
    window.WebSocket = class ControlledWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = ControlledWebSocket.CONNECTING;
        window.__actionsJsonBridgeSockets.push(this);
        setTimeout(() => {
          if (window.__actionsJsonSocketMode === "fail") {
            this.dispatchEvent(new Event("error"));
            this.readyState = ControlledWebSocket.CLOSED;
            this.dispatchEvent(new Event("close"));
            return;
          }
          this.readyState = ControlledWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(raw) {
        window.__actionsJsonBridgeSends.push(JSON.parse(raw));
      }

      close() {
        if (this.readyState === ControlledWebSocket.CLOSED) return;
        this.readyState = ControlledWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    };
  });

  await page.goto("data:text/html,<main><h1>Bridge retry test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:bridge-connect",
              bridgeUrl: "ws://127.0.0.1:17345/extension",
              readyItem: {
                type: "runtime_ready",
                runtime_id: "runtime-101",
                runtime_key: "chrome-tab:101",
                authorization_id: "auth-101",
                extension_version: "test-version",
                url: "https://trello.com/b/example/actions-json",
                manifest: { tools: [{ name: "page.info" }] },
              },
            },
            { tab: { id: 101 } },
            resolve,
          );
        }),
    )
  ).resolves.toMatchObject({ ok: true, transport_owner: "extension_background" });

  await expect.poll(() => page.evaluate(() => window.__actionsJsonBridgeSockets.length)).toBe(1);
  await page.evaluate(() => {
    window.__actionsJsonSocketMode = "fail";
    window.__actionsJsonBridgeSockets[0].close();
  });
  await expect.poll(() => page.evaluate(() => window.__actionsJsonBridgeSockets.length)).toBe(2);
  await page.evaluate(() => {
    window.__actionsJsonSocketMode = "open";
  });

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBridgeSockets.length), { timeout: 7000 })
    .toBeGreaterThanOrEqual(3);
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBridgeSends.filter((item) => item.type === "runtime_ready").length))
    .toBeGreaterThanOrEqual(2);
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
          return { id, windowId: 77, url: "https://acme.example/start" };
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

test("browser.run_javascript delegates through the CSP-safe debugger evaluator", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "browser.run_javascript", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <meta http-equiv="Content-Security-Policy" content="script-src 'self'">
    <main>
      <h2>Outstanding dramas</h2>
      <div class="strip" style="display:flex; gap:12px; width:320px; overflow-x:auto;">
        <a href="/gp/video/detail/ONE" style="display:block; min-width:220px;">One</a>
        <a href="/gp/video/detail/TWO" style="display:block; min-width:220px;">Two</a>
        <a href="/gp/video/detail/THREE" style="display:block; min-width:220px;">Three</a>
      </div>
    </main>
  `);

  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) =>
      nativeSetTimeout(callback, delay === 10_000 ? 10 : delay, ...args);
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:debug-evaluate") {
        return { ok: false, error: `unexpected message ${message.type}` };
      }
      // A response that arrives after the old 10-second content-message budget
      // (scaled to 10ms above) must still succeed.
      await new Promise((resolve) => nativeSetTimeout(resolve, 30));
      const target = document.querySelector(message.args.selector);
      const before = { left: target.scrollLeft, top: target.scrollTop };
      target.scrollBy({ left: message.args.left, top: 0, behavior: "instant" });
      const after = { left: target.scrollLeft, top: target.scrollTop };
      return {
        ok: true,
        result: { before, after, moved: after.left !== before.left },
        url: location.href,
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
        execution: {
          adapter: "extension",
          capability_class: "debug",
          transport: "chrome.debugger",
        },
      },
    });

  await expect(
    page.evaluate(() => document.querySelector(".strip").scrollLeft)
  ).resolves.toBeGreaterThan(0);

  await expect(
    page.evaluate(() =>
      window.__actionsJsonMessages.find(
        (item) => item.type === "chrome_runtime_message"
          && item.message?.type === "actions-json:debug-evaluate"
      )?.message
    )
  ).resolves.toMatchObject({
    type: "actions-json:debug-evaluate",
    primitive: "browser.run_javascript",
    args: { selector: ".strip", left: 260 },
  });

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
    <input
      data-testid="controlled-text-target"
      value="old controlled value"
      style="position:absolute;left:320px;top:260px;width:180px;height:36px"
    />
    <div
      data-testid="contenteditable-target"
      contenteditable="true"
      style="position:absolute;left:120px;top:320px;width:220px;min-height:40px;border:1px solid #999"
      oninput="document.body.dataset.editableText = this.textContent"
    >old editable text</div>
    <div
      data-testid="model-backed-editor"
      contenteditable="true"
      style="position:absolute;left:120px;top:380px;width:220px;min-height:40px;border:1px solid #999"
    >old model text</div>
  `);
  await page.evaluate(() => {
    const editor = document.querySelector("[data-testid='model-backed-editor']");
    window.__modelBackedEditorValue = editor.textContent;
    editor.addEventListener("paste", (event) => {
      const pasted = event.clipboardData?.getData("text/plain") || "";
      event.preventDefault();
      window.__modelBackedEditorValue = pasted;
      editor.textContent = pasted;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertFromPaste",
        data: pasted,
      }));
    });
    editor.addEventListener("input", () => {
      document.body.dataset.modelBackedEditorDomText = editor.textContent;
    });
    const controlled = document.querySelector("[data-testid='controlled-text-target']");
    window.__controlledInputBeforeInput = null;
    window.__controlledInputValue = controlled.value;
    controlled.addEventListener("beforeinput", (event) => {
      window.__controlledInputBeforeInput = {
        data: event.data,
        inputType: event.inputType,
      };
    });
    controlled.addEventListener("input", () => {
      window.__controlledInputValue = controlled.value;
    });
  });

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

  await callRuntimeAction(page, "extension-text-insert-controlled-input", "text.insert", {
    text: "9:00 AM",
    target: { selector: "[data-testid='controlled-text-target']" },
    mode: "replace",
  });
  await expect.poll(() => actionOutput(page, "extension-text-insert-controlled-input")).toMatchObject({
    output: {
      ok: true,
      primitive: "text.insert",
      adapter: "extension",
      value: {
        inserted: true,
        inserted_length: 7,
        input_method: "native-value-setter+input",
      },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='controlled-text-target']").value)).resolves.toBe("9:00 AM");
  await expect(page.evaluate(() => window.__controlledInputValue)).resolves.toBe("9:00 AM");
  await expect(page.evaluate(() => window.__controlledInputBeforeInput)).resolves.toMatchObject({
    data: "9:00 AM",
    inputType: "insertReplacementText",
  });

  await callRuntimeAction(page, "extension-text-insert-contenteditable", "text.insert", {
    text: "editable note",
    target: { selector: "[data-testid='contenteditable-target']" },
    mode: "replace",
  });
  await expect.poll(() => actionOutput(page, "extension-text-insert-contenteditable")).toMatchObject({
    output: {
      ok: true,
      primitive: "text.insert",
      adapter: "extension",
      value: { inserted: true, inserted_length: 13 },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='contenteditable-target']").textContent)).resolves.toBe("editable note");
  await expect(page.evaluate(() => document.body.dataset.editableText)).resolves.toBe("editable note");

  await callRuntimeAction(page, "extension-text-insert-model-backed-editor", "text.insert", {
    text: "model value",
    target: { selector: "[data-testid='model-backed-editor']" },
    mode: "replace",
  });
  await expect.poll(() => actionOutput(page, "extension-text-insert-model-backed-editor")).toMatchObject({
    output: {
      ok: true,
      primitive: "text.insert",
      adapter: "extension",
      value: {
        inserted: true,
        inserted_length: 11,
        input_method: "synthetic-paste",
      },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='model-backed-editor']").textContent)).resolves.toBe("model value");
  await expect(page.evaluate(() => window.__modelBackedEditorValue)).resolves.toBe("model value");
  await expect(page.evaluate(() => document.body.dataset.modelBackedEditorDomText)).resolves.toBe("model value");
});

test("extension executes supported primitives declared only in primitive dictionary", async ({ page }) => {
  await installRuntime(page, {
    tools: [],
    primitive_dictionary: {
      primitives: [
        {
          name: "text.insert",
          support: "supported",
          input_schema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
          },
        },
      ],
    },
  });

  await page.setContent(`<input data-testid="text-target" />`);
  await connectRuntime(page);
  await page.locator("[data-testid='text-target']").focus();

  await callRuntimeAction(page, "dictionary-text-insert", "text.insert", { text: "dictionary primitive" });

  await expect.poll(() => actionOutput(page, "dictionary-text-insert")).toMatchObject({
    output: {
      ok: true,
      primitive: "text.insert",
      adapter: "extension",
      value: { inserted: true, inserted_length: 20 },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='text-target']").value)).resolves.toBe(
    "dictionary primitive",
  );
});

test("extension pointer.drag resolves source and destination locators", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "pointer.drag", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <div
      data-testid="source-card"
      style="position:absolute;left:120px;top:140px;width:160px;height:56px;background:#dbeafe"
      onpointerdown="document.body.dataset.dragLocatorStarted = 'yes'"
    >Move me</div>
    <div
      data-testid="target-list"
      style="position:absolute;left:420px;top:220px;width:180px;height:96px;background:#dcfce7"
      onpointerup="document.body.dataset.dragLocatorEnded = 'yes'"
    >Done</div>
  `);
  await connectRuntime(page);

  await callRuntimeAction(page, "extension-pointer-drag-locator", "pointer.drag", {
    from: { selector: "[data-testid='source-card']" },
    to: { selector: "[data-testid='target-list']" },
    duration_ms: 0,
    steps: 4,
  });

  await expect.poll(() => actionOutput(page, "extension-pointer-drag-locator")).toMatchObject({
    output: {
      ok: true,
      primitive: "pointer.drag",
      adapter: "extension",
      value: {
        dragged: true,
        steps: 4,
        diagnostics: {
          from: { source: "locator", tag_name: "div", text: "Move me" },
          to: { source: "locator", tag_name: "div", text: "Done" },
        },
      },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.dragLocatorStarted)).resolves.toBe("yes");
  await expect(page.evaluate(() => document.body.dataset.dragLocatorEnded)).resolves.toBe("yes");
});

test("extension pointer.drag rejects an occluded locator instead of dispatching a blind drag", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "pointer.drag", input_schema: { type: "object" } },
    ],
  });

  await page.setContent(`
    <div data-testid="source-card"
      style="position:absolute;left:120px;top:140px;width:160px;height:56px;background:#dbeafe"
      onpointerdown="document.body.dataset.dragOcclusionStarted = 'yes'">Move me</div>
    <div data-testid="target-list"
      style="position:absolute;left:420px;top:220px;width:180px;height:96px;background:#dcfce7">Done</div>
    <div data-testid="occluder"
      style="position:absolute;left:120px;top:140px;width:160px;height:56px;background:#111827;z-index:10">Overlay</div>
  `);
  await connectRuntime(page);

  await callRuntimeAction(page, "extension-pointer-drag-occluded", "pointer.drag", {
    from: { selector: "[data-testid='source-card']" },
    to: { selector: "[data-testid='target-list']" },
    duration_ms: 0,
  });

  await expect.poll(() => actionOutput(page, "extension-pointer-drag-occluded")).toMatchObject({
    output: {
      ok: false,
      primitive: "pointer.drag",
      adapter: "extension",
      error: {
        code: "target_not_actionable",
        evidence: {
          actionability: {
            receives_events: false,
            clickable: false,
          },
        },
      },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.dragOcclusionStarted || "")).resolves.toBe("");
});

test("extension transfer buffer writes, reads, and inserts rendered data through the action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "transfer.write", input_schema: { type: "object" } },
      { name: "transfer.read", input_schema: { type: "object" } },
      { name: "transfer.clear", input_schema: { type: "object" } },
      { name: "transfer.insert", input_schema: { type: "object" } },
    ],
  });
  await page.setContent(`
    <main>
      <textarea
        data-testid="trello-card"
        style="position:absolute;left:120px;top:180px;width:320px;height:120px"
        oninput="document.body.dataset.cardText = this.value"
      ></textarea>
      <div
        data-testid="trello-description"
        contenteditable="true"
        style="position:absolute;left:120px;top:340px;width:320px;min-height:80px;border:1px solid #999"
        oninput="document.body.dataset.descriptionText = this.textContent"
      ></div>
    </main>
  `);
  await page.evaluate(() => {
    const items = new Map();
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:transfer-buffer") return { ok: true };
      const args = message.arguments || {};
      if (message.primitive === "transfer.write") {
        const item = {
          id: `transfer-${items.size + 1}`,
          label: args.label,
          format: args.format,
          value: args.value,
          metadata: args.metadata || {},
          size_bytes: JSON.stringify(args.value).length,
        };
        items.set(args.label, item);
        return { ok: true, result: { ok: true, primitive: message.primitive, adapter: "extension", value: item } };
      }
      if (message.primitive === "transfer.read") {
        const item = items.get(args.label);
        return {
          ok: true,
          result: {
            ok: true,
            primitive: message.primitive,
            adapter: "extension",
            value: args.include_value ? item : { ...item, value: undefined },
          },
        };
      }
      if (message.primitive === "transfer.insert") {
        const item = items.get(args.label);
        const first = item.value[0];
        return {
          ok: true,
          result: {
            ok: true,
            primitive: message.primitive,
            adapter: "extension",
            value: {
              id: item.id,
              label: item.label,
              text: `${first.title} - ${first.owner}`,
            },
          },
        };
      }
      if (message.primitive === "transfer.clear") {
        items.delete(args.label);
        return { ok: true, result: { ok: true, primitive: message.primitive, adapter: "extension", value: { cleared: 1 } } };
      }
      return { ok: false, error: "unexpected transfer primitive" };
    };
  });

  await connectRuntime(page);

  await callRuntimeAction(page, "transfer-write", "transfer.write", {
    label: "linear-import",
    format: "application/json",
    value: [{ title: "Fix Trello drag primitive", owner: "Alex" }],
  });
  await expect.poll(() => actionOutput(page, "transfer-write")).toMatchObject({
    output: {
      ok: true,
      primitive: "transfer.write",
      adapter: "extension",
      value: { label: "linear-import", format: "application/json" },
    },
  });

  await callRuntimeAction(page, "transfer-read", "transfer.read", {
    label: "linear-import",
    include_value: false,
  });
  await expect.poll(() => actionOutput(page, "transfer-read")).toMatchObject({
    output: {
      ok: true,
      primitive: "transfer.read",
      adapter: "extension",
      value: { label: "linear-import" },
    },
  });

  await callRuntimeAction(page, "transfer-insert", "transfer.insert", {
    label: "linear-import",
    target: { selector: "[data-testid='trello-card']" },
    item_selector: { index: 0 },
    render: { template: "{{title}} - {{owner}}" },
  });
  await expect.poll(() => actionOutput(page, "transfer-insert")).toMatchObject({
    output: {
      ok: true,
      primitive: "transfer.insert",
      adapter: "extension",
      value: { inserted: true },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='trello-card']").value)).resolves.toBe(
    "Fix Trello drag primitive - Alex",
  );

  await callRuntimeAction(page, "transfer-insert-contenteditable", "transfer.insert", {
    label: "linear-import",
    target: { selector: "[data-testid='trello-description']" },
    item_selector: { index: 0 },
    render: { template: "{{title}}" },
    mode: "replace",
  });
  await expect.poll(() => actionOutput(page, "transfer-insert-contenteditable")).toMatchObject({
    output: {
      ok: true,
      primitive: "transfer.insert",
      adapter: "extension",
      value: { inserted: true },
    },
  });
  await expect(page.evaluate(() => document.querySelector("[data-testid='trello-description']").textContent)).resolves.toBe(
    "Fix Trello drag primitive - Alex",
  );
});

test("extension storage.read_file reads declared files through the action path", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "storage.read_file", input_schema: { type: "object" } },
    ],
  });
  await page.setContent("<main><h1>Storage file action path</h1></main>");
  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = async (message) => {
      if (message.type !== "actions-json:storage-read-file") return { ok: true };
      return {
        ok: true,
        result: {
          ok: true,
          primitive: "storage.read_file",
          adapter: "extension",
          value: {
            id: message.arguments.id || null,
            path: message.arguments.path || "scopes/shared/youtube/sites/youtube.com/watch/SKILL.md",
            kind: "skill",
            mime_type: "text/markdown",
            bytes: 96,
            truncated: false,
            front_matter: {
              name: "YouTube Tutorial Extraction",
              description: "Operate YouTube videos with ad-aware screenshot capture.",
            },
            text: "---\nname: YouTube Tutorial Extraction\n---\n# YouTube Skill",
          },
        },
      };
    };
  });

  await connectRuntime(page);

  await callRuntimeAction(page, "read-youtube-skill", "storage.read_file", {
    id: "youtube-tutorial-skill",
  });
  await expect.poll(() => actionOutput(page, "read-youtube-skill")).toMatchObject({
    output: {
      ok: true,
      primitive: "storage.read_file",
      adapter: "extension",
      value: {
        id: "youtube-tutorial-skill",
        kind: "skill",
        front_matter: {
          name: "YouTube Tutorial Extraction",
        },
      },
    },
  });
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
      <button data-testid="visible-action" onkeydown="document.body.dataset.key = event.key; document.body.dataset.modifierChord = event.metaKey && event.key === 'a' ? 'yes' : document.body.dataset.modifierChord">Observe Me</button>
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
  // Matches must carry a ready-to-click point: hosted agents were clicking the
  // bounding_box top-left corner (a miss) because no center was provided.
  const observeMatch = (await actionOutput(page, "extension-dom-observe")).output.value.matches[0];
  expect(observeMatch.clickable).toBe(true);
  expect(observeMatch.clickable_center.x).toBeGreaterThan(observeMatch.bounding_box.left);
  expect(observeMatch.clickable_center.x).toBeLessThan(observeMatch.bounding_box.right);
  expect(observeMatch.clickable_center.y).toBeGreaterThan(observeMatch.bounding_box.top);
  expect(observeMatch.clickable_center.y).toBeLessThan(observeMatch.bounding_box.bottom);

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
      value: { pressed: true, key: "Enter", fidelity: "synthetic" },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.key)).resolves.toBe("Enter");

  await callRuntimeAction(page, "extension-keyboard-modifier", "keyboard.press", { key: "Meta+a" });
  await expect.poll(() => actionOutput(page, "extension-keyboard-modifier")).toMatchObject({
    output: {
      ok: true,
      primitive: "keyboard.press",
      adapter: "extension",
      value: { pressed: true, key: "a", modifiers: ["meta"], fidelity: "synthetic" },
    },
  });
  await expect(page.evaluate(() => document.body.dataset.modifierChord)).resolves.toBe("yes");
});

test("dom.observe.visible omits clickable_center for an occluded match", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "dom.observe.visible", input_schema: { type: "object" } }],
  });
  await page.setContent(`
    <button id="covered" style="position:absolute;left:20px;top:20px;width:220px;height:48px">Covered action</button>
    <div id="sticky-cover" style="position:fixed;left:0;top:0;width:320px;height:120px;background:#fff;z-index:10000">Sticky cover</div>
  `);
  await connectRuntime(page);
  await callRuntimeAction(page, "occluded-dom-observe", "dom.observe.visible", { selector: "#covered" });
  const output = (await actionOutput(page, "occluded-dom-observe")).output.value;
  expect(output.match_count).toBe(1);
  const match = output.matches[0];
  expect(match.clickable).toBe(false);
  expect(match.receives_events).toBe(false);
  expect(match.clickable_center).toBeUndefined();
  expect(match.visible_center).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  expect(match.occluded_by).toEqual(expect.objectContaining({ tag_name: "div" }));
});

test("dom.observe.visible refuses oversized broad payloads with narrowing hints", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "dom.observe.visible", input_schema: { type: "object" } },
    ],
  });

  const repeated = Array.from({ length: 80 }, (_, index) =>
    `<section><h2>Card section ${index}</h2><p>${"Card payload text ".repeat(200)}</p></section>`
  ).join("");
  await page.setContent(`
    <title>Large Observation Fixture</title>
    <main>${repeated}</main>
  `);

  await connectRuntime(page);

  await callRuntimeAction(page, "large-dom-observe", "dom.observe.visible", {
    text_contains: "Card",
  });

  await expect.poll(() => actionOutput(page, "large-dom-observe")).toMatchObject({
    output: {
      ok: true,
      primitive: "dom.observe.visible",
      adapter: "extension",
      value: {
        ok: false,
        error: {
          code: "payload_too_large",
        },
      },
    },
  });
  const output = await actionOutput(page, "large-dom-observe");
  expect(JSON.stringify(output.output.value).length).toBeLessThan(2000);
  expect(output.output.value.error.evidence.match_count).toBeGreaterThan(0);
  expect(output.output.value.error.evidence.narrowing_hints).toContain("Use a narrower selector.");
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

test("background bridge connect reports failure when WebSocket never opens", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonBackgroundDiagnostics = [];
    window.__actionsJsonStorage = {};
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
            if (typeof key === "string") {
              return { [key]: window.__actionsJsonStorage[key] };
            }
            return { ...window.__actionsJsonStorage };
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
          return { id, windowId: 77, url: "https://secure-actions-json.test/" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {},
      },
    };
    window.WebSocket = class FailingWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = FailingWebSocket.CONNECTING;
        window.__actionsJsonBackgroundWebSocket = this;
        setTimeout(() => {
          this.dispatchEvent(new Event("error"));
          this.readyState = FailingWebSocket.CLOSED;
          this.dispatchEvent(new CloseEvent("close"));
        }, 0);
      }

      send() {}

      close() {
        this.readyState = FailingWebSocket.CLOSED;
      }
    };
  });

  await page.goto("data:text/html,<main><h1>Background bridge test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:bridge-connect",
              bridgeUrl: "ws://100.99.150.49:17345/extension",
              readyItem: {
                type: "runtime_ready",
                runtime_id: "secure-runtime",
                manifest: { tools: [] },
              },
            },
            { tab: { id: 123, windowId: 77, url: "https://secure-actions-json.test/" } },
            resolve,
          );
        }),
    )
  ).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("WebSocket"),
  });
});

test("background bridge credential hydration stores OpenAI key without logging the raw key", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.__actionsJsonBridgeSends = [];
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
          return { id, windowId: 77, url: "https://trello.com/b/example/actions-json" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
    window.WebSocket = class OpenWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = OpenWebSocket.CONNECTING;
        window.__actionsJsonBackgroundWebSocket = this;
        setTimeout(() => {
          this.readyState = OpenWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(value) {
        window.__actionsJsonBridgeSends.push(JSON.parse(value));
      }

      close() {
        this.readyState = OpenWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    };
  });

  await page.goto("data:text/html,<main><h1>Credential hydration test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:bridge-connect",
              bridgeUrl: "ws://100.99.150.49:17345/extension",
              readyItem: {
                type: "runtime_ready",
                runtime_id: "trello-runtime",
                manifest: { tools: [] },
              },
            },
            { tab: { id: 202, windowId: 77, url: "https://trello.com/b/example/actions-json" } },
            resolve,
          );
        }),
    )
  ).resolves.toMatchObject({ ok: true });

  await page.evaluate(() => {
    window.__actionsJsonBackgroundWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "credential_hydration",
          provider: "openai",
          source: "mcp_bridge_local",
          credential: { api_key: "sk-test-hydration-1234567890" },
          redacted: "sk...7890",
        }),
      }),
    );
  });

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_OPENAI_API_KEY || null))
    .toBe("sk-test-hydration-1234567890");
  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBridgeSends.find((item) => item.type === "credential_hydration_result") || null))
    .toMatchObject({
      type: "credential_hydration_result",
      provider: "openai",
      ok: true,
      configured: true,
      redacted: "sk...7890",
    });
  await expect(
    page.evaluate(() => JSON.stringify(window.__actionsJsonStorage.ACTIONS_JSON_AGENT_MEMORY_V1 || {})),
  ).resolves.not.toContain("sk-test-hydration-1234567890");
});

test("background bridge rejects malformed credential hydration without storing a key", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonStorage = {};
    window.__actionsJsonBridgeSends = [];
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
          return { id, windowId: 77, url: "https://trello.com/b/example/actions-json" };
        },
        async group() {
          return 42;
        },
        async sendMessage() {
          return { ok: true };
        },
      },
    };
    window.WebSocket = class OpenWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = url;
        this.readyState = OpenWebSocket.CONNECTING;
        window.__actionsJsonBackgroundWebSocket = this;
        setTimeout(() => {
          this.readyState = OpenWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(value) {
        window.__actionsJsonBridgeSends.push(JSON.parse(value));
      }

      close() {
        this.readyState = OpenWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    };
  });

  await page.goto("data:text/html,<main><h1>Credential hydration rejection test</h1></main>");
  await addBackgroundScript(page);

  await expect(
    page.evaluate(
      () =>
        new Promise((resolve) => {
          window.__actionsJsonBackgroundMessageListener(
            {
              type: "actions-json:bridge-connect",
              bridgeUrl: "ws://100.99.150.49:17345/extension",
              readyItem: {
                type: "runtime_ready",
                runtime_id: "trello-runtime",
                manifest: { tools: [] },
              },
            },
            { tab: { id: 202, windowId: 77, url: "https://trello.com/b/example/actions-json" } },
            resolve,
          );
        }),
    )
  ).resolves.toMatchObject({ ok: true });

  await page.evaluate(() => {
    window.__actionsJsonBackgroundWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "credential_hydration",
          provider: "openai",
          source: "mcp_bridge_local",
          credential: {},
        }),
      }),
    );
  });

  await expect
    .poll(() => page.evaluate(() => window.__actionsJsonBridgeSends.find((item) => item.type === "credential_hydration_result") || null))
    .toMatchObject({
      type: "credential_hydration_result",
      provider: "openai",
      ok: false,
      configured: false,
      error: {
        code: "credential_hydration_failed",
      },
    });
  await expect(page.evaluate(() => window.__actionsJsonStorage.ACTIONS_JSON_OPENAI_API_KEY || null)).resolves.toBeNull();
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
    primitive: "debug.run_javascript",
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

  await expect(overlayReportFrame(page).locator("body")).toContainText("Opened from a root attachment");
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
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-width", "42px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-height", "42px");

  await page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
    host.shadowRoot.querySelector("[data-minimize]").click();
  });
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("left", "118px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("top", "77px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("width", "300px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("height", "260px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-width", "220px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-height", "42px");
  await expect(
    page.locator("#__actions_json_menu_overlay_host").evaluate((host) =>
      host.shadowRoot.querySelector(".title").textContent
    )
  ).resolves.toBe("actions.json agent");
});

test("actions.json menu overlay collapse action leaves a tiny expandable affordance", async ({ page }) => {
  await installRuntime(page, {
    tools: [
      { name: "overlay.menu.collapse", input_schema: { type: "object" } },
      { name: "overlay.menu.expand", input_schema: { type: "object" } },
    ],
  });
  await connectRuntime(page);

  await page.evaluate(async () => {
    const listener = window.__actionsJsonRuntimeListeners[0];
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

  await callRuntimeAction(page, "collapse-menu", "overlay.menu.collapse");
  const collapsedOutput = await actionOutput(page, "collapse-menu");
  expect(collapsedOutput.output).toMatchObject({
    ok: true,
    collapsed: true,
    geometry: { left: 118, top: 77, width: 42, height: 42 },
  });
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("width", "42px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("height", "42px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-width", "42px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-height", "42px");
  await expect(
    page.locator("#__actions_json_menu_overlay_host").evaluate((host) => {
      const button = host.shadowRoot.querySelector("[data-minimize]");
      return {
        title: button.title,
        visibleText: button.textContent,
        rect: button.getBoundingClientRect().toJSON(),
      };
    })
  ).resolves.toMatchObject({
    title: "Expand",
    visibleText: "☰",
    rect: { width: 30, height: 30 },
  });

  await callRuntimeAction(page, "expand-menu", "overlay.menu.expand");
  const expandedOutput = await actionOutput(page, "expand-menu");
  expect(expandedOutput.output).toMatchObject({
    ok: true,
    collapsed: false,
    geometry: { left: 118, top: 77, width: 300, height: 260 },
  });
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("width", "300px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("height", "260px");
  await expect(page.locator("#__actions_json_menu_overlay_host")).toHaveCSS("min-width", "220px");
  await expect(
    page.locator("#__actions_json_menu_overlay_host").evaluate((host) =>
      host.shadowRoot.querySelector(".title").textContent
    )
  ).resolves.toBe("actions.json agent");
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
    value: {
      clicked: true,
      x: 320,
      y: 204,
      target: {
        tag_name: "button",
        data_testid: "target-action",
        text: "Launch sequence",
        disabled: false,
        bounding_box: { x: 240, y: 180, width: 160, height: 48 },
        viewport: { width: 1280, height: 720 },
      },
    },
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

test("locator.element_info returns visible candidate options when text matches multiple elements", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "locator.element_info", input_schema: { type: "object" } }],
  });

  await page.setViewportSize({ width: 900, height: 700 });
  await page.setContent(`
    <main data-testid="board" style="position:absolute;left:0;top:40px;width:800px;height:500px">
      <a data-testid="trello-card" href="/c/a" style="position:absolute;left:20px;top:30px;width:260px;height:60px;display:block">
        Get Trello control to be demo ready
      </a>
      <a data-testid="trello-card" href="/c/b" style="position:absolute;left:320px;top:160px;width:260px;height:60px;display:block">
        Get Trello control to be demo ready follow-up
      </a>
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

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "locator-ambiguous-call",
          name: "locator.element_info",
          arguments: { locator: { selector: "[data-testid='board'], [data-testid='trello-card']", text_contains: "Get Trello control to be demo ready" } },
        }),
      })
    );
  });
  const output = await readExtensionActionOutput(page, "locator-ambiguous-call");

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      ambiguous: true,
      candidate_count: 3,
      candidates: [
        expect.objectContaining({
          tag_name: "main",
          text: expect.stringContaining("Get Trello control to be demo ready"),
          bounding_box: expect.objectContaining({ x: 0, y: 40, width: 800, height: 500 }),
          clickable_center: { x: 400, y: 290 },
        }),
        expect.objectContaining({
          tag_name: "a",
          text: "Get Trello control to be demo ready",
          bounding_box: expect.objectContaining({ x: 20, y: 70, width: 260, height: 60 }),
          clickable_center: { x: 150, y: 100 },
        }),
        expect.objectContaining({
          tag_name: "a",
          text: "Get Trello control to be demo ready follow-up",
          bounding_box: expect.objectContaining({ x: 320, y: 200, width: 260, height: 60 }),
          clickable_center: { x: 450, y: 230 },
        }),
      ],
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

test("locator.element_info scrolls clipped scroll-container targets into a clickable position", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "locator.element_info", input_schema: { type: "object" } }],
  });

  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <section
      data-testid="modal-scroll"
      style="position:absolute;left:100px;top:100px;width:260px;height:90px;overflow:auto;border:1px solid black"
    >
      <div style="height:170px"></div>
      <button data-testid="save-button" style="display:block;width:180px;height:36px">Save</button>
    </section>
  `);

  await connectRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: "locator-scroll-container-call",
          name: "locator.element_info",
          arguments: { locator: { selector: "[data-testid='save-button']" } },
        }),
      })
    );
  });
  const output = await readExtensionActionOutput(page, "locator-scroll-container-call");
  const scrollTop = await page.locator("[data-testid='modal-scroll']").evaluate((element) => element.scrollTop);
  const scrollBox = await page.locator("[data-testid='modal-scroll']").boundingBox();

  expect(scrollTop).toBeGreaterThan(0);
  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      tag_name: "button",
      clickable: true,
      initial_visibility: expect.objectContaining({
        state: "requires_scroll",
        scroll_operation: expect.objectContaining({
          target: "element",
          delta_y: expect.any(Number),
        }),
      }),
      visibility: expect.objectContaining({
        state: "visible",
        fully_visible: true,
      }),
    },
  });
  expect(output.value.initial_visibility.scroll_operation.delta_y).toBeGreaterThan(0);
  expect(output.value.clickable_center.y).toBeGreaterThanOrEqual(scrollBox.y);
  expect(output.value.clickable_center.y).toBeLessThanOrEqual(scrollBox.y + scrollBox.height);
});

test("locator.element_info scrolls a geometrically visible target clear of a sticky occluder", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "locator.element_info", input_schema: { type: "object" } }],
  });

  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <section
      data-testid="modal-scroll"
      style="position:absolute;left:100px;top:100px;width:260px;height:140px;overflow:auto;border:1px solid black"
    >
      <div
        data-testid="sticky-header"
        style="position:sticky;top:0;z-index:2;height:44px;background:white"
      >Sticky controls</div>
      <div style="height:56px"></div>
      <label
        data-testid="clickable-checkbox"
        style="display:block;width:32px;height:32px;background:lightgreen"
      >Toggle</label>
      <div style="height:180px"></div>
    </section>
  `);
  await page.locator("[data-testid='modal-scroll']").evaluate((element) => {
    element.scrollTop = 100;
  });

  await connectRuntime(page);
  await callRuntimeAction(page, "locator-sticky-occluder-call", "locator.element_info", {
    locator: { selector: "[data-testid='clickable-checkbox']" },
  });

  const output = await readExtensionActionOutput(page, "locator-sticky-occluder-call");
  expect(output, JSON.stringify(output, null, 2)).toHaveProperty("value.clickable_center");
  const result = await page.evaluate(({ x, y }) => {
    const target = document.querySelector("[data-testid='clickable-checkbox']");
    const hit = document.elementFromPoint(x, y);
    return {
      scrollTop: document.querySelector("[data-testid='modal-scroll']").scrollTop,
      hitTestPassed: hit === target || target.contains(hit),
      hitTestId: hit?.getAttribute("data-testid") || null,
    };
  }, output.value.clickable_center);

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      clickable: true,
      initial_visibility: expect.objectContaining({
        state: "requires_scroll",
        fully_visible: true,
        receives_events: false,
        occluded_by: expect.objectContaining({
          target_label: expect.stringContaining("sticky-header"),
        }),
        scroll_operation: expect.objectContaining({
          target: "element",
          delta_y: expect.any(Number),
        }),
      }),
      visibility: expect.objectContaining({
        state: "visible",
        fully_visible: true,
        receives_events: true,
      }),
      scroll_operations_performed: [expect.objectContaining({ target: "element" })],
    },
  });
  expect(output.value.initial_visibility.scroll_operation.delta_y).toBeLessThan(0);
  expect(result.scrollTop).toBeLessThan(100);
  expect(result.hitTestPassed).toBe(true);
  expect(result.hitTestId).toBe("clickable-checkbox");
});

test("locator.element_info retargets hidden semantic identity to its visible control", async ({ page }) => {
  await installRuntime(page, {
    tools: [{ name: "locator.element_info", input_schema: { type: "object" } }],
  });

  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(`
    <section data-testid="checklist" style="height:90px;overflow:auto">
      <div style="height:160px"></div>
      <div data-testid="check-item-container">
        <input
          type="checkbox"
          aria-label="Phase 8: implement and verify immediate fix"
          style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)"
        >
        <label data-testid="clickable-checkbox" style="display:block;width:32px;height:32px">Toggle</label>
      </div>
    </section>
  `);

  await connectRuntime(page);
  await callRuntimeAction(page, "locator-retarget-call", "locator.element_info", {
    locator: {
      selector: "input[type='checkbox']",
      text_equals: "Phase 8: implement and verify immediate fix",
      retarget: {
        closest: "[data-testid='check-item-container']",
        selector: "label[data-testid='clickable-checkbox']",
      },
    },
  });

  const output = await readExtensionActionOutput(page, "locator-retarget-call");
  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "extension",
    value: {
      tag_name: "label",
      text: "Toggle",
      clickable: true,
      visibility: expect.objectContaining({ fully_visible: true }),
    },
  });
  await expect(page.locator("[data-testid='checklist']")).not.toHaveJSProperty("scrollTop", 0);
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

test("bridge state_projection_call forwards to the background executor and returns output", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonStateProjectionRequests = [];
    window.__actionsJsonRuntimeMessageHandler = (message) => {
      if (message?.type === "actions-json:bridge-state-projection-call") {
        window.__actionsJsonStateProjectionRequests.push(message.item);
        return {
          ok: true,
          call_id: message.item?.call_id || null,
          output: {
            ok: true,
            projection: message.item?.projection_name || null,
            state: { board: { lists: [] } },
            state_hash: "sha256:test",
          },
        };
      }
      return { ok: true };
    };
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "state_projection_call",
          call_id: "state-call-1",
          mode: "state_read",
          projection_name: "trello.board",
          map_path: "scopes/private/sites/trello.com/board/actions.json",
          projection: {
            name: "trello.board",
            snapshot: {
              version: 1,
              source: "dom",
              extract: [],
              projection: { language: "jsonata", expression: "{% records %}" },
            },
          },
        }),
      })
    );
  });

  await expect.poll(() => actionOutput(page, "state-call-1")).toMatchObject({
    type: "action_call_output",
    call_id: "state-call-1",
    output: {
      ok: true,
      projection: "trello.board",
      state_hash: "sha256:test",
    },
  });

  const forwarded = await page.evaluate(() => window.__actionsJsonStateProjectionRequests);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toMatchObject({
    type: "state_projection_call",
    mode: "state_read",
    projection_name: "trello.board",
    map_path: "scopes/private/sites/trello.com/board/actions.json",
  });
  expect(forwarded[0].projection.snapshot.version).toBe(1);
});

test("bridge state_projection_call returns a structured action_error when execution fails", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = (message) => {
      if (message?.type === "actions-json:bridge-state-projection-call") {
        return {
          ok: false,
          error: {
            code: "state_payload_too_large",
            message: "Full state exceeded the configured budget.",
            recoverable: true,
          },
        };
      }
      return { ok: true };
    };
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "state_projection_call",
          call_id: "state-call-2",
          mode: "state_read",
          projection_name: "trello.board",
          map_path: "scopes/private/sites/trello.com/board/actions.json",
          projection: { name: "trello.board" },
        }),
      })
    );
  });

  await expect.poll(() => actionError(page, "state-call-2")).toMatchObject({
    type: "action_error",
    call_id: "state-call-2",
    error: { code: "state_payload_too_large" },
  });
});

test("bridge site_action_call forwards to the background executor and returns output", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonSiteActionRequests = [];
    window.__actionsJsonRuntimeMessageHandler = (message) => {
      if (message?.type === "actions-json:bridge-site-action-call") {
        window.__actionsJsonSiteActionRequests.push(message.item);
        return {
          ok: true,
          call_id: message.item?.call_id || null,
          output: {
            ok: true,
            opened: message.item?.arguments?.list_name || null,
            steps: [],
          },
        };
      }
      return { ok: true };
    };
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "site_action_call",
          call_id: "site-action-call-1",
          action: "trello.board.add_card.open_composer",
          arguments: { list_name: "Backlog" },
          map_path: "scopes/private/sites/trello.com/board/actions.json",
          map: {
            protocol: "actions.json",
            tools: [
              {
                name: "trello.board.add_card.open_composer",
                workflow: { version: 1, expression_language: "jsonata", steps: [] },
              },
            ],
          },
        }),
      })
    );
  });

  await expect.poll(() => actionOutput(page, "site-action-call-1")).toMatchObject({
    type: "action_call_output",
    call_id: "site-action-call-1",
    output: {
      ok: true,
      opened: "Backlog",
    },
  });

  const forwarded = await page.evaluate(() => window.__actionsJsonSiteActionRequests);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toMatchObject({
    type: "site_action_call",
    action: "trello.board.add_card.open_composer",
    map_path: "scopes/private/sites/trello.com/board/actions.json",
  });
  expect(forwarded[0].map.tools[0].workflow.version).toBe(1);
});

test("bridge site_action_call returns a structured action_error when execution fails", async ({ page }) => {
  await installRuntime(page);
  await connectRuntime(page);

  await page.evaluate(() => {
    window.__actionsJsonRuntimeMessageHandler = (message) => {
      if (message?.type === "actions-json:bridge-site-action-call") {
        return {
          ok: false,
          error: {
            code: "workflow_step_failed",
            message: "Step findList failed: list not visible.",
            recoverable: true,
          },
        };
      }
      return { ok: true };
    };
    window.__actionsJsonWebSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "site_action_call",
          call_id: "site-action-call-2",
          action: "trello.board.add_card.open_composer",
          arguments: { list_name: "Backlog" },
          map_path: "scopes/private/sites/trello.com/board/actions.json",
          map: { protocol: "actions.json", tools: [] },
        }),
      })
    );
  });

  await expect.poll(() => actionError(page, "site-action-call-2")).toMatchObject({
    type: "action_error",
    call_id: "site-action-call-2",
    error: { code: "workflow_step_failed" },
  });
});
