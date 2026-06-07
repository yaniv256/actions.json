import assert from "node:assert/strict";
import test from "node:test";

import { saveOpenAiApiKey } from "../src/agent/credential-store.mjs";
import { HostedRealtimeSessionManager } from "../src/agent/realtime-session-manager.mjs";
import {
  getAgentSessionLog,
  recordAgentMemoryEvent,
} from "../src/agent/session-memory-store.mjs";
import { saveRealtimeVoice } from "../src/agent/voice-settings-store.mjs";
import { saveRealtimeTurnDetectionSettings } from "../src/agent/voice-settings-store.mjs";

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (typeof key === "string") {
        return { [key]: data[key] };
      }
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

function createFakeTransportFactory() {
  const calls = [];
  const transports = [];
  return {
    calls,
    transports,
    create(options) {
      calls.push(["create", options]);
      const transport = {
        connected: false,
        closed: false,
        events: [],
        async connect() {
          this.connected = true;
          calls.push(["connect"]);
        },
        async sendEvent(event) {
          this.events.push(event);
          calls.push(["sendEvent", event]);
        },
        async close() {
          this.closed = true;
          calls.push(["close"]);
        },
      };
      transports.push(transport);
      return transport;
    },
  };
}

test("hosted realtime session fails closed when no OpenAI key is configured", async () => {
  const storage = createStorage();
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await assert.rejects(() => manager.start(), /OpenAI API key is required/);

  assert.deepEqual(transportFactory.calls, []);
  assert.deepEqual(manager.getState(), {
    status: "error",
    model: "gpt-realtime-2",
    error: "OpenAI API key is required",
    inputMuted: false,
  });
});

test("hosted realtime session starts gpt-realtime-2 with a fake transport and redacted public state", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  const state = await manager.start({ textOnly: true });

  assert.deepEqual(state, {
    status: "connected",
    model: "gpt-realtime-2",
    error: null,
    inputMuted: false,
  });
  assert.equal(transportFactory.calls[0][0], "create");
  assert.equal(transportFactory.calls[0][1].model, "gpt-realtime-2");
  assert.equal(transportFactory.calls[0][1].apiKey, "sk-proj-session-secret-value-123456");
  const publicState = await manager.getPublicState();
  assert.equal(JSON.stringify(publicState).includes("session-secret"), false);
  assert.deepEqual(publicState, {
    status: "connected",
    model: "gpt-realtime-2",
    error: null,
    inputMuted: false,
    credential: {
      configured: true,
      redacted: "sk-proj...3456",
    },
  });

  const sentEvents = transportFactory.transports[0].events;
  assert.equal(sentEvents.length, 2);
  assert.equal(sentEvents[0].type, "session.update");
  assert.equal(sentEvents[0].session.type, "realtime");
  assert.equal(sentEvents[0].session.model, "gpt-realtime-2");
  assert.equal(sentEvents[0].session.modalities, undefined);
  assert.deepEqual(sentEvents[0].session.output_modalities, ["text"]);
  assert.match(sentEvents[0].session.instructions, /actions\.json/);
  assert.match(sentEvents[0].session.instructions, /proactive/i);
  assert.match(sentEvents[0].session.instructions, /navigate|navigation/i);
  assert.match(sentEvents[0].session.instructions, /do not narrate/i);
  assert.match(sentEvents[0].session.instructions, /before answering/i);
  assert.match(sentEvents[0].session.instructions, /start of a session/i);
  assert.match(sentEvents[0].session.instructions, /mode=list/i);
  assert.match(sentEvents[0].session.instructions, /site role/i);
  assert.match(sentEvents[0].session.instructions, /pointer\.click/);
  assert.match(sentEvents[0].session.instructions, /clickable_center/);
  assert.match(sentEvents[0].session.instructions, /overlay/i);
  assert.match(sentEvents[0].session.instructions, /overlay_open|overlay\.open/);
  assert.match(sentEvents[0].session.instructions, /Do not say you cannot directly open an overlay/i);
  assert.equal(sentEvents[0].session.tool_choice, "auto");
  assert.equal(sentEvents[1].type, "response.create");
  assert.match(sentEvents[1].response.instructions, /intro/i);
  assert.match(sentEvents[1].response.instructions, /website|page/i);
  assert.match(sentEvents[1].response.instructions, /what brought/i);
  assert.match(sentEvents[1].response.instructions, /friction|pain/i);
  assert.doesNotMatch(sentEvents[1].response.instructions, /including .*,/i);
  assert.doesNotMatch(sentEvents[1].response.instructions, /tools are available/i);
});

