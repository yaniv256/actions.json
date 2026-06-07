import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import {
  listSiteActionsFromBundle,
  resolveSiteActionFromBundle,
  siteBlockedPrimitiveNamesFromBundle,
} from "../extensions/chrome-overlay-runtime/src/agent/local-actions-catalog.mjs";
import {
  buildRealtimeToolCatalog,
  filterRealtimeToolsForBlockedPrimitives,
} from "../extensions/chrome-overlay-runtime/src/agent/realtime-tool-catalog.mjs";

function backgroundScriptForVm() {
  return readFileSync("extensions/chrome-overlay-runtime/src/background.js", "utf8")
    .replace(
      /^import \{\n  listSiteActionsFromBundle,\n  resolveSiteActionFromBundle,\n  siteBlockedPrimitiveNamesFromBundle,\n\} from "\.\/agent\/local-actions-catalog\.mjs";\nimport \{\n  buildRealtimeToolCatalog,\n  filterRealtimeToolsForBlockedPrimitives,\n\} from "\.\/agent\/realtime-tool-catalog\.mjs";\n\n/,
      "",
    );
}

function withBackgroundCatalog(context) {
  return {
    ...context,
    listSiteActionsFromBundle,
    resolveSiteActionFromBundle,
    siteBlockedPrimitiveNamesFromBundle,
    buildRealtimeToolCatalog,
    filterRealtimeToolsForBlockedPrimitives,
  };
}

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

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

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

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

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

  const memory = storage.ACTIONS_JSON_AGENT_MEMORY_V1;
  const navigationEvents = memory.events.filter((event) => event.name === "background.navigation.lifecycle");
  assert.equal(navigationEvents.length, 1);
  assert.deepEqual(
    {
      type: navigationEvents[0].type,
      tab_id: navigationEvents[0].input.tab_id,
      runtime_key: navigationEvents[0].input.runtime_key,
      previous_url: navigationEvents[0].input.previous_url,
      new_url: navigationEvents[0].input.new_url,
      same_origin: navigationEvents[0].input.same_origin,
      same_document: navigationEvents[0].input.same_document,
      content_reconnected: navigationEvents[0].output.content_reconnected,
      catalog_reload_required: navigationEvents[0].output.catalog_reload_required,
    },
    {
      type: "navigation",
      tab_id: 321,
      runtime_key: "chrome-tab:321",
      previous_url: "https://www.amazon.com/gp/video/storefront",
      new_url: "https://www.amazon.com/detail/movie",
      same_origin: true,
      same_document: false,
      content_reconnected: true,
      catalog_reload_required: false,
    }
  );
});

test("background credential messages never return the raw OpenAI key", async () => {
  let messageListener;
  const storage = {};
  const context = {
    console,
    setTimeout,
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.30" };
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const saveResponse = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-save-credential",
        apiKey: "sk-proj-background-secret-value-123456",
      },
      {},
      resolve
    );
    assert.equal(asyncResponse, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(saveResponse)), {
    ok: true,
    credential: {
      configured: true,
      redacted: "sk-proj...3456",
    },
  });
  assert.equal(JSON.stringify(saveResponse).includes("background-secret"), false);

  const stateResponse = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      { type: "actions-json:agent-credential-state" },
      {},
      resolve
    );
    assert.equal(asyncResponse, true);
  });
  assert.equal(JSON.stringify(stateResponse).includes("background-secret"), false);

  const clearResponse = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      { type: "actions-json:agent-clear-credential" },
      {},
      resolve
    );
    assert.equal(asyncResponse, true);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(clearResponse)), {
    ok: true,
    credential: { configured: false, redacted: null },
  });
});

