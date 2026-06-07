import {
  getOpenAiCredentialState,
  loadOpenAiApiKey,
} from "./credential-store.mjs";
import {
  loadReturningSessionContext,
  recordAgentMemoryEvent,
} from "./session-memory-store.mjs";
import {
  getRealtimeTurnDetectionSettings,
  getRealtimeVoice,
  realtimeTurnDetectionConfig,
} from "./voice-settings-store.mjs";

const DEFAULT_MODEL = "gpt-realtime-2";
const MAX_REALTIME_IMAGE_DATA_URL_CHARS = 512_000;

const DEFAULT_INSTRUCTIONS = [
  "You are an actions.json hosted browser agent running inside the user's browser.",
  "Act like a curious, useful website host: ask what brought the visitor here, listen for their friction and pain points, and use the current website to help solve an actual problem they have.",
  "When tools are declared, you can inspect and operate the active browser page through them.",
  "Use actions.site to discover and run current-site actions. At the start of a session, when the user asks you to orient to a site, or when navigation changes to a new site, call actions.site/actions_site with mode=list before relying on generic screenshots or DOM extraction.",
  "After listing site actions, look for a current-site map, context, diagnostic, guide, product, teacher, or host action. Call the best matching action before the first substantive answer, then adopt any returned site role, teaching mission, host guidance, interview flow, or operating boundaries unless they conflict with higher-priority instructions.",
  "Use browser.screenshot to see the visible page after the site map is loaded, or when visual layout matters.",
  "Realtime function names may replace dots with underscores. If the catalog exposes actions_site and pointer_click, use actions_site to call a *_info action that returns locator geometry, then call pointer_click with the returned clickable_center x and y.",
  "For navigation, prefer human-like point actions. Do not say pointer or click tools are unavailable unless pointer.click/pointer_click itself is absent from the tool catalog or a pointer.click/pointer_click call failed.",
  "Be proactive: if the user discusses a topic, page, section, resource, comparison, or workflow that has a relevant website action or navigation target, navigate, scroll, inspect, or run that action before answering. Do not wait for the user to ask for navigation.",
  "Operate quietly while using tools. Do not narrate internal thinking, tool selection, or step-by-step navigation plans. Avoid phrases like let me check, I will navigate, I will open, I am going to use, or I need to inspect. Execute the best available action first, then briefly explain the visible result or what changed.",
  "When a visual comparison, summary, checklist, or teaching aid would make the answer clearer, create or update an overlay without waiting for the user to request one.",
  "If the user explicitly asks for an overlay and the catalog exposes overlay_open or overlay.open, call that tool with an HTML summary. Do not say you cannot directly open an overlay unless the overlay tool is absent or an overlay tool call fails.",
  "Use overlays deliberately when they improve comprehension, comparison, next steps, or demonstration value; do not spam overlays for simple answers.",
  "Do not tell the user you cannot see the screen or cannot use tools unless browser.screenshot, actions.site, or the requested tool has failed.",
  "Prefer portable actions.json operations over debugger fallback.",
  "If a tool action takes noticeable time, give at most one short status phrase without exposing internal reasoning.",
  "For voice, speak in short consecutive chunks. Prefer one compact idea, then pause for the user to respond or continue.",
  "Avoid long monologues. If the topic is large, offer to continue rather than trying to deliver the full answer in one turn.",
  "If the user interrupts you, assume they may not have heard the rest of your previous turn. Continue from the last clearly delivered point instead of skipping ahead.",
].join(" ");

const defaultToolExecutor = {
  async execute(call) {
    return {
      ok: false,
      error: {
        code: "tool_executor_unavailable",
        message: `No hosted tool executor configured for ${call.name}.`,
      },
    };
  },
};

function responseOutputItems(event) {
  return Array.isArray(event?.response?.output) ? event.response.output : [];
}

