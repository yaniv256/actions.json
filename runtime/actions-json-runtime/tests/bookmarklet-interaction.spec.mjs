import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bookmarkletSource = readFileSync(join(here, "..", "bookmarklet", "storage-bookmarklet.js"), "utf8");

test("bookmarklet styles stay inside a shadow style node instead of visible page text", async ({ page }) => {
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>LinkedIn-like host page</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });

  const state = await page.evaluate(() => {
    const host = document.querySelector("#actions-json-storage-bookmarklet");
    const root = host?.shadowRoot;
    const panel = root?.querySelector(".panel");
    return {
      hostExists: !!host,
      styleCount: root?.querySelectorAll("style").length || 0,
      visibleCssInBody: document.body.innerText.includes(":host {"),
      panelWidth: panel ? getComputedStyle(panel).width : "",
    };
  });

  expect(state.hostExists).toBe(true);
  expect(state.styleCount).toBe(1);
  expect(state.visibleCssInBody).toBe(false);
  expect(state.panelWidth).toBe("440px");
});

test("bookmarklet falls back to extension relay when direct bridge WebSocket fails", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonRelayMessages = [];
    window.WebSocket = class BlockedWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = BlockedWebSocket.CONNECTING;
        this.listeners = new Map();
        setTimeout(() => {
          this.dispatch("error", new Event("error"));
          this.readyState = BlockedWebSocket.CLOSED;
          this.dispatch("close", new CloseEvent("close"));
        }, 0);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      send() {
        throw new Error("direct socket blocked");
      }
      close() {
        this.readyState = BlockedWebSocket.CLOSED;
      }
      dispatch(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
    };
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.source === "ajbm" &&
        event.data?.direction === "page-to-extension"
      ) {
        window.__actionsJsonRelayMessages.push(event.data.item);
      }
    });
  });
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Relay target</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonRelayMessages.some(
          (message) => message.type === "runtime_ready" && message.runtime_id?.startsWith("actions-json-bookmarklet-"),
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator("#actions-json-storage-bookmarklet")).toContainText("Bridge: extension relay");

  await page.evaluate(() => {
    const runtimeId = window.__actionsJsonRelayMessages.find((message) => message.type === "runtime_ready").runtime_id;
    window.postMessage(
      {
        source: "ajex",
        direction: "extension-to-page",
        item: {
          type: "action_call",
          runtime_id: runtimeId,
          call_id: "relay-storage-list",
          name: "storage.list",
          arguments: {},
        },
      },
      "*",
    );
  });

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__actionsJsonRelayMessages.some(
          (message) => message.type === "action_call_output" && message.call_id === "relay-storage-list",
        ),
      ),
    )
    .toBe(true);
});

test("bookmarklet repeats relay runtime_ready while direct bridge remains blocked", async ({ page }) => {
  await page.addInitScript(() => {
    window.__actionsJsonRelayMessages = [];
    window.WebSocket = class BlockedWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor() {
        this.readyState = BlockedWebSocket.CONNECTING;
        this.listeners = new Map();
        setTimeout(() => {
          this.dispatch("error", new Event("error"));
          this.readyState = BlockedWebSocket.CLOSED;
          this.dispatch("close", new CloseEvent("close"));
        }, 0);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      send() {}
      close() {
        this.readyState = BlockedWebSocket.CLOSED;
      }
      dispatch(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
    };
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.source === "ajbm" &&
        event.data?.direction === "page-to-extension"
      ) {
        window.__actionsJsonRelayMessages.push(event.data.item);
      }
    });
  });
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Relay target</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });

  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__actionsJsonRelayMessages.filter((message) => message.type === "runtime_ready").length,
        ),
      { timeout: 5000 },
    )
    .toBeGreaterThanOrEqual(2);
});

