import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

test("background screenshot capture activates the sender tab before captureVisibleTab", async () => {
  const calls = [];
  let messageListener;
  const context = {
    setTimeout,
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: {
          addListener() {},
        },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
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
      tabs: {
        update(tabId, updateInfo, callback) {
          calls.push(["update", tabId, updateInfo]);
          callback();
        },
        captureVisibleTab(windowId, options, callback) {
          calls.push(["captureVisibleTab", windowId, options]);
          callback("data:image/png;base64,abc");
        },
      },
    },
  };

  vm.runInNewContext(
    readFileSync("extensions/chrome-overlay-runtime/src/background.js", "utf8"),
    context
  );

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      { type: "actions-json:capture-visible-tab", format: "png" },
      { tab: { id: 123, windowId: 456 } },
      resolve
    );
    assert.equal(asyncResponse, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["update", 123, { active: true }],
    ["captureVisibleTab", 456, { format: "png" }],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    dataUrl: "data:image/png;base64,abc",
  });
});

test("background claims authorized tabs into an Open Browser Use style session group and reconnects after navigation", async () => {
  const calls = [];
  let messageListener;
  let updatedListener;
  const storage = {};
  const context = {
    console,
    setTimeout,
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.18" };
        },
        onInstalled: {
          addListener() {},
        },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return { [key]: storage[key] };
            }
            return { ...storage };
          },
          async set(value) {
            Object.assign(storage, value);
          },
        },
      },
      scripting: {
        async executeScript(details) {
          calls.push(["executeScript", details]);
        },
      },
      tabGroups: {
        async get(groupId) {
          if (groupId !== 771) {
            throw new Error(`missing group ${groupId}`);
          }
          return { id: groupId };
        },
        async update(groupId, details) {
          calls.push(["tabGroups.update", groupId, details]);
          return { id: groupId };
        },
      },
      tabs: {
        async get(tabId) {
          return {
            id: tabId,
            windowId: 456,
            groupId: -1,
            url: "https://www.amazon.com/gp/video/storefront",
          };
        },
        async group(details) {
          calls.push(["tabs.group", details]);
          return 771;
        },
        async sendMessage(tabId, message) {
          calls.push(["sendMessage", tabId, message]);
        },
        onUpdated: {
          addListener(listener) {
            updatedListener = listener;
          },
        },
        update(tabId, updateInfo, callback) {
          calls.push(["update", tabId, updateInfo]);
          callback();
        },
        captureVisibleTab(windowId, options, callback) {
          calls.push(["captureVisibleTab", windowId, options]);
          callback("data:image/png;base64,abc");
        },
      },
    },
  };

  vm.runInNewContext(
    readFileSync("extensions/chrome-overlay-runtime/src/background.js", "utf8"),
    context
  );

  const authorizeResponse = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:authorize-tab",
        tabId: 321,
        bridgeUrl: "ws://127.0.0.1:17345/extension",
      },
      {},
      resolve
    );
    assert.equal(asyncResponse, true);
  });

  const normalizedAuthorizeResponse = JSON.parse(JSON.stringify(authorizeResponse));
  assert.deepEqual(normalizedAuthorizeResponse, {
    ok: true,
    tabId: 321,
    runtimeKey: "chrome-tab:321",
    authorizationId: authorizeResponse.authorizationId,
    groupId: 771,
  });
  assert.match(authorizeResponse.authorizationId, /^authorization-/);
  assert.equal(typeof updatedListener, "function");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(0, 4))), [
    ["tabs.group", { tabIds: [321] }],
    ["tabGroups.update", 771, { title: "actions.json", color: "blue", collapsed: false }],
    ["executeScript", { target: { tabId: 321 }, files: ["src/content.js"] }],
    [
      "sendMessage",
      321,
      {
        type: "actions-json:connect",
        bridgeUrl: "ws://127.0.0.1:17345/extension",
        runtimeKey: "chrome-tab:321",
        authorizationId: authorizeResponse.authorizationId,
        extensionVersion: "0.1.18",
      },
    ],
  ]);

  calls.length = 0;
  await updatedListener(
    321,
    { status: "complete", url: "https://www.amazon.com/detail/movie" },
    {
      id: 321,
      windowId: 456,
      groupId: 771,
      url: "https://www.amazon.com/detail/movie",
    }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["executeScript", { target: { tabId: 321 }, files: ["src/content.js"] }],
    [
      "sendMessage",
      321,
      {
        type: "actions-json:connect",
        bridgeUrl: "ws://127.0.0.1:17345/extension",
        runtimeKey: "chrome-tab:321",
        authorizationId: authorizeResponse.authorizationId,
        extensionVersion: "0.1.18",
      },
    ],
  ]);
});