test("hosted realtime session tells the model the realtime-safe pointer click function name", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    tools: [
      {
        type: "function",
        name: "actions.site",
        description: "List or call current-site actions.",
        parameters: { type: "object", additionalProperties: false },
      },
      {
        type: "function",
        name: "pointer.click",
        description: "Click a viewport point.",
        parameters: {
          type: "object",
          required: ["x", "y"],
          properties: { x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "overlay.open",
        description: "Open an HTML overlay.",
        parameters: {
          type: "object",
          required: ["html"],
          properties: { html: { type: "string" }, title: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
  });

  await manager.start({ textOnly: true });

  const sessionUpdate = transportFactory.transports[0].events[0];
  const initialResponse = transportFactory.transports[0].events[1];
  assert.deepEqual(
    sessionUpdate.session.tools.map((tool) => tool.name),
    ["actions_site", "pointer_click", "overlay_open"],
  );
  assert.match(sessionUpdate.session.instructions, /pointer_click/);
  assert.match(sessionUpdate.session.instructions, /actions_site/);
  assert.match(sessionUpdate.session.instructions, /overlay_open/);
  assert.match(initialResponse.response.instructions, /Before greeting/i);
  assert.match(initialResponse.response.instructions, /actions_site/i);
  assert.match(initialResponse.response.instructions, /site\.map|teacher|host|guide/i);
});

test("hosted realtime session starts audio mode with transcription and realtime voice output", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });

  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  assert.equal(sessionUpdate.session.modalities, undefined);
  assert.deepEqual(sessionUpdate.session.output_modalities, ["audio"]);
  assert.deepEqual(sessionUpdate.session.audio, {
    input: {
      transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 800,
        create_response: true,
        interrupt_response: true,
      },
    },
    output: { voice: "cedar" },
  });
  assert.deepEqual(sessionUpdate.session.reasoning, { effort: "low" });
});

test("hosted realtime session applies persisted server VAD controls to audio session.update", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  await saveRealtimeTurnDetectionSettings(storage, {
    mode: "server_vad",
    threshold: 0.72,
    silenceDurationMs: 1200,
    interruptResponse: false,
  });
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });

  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  assert.deepEqual(sessionUpdate.session.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.72,
    prefix_padding_ms: 300,
    silence_duration_ms: 1200,
    create_response: true,
    interrupt_response: false,
  });
});

test("hosted realtime session applies persisted semantic VAD controls to audio session.update", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  await saveRealtimeTurnDetectionSettings(storage, {
    mode: "semantic_vad",
    eagerness: "low",
    interruptResponse: true,
  });
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });

  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  assert.deepEqual(sessionUpdate.session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "low",
    create_response: true,
    interrupt_response: true,
  });
});

test("hosted realtime session logs the active audio turn detection config", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  await saveRealtimeTurnDetectionSettings(storage, {
    mode: "semantic_vad",
    eagerness: "high",
    interruptResponse: false,
  });
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });

  const configEvent = storage.data.ACTIONS_JSON_AGENT_MEMORY_V1.events.find(
    (event) => event.type === "realtime" && event.name === "realtime.session.audio_config",
  );
  assert.equal(configEvent.ok, true);
  assert.deepEqual(configEvent.output, {
    text_only: false,
    voice: "cedar",
    turn_detection: {
      type: "semantic_vad",
      eagerness: "high",
      create_response: true,
      interrupt_response: false,
    },
  });
});