test("collapsed bookmarklet preserves hamburger position, expands, and remains draggable", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main style='height:2000px'>Test page</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });

  const state = async () =>
    page.evaluate(() => {
      const host = document.querySelector("#actions-json-storage-bookmarklet");
      const root = host?.shadowRoot;
      const panel = root?.querySelector(".panel");
      const button = root?.querySelector("[data-collapse]");
      const hostRect = host?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        host: hostRect && {
          left: hostRect.left,
          top: hostRect.top,
          width: hostRect.width,
          height: hostRect.height,
        },
        panelClass: panel?.className || "",
        panel: panelRect && {
          left: panelRect.left,
          top: panelRect.top,
          width: panelRect.width,
          height: panelRect.height,
        },
        buttonTitle: button?.getAttribute("title") || "",
        button: buttonRect && {
          left: buttonRect.left,
          top: buttonRect.top,
          width: buttonRect.width,
          height: buttonRect.height,
        },
      };
    });

  const clickCollapseButton = async () => {
    const current = await state();
    await page.mouse.click(
      current.button.left + current.button.width / 2,
      current.button.top + current.button.height / 2,
    );
    await page.waitForTimeout(30);
    return state();
  };

  const before = await state();
  const collapsed = await clickCollapseButton();

  expect(collapsed.panelClass).toContain("collapsed");
  expect(collapsed.buttonTitle).toBe("Expand");
  expect(collapsed.button.left).toBeCloseTo(before.button.left, 0);
  expect(collapsed.button.top).toBeCloseTo(before.button.top, 0);

  const expanded = await clickCollapseButton();
  expect(expanded.panelClass).not.toContain("collapsed");
  expect(expanded.buttonTitle).toBe("Collapse");
  expect(expanded.panel.width).toBeGreaterThan(200);

  const recollapsed = await clickCollapseButton();
  const startX = recollapsed.button.left + recollapsed.button.width / 2;
  const startY = recollapsed.button.top + recollapsed.button.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 90, startY + 70, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(20);

  const dragged = await state();
  expect(dragged.panelClass).toContain("collapsed");
  expect(dragged.button.left).toBeLessThan(recollapsed.button.left - 40);
  expect(dragged.button.top).toBeGreaterThan(recollapsed.button.top + 30);

  await page.mouse.move(dragged.button.left + dragged.button.width / 2, dragged.button.top + dragged.button.height / 2);
  await page.mouse.down();
  await page.mouse.move(999, dragged.button.top + dragged.button.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const draggedRight = await state();
  expect(draggedRight.button.left + draggedRight.button.width).toBeCloseTo(1000, 0);

  const expandedAfterDrag = await clickCollapseButton();
  expect(expandedAfterDrag.panelClass).not.toContain("collapsed");
  expect(expandedAfterDrag.buttonTitle).toBe("Collapse");
});

test("bookmarklet captures screenshots through user-consented screen capture", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 420 });
  await page.addInitScript(() => {
    window.__actionsJsonFakeSockets = [];
    window.__actionsJsonGetDisplayMediaCalls = 0;
    window.__actionsJsonDrawImageCalls = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
      getDisplayMedia: async (options) => {
        window.__actionsJsonGetDisplayMediaCalls += 1;
        window.__actionsJsonDisplayMediaOptions = options;
        return {
          getVideoTracks() {
            return [{
              getSettings: () => ({ width: 320, height: 180 }),
              stop: () => { window.__actionsJsonTrackStopped = true; },
            }];
          },
        };
      },
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "videoWidth", { configurable: true, get: () => 320 });
    Object.defineProperty(HTMLMediaElement.prototype, "videoHeight", { configurable: true, get: () => 180 });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() {
        return this.__actionsJsonSrcObject || null;
      },
      set(value) {
        this.__actionsJsonSrcObject = value;
      },
    });
    HTMLMediaElement.prototype.play = async function play() {
      queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
    };
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
      if (type !== "2d") return originalGetContext.call(this, type, ...args);
      return {
        drawImage: () => {
          window.__actionsJsonDrawImageCalls += 1;
        },
      };
    };
    HTMLCanvasElement.prototype.toDataURL = function toDataURL(type, quality) {
      window.__actionsJsonCanvasExport = { width: this.width, height: this.height, type, quality };
      return `data:${type || "image/png"};base64,ZmFrZS1zY3JlZW5zaG90`;
    };
    window.WebSocket = class FakeWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.listeners = new Map();
        this.sent = [];
        window.__actionsJsonFakeSockets.push(this);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      send(message) {
        this.sent.push(JSON.parse(message));
      }
      close() {
        this.readyState = 3;
      }
      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
    };
  });
  await page.route("https://example.test/screenshot", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main style='width:900px;height:700px;background:#184d47;color:white;font:28px sans-serif;padding:24px'>Screenshot target</main></body></html>",
    });
  });
  await page.goto("https://example.test/screenshot");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));
  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "screenshot-call",
        name: "browser.screenshot",
        arguments: {},
      }),
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => !!document.querySelector("#actions-json-storage-bookmarklet").shadowRoot.querySelector("[data-capture-screenshot]"),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      window.__actionsJsonFakeSockets[0].sent.some(
        (message) => message.type === "action_call_output" && message.call_id === "screenshot-call",
      ),
    ),
  ).toBe(false);

  await page.evaluate(() =>
    document.querySelector("#actions-json-storage-bookmarklet").shadowRoot.querySelector("[data-capture-screenshot]").click(),
  );

  const readOutput = () =>
    page.evaluate(() =>
      window.__actionsJsonFakeSockets[0].sent.find(
        (message) => message.type === "action_call_output" && message.call_id === "screenshot-call",
      )?.output || null,
    );
  await expect
    .poll(async () =>
      readOutput(),
    )
    .not.toBeNull();
  const output = await readOutput();

  expect(output).toMatchObject({
    ok: true,
    capture_method: "getDisplayMedia",
    rendered: true,
    width: 320,
    height: 180,
    mime_type: "image/png",
  });
  expect(output.data_url).toBe("data:image/png;base64,ZmFrZS1zY3JlZW5zaG90");
  expect(await page.evaluate(() => window.__actionsJsonGetDisplayMediaCalls)).toBe(1);
  expect(await page.evaluate(() => window.__actionsJsonDrawImageCalls)).toBe(1);
  expect(await page.evaluate(() => window.__actionsJsonTrackStopped)).toBe(true);
  expect(await page.evaluate(() => window.__actionsJsonDisplayMediaOptions)).toMatchObject({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  });
  expect(await page.evaluate(() => window.__actionsJsonCanvasExport)).toMatchObject({
    width: 320,
    height: 180,
    type: "image/png",
  });
});

