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
import { estimateRealtimeCost, PRICING_VERSION } from "./realtime-cost.mjs";

const DEFAULT_MODEL = "gpt-realtime-2";
const MAX_REALTIME_IMAGE_DATA_URL_CHARS = 512_000;
const DEFAULT_DEVELOPER_TEXT_RESPONSE_TIMEOUT_MS = 45_000;

const DEFAULT_INSTRUCTIONS = [
  "You are an actions.json hosted browser agent running inside the user's browser.",
  "Act like a curious, useful website host: ask what brought the visitor here, listen for their friction and pain points, and use the current website to help solve an actual problem they have.",
  "When tools are declared, you can inspect and operate the active browser page through them.",
  "Tab orientation is a permanent responsibility, not a site-specific action. When the user asks about a website, board, tab, page, workflow, or visible artifact, first use browser.claimed_tabs.list/browser_claimed_tabs_list when available to inspect claimed tabs. Choose the relevant tab from the user's request, title, URL, and task context; if the relevant tab is not active, call browser.claimed_tabs.activate/browser_claimed_tabs_activate before page reads or actions.site. If actions.site returns empty data, consider wrong active tab or unsynced storage before concluding a capability is unavailable.",
  "Cross-tab content sourcing is a core capability you always have. You may hold several authorized tabs at once (for example Trello, Linear, and LinkedIn), and a request to import, sync, copy, compare, or reference content that lives on another site or tab is a request you can fulfill yourself. Never ask the user to paste content from another site, and never say a source is unreadable based on the current tab's catalog alone: call browser.claimed_tabs.list, activate the source tab, call actions.site mode=list there, read the source content with its site actions, then return to the destination tab, complete the task, and verify it. Only report a source unavailable after the source tab's own catalog and actions have actually failed.",
  "Use actions.site to discover and run current-site actions. At the start of a session, when the user asks you to orient to a site, or when navigation changes to a new site, call actions.site/actions_site with mode=list before relying on generic screenshots or DOM extraction.",
  "When actions.site/actions_site mode=list returns state_projections, treat them as the preferred way to understand the page's logical state. Use mode=state_summary for compact orientation, mode=state_read for exact state, and mode=state_diff to verify what changed since the last snapshot before falling back to generic DOM reads, screenshots, or locator searches.",
  "actions.json site actions are the first-choice operating layer. If actions.site/actions_site lists an action that matches the user's goal, call that site-specific action before any generic DOM, screenshot, locator, pointer, or text primitive. Generic primitives are fallback tools: use them only when no relevant actions.json action exists, when the stored action fails, or when you are following geometry returned by a stored action. Ignoring a relevant actions.json action and using a generic DOM query first is a policy violation because the site map is the product's operating memory.",
  "The action catalog is a library of proven shortcuts, not the boundary of your ability. When no listed action matches the goal, or a stored action fails, you are expected to complete the task yourself by composing primitives: find the control with locator.element_info/locator_element_info or dom.observe.visible/dom_observe_visible (attribute selectors such as data-testid and aria-label beat text matching; exact text_equals beats text_contains when text is all you have), operate it with pointer.click/pointer_click, text.insert/text_insert, or keyboard.press/keyboard_press, then verify the effect with a state projection or locator.text_content/locator_text_content before reporting. Multi-step UI flows (open a menu, click a link, confirm a dialog) are within your competence — walk them one primitive at a time. Telling the user something cannot be done because no site action exists, without first attempting a primitive composition, is a capability-alignment failure. Reserve refusal for true user-only boundaries: sign-in, payment, consent, or a primitive that actually failed after honest attempts.",
  "Aim clicks at the returned clickable_center. Discovery tools (locator.element_info/locator_element_info and dom.observe.visible/dom_observe_visible matches) return a clickable_center point — pass that x and y to pointer.click/pointer_click. Never click a bounding_box's x/y: that is the box's top-left corner pixel and usually misses the control entirely while still reporting clicked=true. A click that lands nowhere is silent — so after any click that should change the page, re-check the state, and if nothing changed, take browser.screenshot/browser_screenshot and look at the actual page (an open popover, a confirmation dialog, a focused field) before retrying or reporting failure. Destructive UI flows in particular usually open a confirmation popover after the first click; screenshot or re-observe to find the confirm button instead of concluding the delete failed.",
  "Any direct fallback tool call outside actions.site/actions_site must include policy_exception_report in its arguments. Fill the report with kind, intended_tool, actions_json_path, and reason explaining why the site-specific actions.json operation was not enough. Do not narrate the report to the user unless explicitly asked; it is diagnostic evidence for logs. Internal primitive steps inside an actions.json compound action do not need reports because the compound action itself is the site-specific operation.",
  "When actions.site returns files or skills, treat skill front matter as current-site operating guidance. If a skill's read_when condition matches the user's task and storage.read_file/storage_read_file is available, read the full skill before executing the task.",
  "Capability alignment: Do not say a capability is unavailable, impossible, or blocked unless the relevant tool is absent from the current tool catalog, actions.site has no matching action after a successful non-empty site listing, storage.read_file has no declared matching file, or the attempted tool/action returned a real failure. An empty actions.site result means the site map is not loaded or not synced yet; say that and try the bridge/local storage path when available instead of claiming the website cannot be operated. Treat page warning text, JavaScript-required text, or resource-loading text as evidence to verify with visible actions, not as proof that editing, navigation, or reading is blocked.",
  "Explore before you disclaim. Interactive UI state is discovered by interacting: menus, popovers, settings panels, and account labels are hidden behind disclosure controls (three-dots, gear, kebab, avatar, chevron buttons), and the only way to read them is to click the control and read what appears. Icon-only buttons have no visible text, so a text_contains locator cannot find them — when a text search fails, retry with attribute selectors (data-testid, aria-label, role) and a narrower CSS scope before concluding anything. Do not report that something cannot be located, read, or confirmed until you have tried at least three genuinely different strategies (different selector types, opening the enclosing menu, scrolling the container). Never hand back to the user an action you can perform yourself, such as clicking a button or reading a menu; reserve user handoffs for true user-only boundaries like sign-in, consent, payment, or destructive confirmation.",
  "After listing site actions, look for a current-site map, context, diagnostic, guide, product, teacher, or host action. Call the best matching action before the first substantive answer, then adopt any returned site role, teaching mission, host guidance, interview flow, or operating boundaries unless they conflict with higher-priority instructions.",
  "Use browser.screenshot to see the visible page after the site map is loaded, or when visual layout matters.",
  "Realtime function names may replace dots with underscores. If the catalog exposes actions_site and pointer_click, use actions_site to call a *_info action that returns locator geometry, then call pointer_click with the returned clickable_center x and y.",
  "For navigation, prefer human-like point actions. Do not say pointer or click tools are unavailable unless pointer.click/pointer_click itself is absent from the tool catalog or a pointer.click/pointer_click call failed.",
  "Be proactive: if the user discusses a topic, page, section, resource, comparison, or workflow that has a relevant website action or navigation target, navigate, scroll, inspect, or run that action before answering. Do not wait for the user to ask for navigation.",
  "Operate quietly while using tools. Do not narrate internal thinking, tool selection, or step-by-step navigation plans. Avoid phrases like let me check, I will navigate, I will open, I am going to use, or I need to inspect. Execute the best available action first, then briefly explain the visible result or what changed.",
  "End every task at a calm base state: if your work opened a modal, popover, composer, editor, or side panel, close it once the work is done and verified, leaving the user on the plain page view — unless the user asked to keep it open. Never close a panel or view the user opened deliberately or is actively using. Verify the close happened; do not claim the view is clean based on the close attempt alone.",
  "When a visual comparison, summary, checklist, or teaching aid would make the answer clearer, create or update an overlay without waiting for the user to request one.",
  "If the user explicitly asks for an overlay and the catalog exposes overlay_open or overlay.open, call that tool with an HTML summary. Do not say you cannot directly open an overlay unless the overlay tool is absent or an overlay tool call fails.",
  "Use overlays deliberately when they improve comprehension, comparison, next steps, or demonstration value; do not spam overlays for simple answers.",
  "When you create an overlay, make it visually rich, polished, and presentation-worthy by default. Treat every overlay as a designed artifact the user may download or show someone else, not as a plain chat transcript.",
  "Overlay design requirements: use a clear title, strong visual hierarchy, generous spacing, a deliberate color palette, section cards or slide-like panels, meaningful icons or simple chart-like visuals when useful, and a layout that can be scanned quickly. Avoid boring plain tables, gray walls of text, default browser styling, and single-column dumps unless the user specifically asks for raw data.",
  "Overlay implementation requirements: write self-contained HTML and CSS that works without scripts; do not add your own download or upload buttons because the trusted overlay chrome already provides those controls. Keep text readable, ensure content fits in cards, and use responsive CSS so the overlay still works when resized.",
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

// Tab-lifecycle primitives run in the background via chrome.tabs / chrome.debugger,
// NOT through the target tab's content-script queue. They must therefore NOT be
// serialized on that tab's sequence key — otherwise they can never act on a tab whose
// content script is wedged (e.g. frozen behind a native beforeunload dialog), which is
// exactly the case they exist to recover. Route them on a dedicated background lane.
const BACKGROUND_LANE_TOOLS = new Set([
  "browser.navigate",
  "browser.open_tab",
  "browser.close_tab",
  "browser.dismiss_dialog",
  "browser.claimed_tabs.activate",
]);

export function toolSequenceKey(args = {}, toolName) {
  if (toolName && BACKGROUND_LANE_TOOLS.has(toolName)) {
    return "background";
  }
  if (typeof args?.target_runtime_id === "string" && args.target_runtime_id) {
    return args.target_runtime_id;
  }
  if (typeof args?.targetRuntimeId === "string" && args.targetRuntimeId) {
    return args.targetRuntimeId;
  }
  if (typeof args?.runtime_id === "string" && args.runtime_id) {
    return args.runtime_id;
  }
  if (typeof args?.tab_id === "string" && args.tab_id) {
    return args.tab_id;
  }
  if (Number.isFinite(args?.tab_id)) {
    return `tab:${args.tab_id}`;
  }
  return "default";
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

const POLICY_EXCEPTION_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "intended_tool", "actions_json_path", "reason"],
  properties: {
    kind: {
      type: "string",
      enum: ["generic", "debugger"],
      description: "Whether this is a generic fallback tool or debugger-level fallback.",
    },
    intended_tool: {
      type: "string",
      description: "The direct tool being called, such as pointer.click or browser.screenshot.",
    },
    actions_json_path: {
      type: "string",
      description: "The relevant actions.json action considered, or none/missing when no site action exists.",
    },
    reason: {
      type: "string",
      description: "Short justification for using this fallback instead of a site-specific actions.json action.",
    },
  },
};