test("hosted realtime session uses the persisted realtime voice selection", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  await saveRealtimeVoice(storage, "cedar");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });

  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  assert.equal(sessionUpdate.session.audio.output.voice, "cedar");
});

test("hosted realtime session stop closes the active transport and clears transient state", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start();
  const state = await manager.stop();

  assert.equal(transportFactory.transports[0].closed, true);
  assert.deepEqual(state, {
    status: "stopped",
    model: "gpt-realtime-2",
    error: null,
    inputMuted: false,
  });
});

test("hosted realtime session injects returning local memory before session update", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  await recordAgentMemoryEvent(storage, {
    type: "transcript",
    role: "user",
    text: "We were authoring LinkedIn analytics actions.",
  });
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: true });

  const sentEvents = transportFactory.transports[0].events;
  assert.equal(sentEvents[0].type, "conversation.item.create");
  assert.equal(sentEvents[0].item.role, "system");
  assert.match(sentEvents[0].item.content[0].text, /LinkedIn analytics actions/);
  assert.equal(sentEvents[1].type, "session.update");
});

test("hosted realtime session sends injected realtime tool declarations", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const tools = [
    {
      type: "function",
      name: "actions.site",
      description: "List or call current-site actions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory, tools });

  await manager.start({ textOnly: true });

  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  assert.deepEqual(sessionUpdate.session.tools, [
    {
      ...tools[0],
      name: "actions_site",
    },
  ]);
  assert.match(sessionUpdate.session.instructions, /browser\.screenshot/);
  assert.match(sessionUpdate.session.instructions, /proactive/i);
  assert.match(sessionUpdate.session.instructions, /navigate|navigation/i);
  assert.match(sessionUpdate.session.instructions, /do not narrate/i);
  assert.match(sessionUpdate.session.instructions, /before answering/i);
  assert.match(sessionUpdate.session.instructions, /pointer\.click/);
  assert.match(sessionUpdate.session.instructions, /clickable_center/);
  assert.match(sessionUpdate.session.instructions, /overlay/i);
  assert.match(sessionUpdate.session.instructions, /Do not tell the user you cannot see/);
  const initialResponse = transportFactory.transports[0].events.find((event) => event.type === "response.create");
  assert.match(initialResponse.response.instructions, /visual overlay/i);
  assert.match(initialResponse.response.instructions, /navigation/i);
});

test("hosted realtime session logs raw and normalized session.update tool names", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    tools: [
      {
        type: "function",
        name: "actions.site",
        description: "List or call current-site actions.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        type: "function",
        name: "pointer.click",
        description: "Click a viewport point.",
        parameters: {
          type: "object",
          required: ["x", "y"],
          properties: { x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
      },
    ],
  });

  await manager.start({ textOnly: true });

  const catalogEvent = storage.data.ACTIONS_JSON_AGENT_MEMORY_V1.events.find(
    (event) => event.type === "tool" && event.name === "realtime.session.update.tools",
  );
  assert.equal(catalogEvent.ok, true);
  assert.deepEqual(catalogEvent.output.raw_tool_names, ["actions.site", "pointer.click"]);
  assert.deepEqual(catalogEvent.output.realtime_tool_names, ["actions_site", "pointer_click"]);
  assert.deepEqual(catalogEvent.output.schema_fingerprints, [
    {
      name: "actions_site",
      required: [],
      properties: [],
    },
    {
      name: "pointer_click",
      required: ["x", "y"],
      properties: ["x", "y"],
    },
  ]);
  assert.equal(catalogEvent.output.has_actions_site, true);
  assert.equal(catalogEvent.output.has_pointer_click, true);
});