test("background starts hosted agent through an offscreen realtime document", async () => {
  const calls = [];
  let messageListener;
  const storage = {
    bridgeUrl: "ws://127.0.0.1:17345/extension",
  };
  const context = {
    console,
    setTimeout,
    URL,
    async fetch() {
      return {
        ok: true,
        async json() {
          return {
            primitive_dictionary: {
              primitives: [
                {
                  name: "pointer.click",
                  summary: "Click a point.",
                  portable: true,
                  adapters: { extension: { support: "supported" } },
                  input_schema: { type: "object", additionalProperties: false },
                },
              ],
            },
          };
        },
      };
    },
    chrome: {
      offscreen: {
        async createDocument(details) {
          calls.push(["offscreen.createDocument", details]);
        },
      },
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.49" };
        },
        getURL(path) {
          return `chrome-extension://fixture/${path}`;
        },
        async getContexts(query) {
          calls.push(["runtime.getContexts", query]);
          return [];
        },
        async sendMessage(message) {
          calls.push(["runtime.sendMessage", message]);
          return {
            ok: true,
            state: { status: "connected", model: "gpt-realtime-2", error: null },
          };
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-session-start",
        textOnly: false,
        tools: [{ type: "function", name: "actions.site" }],
      },
      {},
      resolve
    );
    assert.equal(asyncResponse, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    state: { status: "connected", model: "gpt-realtime-2", error: null },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      "runtime.getContexts",
      {
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: ["chrome-extension://fixture/offscreen.html"],
      },
    ],
    [
      "offscreen.createDocument",
      {
        url: "offscreen.html",
        reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
        justification: "Keep the actions.json GPT Realtime voice session alive across page navigation.",
      },
    ],
    [
      "runtime.sendMessage",
      {
        type: "actions-json:agent-session-start",
        textOnly: false,
        tools: [
          { type: "function", name: "actions.site" },
          {
            type: "function",
            name: "pointer.click",
            description: "Click a point. Portable action.",
            parameters: { type: "object", additionalProperties: false },
          },
        ],
        target: "actions-json-agent-offscreen",
      },
    ],
  ]);
});

test("background fills hosted agent tools when popup starts voice with an empty tool list", async () => {
  const calls = [];
  let messageListener;
  const storage = {
    bridgeUrl: "ws://127.0.0.1:17345/extension",
  };
  const context = {
    console,
    setTimeout,
    URL,
    async fetch(url) {
      calls.push(["fetch", url]);
      return {
        ok: true,
        async json() {
          return {
            primitive_dictionary: {
              primitives: [
                {
                  name: "pointer.click",
                  summary: "Click a point.",
                  portable: true,
                  adapters: { extension: { support: "supported" } },
                  input_schema: { type: "object", additionalProperties: false },
                },
                {
                  name: "viewport.scroll",
                  summary: "Scroll the viewport.",
                  portable: true,
                  adapters: { extension: { support: "supported" } },
                  input_schema: { type: "object", additionalProperties: false },
                },
              ],
            },
          };
        },
      };
    },
    chrome: {
      offscreen: {
        async createDocument(details) {
          calls.push(["offscreen.createDocument", details]);
        },
      },
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.63" };
        },
        getURL(path) {
          return `chrome-extension://fixture/${path}`;
        },
        async getContexts(query) {
          calls.push(["runtime.getContexts", query]);
          return [];
        },
        async sendMessage(message) {
          calls.push(["runtime.sendMessage", message]);
          return {
            ok: true,
            state: { status: "connected", model: "gpt-realtime-2", error: null },
          };
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://pragmaworks.dev/" }];
        },
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-session-start",
        textOnly: false,
        tools: [],
      },
      {},
      resolve
    );
    assert.equal(asyncResponse, true);
  });

  assert.equal(response.ok, true);
  const forwarded = calls.find(
    (call) => call[0] === "runtime.sendMessage" && call[1].type === "actions-json:agent-session-start",
  )[1];
  assert.equal(forwarded.tools.some((tool) => tool.name === "actions.site"), true);
  assert.equal(forwarded.tools.some((tool) => tool.name === "pointer.click"), true);
  const diagnostic = storage.ACTIONS_JSON_AGENT_MEMORY_V1.events.find(
    (event) => event.type === "tool" && event.name === "background.hosted_session.tools",
  );
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.output.input_tool_count, 0);
  assert.equal(diagnostic.output.forwarded_tool_count, 3);
  assert.deepEqual(diagnostic.output.forwarded_tool_names, [
    "actions.site",
    "pointer.click",
    "viewport.scroll",
  ]);
  assert.equal(diagnostic.output.has_pointer_click, true);
});