test("opened content uses real tabs instead of stacked sections", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 640 });
  await page.route("https://example.test/tabs", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Tab layout target</main></body></html>",
    });
  });
  await page.goto("https://example.test/tabs");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => {
    const root = document.querySelector("#actions-json-storage-bookmarklet").shadowRoot;
    root.querySelector("[data-status]").textContent = Array.from({ length: 40 }, (_, index) => `diagnostic ${index}`).join("\n");
    window.__actionsJsonStorageBookmarkletRuntime.openTab({
      id: "latest-screenshot",
      title: "Latest Screenshot",
      html: "<img alt='screenshot' src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22200%22%3E%3Crect width=%22300%22 height=%22200%22 fill=%22%23182749%22/%3E%3C/svg%3E'>",
    });
  });

  const layout = await page.evaluate(() => {
    const root = document.querySelector("#actions-json-storage-bookmarklet").shadowRoot;
    const panel = root.querySelector(".panel").getBoundingClientRect();
    const tabs = root.querySelector("[data-tabs]").getBoundingClientRect();
    const tabPanels = root.querySelector("[data-tab-panels]").getBoundingClientRect();
    const pagePanel = root.querySelector('.tab-panel[data-tab-id="actions-json"]');
    const statusPanel = root.querySelector('.tab-panel[data-tab-id="status"]');
    const screenshotPanel = root.querySelector('.tab-panel[data-tab-id="latest-screenshot"]');
    const hitTests = [...root.querySelectorAll(".tab-button")].map((button) => {
      const rect = button.getBoundingClientRect();
      const element = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height * 0.8);
      return {
        tabId: button.dataset.tabId,
        hitTag: element?.tagName,
        hitTabId: element?.dataset?.tabId || null,
      };
    });
    return {
      panel: { top: panel.top, bottom: panel.bottom },
      tabs: { top: tabs.top, bottom: tabs.bottom },
      tabPanels: { top: tabPanels.top, bottom: tabPanels.bottom },
      headerContainsTabs: root.querySelector("header [data-tabs]") === root.querySelector("[data-tabs]"),
      titleCount: root.querySelectorAll("h1").length,
      firstTabText: root.querySelector(".tab-button")?.textContent,
      selectedTab: root.querySelector('[aria-selected="true"]')?.dataset.tabId,
      pageDisplay: getComputedStyle(pagePanel).display,
      statusDisplay: getComputedStyle(statusPanel).display,
      screenshotDisplay: getComputedStyle(screenshotPanel).display,
      pageHasFolderControls: !!pagePanel.querySelector("[data-choose-folder]"),
      activeHasFolderControls: !!screenshotPanel.querySelector("[data-choose-folder]"),
      hitTests,
    };
  });

  expect(layout.tabs.top).toBeGreaterThanOrEqual(layout.panel.top);
  expect(layout.tabs.bottom).toBeLessThan(layout.panel.bottom);
  expect(layout.tabPanels.bottom).toBeLessThanOrEqual(layout.panel.bottom);
  expect(layout.headerContainsTabs).toBe(true);
  expect(layout.titleCount).toBe(0);
  expect(layout.firstTabText).toBe("actions.json");
  expect(layout.selectedTab).toBe("latest-screenshot");
  expect(layout.pageDisplay).toBe("none");
  expect(layout.statusDisplay).toBe("none");
  expect(layout.screenshotDisplay).toBe("block");
  expect(layout.pageHasFolderControls).toBe(true);
  expect(layout.activeHasFolderControls).toBe(false);
  expect(layout.hitTests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tabId: "actions-json", hitTag: "BUTTON", hitTabId: "actions-json" }),
      expect.objectContaining({ tabId: "status", hitTag: "BUTTON", hitTabId: "status" }),
      expect.objectContaining({ tabId: "latest-screenshot", hitTag: "BUTTON", hitTabId: "latest-screenshot" }),
    ]),
  );
});

