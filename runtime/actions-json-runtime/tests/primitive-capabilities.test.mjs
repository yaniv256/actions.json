import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describePrimitiveCapability } from "../src/primitives/capability-descriptor.mjs";

const dictionaryPath = new URL("../src/primitives/dictionary.v1.json", import.meta.url);

async function loadDictionary() {
  return JSON.parse(await readFile(dictionaryPath, "utf8"));
}

test("extension adapter advertises privileged screenshot support", async () => {
  const capability = describePrimitiveCapability(await loadDictionary(), {
    primitive: "browser.screenshot",
    host: "extension",
  });

  assert.equal(capability.primitive, "browser.screenshot");
  assert.equal(capability.host, "extension");
  assert.equal(capability.support, "supported");
  assert.equal(capability.capability_class, "privileged");
});

test("bookmarklet/embed adapter rejects autonomous screenshot with capability_unavailable", async () => {
  const capability = describePrimitiveCapability(await loadDictionary(), {
    primitive: "browser.screenshot",
    host: "embed",
  });

  assert.equal(capability.support, "unsupported");
  assert.equal(capability.reason, "capability_unavailable");
});

test("keyboard.press reports mixed host capability", async () => {
  const dictionary = await loadDictionary();

  assert.deepEqual(
    describePrimitiveCapability(dictionary, { primitive: "keyboard.press", host: "extension" }),
    {
      primitive: "keyboard.press",
      host: "extension",
      support: "supported",
      reason: null,
      capability_class: "mixed",
      portable: false,
    },
  );
  assert.deepEqual(
    describePrimitiveCapability(dictionary, { primitive: "keyboard.press", host: "embed" }),
    {
      primitive: "keyboard.press",
      host: "embed",
      support: "partial",
      reason: "trusted_key_events_unavailable",
      capability_class: "mixed",
      portable: false,
    },
  );
});

test("bookmarklet transport capability reports page CSP bridge blocking", async () => {
  const capability = describePrimitiveCapability(await loadDictionary(), {
    primitive: "runtime.transport.bridge",
    host: "bookmarklet",
    context: {
      bridgeAllowedByPagePolicy: false,
      transport: "websocket",
      bridgeUrl: "ws://127.0.0.1:17345/extension",
    },
  });

  assert.deepEqual(capability, {
    primitive: "runtime.transport.bridge",
    host: "bookmarklet",
    support: "unsupported",
    reason: "transport_unavailable",
    capability_class: "transport",
    portable: false,
    transport: "websocket",
    bridge_url: "ws://127.0.0.1:17345/extension",
  });
});
