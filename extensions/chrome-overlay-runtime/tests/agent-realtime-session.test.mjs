import assert from "node:assert/strict";
import test from "node:test";

import { saveOpenAiApiKey } from "../src/agent/credential-store.mjs";
import { DEFAULT_MODEL, HostedRealtimeSessionManager } from "../src/agent/realtime-session-manager.mjs";
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function nextTimer() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fallbackArgs(args = {}, overrides = {}) {
  return {
    ...args,
    policy_exception_report: {
      kind: overrides.kind || "generic",
      intended_tool: overrides.intended_tool || overrides.tool || "unknown",
      actions_json_path: overrides.actions_json_path || "none",
      reason: overrides.reason || "Test fixture is exercising a direct fallback tool call.",
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
    model: DEFAULT_MODEL,
    error: "OpenAI API key is required",
    inputMuted: true,
    outputMuted: true,
    textOnly: true,
    busy: false,
    activeResponseId: null,
  });
});

test("hosted realtime session starts the default model with a fake transport and redacted public state", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  const state = await manager.start({ textOnly: true });

  assert.deepEqual(state, {
    status: "connected",
    model: DEFAULT_MODEL,
    error: null,
    inputMuted: true,
    outputMuted: true,
    textOnly: true,
    busy: false,
    activeResponseId: null,
  });
  assert.equal(transportFactory.calls[0][0], "create");
  assert.equal(transportFactory.calls[0][1].model, DEFAULT_MODEL);
  assert.equal(transportFactory.calls[0][1].apiKey, "sk-proj-session-secret-value-123456");
  const publicState = await manager.getPublicState();
  assert.equal(JSON.stringify(publicState).includes("session-secret"), false);
  assert.deepEqual(publicState, {
    status: "connected",
    model: DEFAULT_MODEL,
    error: null,
    inputMuted: true,
    outputMuted: true,
    textOnly: true,
    busy: false,
    activeResponseId: null,
    credential: {
      configured: true,
      redacted: "sk-proj...3456",
    },
  });

  const sentEvents = transportFactory.transports[0].events;
  assert.equal(sentEvents.length, 2);
  assert.equal(sentEvents[0].type, "session.update");
  assert.equal(sentEvents[0].session.type, "realtime");
  assert.equal(sentEvents[0].session.model, DEFAULT_MODEL);
  assert.equal(sentEvents[0].session.modalities, undefined);
  assert.deepEqual(sentEvents[0].session.output_modalities, ["text"]);
  assert.match(sentEvents[0].session.instructions, /actions\.json/);
  assert.match(sentEvents[0].session.instructions, /proactive/i);
  assert.match(sentEvents[0].session.instructions, /navigate|navigation/i);
  assert.match(sentEvents[0].session.instructions, /do not narrate/i);
  assert.match(sentEvents[0].session.instructions, /before answering/i);
  assert.match(sentEvents[0].session.instructions, /claimed tabs/i);
  assert.match(sentEvents[0].session.instructions, /activate/i);
  assert.match(sentEvents[0].session.instructions, /relevant tab/i);
  assert.match(sentEvents[0].session.instructions, /start of a session/i);
  assert.match(sentEvents[0].session.instructions, /mode=list/i);
  assert.match(sentEvents[0].session.instructions, /site role/i);
  assert.match(sentEvents[0].session.instructions, /pointer\.click/);
  assert.match(sentEvents[0].session.instructions, /clickable_center/);
  assert.match(sentEvents[0].session.instructions, /overlay/i);
  assert.match(sentEvents[0].session.instructions, /overlay_open|overlay\.open/);
  assert.match(sentEvents[0].session.instructions, /Do not say you cannot directly open an overlay/i);
  assert.match(sentEvents[0].session.instructions, /visually rich/i);
  assert.match(sentEvents[0].session.instructions, /presentation-worthy/i);
  assert.match(sentEvents[0].session.instructions, /designed artifact/i);
  assert.match(sentEvents[0].session.instructions, /download or show/i);
  assert.match(sentEvents[0].session.instructions, /scanned quickly/i);
  assert.match(sentEvents[0].session.instructions, /self-contained HTML and CSS/i);
  assert.match(sentEvents[0].session.instructions, /without scripts/i);
  assert.match(sentEvents[0].session.instructions, /do not add your own download or upload buttons/i);
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
    model: DEFAULT_MODEL,
    error: null,
    inputMuted: false,
    outputMuted: false,
    textOnly: true,
    busy: false,
    activeResponseId: null,
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
  assert.match(sessionUpdate.session.instructions, /boring plain tables/i);
  assert.match(sessionUpdate.session.instructions, /section cards|slide-like panels/i);
  assert.match(sessionUpdate.session.instructions, /Do not tell the user you cannot see/);
  assert.match(sessionUpdate.session.instructions, /Capability alignment/i);
  assert.match(sessionUpdate.session.instructions, /Do not say a capability is unavailable/i);
  assert.match(sessionUpdate.session.instructions, /empty actions\.site result means the site map is not loaded/i);
  assert.match(sessionUpdate.session.instructions, /wrong active tab/i);
  assert.match(sessionUpdate.session.instructions, /browser_claimed_tabs_list|browser\.claimed_tabs\.list/i);
  assert.match(sessionUpdate.session.instructions, /browser_claimed_tabs_activate|browser\.claimed_tabs\.activate/i);
  assert.match(sessionUpdate.session.instructions, /page warning text/i);
  assert.match(sessionUpdate.session.instructions, /actions\.json site actions are the first-choice operating layer/i);
  assert.match(sessionUpdate.session.instructions, /Generic primitives are fallback tools/i);
  assert.match(sessionUpdate.session.instructions, /policy violation/i);
  assert.match(sessionUpdate.session.instructions, /policy_exception_report/i);
  assert.match(sessionUpdate.session.instructions, /not the boundary of your ability/i);
  assert.match(sessionUpdate.session.instructions, /composing primitives/i);
  assert.match(sessionUpdate.session.instructions, /capability-alignment failure/i);
  assert.match(sessionUpdate.session.instructions, /Aim clicks at the returned clickable_center/i);
  assert.match(sessionUpdate.session.instructions, /Never click a bounding_box's x\/y/i);
  assert.match(sessionUpdate.session.instructions, /if nothing changed, take browser\.screenshot/i);
  assert.match(sessionUpdate.session.instructions, /Do not narrate the report/i);
  const initialResponse = transportFactory.transports[0].events.find((event) => event.type === "response.create");
  assert.match(initialResponse.response.instructions, /visual overlay/i);
  assert.match(initialResponse.response.instructions, /navigation/i);
  assert.match(initialResponse.response.instructions, /site-specific action before any generic DOM/i);
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
      required: ["x", "y", "policy_exception_report"],
      properties: ["x", "y", "policy_exception_report"],
    },
  ]);
  const sessionUpdate = transportFactory.transports[0].events.find((event) => event.type === "session.update");
  const actionsSite = sessionUpdate.session.tools.find((tool) => tool.name === "actions_site");
  const pointerClick = sessionUpdate.session.tools.find((tool) => tool.name === "pointer_click");
  assert.equal(actionsSite.parameters.properties.policy_exception_report, undefined);
  assert.equal(pointerClick.parameters.properties.policy_exception_report.type, "object");
  assert.deepEqual(pointerClick.parameters.properties.policy_exception_report.required, [
    "kind",
    "intended_tool",
    "actions_json_path",
    "reason",
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
  assert.equal(sessionUpdate.session.tools[0].name, "browser_screenshot");
  assert.equal(sessionUpdate.session.tools[0].parameters.properties.policy_exception_report.type, "object");
  assert.deepEqual(sessionUpdate.session.tools[0].parameters.required, ["policy_exception_report"]);
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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "browser.screenshot" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

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
          arguments: JSON.stringify(fallbackArgs({ x: 759.96484375, y: 34 }, { tool: "pointer.click" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "page.info" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

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

test("hosted realtime session queues function calls without blocking the realtime event handler", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const releaseTool = deferred();
  let executeStarted = false;
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        executeStarted = true;
        await releaseTool.promise;
        return { ok: true, output: { done: true } };
      },
    },
  });

  await manager.start({ textOnly: true });
  const result = await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "page.info",
          call_id: "call-slow-page-info",
          arguments: JSON.stringify(fallbackArgs({}, { tool: "page.info" })),
        },
      ],
    },
  });

  assert.deepEqual(result, { handled: true, toolCalls: 1, queued: true });
  assert.equal(executeStarted, false);
  assert.equal(
    transportFactory.transports[0].events.some((event) => event.item?.call_id === "call-slow-page-info"),
    false,
  );

  releaseTool.resolve();
  await manager.waitForToolJobsIdle();

  assert.equal(
    transportFactory.transports[0].events.some((event) => event.item?.call_id === "call-slow-page-info"),
    true,
  );
});