test("overlay.open action renders a tab in the bookmarklet overlay", async ({ page }) => {
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Overlay action target</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "overlay-open-call",
        name: "overlay.open",
        arguments: {
          id: "horizon-attribution",
          title: "Horizon Attribution",
          html: "<section><h2>Rolling windows</h2><p>LinkedIn summary</p></section>",
        },
      }),
    });
  });

  const output = await readActionOutput(page, "overlay-open-call");
  const state = await page.evaluate(() => {
    const root = document.querySelector("#actions-json-storage-bookmarklet").shadowRoot;
    return {
      selectedTab: root.querySelector('.tab-button[aria-selected="true"]')?.textContent,
      panelText: root.querySelector(".tab-panel.active")?.textContent,
    };
  });

  expect(output).toMatchObject({ ok: true, tab_id: "horizon-attribution" });
  expect(state.selectedTab).toBe("Horizon Attribution");
  expect(state.panelText).toContain("Rolling windows");
});

test("overlay.open action parses full HTML documents without showing CSS as text", async ({ page }) => {
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Overlay action target</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "overlay-open-document-call",
        name: "overlay.open",
        arguments: {
          id: "document-overlay",
          title: "Document Overlay",
          html: `<!doctype html>
            <html>
              <head>
                <style>.report-title { color: rgb(123, 97, 255); }</style>
              </head>
              <body><main><h2 class="report-title">Rendered report</h2></main></body>
            </html>`,
        },
      }),
    });
  });
  await readActionOutput(page, "overlay-open-document-call");

  const state = await page.evaluate(() => {
    const root = document.querySelector("#actions-json-storage-bookmarklet").shadowRoot;
    const activePanel = root.querySelector(".tab-panel.active");
    const frame = activePanel.querySelector("iframe.tab-frame");
    return {
      activeText: activePanel.textContent,
      activeHtml: activePanel.innerHTML,
      frameTitle: frame?.title,
      frameSrc: frame?.src,
    };
  });

  expect(state.frameTitle).toBeUndefined();
  expect(state.frameSrc).toBeUndefined();
  expect(state.activeText).toContain("Rendered report");
  expect(state.activeText).not.toContain(".report-title");
  expect(state.activeHtml).toContain("report-title");
});

test("overlay.open action does not depend on DOMParser preserving HTML structure", async ({ page }) => {
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Overlay action target</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => {
    window.DOMParser = class FlatteningDOMParser {
      parseFromString(value) {
        return {
          body: { innerHTML: String(value).replace(/<[^>]+>/g, "") },
          querySelectorAll() {
            return [];
          },
        };
      }
    };
  });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "overlay-open-parser-independent-call",
        name: "overlay.open",
        arguments: {
          id: "parser-independent-overlay",
          title: "Parser Independent Overlay",
          html: `<!doctype html>
            <html>
              <head>
                <title>Parser Independent Overlay</title>
                <style>.report-title { color: rgb(0, 143, 140); }</style>
              </head>
              <body><main><h2 class="report-title">Rendered without DOMParser</h2></main></body>
            </html>`,
        },
      }),
    });
  });
  await readActionOutput(page, "overlay-open-parser-independent-call");

  const state = await page.evaluate(() => {
    const root = document.querySelector("#actions-json-storage-bookmarklet").shadowRoot;
    const activePanel = root.querySelector(".tab-panel.active");
    const frame = activePanel.querySelector("iframe.tab-frame");
    return {
      activeText: activePanel.textContent,
      activeHtml: activePanel.innerHTML,
      frameTitle: frame?.title,
      frameSrc: frame?.src,
    };
  });

  expect(state.frameTitle).toBeUndefined();
  expect(state.frameSrc).toBeUndefined();
  expect(state.activeText).toContain("Rendered without DOMParser");
  expect(state.activeText).not.toContain(".report-title");
  expect(state.activeText).not.toContain("Parser Independent Overlay.report-title");
  expect(state.activeHtml).toContain("report-title");
});