test("hosted realtime session can update realtime tool declarations before start", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });
  const tools = [
    {
      type: "function",
      name: "browser.screenshot",
      description: "Capture the visible browser tab through the actions.json bridge.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];

  const returnedTools = manager.setTools(tools);
  await manager.start({ textOnly: true });

  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  assert.deepEqual(returnedTools, tools);
  assert.deepEqual(sessionUpdate.session.tools, [
    {
      ...tools[0],
      name: "browser_screenshot",
    },
  ]);
});

test("hosted realtime session maps safe OpenAI tool names back to bridge names", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const toolCalls = [];
  const tools = [
    {
      type: "function",
      name: "browser.screenshot",
      description: "Capture the visible browser tab through the actions.json bridge.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    tools,
    toolExecutor: {
      async execute(call) {
        toolCalls.push(call);
        return { ok: true, output: { primitive: call.name } };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "browser_screenshot",
          call_id: "call-safe-screenshot",
          arguments: "{}",
        },
      ],
    },
  });

  assert.deepEqual(toolCalls, [
    {
      name: "browser.screenshot",
      call_id: "call-safe-screenshot",
      arguments: {},
    },
  ]);
});

test("hosted realtime session maps pointer_click arguments to pointer.click execution", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const toolCalls = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    tools: [
      {
        type: "function",
        name: "pointer.click",
        description: "Click a viewport point.",
        parameters: {
          type: "object",
          required: ["x", "y"],
          properties: { x: { type: "number" }, y: { type: "number" } },
          additionalProperties: false,
        },
      },
    ],
    toolExecutor: {
      async execute(call) {
        toolCalls.push(call);
        return { ok: true, output: { ok: true, primitive: call.name, value: { clicked: true } } };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "pointer_click",
          call_id: "call-pointer-click",
          arguments: JSON.stringify({ x: 759.96484375, y: 34 }),
        },
      ],
    },
  });

  assert.deepEqual(toolCalls, [
    {
      name: "pointer.click",
      call_id: "call-pointer-click",
      arguments: { x: 759.96484375, y: 34 },
    },
  ]);
});

test("hosted realtime session executes response.done function calls and asks the model to continue once", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const toolCalls = [];
  const toolExecutor = {
    async execute(call) {
      toolCalls.push(call);
      return {
        ok: true,
        output: { ok: true, primitive: call.name, value: { title: "Fixture" } },
      };
    },
  };
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory, toolExecutor });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "page.info",
          call_id: "call-page-info",
          arguments: "{}",
        },
      ],
    },
  });

  assert.deepEqual(toolCalls, [
    {
      name: "page.info",
      call_id: "call-page-info",
      arguments: {},
    },
  ]);
  const sentEvents = transportFactory.transports[0].events;
  assert.deepEqual(sentEvents.at(-2), {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-page-info",
      output: JSON.stringify({
        ok: true,
        output: { ok: true, primitive: "page.info", value: { title: "Fixture" } },
      }),
    },
  });
  assert.deepEqual(sentEvents.at(-1), { type: "response.create" });
  const log = await getAgentSessionLog(storage);
  assert.deepEqual(log.events.at(-1), {
    id: log.events.at(-1).id,
    type: "tool",
    timestamp: log.events.at(-1).timestamp,
    name: "page.info",
    ok: true,
    summary: "page.info completed.",
    input: {
      call_id: "call-page-info",
      arguments: {},
    },
    output: {
      ok: true,
      primitive: "page.info",
      value: { title: "Fixture" },
    },
  });
});