test("background merges default primitive tools into caller-provided hosted site tools", async () => {
  const calls = [];
  let messageListener;
  const storage = {
    bridgeUrl: "ws://127.0.0.1:17345/extension",
  };
  const context = {
    console,
    setTimeout,
    URL,
    async fetch(url) {
      calls.push(["fetch", url]);
      return {
        ok: true,
        async json() {
          return {
            primitive_dictionary: {
              primitives: [
                {
                  name: "pointer.click",
                  summary: "Click a point.",
                  portable: true,
                  adapters: { extension: { support: "supported" } },
                  input_schema: { type: "object", additionalProperties: false },
                },
                {
                  name: "viewport.scroll",
                  summary: "Scroll the viewport.",
                  portable: true,
                  adapters: { extension: { support: "supported" } },
                  input_schema: { type: "object", additionalProperties: false },
                },
              ],
            },
          };
        },
      };
    },
    chrome: {
      offscreen: {
        async createDocument(details) {
          calls.push(["offscreen.createDocument", details]);
        },
      },
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.65" };
        },
        getURL(path) {
          return `chrome-extension://fixture/${path}`;
        },
        async getContexts(query) {
          calls.push(["runtime.getContexts", query]);
          return [];
        },
        async sendMessage(message) {
          calls.push(["runtime.sendMessage", message]);
          return {
            ok: true,
            state: { status: "connected", model: "gpt-realtime-2", error: null },
          };
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        async query() {
          return [{ id: 101, url: "https://pragmaworks.dev/" }];
        },
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-session-start",
        textOnly: false,
        tools: [{ type: "function", name: "actions.site" }],
      },
      {},
      resolve,
    );
    assert.equal(asyncResponse, true);
  });

  assert.equal(response.ok, true);
  const forwarded = calls.find(
    (call) => call[0] === "runtime.sendMessage" && call[1].type === "actions-json:agent-session-start",
  )[1];
  assert.deepEqual(JSON.parse(JSON.stringify(forwarded.tools.map((tool) => tool.name))), [
    "actions.site",
    "pointer.click",
    "viewport.scroll",
  ]);
  const diagnostic = storage.ACTIONS_JSON_AGENT_MEMORY_V1.events.find(
    (event) => event.type === "tool" && event.name === "background.hosted_session.tools",
  );
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.output.source, "caller_provided_plus_extension_default_catalog");
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.output.input_tool_names)), ["actions.site"]);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.output.forwarded_tool_names)), [
    "actions.site",
    "pointer.click",
    "viewport.scroll",
  ]);
  assert.equal(diagnostic.output.has_pointer_click, true);
});

test("background serves hosted actions.site from uploaded extension storage without bridge fetch", async () => {
  let messageListener;
  const storage = {
    actionsJsonStorageBundle: {
      protocol: "actions.json.storage.bundle",
      entries: [
        {
          path: "scopes/shared/pragmaworks/sites/pragmaworks.dev/home/actions.json",
          content: JSON.stringify({
            protocol: "actions.json",
            tools: [
              {
                name: "pragmaworks.site.map",
                description: "Return the PragmaWorks site map.",
                input_schema: { type: "object", additionalProperties: false },
                x_actions: {
                  static_output: { ok: true, site: "pragmaworks.dev" },
                },
              },
            ],
          }),
        },
      ],
    },
    bridgeUrl: "ws://100.99.150.49:17345/extension",
  };
  const context = {
    console,
    setTimeout,
    URL,
    async fetch() {
      throw new Error("bridge fetch should not be used for actions.site list");
    },
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.60" };
        },
        getURL(path) {
          return `chrome-extension://fixture/${path}`;
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        async query(query) {
          assert.deepEqual(JSON.parse(JSON.stringify(query)), { active: true, currentWindow: true });
          return [{ id: 190778180, url: "https://pragmaworks.dev/" }];
        },
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-tool-execute",
        target: "background",
        call: {
          name: "actions.site",
          call_id: "call-actions-site",
          arguments: { mode: "list" },
        },
      },
      {},
      resolve,
    );
    assert.equal(asyncResponse, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    result: {
      ok: true,
      call_id: "call-actions-site",
      output: {
        ok: true,
        target_url_contains: "https://pragmaworks.dev/",
        actions: [
          {
            name: "pragmaworks.site.map",
            description: "Return the PragmaWorks site map.",
            input_schema: { type: "object", additionalProperties: false },
            target_url_contains: null,
          },
        ],
      },
      error: null,
    },
  });
});