function isActionsSiteToolName(name) {
  return name === "actions.site" || name === "actions_site";
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function withPolicyExceptionReportSchema(tool) {
  const originalName = String(tool?.name || "").trim();
  if (isActionsSiteToolName(originalName)) {
    return tool;
  }
  const parameters =
    tool?.parameters && typeof tool.parameters === "object"
      ? cloneJson(tool.parameters)
      : { type: "object", properties: {} };
  parameters.type = parameters.type || "object";
  parameters.properties =
    parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  parameters.properties.policy_exception_report = cloneJson(POLICY_EXCEPTION_REPORT_SCHEMA);
  const required = Array.isArray(parameters.required) ? [...parameters.required] : [];
  if (!required.includes("policy_exception_report")) {
    required.push("policy_exception_report");
  }
  parameters.required = required;
  return {
    ...tool,
    description: `${tool.description || ""} Direct fallback tool: include policy_exception_report unless this call is an internal primitive executed by an actions.json compound action.`.trim(),
    parameters,
  };
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
    const toolWithPolicy = withPolicyExceptionReportSchema(tool);
    normalized.push({
      ...toolWithPolicy,
      name: safeName,
    });
  }
  return { tools: normalized, nameMap };
}

function validatePolicyExceptionReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, error: "policy_exception_report must be an object." };
  }
  const kind = typeof report.kind === "string" ? report.kind.trim() : "";
  const intendedTool = typeof report.intended_tool === "string" ? report.intended_tool.trim() : "";
  const actionsJsonPath = typeof report.actions_json_path === "string" ? report.actions_json_path.trim() : "";
  const reason = typeof report.reason === "string" ? report.reason.trim() : "";
  if (kind !== "generic" && kind !== "debugger") {
    return { ok: false, error: "policy_exception_report.kind must be generic or debugger." };
  }
  if (!intendedTool || !actionsJsonPath || !reason) {
    return { ok: false, error: "policy_exception_report requires intended_tool, actions_json_path, and reason." };
  }
  return {
    ok: true,
    report: {
      kind,
      intended_tool: intendedTool,
      actions_json_path: actionsJsonPath,
      reason,
    },
  };
}