test("overlay.open action scopes full-document root and body styles into the tab content", async ({ page }) => {
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main>Overlay action target</main></body></html>",
    });
  });
  await page.goto("https://example.test/");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "overlay-open-root-body-css-call",
        name: "overlay.open",
        arguments: {
          id: "root-body-css-overlay",
          title: "Root Body CSS Overlay",
          html: `<!doctype html>
            <html>
              <head>
                <style>
                  :root { --report-ink: rgb(17, 32, 47); }
                  html, body {
                    margin: 0;
                    color: var(--report-ink);
                    background: rgb(240, 246, 255);
                    font-family: Arial, sans-serif;
                  }
                  .report-card { color: var(--report-ink); padding: 19px; }
                </style>
              </head>
              <body><main class="report-card">Document-level styles apply</main></body>
            </html>`,
        },
      }),
    });
  });
  await readActionOutput(page, "overlay-open-root-body-css-call");

  const state = await page.evaluate(() => {
    const root = document.querySelector("#actions-json-storage-bookmarklet").shadowRoot;
    const activePanel = root.querySelector(".tab-panel.active");
    const content = activePanel.querySelector(".tab-content");
    const card = activePanel.querySelector(".report-card");
    return {
      contentColor: getComputedStyle(content).color,
      contentBackground: getComputedStyle(content).backgroundColor,
      cardColor: getComputedStyle(card).color,
      cardPadding: getComputedStyle(card).paddingTop,
    };
  });

  expect(state.contentColor).toBe("rgb(17, 32, 47)");
  expect(state.contentBackground).toBe("rgb(240, 246, 255)");
  expect(state.cardColor).toBe("rgb(17, 32, 47)");
  expect(state.cardPadding).toBe("19px");
});

test("locator.element_info returns viewport geometry and clickable center", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/locator", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <main style="padding: 80px">
              <button
                data-testid="target-action"
                style="position:absolute;left:240px;top:180px;width:160px;height:48px"
              >Launch sequence</button>
            </main>
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/locator");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));
  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "locator-call",
        name: "locator.element_info",
        arguments: { locator: { selector: "[data-testid='target-action']" } },
      }),
    });
  });

  const output = await readActionOutput(page, "locator-call");

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "embed",
    value: {
      text: "Launch sequence",
      tag_name: "button",
      bounding_box: {
        x: 240,
        y: 180,
        width: 160,
        height: 48,
      },
      clickable_center: {
        x: 320,
        y: 204,
      },
    },
  });
});

test("locator.element_info filters selector candidates by exact text", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/locator-text-scope", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <section style="position:absolute;left:10px;top:10px;width:700px;height:400px">
              <h2 style="position:absolute;left:20px;top:20px;width:300px;height:40px;margin:0">Drama TV and movies</h2>
              <h2 style="position:absolute;left:20px;top:100px;width:300px;height:40px;margin:0">Continue watching</h2>
            </section>
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/locator-text-scope");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));
  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "locator-selector-text-call",
        name: "locator.element_info",
        arguments: { locator: { selector: "h2", text_equals: "Continue watching" } },
      }),
    });
  });

  const output = await readActionOutput(page, "locator-selector-text-call");

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "embed",
    value: {
      text: "Continue watching",
      tag_name: "h2",
      bounding_box: { x: 30, y: 110, width: 300, height: 40 },
      clickable_center: { x: 180, y: 130 },
    },
  });
});

test("locator.element_info returns a visible clickable center for partially offscreen targets", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/locator-partial", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <a
              href="#partial"
              data-testid="partial-card"
              style="position:absolute;left:40px;top:-110px;width:220px;height:120px;display:block"
            >Partially visible card</a>
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/locator-partial");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));
  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "locator-partial-call",
        name: "locator.element_info",
        arguments: { locator: { selector: "[data-testid='partial-card']" } },
      }),
    });
  });

  const output = await readActionOutput(page, "locator-partial-call");

  expect(output).toMatchObject({
    ok: true,
    primitive: "locator.element_info",
    adapter: "embed",
    value: {
      bounding_box: { x: 40, y: -110, width: 220, height: 120 },
      clickable_center: { x: 150, y: 5 },
    },
  });
});

test("locator.element_info reports target_not_found for missing visible targets", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/locator-missing", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main><button>Visible button</button></main></body></html>",
    });
  });
  await page.goto("https://example.test/locator-missing");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));
  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "locator-missing-call",
        name: "locator.element_info",
        arguments: { locator: { selector: "[data-testid='missing-action']" } },
      }),
    });
  });

  const output = await readActionOutput(page, "locator-missing-call");

  expect(output).toMatchObject({
    ok: false,
    primitive: "locator.element_info",
    adapter: "embed",
    error: {
      code: "target_not_found",
      recoverable: true,
      evidence: { locator: { selector: "[data-testid='missing-action']" } },
    },
  });
});