test("hosted realtime session log preserves compact tool arguments and results", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute(call) {
        return {
          ok: true,
          output: {
            ok: true,
            primitive: "locator.element_info",
            value: {
              locator: call.arguments.locator,
              text: "genspec.dev",
              clickable_center: { x: 412.25, y: 538.5 },
              bounding_box: {
                x: 360,
                y: 520,
                width: 104,
                height: 37,
                left: 360,
                top: 520,
                right: 464,
                bottom: 557,
              },
              data_url: "data:image/png;base64,should-not-be-stored",
            },
          },
        };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "locator.element_info",
          call_id: "call-genspec-locator",
          arguments: JSON.stringify({
            locator: {
              selector: "a[href*='genspec.dev']",
              text_contains: "genspec.dev",
            },
          }),
        },
      ],
    },
  });

  const event = (await getAgentSessionLog(storage)).events.at(-1);
  assert.equal(event.name, "locator.element_info");
  assert.deepEqual(event.input, {
    call_id: "call-genspec-locator",
    arguments: {
      locator: {
        selector: "a[href*='genspec.dev']",
        text_contains: "genspec.dev",
      },
    },
  });
  assert.deepEqual(event.output, {
    ok: true,
    primitive: "locator.element_info",
    value: {
      locator: {
        selector: "a[href*='genspec.dev']",
        text_contains: "genspec.dev",
      },
      text: "genspec.dev",
      clickable_center: { x: 412.25, y: 538.5 },
      bounding_box: {
        x: 360,
        y: 520,
        width: 104,
        height: 37,
        left: 360,
        top: 520,
        right: 464,
        bottom: 557,
      },
    },
  });
  assert.equal(JSON.stringify(event).includes("should-not-be-stored"), false);
});

test("hosted realtime session notifies observers when tool calls start and finish", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const observed = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    eventObserver(event) {
      if (event.type.startsWith("actions_json.tool.")) {
        observed.push(event);
      }
    },
    toolExecutor: {
      async execute() {
        return { ok: false, error: { message: "Bridge disconnected" } };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "browser.screenshot",
          call_id: "call-tool-observer",
          arguments: "{}",
        },
      ],
    },
  });

  assert.deepEqual(observed, [
    {
      type: "actions_json.tool.started",
      name: "browser.screenshot",
      call_id: "call-tool-observer",
    },
    {
      type: "actions_json.tool.completed",
      name: "browser.screenshot",
      call_id: "call-tool-observer",
      ok: false,
      error: { message: "Bridge disconnected" },
    },
  ]);
});

test("hosted realtime session log preserves tool failures and realtime errors", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        return {
          ok: false,
          error: {
            code: "bridge_failed",
            message: "Bridge disconnected",
          },
        };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "browser.screenshot",
          call_id: "call-failed-screenshot",
          arguments: "{}",
        },
      ],
    },
  });
  await manager.handleRealtimeEvent({
    type: "error",
    error: {
      code: "invalid_tool_output",
      message: "Missing required parameter: item.type",
    },
  });

  const log = await getAgentSessionLog(storage);
  assert.deepEqual(
    log.events.slice(-2).map((event) => ({
      type: event.type,
      name: event.name,
      ok: event.ok,
      code: event.code,
      message: event.message,
      summary: event.summary,
    })),
    [
      {
        type: "tool",
        name: "browser.screenshot",
        ok: false,
        code: undefined,
        message: undefined,
        summary: "browser.screenshot failed: Bridge disconnected.",
      },
      {
        type: "error",
        name: undefined,
        ok: undefined,
        code: "invalid_tool_output",
        message: "Missing required parameter: item.type",
        summary: undefined,
      },
    ],
  );
});

test("hosted realtime session de-duplicates repeated realtime function call ids", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  let count = 0;
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        count += 1;
        return { ok: true };
      },
    },
  });
  const event = {
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "page.info",
          call_id: "same-call",
          arguments: "{}",
        },
      ],
    },
  };

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent(event);
  await manager.handleRealtimeEvent(event);

  assert.equal(count, 1);
  assert.equal(
    transportFactory.transports[0].events.filter((sentEvent) => sentEvent.type === "response.create").length,
    2,
  );
});