test("background records hosted tool routing decisions in the session log", async () => {
  let messageListener;
  const storage = { bridgeUrl: "ws://127.0.0.1:17345/extension" };
  const context = {
    console,
    setTimeout,
    URL,
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.69" };
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        async query(query) {
          assert.deepEqual(JSON.parse(JSON.stringify(query)), { active: true, currentWindow: true });
          return [{ id: 190778180, url: "https://pragmaworks.dev/#research" }];
        },
        async sendMessage() {
          throw new Error("content runtime absent");
        },
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
    async fetch(url) {
      assert.equal(String(url), "http://127.0.0.1:17345/mcp/tools/call");
      return {
        ok: false,
        status: 404,
        async json() {
          return {
            error: "no runtime URL matched target_url_contains",
            target_url_contains: "https://genspec.dev/",
            runtimes: [{ runtime_id: "runtime-a", url: "https://pragmaworks.dev/#research" }],
          };
        },
        async text() {
          return "";
        },
      };
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-tool-execute",
        target: "background",
        call: {
          name: "browser.screenshot",
          call_id: "call-screenshot",
          arguments: { target_url_contains: "https://genspec.dev/" },
        },
      },
      {},
      resolve,
    );
    assert.equal(asyncResponse, true);
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.ok, false);
  const routingEvents = storage.ACTIONS_JSON_AGENT_MEMORY_V1.events.filter(
    (event) => event.name === "background.hosted_tool.routing",
  );
  assert.equal(routingEvents.length, 1);
  assert.deepEqual(
    {
      type: routingEvents[0].type,
      tool: routingEvents[0].input.tool,
      call_id: routingEvents[0].input.call_id,
      active_tab_url: routingEvents[0].input.active_tab_url,
      requested_target_url_contains: routingEvents[0].input.requested_target_url_contains,
      route: routingEvents[0].output.route,
      ok: routingEvents[0].output.ok,
      bridge_status: routingEvents[0].output.bridge_status,
      error_code: routingEvents[0].output.error_code,
    },
    {
      type: "routing",
      tool: "browser.screenshot",
      call_id: "call-screenshot",
      active_tab_url: "https://pragmaworks.dev/#research",
      requested_target_url_contains: "https://genspec.dev/",
      route: "bridge",
      ok: false,
      bridge_status: 404,
      error_code: "bridge_tool_call_failed",
    },
  );
});

