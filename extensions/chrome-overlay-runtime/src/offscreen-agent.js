import { HostedRealtimeSessionManager } from "./agent/realtime-session-manager.mjs";
import { RealtimeWebRtcTransportFactory } from "./agent/realtime-webrtc-transport.mjs";
import { recordAgentMemoryEvent } from "./agent/session-memory-store.mjs";

const TARGET = "actions-json-agent-offscreen";

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

const storageProxy = {
  async get(key) {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-storage-get",
      target: "background",
      key,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "agent storage get failed");
    }
    return response.value || {};
  },
  async set(values) {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-storage-set",
      target: "background",
      values,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "agent storage set failed");
    }
  },
  async remove(key) {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-storage-remove",
      target: "background",
      key,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "agent storage remove failed");
    }
  },
};

const toolExecutor = {
  async execute(call) {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-tool-execute",
      target: "background",
      call,
    });
    if (!response?.ok) {
      return {
        ok: false,
        call_id: call.call_id,
        error: {
          code: "hosted_tool_proxy_failed",
          message: response?.error || "Hosted tool proxy failed.",
        },
      };
    }
    return response.result;
  },
};

let manager = null;

const toolNames = (tools = []) =>
  (Array.isArray(tools) ? tools : [])
    .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
    .filter(Boolean);

function getManager() {
  if (!manager) {
    manager = new HostedRealtimeSessionManager({
      storage: storageProxy,
      transportFactory: new RealtimeWebRtcTransportFactory(),
      toolExecutor,
      eventObserver(event) {
        chrome.runtime.sendMessage({
          type: "actions-json:agent-session-event",
          event,
          state: manager?.getState?.() || null,
        }).catch(() => {});
      },
      expenditureObserver({ record, meter }) {
        if (record) {
          chrome.runtime.sendMessage({
            type: "actions-json:expenditure-record",
            record,
          }).catch(() => {});
        }
        if (meter) {
          chrome.runtime.sendMessage({
            type: "actions-json:cost-meter-update",
            meter,
          }).catch(() => {});
        }
      },
    });
  }
  return manager;
}

async function handleCommand(message) {
  const session = getManager();
  if (message.type === "actions-json:agent-session-tools") {
    session.setTools(message.tools || []);
    const names = toolNames(message.tools);
    await recordAgentMemoryEvent(storageProxy, {
      type: "tool",
      name: "offscreen.hosted_session.tools",
      ok: true,
      summary: "Offscreen received hosted Realtime tool update.",
      output: {
        message_type: message.type,
        received_tool_count: names.length,
        received_tool_names: names,
        has_actions_site: names.includes("actions.site"),
        has_pointer_click: names.includes("pointer.click"),
        status_after: session.getState().status,
      },
    }).catch(() => {});
    return { ok: true, state: session.getState() };
  }
  if (message.type === "actions-json:agent-session-start") {
    const names = toolNames(message.tools);
    const statusBefore = session.getState().status;
    session.setTools(message.tools || []);
    const current = session.getState();
    await recordAgentMemoryEvent(storageProxy, {
      type: "tool",
      name: "offscreen.hosted_session.start",
      ok: true,
      summary: "Offscreen received hosted Realtime session start.",
      output: {
        message_type: message.type,
        received_tool_count: names.length,
        received_tool_names: names,
        has_actions_site: names.includes("actions.site"),
        has_pointer_click: names.includes("pointer.click"),
        status_before: statusBefore,
        status_after_set_tools: current.status,
      },
    }).catch(() => {});
    if (current.status === "connected" || current.status === "connecting") {
      await recordAgentMemoryEvent(storageProxy, {
        type: "tool",
        name: "offscreen.hosted_session.start_reused",
        ok: true,
        summary: "Offscreen reused an existing hosted Realtime session instead of starting a new one.",
        output: {
          status: current.status,
          received_tool_count: names.length,
          received_tool_names: names,
          has_pointer_click: names.includes("pointer.click"),
        },
      }).catch(() => {});
      return { ok: true, state: current };
    }
    const state = await session.start({ textOnly: message.textOnly !== false });
    await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-event",
      event: {
        type: "actions_json.session.state",
        status: state.status,
      },
      state,
    }).catch(() => {});
    return { ok: true, state };
  }
  if (message.type === "actions-json:agent-session-stop") {
    const state = await session.stop();
    await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-event",
      event: {
        type: "actions_json.session.state",
        status: state.status,
      },
      state,
    }).catch(() => {});
    return { ok: true, state };
  }
  if (message.type === "actions-json:agent-session-mute") {
    const state = await session.setInputMuted(message.muted !== false);
    await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-event",
      event: {
        type: "actions_json.session.state",
        status: state.status,
        inputMuted: state.inputMuted,
      },
      state,
    }).catch(() => {});
    return { ok: true, state };
  }
  if (message.type === "actions-json:agent-session-output-mute") {
    const state = await session.setOutputMuted(message.muted !== false);
    await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-event",
      event: {
        type: "actions_json.session.state",
        status: state.status,
        outputMuted: state.outputMuted,
      },
      state,
    }).catch(() => {});
    return { ok: true, state };
  }
  if (message.type === "actions-json:agent-session-user-message") {
    const result = await session.sendUserMessage({
      text: message.text,
    });
    return { ok: true, result, state: session.getState() };
  }
  if (message.type === "actions-json:agent-session-state") {
    return { ok: true, state: session.getState() };
  }
  return { ok: false, error: `Unsupported offscreen command: ${message.type}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET) {
    return false;
  }
  handleCommand(message)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
