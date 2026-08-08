import assert from "node:assert/strict";
import test from "node:test";

import {
  createChromeHostedToolExecutor,
  fetchBridgeRealtimeToolCatalog,
} from "../src/agent/hosted-tool-executor.mjs";

function createChromeApi({
  activeTab = { id: 42, url: "https://example.test/" },
  bridgeUrl = "ws://127.0.0.1:17345/extension",
  handshakeSecret = "test-handshake-secret",
  sentMessages = [],
} = {}) {
  return {
    tabs: {
      async query(query) {
        assert.deepEqual(query, { active: true, currentWindow: true });
        return activeTab ? [activeTab] : [];
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message });
        callback?.({ ok: true });
      },
    },
    storage: {
      local: {
        async get(key) {
          if (key === "bridgeHandshakeSecret") {
            return handshakeSecret ? { bridgeHandshakeSecret: handshakeSecret } : {};
          }
          assert.equal(key, "bridgeUrl");
          return bridgeUrl ? { bridgeUrl } : {};
        },
      },
    },
    runtime: {
      lastError: null,
    },
  };
}

function createOkFetch(fetchCalls, responseBody) {
  return async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return responseBody;
      },
      async text() {
        return JSON.stringify(responseBody);
      },
    };
  };
}

test("chrome hosted tool executor sends function calls through the configured bridge API", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi();
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      ok: true,
      call_id: "bridge-call-1",
      output: { ok: true, primitive: "page.info" },
    }),
  });

  const result = await executor.execute({
    name: "page.info",
    call_id: "call-1",
    arguments: {},
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:17345/mcp/tools/call");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    name: "page.info",
    target_url_contains: "https://example.test/",
    arguments: {},
  });
  assert.deepEqual(result, {
    ok: true,
    call_id: "bridge-call-1",
    output: { ok: true, primitive: "page.info" },
  });
});

test("chrome hosted tool executor adds compact defaults to screenshot calls", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi();
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      ok: true,
      call_id: "bridge-screenshot-call",
      output: {
        ok: true,
        primitive: "browser.screenshot",
        data_url: "data:image/png;base64,abc123",
        mime_type: "image/png",
      },
    }),
  });

  const result = await executor.execute({
    name: "browser.screenshot",
    call_id: "call-1",
    arguments: {},
  });

  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    name: "browser.screenshot",
    target_url_contains: "https://example.test/",
    arguments: {
      format: "jpeg",
      quality: 60,
      max_width: 960,
      max_height: 960,
      max_kilobytes: 180,
      capture_timeout_ms: 10000,
    },
  });
  assert.deepEqual(result, {
    ok: true,
    call_id: "bridge-screenshot-call",
    output: {
      ok: true,
      primitive: "browser.screenshot",
      data_url: "data:image/png;base64,abc123",
      mime_type: "image/png",
    },
  });
});

test("chrome hosted tool executor preserves explicit screenshot constraints", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi();
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      ok: true,
      call_id: "bridge-screenshot-call",
      output: { ok: true, primitive: "browser.screenshot" },
    }),
  });

  await executor.execute({
    name: "browser.screenshot",
    call_id: "call-1",
    arguments: { format: "png", max_width: 480, max_kilobytes: 80 },
  });

  assert.deepEqual(JSON.parse(fetchCalls[0].options.body).arguments, {
    format: "png",
    quality: 60,
    max_width: 480,
    max_height: 960,
    max_kilobytes: 80,
    capture_timeout_ms: 10000,
  });
});

test("chrome hosted tool executor returns bridge response errors as structured tool errors", async () => {
  const chromeApi = createChromeApi();
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async json() {
        return { error: "multiple extension runtimes connected" };
      },
      async text() {
        return JSON.stringify({ error: "multiple extension runtimes connected" });
      },
    }),
  });

  const result = await executor.execute({
    name: "page.info",
    call_id: "call-1",
    arguments: {},
  });

  assert.deepEqual(result, {
    ok: false,
    call_id: "call-1",
    error: {
      code: "bridge_tool_call_failed",
      message: "Bridge returned 409.",
      details: { error: "multiple extension runtimes connected" },
    },
  });
});

test("chrome hosted tool executor preserves JSON parse failures without reading a consumed body twice", async () => {
  const chromeApi = createChromeApi();
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
      async text() {
        return "<html>bad gateway</html>";
      },
    }),
  });

  const result = await executor.execute({
    name: "page.info",
    call_id: "call-parse-fails",
    arguments: {},
  });

  assert.deepEqual(result, {
    ok: false,
    call_id: "call-parse-fails",
    error: {
      code: "bridge_tool_call_failed",
      message: "Bridge returned 502.",
      details: {
        error: "Unable to parse bridge response as JSON.",
        parse_error: "Unexpected token '<', \"<html>bad \"... is not valid JSON",
      },
    },
  });
});