test("hosted realtime session notifies observers and stores completed transcripts", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const observed = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    eventObserver(event) {
      observed.push(event.type);
    },
  });

  await manager.start({ textOnly: true });
  await transportFactory.transports[0].onEvent({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Can you inspect this page?",
  });
  await transportFactory.transports[0].onEvent({
    type: "response.output_audio_transcript.done",
    transcript: "I can inspect it now.",
  });

  assert.deepEqual(observed, [
    "conversation.item.input_audio_transcription.completed",
    "response.output_audio_transcript.done",
  ]);
  const transcriptEvents = storage.data.ACTIONS_JSON_AGENT_MEMORY_V1.events.filter(
    (event) => event.type === "transcript",
  );
  assert.match(transcriptEvents.at(-2).text, /inspect this page/);
  assert.match(transcriptEvents.at(-1).text, /inspect it now/);
});

test("hosted realtime session persists realtime VAD and interruption lifecycle events", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });
  await transportFactory.transports[0].onEvent({
    type: "response.created",
    response: { id: "resp_1" },
  });
  await transportFactory.transports[0].onEvent({
    type: "response.output_item.added",
    response_id: "resp_1",
    output_index: 0,
    item: { id: "item_1", type: "message" },
  });
  await transportFactory.transports[0].onEvent({
    type: "response.output_audio_transcript.delta",
    response_id: "resp_1",
    item_id: "item_1",
    output_index: 0,
    content_index: 0,
    delta: "Long answer part one. ",
  });
  await transportFactory.transports[0].onEvent({
    type: "input_audio_buffer.speech_started",
    audio_start_ms: 2410,
    item_id: "user_item_1",
  });
  await transportFactory.transports[0].onEvent({
    type: "response.cancelled",
    response: { id: "resp_1", status: "cancelled" },
  });
  await transportFactory.transports[0].onEvent({
    type: "conversation.item.truncated",
    item_id: "item_1",
    content_index: 0,
    audio_end_ms: 1550,
  });

  const lifecycleEvents = (await getAgentSessionLog(storage)).events.filter((event) => event.type === "realtime");
  assert.deepEqual(
    lifecycleEvents.slice(-4).map((event) => ({
      name: event.name,
      ok: event.ok,
      output: event.output,
    })),
    [
      {
        name: "response.output_item.added",
        ok: true,
        output: {
          response_id: "resp_1",
          item_id: "item_1",
          item_type: "message",
          output_index: 0,
          content_index: null,
          audio_ms: null,
          delta: null,
          generated_transcript: null,
          transcript: null,
          status: null,
        },
      },
      {
        name: "input_audio_buffer.speech_started",
        ok: true,
        output: {
          response_id: null,
          item_id: "user_item_1",
          item_type: null,
          output_index: null,
          content_index: null,
          audio_ms: 2410,
          delta: null,
          generated_transcript: null,
          transcript: null,
          status: null,
        },
      },
      {
        name: "response.cancelled",
        ok: true,
        output: {
          response_id: "resp_1",
          item_id: null,
          item_type: null,
          output_index: null,
          content_index: null,
          audio_ms: null,
          delta: null,
          generated_transcript: "Long answer part one.",
          transcript: null,
          status: "cancelled",
        },
      },
      {
        name: "conversation.item.truncated",
        ok: true,
        output: {
          response_id: null,
          item_id: "item_1",
          item_type: null,
          output_index: null,
          content_index: 0,
          audio_ms: 1550,
          delta: null,
          generated_transcript: "Long answer part one.",
          transcript: null,
          status: null,
        },
      },
    ],
  );
});