test("hosted realtime session serializes queued tool calls for the same runtime", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const firstRelease = deferred();
  const order = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute(call) {
        order.push(`start:${call.call_id}`);
        if (call.call_id === "call-first-mutation") {
          await firstRelease.promise;
        }
        order.push(`finish:${call.call_id}`);
        return { ok: true, output: { call_id: call.call_id } };
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
          name: "pointer.click",
          call_id: "call-first-mutation",
          arguments: JSON.stringify(
            fallbackArgs({ target_runtime_id: "runtime-1", x: 10, y: 10 }, { tool: "pointer.click" }),
          ),
        },
        {
          type: "function_call",
          name: "pointer.click",
          call_id: "call-second-mutation",
          arguments: JSON.stringify(
            fallbackArgs({ target_runtime_id: "runtime-1", x: 20, y: 20 }, { tool: "pointer.click" }),
          ),
        },
      ],
    },
  });

  await nextTimer();
  assert.deepEqual(order, ["start:call-first-mutation"]);

  firstRelease.resolve();
  await manager.waitForToolJobsIdle();

  assert.deepEqual(order, [
    "start:call-first-mutation",
    "finish:call-first-mutation",
    "start:call-second-mutation",
    "finish:call-second-mutation",
  ]);
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
              text: "beta.example",
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
          call_id: "call-beta-locator",
          arguments: JSON.stringify(
            fallbackArgs(
              {
                locator: {
                  selector: "a[href*='beta.example']",
                  text_contains: "beta.example",
                },
              },
              { tool: "locator.element_info", actions_json_path: "acme.links.beta.geometry" },
            ),
          ),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

  const event = (await getAgentSessionLog(storage)).events.at(-1);
  assert.equal(event.name, "locator.element_info");
  assert.deepEqual(event.input, {
    call_id: "call-beta-locator",
    arguments: {
      locator: {
        selector: "a[href*='beta.example']",
        text_contains: "beta.example",
      },
    },
  });
  assert.deepEqual(event.output, {
    ok: true,
    primitive: "locator.element_info",
    value: {
      locator: {
        selector: "a[href*='beta.example']",
        text_contains: "beta.example",
      },
      text: "beta.example",
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

test("hosted realtime session records and strips mandatory policy exception reports", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const executed = [];
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
        executed.push(call);
        return { ok: true, output: { primitive: "pointer.click", value: { clicked: true } } };
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
          call_id: "call-policy-report",
          arguments: JSON.stringify({
            x: 12,
            y: 34,
            policy_exception_report: {
              kind: "generic",
              intended_tool: "pointer.click",
              actions_json_path: "trello.board.add_card_buttons.candidates",
              reason: "The click follows geometry returned by the Trello add-card candidate action.",
            },
          }),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

  assert.deepEqual(executed, [
    {
      name: "pointer.click",
      call_id: "call-policy-report",
      arguments: { x: 12, y: 34 },
    },
  ]);
  const log = await getAgentSessionLog(storage);
  const policyEvent = log.events.find((event) => event.type === "policy_exception");
  assert.deepEqual(policyEvent, {
    id: policyEvent.id,
    type: "policy_exception",
    timestamp: policyEvent.timestamp,
    kind: "generic",
    tool: "pointer.click",
    call_id: "call-policy-report",
    intended_tool: "pointer.click",
    actions_json_path: "trello.board.add_card_buttons.candidates",
    reason: "The click follows geometry returned by the Trello add-card candidate action.",
  });
  const toolEvent = log.events.find((event) => event.type === "tool" && event.name === "pointer.click");
  assert.equal(toolEvent.ok, true);
  assert.deepEqual(toolEvent.input.arguments, { x: 12, y: 34 });
});

test("hosted realtime session rejects direct fallback tools without policy exception reports", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const executed = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    tools: [
      {
        type: "function",
        name: "browser.screenshot",
        description: "Capture the visible browser tab.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    toolExecutor: {
      async execute(call) {
        executed.push(call);
        return { ok: true };
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
          call_id: "call-missing-policy-report",
          arguments: "{}",
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

  assert.deepEqual(executed, []);
  const toolEvent = (await getAgentSessionLog(storage)).events.find(
    (event) => event.type === "tool" && event.name === "browser.screenshot",
  );
  assert.equal(toolEvent.ok, false);
  assert.equal(toolEvent.output.error.code, "policy_exception_report_required");
  assert.equal(toolEvent.output.error.recoverable, true);
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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "browser.screenshot" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "browser.screenshot" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();
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

test("hosted realtime session records delivery failure and skips follow-up response when function output cannot be sent", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    toolExecutor: {
      async execute() {
        return { ok: true, output: { value: "completed locally" } };
      },
    },
  });

  await manager.start({ textOnly: true });
  const transport = transportFactory.transports[0];
  const originalSendEvent = transport.sendEvent.bind(transport);
  transport.sendEvent = async (event) => {
    if (event?.item?.type === "function_call_output") {
      const error = new Error("Realtime data channel is not open: closed");
      error.code = "realtime_data_channel_not_open";
      error.dataChannelState = "closed";
      throw error;
    }
    return originalSendEvent(event);
  };

  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      output: [
        {
          type: "function_call",
          name: "page.info",
          call_id: "call-delivery-fails",
          arguments: JSON.stringify(fallbackArgs({}, { tool: "page.info" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

  assert.deepEqual(manager.getState(), {
    status: "error",
    model: DEFAULT_MODEL,
    error: "Realtime data channel is not open: closed",
    inputMuted: true,
    outputMuted: true,
    textOnly: true,
    busy: false,
    activeResponseId: null,
  });
  assert.equal(
    transport.events.slice(2).some((event) => event.type === "response.create"),
    false,
  );
  const log = await getAgentSessionLog(storage);
  const failure = log.events.find((event) => event.name === "realtime.data_channel.send_failed");
  assert.deepEqual({
    type: failure.type,
    name: failure.name,
    ok: failure.ok,
    summary: failure.summary,
    input: failure.input,
    output: failure.output,
  }, {
    type: "realtime",
    name: "realtime.data_channel.send_failed",
    ok: false,
    summary: "Failed to send function_call_output for page.info.",
    input: {
      call_id: "call-delivery-fails",
      tool_name: "page.info",
      outgoing_item_type: "function_call_output",
      sequence_key: "default",
    },
    output: {
      delivered_to_model: false,
      browser_tool_output: { value: "completed locally" },
      error: {
        code: "realtime_data_channel_not_open",
        message: "Realtime data channel is not open: closed",
        data_channel_state: "closed",
        peer_connection_state: null,
        ice_connection_state: null,
        signaling_state: null,
        data_channel_buffered_amount: null,
      },
    },
  });
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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "page.info" })),
        },
      ],
    },
  };

  await manager.start({ textOnly: true });
  await manager.handleRealtimeEvent(event);
  await manager.handleRealtimeEvent(event);
  await manager.waitForToolJobsIdle();

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

test("hosted realtime session injects developer text prompts as text-only responses", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const observed = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    developerTextResponseTimeoutMs: 1000,
    eventObserver(event) {
      observed.push(event);
    },
  });

  await manager.start({ textOnly: false });
  const resultPromise = manager.sendUserMessage({
    text: "Open the Trello card called Get Trello control to be demo ready.",
  });
  await nextTimer();

  const sentEvents = transportFactory.transports[0].events;
  assert.deepEqual(sentEvents.at(-2), {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Open the Trello card called Get Trello control to be demo ready.",
        },
      ],
    },
  });
  assert.deepEqual(sentEvents.at(-1), {
    type: "response.create",
    response: {
      output_modalities: ["text"],
      instructions: "Respond to this developer-injected test prompt with text only. Do not produce audio.",
    },
  });

  await transportFactory.transports[0].onEvent({
    type: "response.created",
    response: { id: "resp_dev_text" },
  });
  await transportFactory.transports[0].onEvent({
    type: "response.output_text.done",
    response_id: "resp_dev_text",
    text: "I found two matching card candidates.",
  });
  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.request_id.startsWith("developer-text-"), true);
  assert.equal(result.response_mode, "text_only_transcript");
  assert.equal(result.response_text, "I found two matching card candidates.");
  assert.equal(result.response_id, "resp_dev_text");
  assert.equal(
    observed.some(
      (event) =>
        event.type === "actions_json.transcript" &&
        event.role === "user" &&
        event.source === "mcp" &&
        event.request_id === result.request_id &&
        event.text === "Open the Trello card called Get Trello control to be demo ready.",
    ),
    true,
  );
  assert.equal(
    observed.some(
      (event) =>
        event.type === "actions_json.transcript" &&
        event.role === "assistant" &&
        event.source === "mcp" &&
        event.request_id === result.request_id &&
        event.text === "I found two matching card candidates.",
    ),
    true,
  );
  const log = await getAgentSessionLog(storage);
  assert.equal(
    log.events.some((event) => event.type === "transcript" && event.role === "user" && /Open the Trello card/.test(event.text)),
    true,
  );
  assert.equal(
    log.events.some((event) => event.type === "transcript" && event.role === "assistant" && /two matching card candidates/.test(event.text)),
    true,
  );
  assert.equal(
    log.events.some((event) => event.type === "tool" && event.name === "runtime.agent.user_message" && event.ok === true),
    true,
  );
});