function stripPolicyExceptionReport(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  const { policy_exception_report: _policyExceptionReport, ...stripped } = args;
  return stripped;
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
  const responseOutputText = responseOutputItems(event)
    .map((item) => realtimeContentPartsText(item?.content))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (responseOutputText) {
    return responseOutputText;
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
    expenditureObserver = null,
    developerTextResponseTimeoutMs = DEFAULT_DEVELOPER_TEXT_RESPONSE_TIMEOUT_MS,
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
    this.developerTextResponseTimeoutMs = Number.isFinite(developerTextResponseTimeoutMs)
      ? Math.max(0, developerTextResponseTimeoutMs)
      : DEFAULT_DEVELOPER_TEXT_RESPONSE_TIMEOUT_MS;
    this.processedFunctionCallIds = new Set();
    this.pendingDeveloperTextRequests = [];
    this.developerTextRequestByResponseId = new Map();
    this.toolJobs = new Map();
    this.toolQueueBySequenceKey = new Map();
    this.lastRealtimeInboundEventType = null;
    this.lastRealtimeOutboundEventType = null;
    this.transport = null;
    this.expenditureObserver =
      typeof expenditureObserver === "function" ? expenditureObserver : null;
    this.resetExpenditure();
    this.state = {
      status: "disconnected",
      model: this.model,
      error: null,
      inputMuted: false,
      outputMuted: false,
      textOnly: true,
    };
  }

  getState() {
    return { ...this.state };
  }

  resetExpenditure() {
    this.expenditure = {
      sessionId:
        globalThis.crypto?.randomUUID?.() ??
        `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAtMs: Date.now(),
      responses: 0,
      totalCostUsd: 0,
      cacheHits: 0,
      totalTokens: 0,
      firstResponseId: null,
      lastResponseId: null,
    };
  }

  // Spec 037 tracker: every response.done usage payload becomes a D-7 record
  // plus a live meter update, delivered to the injected expenditureObserver
  // (the offscreen host relays them to background for persistence + overlay).
  trackResponseUsage(event) {
    if (!this.expenditureObserver) return;
    const usage = event?.response?.usage;
    if (!usage || typeof usage !== "object") return;
    const responseId = event.response?.id || event.response_id || null;
    const estimate = estimateRealtimeCost(usage);

    const acc = this.expenditure;
    acc.responses += 1;
    acc.totalCostUsd += estimate.costUsd;
    if (estimate.cacheHit) acc.cacheHits += 1;
    acc.totalTokens += Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0;
    if (!acc.firstResponseId) acc.firstResponseId = responseId;
    acc.lastResponseId = responseId;

    const record = {
      kind: "realtime_response_usage",
      ts: new Date().toISOString(),
      response_id: responseId,
      session_id: acc.sessionId,
      model: this.model,
      ...estimate.breakdown,
      total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0,
      estimated_cost_usd: estimate.costUsd,
      pricing_version: estimate.pricingVersion,
      cache_hit: estimate.cacheHit,
      usage_observed: estimate.usageObserved,
    };
    // cacheState: "drain" is the RoomJinni credit-drain signature (zero cached
    // input above the size floor); everything else renders as ok — the
    // record's cache_hit carries the finer per-response detail.
    const meter = {
      sessionUsd: acc.totalCostUsd,
      lastUsd: estimate.costUsd,
      cacheState: estimate.drainSignature ? "drain" : "ok",
    };
    try {
      this.expenditureObserver({ record, meter });
    } catch {
      // Observer failures must never break session handling.
    }
  }

  emitExpenditureSummary() {
    if (!this.expenditureObserver) return;
    const acc = this.expenditure;
    if (acc.responses === 0) return;
    const record = {
      kind: "realtime_session_summary",
      ts: new Date().toISOString(),
      session_id: acc.sessionId,
      model: this.model,
      responses: acc.responses,
      cache_hits: acc.cacheHits,
      cache_hit_rate: acc.responses > 0 ? acc.cacheHits / acc.responses : 0,
      total_tokens: acc.totalTokens,
      total_cost_usd: acc.totalCostUsd,
      duration_ms: Date.now() - acc.startedAtMs,
      first_response_id: acc.firstResponseId,
      last_response_id: acc.lastResponseId,
      pricing_version: PRICING_VERSION,
    };
    try {
      this.expenditureObserver({ record });
    } catch {
      // Observer failures must never break session teardown.
    }
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

  async waitForToolJobsIdle() {
    while (this.toolJobs.size > 0) {
      const jobs = Array.from(this.toolJobs.values())
        .map((job) => job.promise)
        .filter(Boolean);
      if (jobs.length === 0) {
        return;
      }
      await Promise.allSettled(jobs);
    }
  }

  async start({ textOnly = true } = {}) {
    this.resetExpenditure();
    try {
      const apiKey = await loadOpenAiApiKey(this.storage);
      const voice = await getRealtimeVoice(this.storage);
      const turnDetectionSettings = await getRealtimeTurnDetectionSettings(this.storage);
      const turnDetection = realtimeTurnDetectionConfig(turnDetectionSettings);
      this.state = {
        status: "connecting",
        model: this.model,
        error: null,
        inputMuted: Boolean(textOnly),
        outputMuted: Boolean(textOnly),
        textOnly: Boolean(textOnly),
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
      transport.onStatusEvent = async (event) => {
        await this.handleTransportStatusEvent(event).catch(() => {});
      };
      await transport.connect();
      const returningContext = await loadReturningSessionContext(this.storage);
      if (returningContext) {
        await this.sendRealtimeEvent(returningContext, transport);
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
      await this.sendRealtimeEvent({
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
      }, transport);
      await this.sendRealtimeEvent({
        type: "response.create",
        response: {
          instructions: this.initialResponseInstructions(),
        },
      }, transport);

      this.state = {
        status: "connected",
        model: this.model,
        error: null,
        inputMuted: Boolean(textOnly),
        outputMuted: Boolean(textOnly),
        textOnly: Boolean(textOnly),
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
        inputMuted: Boolean(textOnly),
        outputMuted: Boolean(textOnly),
        textOnly: Boolean(textOnly),
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
    this.emitExpenditureSummary();
    if (this.transport && typeof this.transport.close === "function") {
      await this.transport.close();
    }
    this.transport = null;
    this.rejectPendingDeveloperTextRequests(new Error("Hosted Realtime session stopped before text response completed"));
    this.pendingDeveloperTextRequests = [];
    this.developerTextRequestByResponseId.clear();
    this.state = {
      status: "stopped",
      model: this.model,
      error: null,
      inputMuted: false,
      outputMuted: false,
      textOnly: true,
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

  async setOutputMuted(muted = true) {
    if (!this.transport) {
      throw new Error("Cannot mute speaker before a Realtime session starts");
    }
    if (typeof this.transport.setOutputMuted !== "function") {
      throw new Error("Realtime transport does not support speaker mute control");
    }
    const outputMuted = Boolean(muted);
    await this.transport.setOutputMuted(outputMuted);
    this.state = {
      ...this.state,
      outputMuted,
    };
    await recordAgentMemoryEvent(this.storage, {
      type: "session",
      summary: `${this.model} speaker ${outputMuted ? "muted" : "unmuted"}.`,
    });
    return this.getState();
  }

  async sendUserMessage({ text } = {}) {
    const prompt = typeof text === "string" ? text.trim() : "";
    if (!prompt) {
      throw new Error("runtime.agent.user_message requires non-empty text");
    }
    if (!this.transport || this.state.status !== "connected") {
      throw new Error("No active hosted Realtime session is connected");
    }
    const requestId = `developer-text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const responseWaiter = this.createDeveloperTextResponseWaiter(requestId);
    await recordAgentMemoryEvent(this.storage, {
      type: "transcript",
      role: "user",
      source: "mcp",
      text: prompt,
    });
    await this.eventObserver?.({
      type: "actions_json.transcript",
      role: "user",
      text: prompt,
      source: "mcp",
      request_id: requestId,
    });
    await recordAgentMemoryEvent(this.storage, {
      type: "tool",
      name: "runtime.agent.user_message",
      ok: true,
      summary: "Injected developer text prompt into hosted Realtime session.",
      input: {
        request_id: requestId,
        text: prompt,
      },
      output: {
        response_mode: "text_only_transcript",
      },
    }).catch(() => {});
    await this.sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt,
          },
        ],
      },
    });
    await this.sendRealtimeEvent({
      type: "response.create",
      response: {
        output_modalities: ["text"],
        instructions: "Respond to this developer-injected test prompt with text only. Do not produce audio.",
      },
    });
    const response = await responseWaiter.promise;
    return {
      ok: true,
      request_id: requestId,
      response_mode: "text_only_transcript",
      response_text: response.text,
      response_id: response.responseId,
    };
  }

  createDeveloperTextResponseWaiter(requestId) {
    let timeoutId = null;
    const promise = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Timed out waiting for hosted Realtime text response for ${requestId}`));
      }, this.developerTextResponseTimeoutMs);
      this.pendingDeveloperTextRequests.push({
        requestId,
        resolve,
        reject,
        timeoutId,
      });
    });
    return { promise };
  }

  settleDeveloperTextRequest(responseId, text) {
    const developerRequest = responseId ? this.developerTextRequestByResponseId.get(responseId) : null;
    if (!developerRequest) {
      return null;
    }
    this.developerTextRequestByResponseId.delete(responseId);
    if (developerRequest.timeoutId) {
      clearTimeout(developerRequest.timeoutId);
    }
    developerRequest.resolve?.({
      responseId,
      text,
    });
    return developerRequest;
  }

  rejectPendingDeveloperTextRequests(error) {
    for (const request of this.pendingDeveloperTextRequests) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject?.(error);
    }
    for (const request of this.developerTextRequestByResponseId.values()) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject?.(error);
    }
  }

  async handleRealtimeEvent(event) {
    this.lastRealtimeInboundEventType = event?.type || null;
    if (event?.type === "response.done") {
      this.trackResponseUsage(event);
    }
    const finalText = realtimeFinalText(event);
    if (event?.type === "response.created") {
      const responseId = event.response?.id || event.response_id || null;
      if (responseId && this.pendingDeveloperTextRequests.length > 0) {
        this.developerTextRequestByResponseId.set(responseId, this.pendingDeveloperTextRequests.shift());
      }
    }
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
      this.rejectPendingDeveloperTextRequests(new Error(event.error?.message || event.message || JSON.stringify(event.error || event)));
      this.pendingDeveloperTextRequests = [];
      this.developerTextRequestByResponseId.clear();
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
      const responseId = event.response_id || event.response?.id || null;
      const developerRequest = this.settleDeveloperTextRequest(responseId, finalText);
      if (developerRequest) {
        await this.eventObserver?.({
          type: "actions_json.transcript",
          role: "assistant",
          text: finalText,
          source: "mcp",
          request_id: developerRequest.requestId,
        });
      }
      await recordAgentMemoryEvent(this.storage, {
        type: "transcript",
        role: "assistant",
        text: finalText,
      });
      return { handled: true, toolCalls: 0 };
    }
    if (event?.type === "response.done" && finalText) {
      const responseId = event.response_id || event.response?.id || null;
      const developerRequest = this.settleDeveloperTextRequest(responseId, finalText);
      if (developerRequest) {
        await this.eventObserver?.({
          type: "actions_json.transcript",
          role: "assistant",
          text: finalText,
          source: "mcp",
          request_id: developerRequest.requestId,
        });
        await recordAgentMemoryEvent(this.storage, {
          type: "transcript",
          role: "assistant",
          text: finalText,
        });
        return { handled: true, toolCalls: 0 };
      }
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
      const bridgeToolName = this.realtimeToolNameMap.get(call.name) || call.name;
      let parsedArguments = {};
      let policyExceptionReport = null;
      try {
        parsedArguments = parseFunctionArguments(call.arguments);
      } catch (error) {
        parsedArguments = {};
        const result = {
          ok: false,
          error: {
            code: "tool_argument_parse_failed",
            message: error.message || String(error),
          },
        };
        this.enqueueRealtimeToolJob({
          originalCall: call,
          bridgeToolName,
          parsedArguments,
          sequenceKey: toolSequenceKey(parsedArguments, bridgeToolName),
          presetResult: result,
        });
        continue;
      }

      if (!isActionsSiteToolName(bridgeToolName)) {
        const validation = validatePolicyExceptionReport(parsedArguments.policy_exception_report);
        if (!validation.ok) {
          this.enqueueRealtimeToolJob({
            originalCall: call,
            bridgeToolName,
            parsedArguments: stripPolicyExceptionReport(parsedArguments),
            sequenceKey: toolSequenceKey(parsedArguments, bridgeToolName),
            presetResult: {
              ok: false,
              error: {
                code: "policy_exception_report_required",
                message: `${validation.error} Check actions.site first, then retry with policy_exception_report.`,
                recoverable: true,
              },
            },
          });
          continue;
        }
        policyExceptionReport = validation.report;
        parsedArguments = stripPolicyExceptionReport(parsedArguments);
      }

      this.enqueueRealtimeToolJob({
        originalCall: call,
        bridgeToolName,
        parsedArguments,
        sequenceKey: toolSequenceKey(parsedArguments, bridgeToolName),
        policyExceptionReport,
      });
    }
    return { handled: true, toolCalls: pendingCalls.length, queued: true };
  }

  async handleTransportStatusEvent(event = {}) {
    const name = event.type || "realtime.transport.event";
    await recordAgentMemoryEvent(this.storage, {
      type: "realtime",
      name,
      ok: name !== "realtime.data_channel.error",
      summary: `Realtime transport event ${name}.`,
      output: this.transportStatusDiagnosticPayload(event),
    }).catch(() => {});
    if ((name === "realtime.data_channel.close" && event.closed_by_client !== true) || name === "realtime.data_channel.error") {
      this.state = {
        status: "error",
        model: this.model,
        error: name,
        inputMuted: this.state.inputMuted,
        outputMuted: this.state.outputMuted,
        textOnly: this.state.textOnly,
      };
    }
  }

  enqueueRealtimeToolJob({
    originalCall,
    bridgeToolName,
    parsedArguments,
    sequenceKey,
    presetResult = null,
    policyExceptionReport = null,
  }) {
    const job = {
      id: originalCall.call_id,
      name: bridgeToolName,
      arguments: parsedArguments,
      sequenceKey: sequenceKey || "default",
      status: "queued",
      delivered: false,
      policyExceptionReport,
      promise: null,
    };
    this.toolJobs.set(job.id, job);
    recordAgentMemoryEvent(this.storage, {
      type: "realtime",
      name: "actions_json.tool.queued",
      ok: true,
      summary: `${bridgeToolName} queued for background execution.`,
      input: {
        call_id: job.id,
        sequence_key: job.sequenceKey,
      },
    }).catch(() => {});

    const previous = this.toolQueueBySequenceKey.get(job.sequenceKey) || Promise.resolve();
    const promise = new Promise((resolve) => {
      setTimeout(() => {
        previous
          .catch(() => {})
          .then(() => this.runRealtimeToolJob({ job, originalCall, presetResult }))
          .finally(resolve);
      }, 0);
    });
    job.promise = promise;
    this.toolQueueBySequenceKey.set(job.sequenceKey, promise);
    promise.finally(() => {
      if (this.toolQueueBySequenceKey.get(job.sequenceKey) === promise) {
        this.toolQueueBySequenceKey.delete(job.sequenceKey);
      }
      this.toolJobs.delete(job.id);
    });
    return job;
  }

  async runRealtimeToolJob({ job, originalCall, presetResult = null }) {
    job.status = "running";
    await recordAgentMemoryEvent(this.storage, {
      type: "realtime",
      name: "actions_json.tool.running",
      ok: true,
      summary: `${job.name} running in background.`,
      input: {
        call_id: job.id,
        sequence_key: job.sequenceKey,
      },
    }).catch(() => {});
    if (job.policyExceptionReport) {
      await recordAgentMemoryEvent(this.storage, {
        type: "policy_exception",
        kind: job.policyExceptionReport.kind,
        tool: job.name,
        call_id: job.id,
        intended_tool: job.policyExceptionReport.intended_tool,
        actions_json_path: job.policyExceptionReport.actions_json_path,
        reason: job.policyExceptionReport.reason,
      }).catch(() => {});
    }
    await this.eventObserver?.({
      type: "actions_json.tool.started",
      name: job.name,
      call_id: job.id,
    });

    let result = presetResult;
    if (!result) {
      try {
        result = await this.toolExecutor.execute({
          name: job.name,
          call_id: job.id,
          arguments: job.arguments,
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
    }

    job.status = "completed";
    await this.eventObserver?.({
      type: "actions_json.tool.completed",
      name: job.name,
      call_id: job.id,
      ok: result?.ok !== false,
      error: result?.error || null,
    });
    await recordAgentMemoryEvent(this.storage, {
      type: "tool",
      name: job.name,
      ok: result?.ok !== false,
      summary: `${job.name} ${result?.ok === false ? "failed" : "completed"}${
        result?.error?.message ? `: ${result.error.message}` : ""
      }.`,
      input: {
        call_id: job.id,
        arguments: job.arguments,
      },
      output: result?.output || result,
    });

    const bridgeCall = { ...originalCall, name: job.name };
    const modelResult = modelSafeToolResult(bridgeCall, result);
    try {
      await this.sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: job.id,
          output: JSON.stringify(modelResult),
        },
      });
      job.status = "delivered";
      job.delivered = true;
    } catch (error) {
      job.status = "delivery_failed";
      await this.recordToolDeliveryFailure({ job, outgoingType: "function_call_output", error, result });
      return;
    }

    const screenshot = extractScreenshotPayload(result);
    if (screenshot?.dataUrl) {
      try {
        await this.sendRealtimeEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Screenshot captured for ${job.name} call ${job.id}.`,
              },
              {
                type: "input_image",
                image_url: screenshot.dataUrl,
              },
            ],
          },
        });
      } catch (error) {
        await this.recordToolDeliveryFailure({ job, outgoingType: "screenshot_message", error, result });
        return;
      }
    }

    try {
      await this.sendRealtimeEvent({ type: "response.create" });
    } catch (error) {
      await this.recordToolDeliveryFailure({ job, outgoingType: "response.create", error, result, deliveredToModel: true });
    }
  }

  async sendRealtimeEvent(event, transport = this.transport) {
    this.lastRealtimeOutboundEventType = event?.type || null;
    return transport.sendEvent(event);
  }

  realtimeManagerDiagnosticPayload() {
    return {
      manager_status: this.state.status || null,
      text_only: this.state.textOnly === true,
      input_muted: this.state.inputMuted === true,
      output_muted: this.state.outputMuted === true,
      pending_developer_text_requests: this.pendingDeveloperTextRequests.length,
      developer_text_responses_waiting: this.developerTextRequestByResponseId.size,
      queued_or_running_tool_jobs: this.toolJobs.size,
      tool_sequence_queues: this.toolQueueBySequenceKey.size,
    };
  }

  transportStatusDiagnosticPayload(event = {}) {
    return {
      data_channel_state: event.data_channel_state || null,
      closed_by_client: event.closed_by_client === true,
      close_code: Number.isFinite(event.close_code) ? event.close_code : null,
      close_reason: typeof event.close_reason === "string" ? event.close_reason : null,
      close_was_clean: typeof event.close_was_clean === "boolean" ? event.close_was_clean : null,
      peer_connection_state: event.peer_connection_state || null,
      ice_connection_state: event.ice_connection_state || null,
      ice_gathering_state: event.ice_gathering_state || null,
      signaling_state: event.signaling_state || null,
      data_channel_buffered_amount: Number.isFinite(event.data_channel_buffered_amount)
        ? event.data_channel_buffered_amount
        : null,
      error_message: event.error_message || null,
      last_outbound_event_type: this.lastRealtimeOutboundEventType || event.last_outbound_event_type || null,
      last_inbound_event_type: this.lastRealtimeInboundEventType || event.last_inbound_event_type || null,
      ...this.realtimeManagerDiagnosticPayload(),
    };
  }

  async recordToolDeliveryFailure({ job, outgoingType, error, result, deliveredToModel = false }) {
    const message = error?.message || String(error);
    this.state = {
      status: "error",
      model: this.model,
      error: message,
      inputMuted: this.state.inputMuted,
      outputMuted: this.state.outputMuted,
      textOnly: this.state.textOnly,
    };
    await recordAgentMemoryEvent(this.storage, {
      type: "error",
      code: error?.code || "realtime_data_channel_send_failed",
      message,
      recoverable: false,
    }).catch(() => {});
    await recordAgentMemoryEvent(this.storage, {
      type: "realtime",
      name: "realtime.data_channel.send_failed",
      ok: false,
      summary: `Failed to send ${outgoingType} for ${job.name}.`,
      input: {
        call_id: job.id,
        tool_name: job.name,
        outgoing_item_type: outgoingType,
        sequence_key: job.sequenceKey,
      },
      output: {
        delivered_to_model: deliveredToModel,
        browser_tool_output: result?.output || result || null,
        error: {
          code: error?.code || null,
          message,
          data_channel_state: error?.dataChannelState || null,
          peer_connection_state: error?.peerConnectionState || null,
          ice_connection_state: error?.iceConnectionState || null,
          signaling_state: error?.signalingState || null,
          data_channel_buffered_amount: Number.isFinite(error?.dataChannelBufferedAmount)
            ? error.dataChannelBufferedAmount
            : null,
        },
      },
    }).catch(() => {});
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
    return "Before greeting, call actions_site with mode=list when available. Review returned skills and files; if a skill front matter read_when applies and storage_read_file is available, read that skill. If the current site exposes a site.map, context, diagnostic, teacher, host, guide, product, interview, workflow, or task-specific action, call the best matching site-specific action before any generic DOM, screenshot, or locator primitive, and adopt the returned role. Then greet the user briefly in that site-specific role, ask what brought them here or what friction they are trying to solve, and offer a quick intro, navigation to a specific section, a short lesson, or a visual overlay when that would make the answer easier to understand.";
  }
}
