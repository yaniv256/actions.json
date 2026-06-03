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
