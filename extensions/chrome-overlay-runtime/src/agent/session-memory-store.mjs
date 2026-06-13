export const AGENT_MEMORY_STORAGE_KEY = "ACTIONS_JSON_AGENT_MEMORY_V1";

const MAX_DIAGNOSTIC_EVENTS = 2000;
const DEFAULT_SESSION_LOG_LIMIT = MAX_DIAGNOSTIC_EVENTS;
const MAX_SESSION_LOG_LIMIT = MAX_DIAGNOSTIC_EVENTS;
const REHYDRATION_EVENT_LIMIT = 80;
const MAX_TEXT_LENGTH = 700;
const MAX_COMPACT_DEPTH = 5;
const MAX_COMPACT_ARRAY_ITEMS = 20;
const MAX_COMPACT_OBJECT_KEYS = 40;

function nowIso() {
  return new Date().toISOString();
}

function newVisitorId() {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `local-agent-${random}`;
}

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) {
      return "[omitted image data URL]";
    }
    if (/^sk-[A-Za-z0-9_-]+/.test(value)) {
      return "[redacted secret]";
    }
    return normalizeText(value, 500);
  }
  if (depth >= MAX_COMPACT_DEPTH) {
    return "[omitted nested value]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_COMPACT_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const compacted = {};
    for (const [key, nested] of Object.entries(value).slice(0, MAX_COMPACT_OBJECT_KEYS)) {
      if (/data_?url/i.test(key) || /base64/i.test(key)) {
        continue;
      }
      if (/api[_-]?key|authorization|token|secret/i.test(key)) {
        compacted[key] = "[redacted secret]";
        continue;
      }
      compacted[key] = compactValue(nested, depth + 1);
    }
    return compacted;
  }
  return normalizeText(String(value), 240);
}