test("locator.element_info center feeds pointer.click to change fixture state", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/locator-click", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <main style="padding: 80px">
              <button
                data-testid="target-action"
                style="position:absolute;left:240px;top:180px;width:160px;height:48px"
                onclick="document.body.dataset.clicked = 'yes'; document.body.dataset.clickX = Math.round(event.clientX); document.body.dataset.clickY = Math.round(event.clientY);"
              >Launch sequence</button>
            </main>
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/locator-click");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));
  await page.evaluate(() => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "locator-bridge-call",
        name: "locator.element_info",
        arguments: { locator: { text: "Launch sequence" } },
      }),
    });
  });
  const locatorOutput = await readActionOutput(page, "locator-bridge-call");
  const center = locatorOutput.value.clickable_center;

  await page.evaluate((point) => {
    window.__actionsJsonFakeSockets[0].emit("message", {
      data: JSON.stringify({
        type: "action_call",
        call_id: "pointer-click-call",
        name: "pointer.click",
        arguments: point,
      }),
    });
  }, center);
  const clickOutput = await readActionOutput(page, "pointer-click-call");

  expect(clickOutput).toMatchObject({
    ok: true,
    primitive: "pointer.click",
    adapter: "embed",
    value: { clicked: true, x: 320, y: 204 },
  });
  expect(await page.evaluate(() => document.body.dataset.clicked)).toBe("yes");
  expect(await page.evaluate(() => document.body.dataset.clickX)).toBe("320");
  expect(await page.evaluate(() => document.body.dataset.clickY)).toBe("204");
});

test("bookmarklet implements advertised point and input primitives", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/point-primitives", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <button
              data-testid="double-target"
              style="position:absolute;left:120px;top:100px;width:120px;height:44px"
              ondblclick="document.body.dataset.doubleClicked = 'yes'"
            >Double</button>
            <div
              data-testid="drag-target"
              style="position:absolute;left:120px;top:180px;width:80px;height:44px;background:#ddd"
              ondragstart="event.preventDefault()"
              onpointerdown="document.body.dataset.dragStarted = 'yes'"
            >Drag</div>
            <input
              data-testid="text-target"
              style="position:absolute;left:120px;top:260px;width:180px;height:36px"
              oninput="document.body.dataset.inputValue = this.value"
            />
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/point-primitives");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await callBookmarkletAction(page, "pointer.move-call", "pointer.move", { x: 180, y: 122, duration_ms: 0 });
  const moveOutput = await readActionOutput(page, "pointer.move-call");
  const pointerState = await page.evaluate(() => {
    const pointer = document.querySelector("#actions-json-ghost-pointer");
    return {
      left: pointer?.style.left,
      top: pointer?.style.top,
      visible: !!pointer,
    };
  });

  expect(moveOutput).toMatchObject({
    ok: true,
    primitive: "pointer.move",
    adapter: "embed",
    value: { x: 180, y: 122 },
  });
  expect(pointerState.visible).toBe(true);
  expect(pointerState.left).toBe("180px");
  expect(pointerState.top).toBe("122px");

  await callBookmarkletAction(page, "pointer-double-call", "pointer.double_click", { x: 180, y: 122 });
  const doubleOutput = await readActionOutput(page, "pointer-double-call");
  expect(doubleOutput).toMatchObject({
    ok: true,
    primitive: "pointer.double_click",
    adapter: "embed",
    value: { double_clicked: true, x: 180, y: 122 },
  });
  expect(await page.evaluate(() => document.body.dataset.doubleClicked)).toBe("yes");

  await callBookmarkletAction(page, "pointer-drag-call", "pointer.drag", {
    from: { x: 160, y: 202 },
    to: { x: 240, y: 222 },
    duration_ms: 0,
  });
  const dragOutput = await readActionOutput(page, "pointer-drag-call");
  expect(dragOutput).toMatchObject({
    ok: true,
    primitive: "pointer.drag",
    adapter: "embed",
    value: { dragged: true },
  });
  expect(await page.evaluate(() => document.body.dataset.dragStarted)).toBe("yes");

  await page.locator("[data-testid='text-target']").focus();
  await callBookmarkletAction(page, "text-insert-call", "text.insert", { text: "hello actions" });
  const textOutput = await readActionOutput(page, "text-insert-call");
  expect(textOutput).toMatchObject({
    ok: true,
    primitive: "text.insert",
    adapter: "embed",
    value: { inserted: true, inserted_length: 13 },
  });
  expect(await page.evaluate(() => document.querySelector("[data-testid='text-target']").value)).toBe("hello actions");
  expect(await page.evaluate(() => document.body.dataset.inputValue)).toBe("hello actions");
});