test("background returns structured local hosted primitive failures without bridge fallback", async () => {
  let messageListener;
  let fetchCalled = false;
  const storage = { bridgeUrl: "ws://127.0.0.1:17345/extension" };
  const context = {
    console,
    setTimeout,
    URL,
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.73" };
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
          async remove(key) {
            delete storage[key];
          },
        },
      },
      tabs: {
        async query(query) {
          assert.deepEqual(JSON.parse(JSON.stringify(query)), { active: true, currentWindow: true });
          return [{ id: 190778180, url: "https://pragmaworks.dev/greenfield" }];
        },
        async sendMessage(_tabId, message) {
          assert.equal(message.name, "dom.observe.visible");
          return {
            ok: false,
            error: {
              code: "handler_failed",
              message: "DOM handler failed in content runtime",
            },
          };
        },
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
    async fetch() {
      fetchCalled = true;
      throw new Error("fetch should not be called after a structured local primitive failure");
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener(
      {
        type: "actions-json:agent-tool-execute",
        target: "background",
        call: {
          name: "dom.observe.visible",
          call_id: "call-dom-observe",
          arguments: { text_contains: "Step 02" },
        },
      },
      {},
      resolve,
    );
    assert.equal(asyncResponse, true);
  });

  assert.equal(fetchCalled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result)), {
    ok: false,
    call_id: "call-dom-observe",
    error: {
      code: "handler_failed",
      message: "DOM handler failed in content runtime",
    },
  });
  const routingEvents = storage.ACTIONS_JSON_AGENT_MEMORY_V1.events.filter(
    (event) => event.name === "background.hosted_tool.routing",
  );
  assert.equal(routingEvents.length, 1);
  assert.equal(routingEvents[0].output.route, "extension_local");
  assert.equal(routingEvents[0].output.ok, false);
  assert.equal(routingEvents[0].output.error_code, "handler_failed");
});

test("background reports hosted agent state without creating an offscreen document", async () => {
  const calls = [];
  let messageListener;
  const context = {
    console,
    setTimeout,
    URL,
    fetch,
    chrome: {
      offscreen: {
        async createDocument(details) {
          calls.push(["offscreen.createDocument", details]);
        },
      },
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.53" };
        },
        getURL(path) {
          return `chrome-extension://fixture/${path}`;
        },
        async getContexts(query) {
          calls.push(["runtime.getContexts", query]);
          return [];
        },
        async sendMessage(message) {
          calls.push(["runtime.sendMessage", message]);
          return { ok: true, state: { status: "connected", model: "gpt-realtime-2", error: null } };
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
          async get() {
            return {};
          },
          async set() {},
          async remove() {},
        },
      },
      tabs: {
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener({ type: "actions-json:agent-session-state" }, {}, resolve);
    assert.equal(asyncResponse, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    state: { status: "disconnected", model: "gpt-realtime-2", error: null, inputMuted: false },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      "runtime.getContexts",
      {
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: ["chrome-extension://fixture/offscreen.html"],
      },
    ],
  ]);
});

test("background closes a durable hosted agent offscreen session without requiring an overlay", async () => {
  const calls = [];
  let messageListener;
  const context = {
    console,
    setTimeout,
    URL,
    fetch,
    chrome: {
      offscreen: {
        async createDocument(details) {
          calls.push(["offscreen.createDocument", details]);
        },
        async closeDocument() {
          calls.push(["offscreen.closeDocument"]);
        },
      },
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "0.1.53" };
        },
        getURL(path) {
          return `chrome-extension://fixture/${path}`;
        },
        async getContexts(query) {
          calls.push(["runtime.getContexts", query]);
          return [{ documentUrl: "chrome-extension://fixture/offscreen.html" }];
        },
        async sendMessage(message) {
          calls.push(["runtime.sendMessage", message]);
          return {
            ok: true,
            state: { status: "stopped", model: "gpt-realtime-2", error: null, inputMuted: false },
          };
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
          async get() {
            return {};
          },
          async set() {},
          async remove() {},
        },
      },
      tabs: {
        onUpdated: {
          addListener() {},
        },
        onRemoved: {
          addListener() {},
        },
      },
    },
  };

  vm.runInNewContext(backgroundScriptForVm(), withBackgroundCatalog(context));

  const response = await new Promise((resolve) => {
    const asyncResponse = messageListener({ type: "actions-json:agent-session-close" }, {}, resolve);
    assert.equal(asyncResponse, true);
  });

  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    closed: true,
    state: { status: "stopped", model: "gpt-realtime-2", error: null, inputMuted: false },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      "runtime.getContexts",
      {
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: ["chrome-extension://fixture/offscreen.html"],
      },
    ],
    [
      "runtime.sendMessage",
      {
        type: "actions-json:agent-session-stop",
        target: "actions-json-agent-offscreen",
      },
    ],
    ["offscreen.closeDocument"],
  ]);
});
