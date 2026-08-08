import { HostedRealtimeSessionManager } from "./agent/realtime-session-manager.mjs";
import { RealtimeWebRtcTransportFactory } from "./agent/realtime-webrtc-transport.mjs";
import { recordAgentMemoryEvent } from "./agent/session-memory-store.mjs";
import { createAmplitudeEnvelopePublisher } from "./agent/amplitude-envelope.mjs";
import {
  AMPLITUDE_BROADCAST_CHANNEL,
  createAmplitudeRuntimeMessage,
} from "./agent/amplitude-runtime-message.mjs";

const TARGET = "actions-json-agent-offscreen";

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function emitStartDiagnostic(message = {}) {
  return chrome.runtime.sendMessage({
    type: "actions-json:agent-start-diagnostic",
    target: "background",
    ...message,
  }).catch((error) => {
    console.warn("Hosted-session diagnostic delivery failed", {
      trace_id: message.trace_id || null,
      phase: message.phase || null,
      error: error?.message || String(error),
    });
  });
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
let activeStartTraceId = null;
const amplitudeBroadcastChannel = typeof globalThis.BroadcastChannel === "function"
  ? new globalThis.BroadcastChannel(AMPLITUDE_BROADCAST_CHANNEL)
  : null;

/**
 * Amplitude envelopes use a named same-extension channel so every visible
 * agent surface receives them. The publisher throttles to ~15Hz internally;
 * a per-frame stream would be needless load on either messaging path.
 *
 * `sendMessage` rejects whenever no receiver is listening (a closed agent surface
 * is the normal case), so every publish swallows its rejection exactly like the
 * session-event and expenditure broadcasts above.
 */
function publishAmplitudeMessage(payload) {
  try {
    amplitudeBroadcastChannel?.postMessage(payload);
  } catch (error) {
    console.warn("[offscreen-agent] amplitude broadcast failed", error);
  }
  chrome.runtime.sendMessage(createAmplitudeRuntimeMessage(payload)).catch(() => {});
}

function createAmplitudePublisher() {
  try {
    return createAmplitudeEnvelopePublisher({ publish: publishAmplitudeMessage });
  } catch (error) {
    console.warn("[offscreen-agent] amplitude publisher unavailable", error);
    return null;
  }
}

const toolNames = (tools = []) =>
  (Array.isArray(tools) ? tools : [])
    .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
    .filter(Boolean);

function getManager() {
  if (!manager) {
    manager = new HostedRealtimeSessionManager({
      storage: storageProxy,
      transportFactory: new RealtimeWebRtcTransportFactory({
        amplitudePublisherFactory: createAmplitudePublisher,
      }),
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
      diagnosticObserver(event) {
        return emitStartDiagnostic({
          ...event,
          trace_id: event?.trace_id || activeStartTraceId,
        });
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
      mode: message.mode === "interrupt" ? "interrupt" : "queue",
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
  const traceId = typeof message?.trace_id === "string" ? message.trace_id : null;
  const startedAt = Date.now();
  activeStartTraceId = traceId;
  emitStartDiagnostic({
    trace_id: traceId,
    phase: "offscreen.listener.received",
    ok: true,
    elapsed_ms: 0,
  });
  handleCommand(message)
    .then(async (response) => {
      await emitStartDiagnostic({
        trace_id: traceId,
        phase: "offscreen.handler.resolved",
        ok: response?.ok === true,
        state_status: response?.state?.status || null,
        elapsed_ms: Date.now() - startedAt,
      });
      sendResponse({
        ...response,
        responder: "offscreen-agent",
        trace_id: traceId,
      });
      activeStartTraceId = null;
    })
    .catch(async (error) => {
      await emitStartDiagnostic({
        trace_id: traceId,
        phase: "offscreen.handler.rejected",
        ok: false,
        error_name: error?.name || null,
        error_message: error?.message || String(error),
        elapsed_ms: Date.now() - startedAt,
      });
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        responder: "offscreen-agent",
        trace_id: traceId,
      });
      activeStartTraceId = null;
    });
  return true;
});