test("chrome hosted tool executor returns malformed successful bridge responses as structured errors", async () => {
  const chromeApi = createChromeApi();
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
      async text() {
        return "<html>ok but not json</html>";
      },
    }),
  });

  const result = await executor.execute({
    name: "browser.claimed_tabs.list",
    call_id: "call-parse-fails-ok",
    arguments: {},
  });

  assert.deepEqual(result, {
    ok: false,
    call_id: "call-parse-fails-ok",
    error: {
      code: "bridge_tool_call_failed",
      message: "Bridge response was not valid JSON.",
      details: {
        error: "Unable to parse bridge response as JSON.",
        parse_error: "Unexpected token '<', \"<html>ok b\"... is not valid JSON",
      },
    },
  });
});

test("chrome hosted tool executor falls back to the default bridge URL when storage is empty", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi({ bridgeUrl: null });
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      ok: true,
      call_id: "bridge-call-1",
      output: { ok: true },
    }),
  });

  await executor.execute({
    name: "page.info",
    call_id: "call-1",
    arguments: {},
  });

  assert.deepEqual(fetchCalls.map((call) => call.url), ["http://127.0.0.1:17345/mcp/tools/call"]);
});

test("chrome hosted tool executor converts http bridge URLs without changing the origin", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi({ bridgeUrl: "http://localhost:17345" });
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      ok: true,
      call_id: "bridge-call-1",
      output: { ok: true },
    }),
  });

  await executor.execute({
    name: "page.info",
    call_id: "call-1",
    arguments: {},
  });

  assert.deepEqual(fetchCalls.map((call) => call.url), ["http://localhost:17345/mcp/tools/call"]);
});

test("chrome hosted tool executor returns structured errors when no active tab is available", async () => {
  const chromeApi = createChromeApi({ activeTab: null });
  const executor = createChromeHostedToolExecutor({ chromeApi });

  const result = await executor.execute({
    name: "page.info",
    call_id: "call-1",
    arguments: {},
  });

  assert.deepEqual(result, {
    ok: false,
    call_id: "call-1",
    error: {
      code: "no_active_tab",
      message: "No active browser tab is available for hosted tool execution.",
    },
  });
});

// U12b. The bridge gates the legacy HTTP tool routes on the per-installation
// handshake secret. A service-worker `fetch` CAN set headers (unlike the browser
// WebSocket API, which is why the /extension path uses a query string), so these
// callers present it as `Authorization: Bearer <secret>` or they get a 401.

test("hosted tool calls present the bridge handshake secret as a bearer token", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi({ handshakeSecret: "secret-abc123" });
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, { ok: true, call_id: "bridge-call-1", output: {} }),
  });

  await executor.execute({ name: "page.info", call_id: "call-1", arguments: {} });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer secret-abc123");
  // The gate must not have cost the existing content type.
  assert.equal(fetchCalls[0].options.headers["content-type"], "application/json");
});

test("the realtime tool catalog request presents the bridge handshake secret", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi({ handshakeSecret: "secret-catalog-9" });

  const tools = await fetchBridgeRealtimeToolCatalog({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      tools: [{ name: "page.info", description: "Read the page.", input_schema: { type: "object" } }],
    }),
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:17345/mcp/tools/list");
  assert.equal(fetchCalls[0].options.headers.authorization, "Bearer secret-catalog-9");
  assert.deepEqual(tools.map((tool) => tool.name), ["page.info"]);
});

// An unpaired installation still makes the call. The bridge then answers
// `bridge_secret_missing` — a named cause the operator can act on, which beats a
// request the extension silently declined to make and cannot explain.
test("an unpaired installation still calls the bridge rather than refusing locally", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi({ handshakeSecret: null });
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, { ok: true, call_id: "bridge-call-1", output: {} }),
  });

  await executor.execute({ name: "page.info", call_id: "call-1", arguments: {} });

  assert.equal(fetchCalls.length, 1, "the request must be attempted, not skipped");
  assert.equal(
    fetchCalls[0].options.headers.authorization,
    undefined,
    "an empty secret must not be sent as an empty bearer token",
  );
});

test("an unpaired installation still requests the tool catalog", async () => {
  const fetchCalls = [];
  const chromeApi = createChromeApi({ handshakeSecret: null });

  await fetchBridgeRealtimeToolCatalog({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, { tools: [] }),
  });

  assert.equal(fetchCalls.length, 1, "the request must be attempted, not skipped");
  assert.equal(fetchCalls[0].options?.headers?.authorization, undefined);
});

test("deprecated content-runtime bypass is not used for hosted tool execution", async () => {
  const sentMessages = [];
  const fetchCalls = [];
  const chromeApi = createChromeApi({ sentMessages });
  const executor = createChromeHostedToolExecutor({
    chromeApi,
    fetchImpl: createOkFetch(fetchCalls, {
      ok: true,
      call_id: "bridge-call-1",
      output: { ok: true },
    }),
  });

  await executor.execute({
    name: "page.info",
    call_id: "call-1",
    arguments: {},
  });

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(sentMessages, []);
});