test("hosted realtime session resolves developer text prompts from response.done output content", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const observed = [];
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    developerTextResponseTimeoutMs: 1000,
    eventObserver(event) {
      observed.push(event);
    },
  });

  await manager.start({ textOnly: true });
  const resultPromise = manager.sendUserMessage({
    text: "Find the Trello demo card.",
  });
  await nextTimer();

  await transportFactory.transports[0].onEvent({
    type: "response.created",
    response: { id: "resp_done_text" },
  });
  await transportFactory.transports[0].onEvent({
    type: "response.done",
    response: {
      id: "resp_done_text",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Found the demo card in In Progress.",
            },
          ],
        },
      ],
    },
  });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.response_mode, "text_only_transcript");
  assert.equal(result.response_text, "Found the demo card in In Progress.");
  assert.equal(result.response_id, "resp_done_text");
  assert.equal(
    observed.some(
      (event) =>
        event.type === "actions_json.transcript" &&
        event.role === "user" &&
        event.source === "mcp" &&
        event.request_id === result.request_id &&
        event.text === "Find the Trello demo card.",
    ),
    true,
  );
  assert.equal(
    observed.some(
      (event) =>
        event.type === "actions_json.transcript" &&
        event.role === "assistant" &&
        event.source === "mcp" &&
        event.request_id === result.request_id &&
        event.text === "Found the demo card in In Progress.",
    ),
    true,
  );
  const log = await getAgentSessionLog(storage);
  assert.equal(
    log.events.some((event) => event.type === "transcript" && event.role === "assistant" && /Found the demo card/.test(event.text)),
    true,
  );
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
          arguments: JSON.stringify(fallbackArgs({ purpose: "inspect current page" }, { tool: "browser.screenshot" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "browser.screenshot" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

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
          arguments: JSON.stringify(fallbackArgs({}, { tool: "page.info" })),
        },
      ],
    },
  });
  await manager.waitForToolJobsIdle();

  assert.equal(executed, true);
  assert.equal(
    transportFactory.transports[0].events.some((event) => event.type === "response.create"),
    true,
  );
});

