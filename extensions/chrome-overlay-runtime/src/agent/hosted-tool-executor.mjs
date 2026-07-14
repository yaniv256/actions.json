const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";
const HOSTED_SCREENSHOT_DEFAULTS = {
  format: "jpeg",
  quality: 60,
  max_width: 960,
  max_height: 960,
  max_kilobytes: 180,
  capture_timeout_ms: 10000,
};

function bridgeHttpOrigin(bridgeUrl = DEFAULT_BRIDGE_URL) {
  const url = new URL(bridgeUrl || DEFAULT_BRIDGE_URL);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function loadBridgeUrl(chromeApi) {
  const stored = await chromeApi.storage?.local?.get?.("bridgeUrl");
  return stored?.bridgeUrl || DEFAULT_BRIDGE_URL;
}

function hostedToolArguments(call) {
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  if (call.name !== "browser.screenshot") {
    return args;
  }
  return {
    ...HOSTED_SCREENSHOT_DEFAULTS,
    ...args,
  };
}

async function readJsonResponse(response) {
  let text = "";
  try {
    text = typeof response.text === "function" ? await response.text() : "";
  } catch (error) {
    return {
      __invalidJson: true,
      error: "Unable to read bridge response body.",
      read_error: error.message || String(error),
    };
  }
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      __invalidJson: true,
      error: "Unable to parse bridge response as JSON.",
      parse_error: error.message || String(error),
    };
  }
}

function publicBridgeResponseDetails(body) {
  if (!body?.__invalidJson) {
    return body;
  }
  const details = {
    error: body.error,
  };
  if (body.parse_error) {
    details.parse_error = body.parse_error;
  }
  if (body.read_error) {
    details.read_error = body.read_error;
  }
  return details;
}

export function createChromeHostedToolExecutor({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (!chromeApi?.tabs?.query) {
    throw new Error("createChromeHostedToolExecutor requires chrome.tabs query API");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("createChromeHostedToolExecutor requires fetch");
  }

  return {
    async execute(call) {
      const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        return {
          ok: false,
          call_id: call.call_id,
          error: {
            code: "no_active_tab",
            message: "No active browser tab is available for hosted tool execution.",
          },
        };
      }
      try {
        const bridgeUrl = await loadBridgeUrl(chromeApi);
        const response = await fetchImpl(`${bridgeHttpOrigin(bridgeUrl)}/mcp/tools/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: call.name,
            target_url_contains: tab.url || undefined,
            arguments: hostedToolArguments(call),
          }),
        });
        const body = await readJsonResponse(response);
        if (!response.ok) {
          return {
            ok: false,
            call_id: call.call_id,
            error: {
              code: "bridge_tool_call_failed",
              message: `Bridge returned ${response.status}.`,
              details: publicBridgeResponseDetails(body),
            },
          };
        }
        if (body?.__invalidJson) {
          return {
            ok: false,
            call_id: call.call_id,
            error: {
              code: "bridge_tool_call_failed",
              message: "Bridge response was not valid JSON.",
              details: publicBridgeResponseDetails(body),
            },
          };
        }
        return body;
      } catch (error) {
        return {
          ok: false,
          call_id: call.call_id,
          error: {
            code: "bridge_tool_call_failed",
            message: error.message || String(error),
          },
        };
      }
    },
  };
}

export async function fetchBridgeRealtimeToolCatalog({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchBridgeRealtimeToolCatalog requires fetch");
  }
  const bridgeUrl = await loadBridgeUrl(chromeApi);
  const response = await fetchImpl(`${bridgeHttpOrigin(bridgeUrl)}/mcp/tools/list`);
  const body = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Bridge returned ${response.status} while loading tools.`);
  }
  if (body?.__invalidJson) {
    throw new Error("Bridge returned invalid JSON while loading tools.");
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools
    .filter((tool) => typeof tool?.name === "string" && tool.name)
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || `Execute ${tool.name}.`,
      parameters: tool.input_schema || { type: "object", additionalProperties: false },
    }));
}