test("hosted realtime session aggregates audio transcript deltas so diagnostics do not flood memory", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: false });
  for (let index = 0; index < 120; index += 1) {
    await transportFactory.transports[0].onEvent({
      type: "response.output_audio_transcript.delta",
      response_id: "resp_flood",
      item_id: "item_flood",
      output_index: 0,
      content_index: 0,
      delta: `word${index} `,
    });
  }
  await transportFactory.transports[0].onEvent({
    type: "response.cancelled",
    response: { id: "resp_flood", status: "cancelled" },
  });

  const log = await getAgentSessionLog(storage);
  assert.equal(
    log.events.some((event) => event.name === "realtime.session.audio_config"),
    true,
  );
  assert.equal(
    log.events.some((event) => event.name === "response.output_audio_transcript.delta"),
    false,
  );
  const cancelEvent = log.events.find((event) => event.name === "response.cancelled");
  assert.match(cancelEvent.output.generated_transcript, /word0 word1/);
  assert.match(cancelEvent.output.generated_transcript, /…$/);
});

test("hosted realtime session stores completed user transcripts from nested content", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: true });
  await transportFactory.transports[0].onEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item: {
      content: [
        {
          type: "input_audio",
          transcript: "What website am I on?",
        },
      ],
    },
  });

  assert.match(storage.data.ACTIONS_JSON_AGENT_MEMORY_V1.events.at(-1).text, /What website am I on/);
});

test("hosted realtime session sends screenshot tool results as image input without base64 in function output", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const screenshotDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        return {
          ok: true,
          output: {
            ok: true,
            data_url: screenshotDataUrl,
            mime_type: "image/png",
            image_bytes: 32,
            viewport: { width: 800, height: 600, device_pixel_ratio: 1 },
            url: "https://example.test/",
          },
        };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "browser.screenshot",
          call_id: "call-screenshot",
          arguments: "{\"purpose\":\"inspect current page\"}",
        },
      ],
    },
  });

  const sentEvents = transportFactory.transports[0].events;
  const functionOutput = JSON.parse(sentEvents.at(-3).item.output);
  assert.equal(functionOutput.output.data_url, undefined);
  assert.deepEqual(functionOutput.output.image, {
    delivered_as: "input_image",
    mime_type: "image/png",
    image_bytes: 32,
  });
  assert.deepEqual(sentEvents.at(-2), {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Screenshot captured for browser.screenshot call call-screenshot.",
        },
        {
          type: "input_image",
          image_url: screenshotDataUrl,
        },
      ],
    },
  });
  assert.deepEqual(sentEvents.at(-1), { type: "response.create" });
});

test("hosted realtime session omits oversized screenshot image input", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const largeScreenshotDataUrl = `data:image/jpeg;base64,${"a".repeat(700_000)}`;
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        return {
          ok: true,
          output: {
            ok: true,
            data_url: largeScreenshotDataUrl,
            mime_type: "image/jpeg",
            image_bytes: 525000,
            viewport: { width: 1440, height: 1200, device_pixel_ratio: 2 },
          },
        };
      },
    },
  });

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "browser.screenshot",
          call_id: "call-large-screenshot",
          arguments: "{}",
        },
      ],
    },
  });

  const sentEvents = transportFactory.transports[0].events;
  const toolEvents = sentEvents.slice(2);
  const functionOutput = JSON.parse(toolEvents[0].item.output);
  assert.equal(functionOutput.output.data_url, undefined);
  assert.deepEqual(functionOutput.output.image, {
    delivered_as: "omitted_oversize",
    mime_type: "image/jpeg",
    image_bytes: 525000,
    data_url_chars: largeScreenshotDataUrl.length,
  });
  assert.equal(
    toolEvents.some((event) =>
      event.item?.content?.some?.((part) => part.type === "input_image")
    ),
    false
  );
  assert.deepEqual(toolEvents.at(-1), { type: "response.create" });
});

test("hosted realtime session subscribes transport events to the function-call loop", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  let executed = false;
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        executed = true;
        return { ok: true };
      },
    },
  });

  await manager.start({ textOnly: true });
  await transportFactory.transports[0].onEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "page.info",
          call_id: "subscribed-call",
          arguments: "{}",
        },
      ],
    },
  });

  assert.equal(executed, true);
  assert.equal(
    transportFactory.transports[0].events.some((event) => event.type === "response.create"),
    true,
  );
});