test("bookmarklet implements viewport.scroll for viewport and scoped scroll containers", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/scroll", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body style="margin:0;height:2000px">
            <h2 style="margin-top:720px">Continue watching</h2>
            <section
              data-testid="carousel"
              style="width:300px;height:120px;overflow-x:auto;white-space:nowrap;border:1px solid #999"
            >
              <a style="display:inline-block;width:180px;height:80px;margin:8px" href="/one">One</a>
              <a style="display:inline-block;width:180px;height:80px;margin:8px" href="/two">Two</a>
              <a style="display:inline-block;width:180px;height:80px;margin:8px" href="/three">Three</a>
            </section>
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/scroll");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await callBookmarkletAction(page, "viewport-scroll-call", "viewport.scroll", { delta_y: 500 });
  const scopedScrollStartedAt = Date.now();
  await callBookmarkletAction(page, "scoped-scroll-call", "viewport.scroll", {
    delta_x: 220,
    scope: {
      selector: "h2",
      text_equals: "Continue watching",
      root_strategy: "nearest_ancestor_containing_items",
      max_ancestor_depth: 2,
    },
    item_selector: "a",
  });

  const viewportOutput = await readActionOutput(page, "viewport-scroll-call");
  expect(viewportOutput).toMatchObject({
    ok: true,
    primitive: "viewport.scroll",
    adapter: "embed",
    value: {
      moved: true,
      target: "viewport",
      delta_y: 500,
    },
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(400);

  const scopedOutput = await readActionOutput(page, "scoped-scroll-call");
  expect(scopedOutput).toMatchObject({
    ok: true,
    primitive: "viewport.scroll",
    adapter: "embed",
    value: {
      moved: true,
      target: "element",
      delta_x: 220,
      rate_limit_wait_ms: expect.any(Number),
    },
  });
  expect(Date.now() - scopedScrollStartedAt).toBeGreaterThanOrEqual(450);
  expect(scopedOutput.value.rate_limit_wait_ms).toBeGreaterThanOrEqual(400);
  expect(await page.evaluate(() => document.querySelector("[data-testid='carousel']").scrollLeft)).toBeGreaterThan(100);

  const extractStartedAt = Date.now();
  await callBookmarkletAction(page, "extract-after-scrolls", "browser.extract_elements", {
    scope: {
      selector: "h2",
      text_equals: "Continue watching",
      root_strategy: "nearest_ancestor_containing_items",
      max_ancestor_depth: 2,
    },
    item_selector: "a",
    fields: [
      { name: "title", selector: ":scope", attribute: "text" },
      { name: "url", selector: ":scope", attributes: ["href"] },
    ],
  });
  const extractOutput = await readActionOutput(page, "extract-after-scrolls");
  expect(extractOutput).toMatchObject({
    ok: true,
  });
  expect(Date.now() - extractStartedAt).toBeLessThan(250);
});

test("bookmarklet implements browser.extract_elements with scoped field extraction", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/extract", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <section data-testid="row">
              <h2>Continue watching</h2>
              <a class="card" href="/watch/one">
                <img alt="First cover" src="/covers/one.jpg">
                <span class="title">First Movie</span>
              </a>
              <a class="card" href="/watch/two">
                <img alt="Second cover" src="/covers/two.jpg">
                <span class="title">Second Movie</span>
              </a>
            </section>
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/extract");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await callBookmarkletAction(page, "extract-elements-call", "browser.extract_elements", {
    scope: {
      selector: "h2",
      text_equals: "Continue watching",
      root_strategy: "nearest_ancestor_containing_items",
      max_ancestor_depth: 2,
    },
    item_selector: "a.card",
    fields: [
      { name: "title", selector: ".title", attribute: "text" },
      { name: "url", selector: ":scope", attribute: "href" },
      { name: "cover", selector: "img", attributes: ["currentSrc", "src"] },
    ],
  });

  const output = await readActionOutput(page, "extract-elements-call");
  expect(output).toMatchObject({
    ok: true,
    item_count: 2,
    items: [
      {
        title: "First Movie",
        url: "https://example.test/watch/one",
        cover: "https://example.test/covers/one.jpg",
      },
      {
        title: "Second Movie",
        url: "https://example.test/watch/two",
        cover: "https://example.test/covers/two.jpg",
      },
    ],
  });
});