function parseFunctionArguments(value) {
  if (value && typeof value === "object") {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  return JSON.parse(value);
}

function safeRealtimeToolName(name, usedNames = new Set()) {
  const raw = String(name || "").trim();
  let safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 64);
  if (!safe || !/^[A-Za-z0-9_-]+$/.test(safe)) {
    safe = "tool";
  }
  if (usedNames.has(safe) && safe !== raw) {
    const suffixSource = Array.from(raw).reduce((acc, char) => (acc + char.charCodeAt(0)) % 100000, 0);
    const suffix = `_${suffixSource.toString(36)}`;
    safe = `${safe.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }
  usedNames.add(safe);
  return safe;
}

function normalizeRealtimeTools(tools = []) {
  const usedNames = new Set();
  const nameMap = new Map();
  const normalized = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const originalName = String(tool.name || "").trim();
    if (!originalName) {
      continue;
    }
    const safeName = safeRealtimeToolName(originalName, usedNames);
    nameMap.set(safeName, originalName);
    normalized.push({
      ...tool,
      name: safeName,
    });
  }
  return { tools: normalized, nameMap };
}

function toolSchemaFingerprint(tool) {
  const parameters = tool?.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
  const properties = parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  return {
    name: tool?.name || null,
    required: Array.isArray(parameters.required) ? parameters.required : [],
    properties: Object.keys(properties),
  };
}

function realtimeContentPartsText(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => part?.transcript || part?.text || "")
    .filter(Boolean)
    .join("")
    .trim();
}

function realtimeFinalText(event) {
  for (const value of [event?.transcript, event?.text]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const partText = realtimeContentPartsText(event?.part ? [event.part] : null);
  if (partText) {
    return partText;
  }
  const itemText = realtimeContentPartsText(event?.item?.content);
  if (itemText) {
    return itemText;
  }
  return "";
}

function extractScreenshotPayload(result) {
  const output = result?.output;
  const dataUrl = output?.data_url;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return null;
  }
  const dataUrlChars = dataUrl.length;
  if (dataUrlChars > MAX_REALTIME_IMAGE_DATA_URL_CHARS) {
    return {
      dataUrl: null,
      metadata: {
        delivered_as: "omitted_oversize",
        mime_type: output.mime_type || null,
        image_bytes: output.image_bytes || null,
        data_url_chars: dataUrlChars,
      },
    };
  }
  return {
    dataUrl,
    metadata: {
      delivered_as: "input_image",
      mime_type: output.mime_type || null,
      image_bytes: output.image_bytes || null,
    },
  };
}

const REALTIME_DIAGNOSTIC_EVENT_TYPES = new Set([
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.timeout_triggered",
  "response.created",
  "response.done",
  "response.cancelled",
  "response.output_item.added",
  "response.output_item.done",
  "response.audio_transcript.done",
  "response.output_audio_transcript.done",
  "conversation.item.truncated",
]);

function audioTranscriptKey(event = {}) {
  const response = event.response && typeof event.response === "object" ? event.response : null;
  return [
    event.response_id || response?.id || "unknown-response",
    event.item_id || event.item?.id || "unknown-item",
    Number.isFinite(event.output_index) ? event.output_index : "unknown-output",
    Number.isFinite(event.content_index) ? event.content_index : "unknown-content",
  ].join(":");
}

function normalizeDiagnosticTranscript(value, maxLength = 1200) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function realtimeDiagnosticPayload(event = {}, generatedTranscript = null) {
  const response = event.response && typeof event.response === "object" ? event.response : null;
  const item = event.item && typeof event.item === "object" ? event.item : null;
  return {
    response_id: event.response_id || response?.id || null,
    item_id: event.item_id || item?.id || null,
    item_type: item?.type || null,
    output_index: Number.isFinite(event.output_index) ? event.output_index : null,
    content_index: Number.isFinite(event.content_index) ? event.content_index : null,
    audio_ms: Number.isFinite(event.audio_start_ms)
      ? event.audio_start_ms
      : Number.isFinite(event.audio_end_ms)
        ? event.audio_end_ms
        : null,
    delta: typeof event.delta === "string" && event.delta.trim() ? event.delta : null,
    generated_transcript: normalizeDiagnosticTranscript(generatedTranscript),
    transcript: realtimeFinalText(event) || null,
    status: event.status || response?.status || null,
  };
}

function generatedTranscriptForEvent(buffers, event = {}) {
  const direct = buffers.get(audioTranscriptKey(event));
  if (direct) {
    return direct;
  }
  const responseId = event.response_id || event.response?.id || null;
  if (responseId) {
    const byResponse = Array.from(buffers.entries())
      .filter(([bufferKey]) => bufferKey.startsWith(`${responseId}:`))
      .map(([, text]) => text)
      .join("");
    if (byResponse) {
      return byResponse;
    }
  }
  const itemId = event.item_id || event.item?.id || null;
  if (itemId) {
    const byItem = Array.from(buffers.entries())
      .filter(([bufferKey]) => bufferKey.includes(`:${itemId}:`))
      .map(([, text]) => text)
      .join("");
    if (byItem) {
      return byItem;
    }
  }
  return null;
}

function modelSafeToolResult(call, result) {
  if (call.name !== "browser.screenshot") {
    return result;
  }
  const screenshot = extractScreenshotPayload(result);
  if (!screenshot) {
    return result;
  }
  const output = { ...(result.output || {}) };
  delete output.data_url;
  output.image = screenshot.metadata;
  return {
    ...result,
    output,
  };
}

export class HostedRealtimeSessionManager {
  constructor({
    storage,
    transportFactory,
    model = DEFAULT_MODEL,
    instructions = DEFAULT_INSTRUCTIONS,
    tools = [],
    toolExecutor = defaultToolExecutor,
    eventObserver = null,
  }) {
    if (!storage) {
      throw new Error("HostedRealtimeSessionManager requires storage");
    }
    if (!transportFactory || typeof transportFactory.create !== "function") {
      throw new Error("HostedRealtimeSessionManager requires a transport factory");
    }
    this.storage = storage;
    this.transportFactory = transportFactory;
    this.model = model;
    this.instructions = instructions;
    this.tools = Array.isArray(tools) ? tools : [];
    this.realtimeToolNameMap = new Map();
    this.audioTranscriptBuffers = new Map();
    this.toolExecutor = toolExecutor;
    this.eventObserver = typeof eventObserver === "function" ? eventObserver : null;
    this.processedFunctionCallIds = new Set();
    this.transport = null;
    this.state = {
      status: "disconnected",
      model: this.model,
      error: null,
      inputMuted: false,
    };
  }

  getState() {
    return { ...this.state };
  }

  setTools(tools = []) {
    this.tools = Array.isArray(tools) ? tools : [];
    return this.tools;
  }

  async getPublicState() {
    return {
      ...this.getState(),
      credential: await getOpenAiCredentialState(this.storage),
    };
  }

  async refreshState() {
    return this.getState();
  }

  async start({ textOnly = true } = {}) {
    try {
      const apiKey = await loadOpenAiApiKey(this.storage);
      const voice = await getRealtimeVoice(this.storage);
      const turnDetectionSettings = await getRealtimeTurnDetectionSettings(this.storage);
      const turnDetection = realtimeTurnDetectionConfig(turnDetectionSettings);
      this.state = {
        status: "connecting",
        model: this.model,
        error: null,
        inputMuted: false,
      };

      const transport = this.transportFactory.create({
        apiKey,
        model: this.model,
        textOnly,
      });
      this.transport = transport;
      transport.onEvent = async (event) => {
        try {
          await this.eventObserver?.(event);
          await this.handleRealtimeEvent(event);
        } catch (error) {
          await recordAgentMemoryEvent(this.storage, {
            type: "error",
            code: "realtime_event_handler_failed",
            message: error.message || String(error),
          }).catch(() => {});
          this.state = {
            status: "error",
            model: this.model,
            error: error.message || String(error),
          };
        }
      };
      await transport.connect();
      const returningContext = await loadReturningSessionContext(this.storage);
      if (returningContext) {
        await transport.sendEvent(returningContext);
      }
      const rawToolNames = this.tools
        .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
        .filter(Boolean);
      const realtimeTools = this.realtimeTools();
      const realtimeToolNames = realtimeTools
        .map((tool) => (typeof tool?.name === "string" ? tool.name : null))
        .filter(Boolean);
      await recordAgentMemoryEvent(this.storage, {
        type: "tool",
        name: "realtime.session.update.tools",
        ok: true,
        summary: "Hosted Realtime session.update tool catalog prepared.",
        output: {
          raw_tool_count: rawToolNames.length,
          raw_tool_names: rawToolNames,
          realtime_tool_count: realtimeToolNames.length,
          realtime_tool_names: realtimeToolNames,
          schema_fingerprints: realtimeTools.map(toolSchemaFingerprint),
          has_actions_site: realtimeToolNames.includes("actions_site"),
          has_pointer_click: realtimeToolNames.includes("pointer_click"),
        },
      }).catch(() => {});
      await recordAgentMemoryEvent(this.storage, {
        type: "realtime",
        name: "realtime.session.audio_config",
        ok: true,
        summary: "Hosted Realtime audio configuration prepared.",
        output: {
          text_only: textOnly,
          voice,
          turn_detection: textOnly ? null : turnDetection,
        },
      }).catch(() => {});
      await transport.sendEvent({
        type: "session.update",
        session: {
          type: "realtime",
          model: this.model,
          output_modalities: textOnly ? ["text"] : ["audio"],
          instructions: this.instructions,
          tool_choice: "auto",
          tools: realtimeTools,
          reasoning: { effort: "low" },
          ...(textOnly
            ? {}
            : {
                audio: {
                  input: {
                    transcription: { model: "gpt-4o-mini-transcribe" },
                    turn_detection: turnDetection,
                  },
                  output: { voice },
                },
              }),
        },
      });
      await transport.sendEvent({
        type: "response.create",
        response: {
          instructions: this.initialResponseInstructions(),
        },
      });

      this.state = {
        status: "connected",
        model: this.model,
        error: null,
        inputMuted: false,
      };
      await recordAgentMemoryEvent(this.storage, {
        type: "session",
        summary: `Started ${this.model} session in ${textOnly ? "text" : "audio"} mode.`,
      });
      return this.getState();
    } catch (error) {
      if (this.transport && typeof this.transport.close === "function") {
        await this.transport.close().catch(() => {});
      }
      this.transport = null;
      this.state = {
        status: "error",
        model: this.model,
        error: error.message || String(error),
        inputMuted: false,
      };
      await recordAgentMemoryEvent(this.storage, {
        type: "error",
        code: "session_start_failed",
        message: error.message || String(error),
      }).catch(() => {});
      throw error;
    }
  }

  async stop() {
    if (this.transport && typeof this.transport.close === "function") {
      await this.transport.close();
    }
    this.transport = null;
    this.state = {
      status: "stopped",
      model: this.model,
      error: null,
      inputMuted: false,
    };
    await recordAgentMemoryEvent(this.storage, {
      type: "session",
      summary: `Stopped ${this.model} session.`,
    });
    return this.getState();
  }

  async setInputMuted(muted = true) {
    if (!this.transport) {
      throw new Error("Cannot mute before a Realtime session starts");
    }
    if (typeof this.transport.setInputMuted !== "function") {
      throw new Error("Realtime transport does not support microphone mute control");
    }
    const inputMuted = Boolean(muted);
    await this.transport.setInputMuted(inputMuted);
    this.state = {
      ...this.state,
      inputMuted,
    };
    await recordAgentMemoryEvent(this.storage, {
      type: "session",
      summary: `${this.model} microphone ${inputMuted ? "muted" : "unmuted"}.`,
    });
    return this.getState();
  }

  async handleRealtimeEvent(event) {
    const finalText = realtimeFinalText(event);
    if (event?.type === "response.audio_transcript.delta" || event?.type === "response.output_audio_transcript.delta") {
      const key = audioTranscriptKey(event);
      const previous = this.audioTranscriptBuffers.get(key) || "";
      this.audioTranscriptBuffers.set(key, `${previous}${event.delta || ""}`);
    }
    if (REALTIME_DIAGNOSTIC_EVENT_TYPES.has(event?.type)) {
      const generatedTranscript = generatedTranscriptForEvent(this.audioTranscriptBuffers, event);
      await recordAgentMemoryEvent(this.storage, {
        type: "realtime",
        name: event.type,
        ok: true,
        summary: `Realtime event ${event.type}.`,
        output: realtimeDiagnosticPayload(event, generatedTranscript),
      }).catch(() => {});
      if (
        event?.type === "response.audio_transcript.done" ||
        event?.type === "response.output_audio_transcript.done" ||
        event?.type === "response.done"
      ) {
        const responseId = event.response_id || event.response?.id || null;
        if (responseId) {
          for (const bufferKey of this.audioTranscriptBuffers.keys()) {
            if (bufferKey.startsWith(`${responseId}:`)) {
              this.audioTranscriptBuffers.delete(bufferKey);
            }
          }
        }
      }
    }
    if (event?.type === "error") {
      await recordAgentMemoryEvent(this.storage, {
        type: "error",
        code: event.error?.code || event.code || "realtime_error",
        message: event.error?.message || event.message || JSON.stringify(event.error || event),
      });
      return { handled: true, toolCalls: 0 };
    }
    if (event?.type === "conversation.item.input_audio_transcription.completed" && finalText) {
      await recordAgentMemoryEvent(this.storage, {
        type: "transcript",
        role: "user",
        text: finalText,
      });
      return { handled: true, toolCalls: 0 };
    }
    if (
      (event?.type === "response.audio_transcript.done" ||
        event?.type === "response.output_audio_transcript.done" ||
        event?.type === "response.output_text.done" ||
        event?.type === "response.text.done") &&
      finalText
    ) {
      await recordAgentMemoryEvent(this.storage, {
        type: "transcript",
        role: "assistant",
        text: finalText,
      });
      return { handled: true, toolCalls: 0 };
    }
    if (event?.type !== "response.done") {
      return { handled: false, toolCalls: 0 };
    }
    if (!this.transport) {
      throw new Error("Cannot handle Realtime tool calls before a session starts");
    }

    const calls = responseOutputItems(event).filter((item) => item?.type === "function_call");
    const pendingCalls = calls.filter((call) => {
      if (!call.call_id || this.processedFunctionCallIds.has(call.call_id)) {
        return false;
      }
      this.processedFunctionCallIds.add(call.call_id);
      return true;
    });
    if (pendingCalls.length === 0) {
      return { handled: true, toolCalls: 0 };
    }

    for (const call of pendingCalls) {
      let result;
      let parsedArguments = {};
      const bridgeToolName = this.realtimeToolNameMap.get(call.name) || call.name;
      await this.eventObserver?.({
        type: "actions_json.tool.started",
        name: bridgeToolName,
        call_id: call.call_id,
      });
      try {
        parsedArguments = parseFunctionArguments(call.arguments);
        result = await this.toolExecutor.execute({
          name: bridgeToolName,
          call_id: call.call_id,
          arguments: parsedArguments,
        });
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: "tool_execution_failed",
            message: error.message || String(error),
          },
        };
      }
      await this.eventObserver?.({
        type: "actions_json.tool.completed",
        name: bridgeToolName,
        call_id: call.call_id,
        ok: result?.ok !== false,
        error: result?.error || null,
      });
      const bridgeCall = { ...call, name: bridgeToolName };
      const modelResult = modelSafeToolResult(bridgeCall, result);
      await this.transport.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(modelResult),
        },
      });
      const screenshot = extractScreenshotPayload(result);
      if (screenshot?.dataUrl) {
        await this.transport.sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Screenshot captured for ${bridgeToolName} call ${call.call_id}.`,
              },
              {
                type: "input_image",
                image_url: screenshot.dataUrl,
              },
            ],
          },
        });
      }
      await recordAgentMemoryEvent(this.storage, {
        type: "tool",
        name: bridgeToolName,
        ok: result?.ok !== false,
        summary: `${bridgeToolName} ${result?.ok === false ? "failed" : "completed"}${
          result?.error?.message ? `: ${result.error.message}` : ""
        }.`,
        input: {
          call_id: call.call_id,
          arguments: parsedArguments,
        },
        output: result?.output || result,
      });
    }
    await this.transport.sendEvent({ type: "response.create" });
    return { handled: true, toolCalls: pendingCalls.length };
  }

  realtimeTools() {
    const normalized = normalizeRealtimeTools(this.tools);
    this.realtimeToolNameMap = normalized.nameMap;
    return normalized.tools;
  }

  initialResponseInstructions() {
    if (this.tools.length === 0) {
      return "Greet the user briefly as a curious website host. Ask what brought them here or what friction or pain point they are trying to solve, and offer a quick intro to what the website is about or help navigating it.";
    }
    return "Before greeting, call actions_site with mode=list when available. If the current site exposes a site.map, context, diagnostic, teacher, host, guide, product, or interview action, call that action and adopt the returned role. Then greet the user briefly in that site-specific role, ask what brought them here or what friction they are trying to solve, and offer a quick intro, navigation to a specific section, a short lesson, or a visual overlay when that would make the answer easier to understand.";
  }
}