test("hosted realtime session logs forensic state when the data channel closes unexpectedly", async () => {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-proj-session-secret-value-123456");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({ storage, transportFactory });

  await manager.start({ textOnly: true });
  await manager.handleTransportStatusEvent({
    type: "realtime.data_channel.close",
    data_channel_state: "closed",
    closed_by_client: false,
    close_code: 1006,
    close_reason: "abnormal closure",
    close_was_clean: false,
    peer_connection_state: "failed",
    ice_connection_state: "disconnected",
    ice_gathering_state: "complete",
    signaling_state: "stable",
    data_channel_buffered_amount: 4096,
    error_message: null,
    last_outbound_event_type: "response.create",
    last_inbound_event_type: "response.done",
  });

  const log = await getAgentSessionLog(storage);
  const closeEvent = log.events.find((event) => event.name === "realtime.data_channel.close");
  assert.deepEqual(closeEvent.output, {
    data_channel_state: "closed",
    closed_by_client: false,
    close_code: 1006,
    close_reason: "abnormal closure",
    close_was_clean: false,
    peer_connection_state: "failed",
    ice_connection_state: "disconnected",
    ice_gathering_state: "complete",
    signaling_state: "stable",
    data_channel_buffered_amount: 4096,
    error_message: null,
    last_outbound_event_type: "response.create",
    last_inbound_event_type: "response.done",
    manager_status: "connected",
    text_only: true,
    input_muted: true,
    output_muted: true,
    pending_developer_text_requests: 0,
    developer_text_responses_waiting: 0,
    queued_or_running_tool_jobs: 0,
    tool_sequence_queues: 0,
  });
});