test("bookmarklet implements page, DOM, locator text, wait, and keyboard primitives", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await installFakeBookmarkletSocket(page);
  await page.route("https://example.test/observe", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <head><title>Observation Fixture</title></head>
          <body>
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
          </body>
        </html>
      `,
    });
  });
  await page.goto("https://example.test/observe");
  await page.addScriptTag({ content: bookmarkletSource });
  await page.evaluate(() => window.__actionsJsonFakeSockets[0].emit("open"));

  await callBookmarkletAction(page, "page-info-call", "page.info");
  expect(await readActionOutput(page, "page-info-call")).toMatchObject({
    ok: true,
    primitive: "page.info",
    adapter: "embed",
    value: {
      url: "https://example.test/observe",
      title: "Observation Fixture",
    },
  });

  await callBookmarkletAction(page, "dom-observe-call", "dom.observe.visible", {
    selector: "button",
    text_contains: "Observe",
  });
  expect(await readActionOutput(page, "dom-observe-call")).toMatchObject({
    ok: true,
    primitive: "dom.observe.visible",
    adapter: "embed",
    value: {
      match_count: 1,
      matches: [expect.objectContaining({ tag_name: "button", text: "Observe Me" })],
    },
  });

  await callBookmarkletAction(page, "dom-list-sections-call", "dom.list_sections", {
    selector: "section[data-testid='standard-carousel']",
    heading_selector: "h2",
    item_selector: "article",
  });
  const listSectionsOutput = await readActionOutput(page, "dom-list-sections-call");
  expect(listSectionsOutput).toMatchObject({
    ok: true,
    primitive: "dom.list_sections",
    adapter: "embed",
    value: {
      section_count: 2,
      sections: [
        expect.objectContaining({ heading: "Top picks", item_count: 1 }),
        expect.objectContaining({ heading: "Continue watching", item_count: 2 }),
      ],
    },
  });
  expect(listSectionsOutput.value.sections[1].scroll_y).toBeGreaterThan(listSectionsOutput.value.sections[0].scroll_y);
  expect(listSectionsOutput.value.sections[1].visible).toBe(false);

  await callBookmarkletAction(page, "dom-snapshot-call", "dom.snapshot_text", {
    selector: "main",
    max_chars: 200,
  });
  expect(await readActionOutput(page, "dom-snapshot-call")).toMatchObject({
    ok: true,
    primitive: "dom.snapshot_text",
    adapter: "embed",
    value: {
      text: "Observe Me Visible text snapshot target Top picks First Continue watching Second Third",
      truncated: false,
    },
  });

  await callBookmarkletAction(page, "locator-text-call", "locator.text_content", {
    locator: { selector: "[data-testid='visible-action']" },
  });
  expect(await readActionOutput(page, "locator-text-call")).toMatchObject({
    ok: true,
    primitive: "locator.text_content",
    adapter: "embed",
    value: { text: "Observe Me" },
  });

  await callBookmarkletAction(page, "locator-wait-call", "locator.wait_for", {
    locator: { text_equals: "Observe Me" },
    state: "visible",
    timeout_ms: 100,
  });
  expect(await readActionOutput(page, "locator-wait-call")).toMatchObject({
    ok: true,
    primitive: "locator.wait_for",
    adapter: "embed",
    value: { matched: true, state: "visible" },
  });

  await page.locator("[data-testid='visible-action']").focus();
  await callBookmarkletAction(page, "keyboard-press-call", "keyboard.press", { key: "Enter" });
  expect(await readActionOutput(page, "keyboard-press-call")).toMatchObject({
    ok: true,
    primitive: "keyboard.press",
    adapter: "embed",
    value: { pressed: true, key: "Enter", fidelity: "page_level" },
  });
  expect(await page.evaluate(() => document.body.dataset.key)).toBe("Enter");
});

async function installFakeBookmarkletSocket(page) {
  await page.addInitScript(() => {
    window.__actionsJsonFakeSockets = [];
    window.WebSocket = class FakeWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.listeners = new Map();
        this.sent = [];
        window.__actionsJsonFakeSockets.push(this);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      send(message) {
        this.sent.push(JSON.parse(message));
      }
      close() {
        this.readyState = 3;
      }
      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
    };
  });
}

async function callBookmarkletAction(page, callId, name, args = {}) {
  await page.evaluate(
    ({ callId, name, args }) => {
      window.__actionsJsonFakeSockets[0].emit("message", {
        data: JSON.stringify({
          type: "action_call",
          call_id: callId,
          name,
          arguments: args,
        }),
      });
    },
    { callId, name, args },
  );
}

async function readActionOutput(page, callId) {
  await expect
    .poll(() =>
      page.evaluate((id) =>
        window.__actionsJsonFakeSockets[0].sent.find(
          (message) => message.type === "action_call_output" && message.call_id === id,
        )?.output || null,
      callId),
    )
    .not.toBeNull();
  return page.evaluate((id) =>
    window.__actionsJsonFakeSockets[0].sent.find(
      (message) => message.type === "action_call_output" && message.call_id === id,
    )?.output || null,
  callId);
}
