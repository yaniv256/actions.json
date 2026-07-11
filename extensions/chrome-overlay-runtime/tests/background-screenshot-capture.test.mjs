import assert from "node:assert/strict";
import test from "node:test";

import {
  captureTabSurface,
  createChromeScreenshotBrowser,
} from "../src/agent/background-screenshot-capture.mjs";

test("Chrome adapter converts activation runtime.lastError into a rejected operation", async () => {
  const chromeApi = {
    runtime: { lastError: null },
    tabs: {
      update(_tabId, _details, callback) {
        chromeApi.runtime.lastError = { message: "No tab with id: 123" };
        callback();
        chromeApi.runtime.lastError = null;
      },
    },
  };
  const browser = createChromeScreenshotBrowser(chromeApi);

  await assert.rejects(
    browser.activateTab(123),
    (error) => error.code === "screenshot_target_activation_failed",
  );
});

test("background screenshot refuses capture when target-tab activation fails", async () => {
  const calls = [];
  const browser = {
    async focusWindow() {
      calls.push("focus");
    },
    async activateTab() {
      calls.push("activate");
      throw new Error("No tab with id: 123");
    },
    async readActiveTab() {
      calls.push("read-active");
      return { id: 999 };
    },
    async captureVisibleTab() {
      calls.push("capture");
      return "data:image/png;base64,wrong-surface";
    },
  };

  const result = await captureTabSurface(browser, { id: 123, windowId: 456 }, { format: "png" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "screenshot_target_activation_failed");
  assert.deepEqual(calls, ["focus", "activate"]);
});

test("background screenshot rejects an active surface that differs from the target", async () => {
  const calls = [];
  const browser = {
    async focusWindow() { calls.push("focus"); },
    async activateTab() { calls.push("activate"); },
    async readActiveTab() {
      calls.push("read-active");
      return { id: 999 };
    },
    async captureVisibleTab() {
      calls.push("capture");
      return "data:image/png;base64,wrong-surface";
    },
  };

  const result = await captureTabSurface(browser, { id: 123, windowId: 456 }, { format: "png" });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "screenshot_target_not_active");
  assert.deepEqual(calls, ["focus", "activate", "read-active"]);
});

test("background screenshot honors the requested paint delay before capture", async () => {
  const calls = [];
  let delayedBy = null;
  const browser = {
    async focusWindow() { calls.push("focus"); },
    async activateTab() { calls.push("activate"); },
    async readActiveTab() {
      calls.push("read-active");
      return { id: 123 };
    },
    async delay(ms) {
      delayedBy = ms;
      calls.push("delay");
    },
    async captureVisibleTab() {
      calls.push("capture");
      return "data:image/png;base64,fresh-surface";
    },
  };

  const result = await captureTabSurface(
    browser,
    { id: 123, windowId: 456 },
    { format: "png", delayMs: 30 },
  );

  assert.equal(result.ok, true);
  assert.equal(delayedBy, 30);
  assert.deepEqual(calls, ["focus", "activate", "read-active", "delay", "capture"]);
  assert.equal(result.surface_identity, "verified_active_tab");
  assert.equal(result.freshness, "unverified");
});