function sanitizeMemoryEvent(event = {}) {
  const base = {
    id: event.id || `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: normalizeText(event.type, 80) || "event",
    timestamp: event.timestamp || nowIso(),
  };

  if (event.targetUrl) {
    base.targetUrl = normalizeText(event.targetUrl, 500);
  }

  if (event.type === "transcript") {
    return {
      ...base,
      role: normalizeText(event.role, 40) || "unknown",
      text: normalizeText(event.text),
    };
  }

  if (event.type === "tool" || event.type === "tool_call") {
    const toolEvent = {
      ...base,
      type: "tool",
      name: normalizeText(event.name || event.tool, 120) || "unknown",
      ok: Boolean(event.ok),
      summary: normalizeText(event.summary),
    };
    if (event.input && typeof event.input === "object") {
      toolEvent.input = compactValue(event.input);
    }
    if (event.output && typeof event.output === "object") {
      toolEvent.output = compactValue(event.output);
    }
    return toolEvent;
  }

  if (event.type === "realtime") {
    const realtimeEvent = {
      ...base,
      name: normalizeText(event.name, 160) || "unknown",
      ok: event.ok !== false,
      summary: normalizeText(event.summary),
    };
    if (event.input && typeof event.input === "object") {
      realtimeEvent.input = compactValue(event.input);
    }
    if (event.output && typeof event.output === "object") {
      realtimeEvent.output = compactValue(event.output);
    }
    return realtimeEvent;
  }

  if (event.type === "policy_exception") {
    return {
      ...base,
      kind: normalizeText(event.kind, 40) || "generic",
      tool: normalizeText(event.tool, 120) || "unknown",
      call_id: normalizeText(event.call_id, 160),
      intended_tool: normalizeText(event.intended_tool, 120),
      actions_json_path: normalizeText(event.actions_json_path, 240),
      reason: normalizeText(event.reason, 1000) || "No reason provided",
    };
  }

  if (event.type === "workflow") {
    const workflowEvent = {
      ...base,
      name: normalizeText(event.name, 160) || "unknown",
      ok: event.ok !== false,
      summary: normalizeText(event.summary),
    };
    if (event.input && typeof event.input === "object") {
      workflowEvent.input = compactValue(event.input);
    }
    if (event.output && typeof event.output === "object") {
      workflowEvent.output = compactValue(event.output);
    }
    if (Array.isArray(event.steps)) {
      workflowEvent.steps = event.steps.slice(0, 50).map((step) => compactValue(step));
    }
    return workflowEvent;
  }

  if (event.type === "error") {
    return {
      ...base,
      code: normalizeText(event.code, 120),
      message: normalizeText(event.message || event.summary, 1000) || "Unknown error",
      recoverable: event.recoverable !== false,
    };
  }

  if (event.type === "screenshot") {
    return {
      ...base,
      purpose: normalizeText(event.purpose, 240),
      metadata: {
        width: Number.isFinite(event.width) ? event.width : null,
        height: Number.isFinite(event.height) ? event.height : null,
        byteLength: Number.isFinite(event.byteLength) ? event.byteLength : null,
        format: normalizeText(event.format, 40) || "image",
      },
    };
  }

  return {
    ...base,
    summary: normalizeText(event.summary || event.text),
  };
}

async function loadMemory(storage) {
  const stored = await storage.get(AGENT_MEMORY_STORAGE_KEY);
  const memory = stored?.[AGENT_MEMORY_STORAGE_KEY];
  if (!memory || typeof memory !== "object") {
    return {
      visitorId: newVisitorId(),
      events: [],
    };
  }
  return {
    visitorId: typeof memory.visitorId === "string" ? memory.visitorId : newVisitorId(),
    events: Array.isArray(memory.events) ? memory.events : [],
  };
}

async function saveMemory(storage, memory) {
  await storage.set({
    [AGENT_MEMORY_STORAGE_KEY]: {
      visitorId: memory.visitorId || newVisitorId(),
      events: memory.events.slice(-MAX_DIAGNOSTIC_EVENTS),
    },
  });
}

export async function recordAgentMemoryEvent(storage, event) {
  const memory = await loadMemory(storage);
  const sanitized = sanitizeMemoryEvent(event);
  memory.events.push(sanitized);
  await saveMemory(storage, memory);
  return sanitized;
}

export async function getAgentMemoryState(storage) {
  const stored = await storage.get(AGENT_MEMORY_STORAGE_KEY);
  const memory = stored?.[AGENT_MEMORY_STORAGE_KEY];
  const events = Array.isArray(memory?.events) ? memory.events : [];
  return {
    configured: events.length > 0,
    eventCount: events.length,
    visitorId: typeof memory?.visitorId === "string" ? memory.visitorId : null,
  };
}

export async function getAgentSessionLog(storage, { limit = DEFAULT_SESSION_LOG_LIMIT } = {}) {
  const stored = await storage.get(AGENT_MEMORY_STORAGE_KEY);
  const memory = stored?.[AGENT_MEMORY_STORAGE_KEY];
  const events = Array.isArray(memory?.events) ? memory.events : [];
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_SESSION_LOG_LIMIT, MAX_SESSION_LOG_LIMIT));
  return {
    ok: true,
    visitorId: typeof memory?.visitorId === "string" ? memory.visitorId : null,
    eventCount: events.length,
    events: events.slice(-boundedLimit),
  };
}

export async function clearAgentMemory(storage) {
  await storage.remove(AGENT_MEMORY_STORAGE_KEY);
}

function summarizeEvent(event) {
  if (event.type === "transcript" && event.text) {
    return `${event.role || "unknown"}: ${event.text}`;
  }
  if (event.type === "tool") {
    return `tool ${event.name || "unknown"} ${event.ok ? "ok" : "error"}${event.summary ? `: ${event.summary}` : ""}`;
  }
  if (event.type === "screenshot") {
    const size = [event.metadata?.width, event.metadata?.height].filter(Boolean).join("x");
    const suffix = event.purpose ? `: ${event.purpose}` : "";
    return `screenshot${size ? ` ${size}` : ""}${event.targetUrl ? ` ${event.targetUrl}` : ""}${suffix}`;
  }
  if (event.type === "error") {
    return `error${event.code ? ` ${event.code}` : ""}: ${event.message || event.summary || "Unknown error"}`;
  }
  if (event.type === "realtime") {
    return `realtime ${event.name || "unknown"}${event.summary ? `: ${event.summary}` : ""}`;
  }
  return event.summary ? `${event.type}: ${event.summary}` : null;
}

export async function loadReturningSessionContext(storage) {
  const stored = await storage.get(AGENT_MEMORY_STORAGE_KEY);
  const memory = stored?.[AGENT_MEMORY_STORAGE_KEY];
  const events = Array.isArray(memory?.events) ? memory.events : [];
  if (events.length === 0) {
    return null;
  }

  const lines = events
    .slice(-REHYDRATION_EVENT_LIMIT)
    .map(summarizeEvent)
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  return {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: [
            "Previous local actions.json agent context:",
            ...lines.map((line) => `- ${line}`),
          ].join("\n"),
        },
      ],
    },
  };
}
