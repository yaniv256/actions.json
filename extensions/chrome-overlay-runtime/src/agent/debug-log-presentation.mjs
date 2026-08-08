/**
 * U9 — the Debug tab: turning the agent session log into something a human can
 * read while a failure is still happening.
 *
 * WHY THIS EXISTS
 * ---------------
 * a user hit a failure during a live install (ext 0.1.248, 2026-07-27): the
 * agent replied, ran a tool successfully, issued a post-tool response, and the
 * continuation failed ~135-256ms later. The user saw SILENCE. The investigation
 * could prove WHERE it broke and could never learn WHY, because the logging
 * path removed the decisive field — `status_details` — before writing.
 *
 * That observability defect is fixed (5f8dc90: `realtimeEventIsFailure` plus
 * bounded `status_details` in `realtimeDiagnosticPayload`). But the log it
 * writes to was surfaced NOWHERE in the UI. `getAgentSessionLog` shipped fully
 * built and test-covered with ZERO production callers — someone wrote the
 * reader and never wired it to a screen. This module is that wiring's brain.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN agent-surface.js
 * ---------------------------------------------------
 * Same reason as pill-presentation.mjs: agent-surface.js reaches for `document` at
 * import time, so nothing in it can be unit-tested. The decisions that fail
 * invisibly — which outcome state an entry resolves to, whether a failed
 * response reads as a failure, how a status_details message is truncated,
 * whether the unread dot is lit — live here behind plain data, so a node test
 * exercises the real decision rather than a re-implementation of it.
 *
 * THE RULE THAT MATTERS MOST
 * --------------------------
 * A failed entry must render as a FAILURE. That is precisely the defect
 * 5f8dc90 fixed one layer down, and a dev tab that painted it green would
 * re-create Greg's silence one layer up — the log would say "fine" again, just
 * in a different font.
 */

/**
 * The three outcome states, deliberately three and not two.
 *
 * `indeterminate` is NOT a flavour of failure. The runtime returns
 * `failure_class: "mutation_outcome_indeterminate"` with `retry_safe: false`
 * and `recoverable: true` — meaning the mutation MAY ALREADY HAVE COMMITTED
 * Post-mutation verification failures remain indeterminate until independently resolved.
 * Collapsing it into "failed" tells the user to retry something that may have
 * already landed, which duplicates comments, cards, and checklists. So it gets
 * its own state, its own token, and its own colour.
 */
export const DEBUG_OUTCOMES = Object.freeze(["success", "failure", "indeterminate", "neutral"]);

/**
 * The failure_class values that mean "we cannot tell whether it committed".
 * A set rather than a string compare so a future sibling class joins in one
 * place instead of being missed at one of several call sites.
 */
export const INDETERMINATE_FAILURE_CLASSES = Object.freeze(["mutation_outcome_indeterminate"]);

/**
 * Per-outcome presentation token.
 *
 * Colours are drawn from the surface's existing vocabulary (agent-surface.html
 * `:root`) rather than invented: --ok green, --danger red, and the busy amber
 * already used for `working`. `indeterminate` takes amber precisely because it
 * is the surface's existing "in-between, needs attention, not an alarm" hue —
 * it must be distinguishable from BOTH green and red at a glance.
 */
export const DEBUG_OUTCOME_TOKENS = Object.freeze({
  success: Object.freeze({ label: "OK", hue: "#24744a", background: "#e9f6ee" }),
  failure: Object.freeze({ label: "Failed", hue: "#b64040", background: "#fbeaea" }),
  indeterminate: Object.freeze({ label: "Indeterminate", hue: "#d9480f", background: "#fff4e6" }),
  neutral: Object.freeze({ label: "", hue: "#626b7a", background: "#f1f5f9" }),
});

/** Entry types the log discriminates on, per session-memory-store's sanitizer. */
export const DEBUG_ENTRY_TYPES = Object.freeze([
  "transcript",
  "tool",
  "screenshot",
  "error",
  "realtime",
  "session",
]);

/**
 * How much of a status_details message survives.
 *
 * Truncation preserves the START. The cause lives at the front of an error
 * string ("context_length_exceeded", "invalid_request_error"); the tail is
 * usually an echo of the offending payload. Cutting from the front would throw
 * away the only part worth reading — which is the same class of mistake as
 * dropping the field entirely.
 */
export const STATUS_DETAIL_DISPLAY_LIMIT = 240;

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Keep the beginning; mark the cut so a truncated string is never mistaken for a complete one. */
export function truncateFromStart(value, limit = STATUS_DETAIL_DISPLAY_LIMIT) {
  const raw = text(value);
  if (!raw) return null;
  const bound = Math.max(1, Number(limit) || STATUS_DETAIL_DISPLAY_LIMIT);
  return raw.length > bound ? `${raw.slice(0, bound)}…` : raw;
}

/**
 * Pull the diagnostic that made this whole unit necessary out of an entry.
 *
 * Returns null when the entry carries no status_details, so a healthy realtime
 * event does not sprout an empty diagnostic block.
 */
export function extractStatusDetails(entry) {
  const details = entry?.output?.status_details;
  if (!details || typeof details !== "object") return null;
  const error = details.error && typeof details.error === "object" ? details.error : null;
  const resolved = {
    type: text(details.type),
    reason: text(details.reason),
    errorType: error ? text(error.type) : null,
    code: error ? text(error.code) : null,
    param: error ? text(error.param) : null,
    message: error ? truncateFromStart(error.message) : null,
  };
  const carriesSomething = Object.values(resolved).some((value) => value != null);
  return carriesSomething ? resolved : null;
}

/** The runtime's failure classification, wherever a writer happened to put it. */
export function extractFailureClass(entry) {
  return (
    text(entry?.output?.failure_class) ||
    text(entry?.output?.error?.failure_class) ||
    text(entry?.failure_class) ||
    null
  );
}

/**
 * Resolve an entry's outcome. THE decision this module exists for.
 *
 * Order matters and is deliberate:
 *   1. Indeterminate wins over failure. An indeterminate outcome also carries
 *      ok:false, so checking `ok` first would swallow it into "failed" and
 *      tell the user to retry a mutation that may have committed.
 *   2. `ok === false` is a failure. Explicitly `=== false` rather than falsy:
 *      an entry with no `ok` field (transcript, screenshot, session) is not a
 *      failure, it simply has no outcome — that is `neutral`, not green.
 *   3. Errors are always failures regardless of any other field.
 */
export function resolveEntryOutcome(entry) {
  if (!entry || typeof entry !== "object") return "neutral";

  if (INDETERMINATE_FAILURE_CLASSES.includes(extractFailureClass(entry))) {
    return "indeterminate";
  }
  if (entry.type === "error") {
    return "failure";
  }
  if (entry.ok === false) {
    return "failure";
  }
  if (entry.ok === true) {
    return "success";
  }
  return "neutral";
}

/** Does this entry represent something the user should be alerted to? */
export function entryIsError(entry) {
  const outcome = resolveEntryOutcome(entry);
  return outcome === "failure" || outcome === "indeterminate";
}

const TYPE_LABELS = Object.freeze({
  transcript: "Transcript",
  tool: "Tool",
  screenshot: "Screenshot",
  error: "Error",
  realtime: "Realtime",
  session: "Session",
});

/**
 * The per-type field list, in the order it should be read.
 *
 * Each entry type is projected to the fields session-memory-store's sanitizer
 * actually preserves for it. Returning [] for an unknown type is fine: the
 * headline and summary still render, so a new event type surfaces as readable
 * text rather than disappearing.
 */
function fieldsForEntry(entry) {
  const fields = [];
  const push = (label, value) => {
    const resolved = text(value == null ? null : String(value));
    if (resolved) fields.push({ label, value: resolved });
  };

  if (entry.type === "transcript") {
    push("role", entry.role);
    push("text", entry.text);
    return fields;
  }
  if (entry.type === "tool") {
    push("name", entry.name);
    push("ok", entry.ok === true ? "true" : entry.ok === false ? "false" : null);
    push("summary", entry.summary);
    push("error", entry.error);
    if (entry.output && typeof entry.output === "object") {
      push("output", safeJson(entry.output));
    }
    return fields;
  }
  if (entry.type === "screenshot") {
    const width = entry.metadata?.width;
    const height = entry.metadata?.height;
    if (Number.isFinite(width) && Number.isFinite(height)) {
      push("size", `${width}x${height}`);
    }
    push("targetUrl", entry.targetUrl);
    push("purpose", entry.purpose);
    return fields;
  }
  if (entry.type === "error") {
    push("code", entry.code);
    push("message", entry.message);
    push("summary", entry.summary);
    return fields;
  }
  if (entry.type === "realtime") {
    push("name", entry.name);
    push("summary", entry.summary);
    if (entry.output && typeof entry.output === "object") {
      push("output", safeJson(entry.output));
    }
    return fields;
  }
  push("summary", entry.summary);
  return fields;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return null;
  }
}

/**
 * Project one stored event into everything the renderer needs.
 *
 * The renderer stays dumb on purpose: every judgement — outcome, token,
 * diagnostic extraction, truncation — has already happened here, where a node
 * test can see it.
 */
export function presentLogEntry(entry = {}) {
  const type = text(entry?.type) || "event";
  const outcome = resolveEntryOutcome(entry);
  return {
    id: text(entry?.id) || null,
    type,
    typeLabel: TYPE_LABELS[type] || type,
    timestamp: text(entry?.timestamp) || null,
    outcome,
    token: DEBUG_OUTCOME_TOKENS[outcome] || DEBUG_OUTCOME_TOKENS.neutral,
    summary: text(entry?.summary) || null,
    failureClass: extractFailureClass(entry),
    statusDetails: extractStatusDetails(entry),
    fields: fieldsForEntry(entry && typeof entry === "object" ? entry : {}),
    isError: entryIsError(entry),
  };
}

/**
 * Project a whole `getAgentSessionLog` result.
 *
 * An empty log is an EMPTY STATE, never an error. "No events yet" is the
 * ordinary condition of a fresh session, and rendering it red would train the
 * user to ignore red — the same "failure signal nobody trusts" problem the
 * realtime classifier deliberately avoids by not flagging user interruptions.
 */
export function presentSessionLog(log = {}) {
  const events = Array.isArray(log?.events) ? log.events : [];
  const entries = events.map((event) => presentLogEntry(event));
  return {
    ok: log?.ok !== false,
    visitorId: text(log?.visitorId) || null,
    eventCount: Number.isFinite(log?.eventCount) ? log.eventCount : entries.length,
    entries,
    isEmpty: entries.length === 0,
    emptyMessage: "No session events recorded yet.",
    errorCount: entries.filter((entry) => entry.isError).length,
  };
}

/**
 * The unread-error dot.
 *
 * Tracks errors by entry id rather than by count: a bounded log drops old
 * events off the front, so a count can go DOWN while a new error arrives, and
 * a count-based dot would stay dark exactly when it mattered. `markRead` is
 * called when the tab is actually viewed, not when the log is fetched —
 * fetching happens on a poll the user never sees.
 */
export function createUnreadErrorTracker() {
  const seen = new Set();
  let unread = 0;

  return {
    /** Fold in a freshly-read log. Returns true when the dot should be lit. */
    observe(presentation) {
      const entries = Array.isArray(presentation?.entries) ? presentation.entries : [];
      for (const entry of entries) {
        if (!entry?.isError) continue;
        const key = entry.id || `${entry.type}:${entry.timestamp}:${entry.summary}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unread += 1;
      }
      return unread > 0;
    },
    /** The user looked at the tab. Clear the dot; keep the seen set. */
    markRead() {
      unread = 0;
      return false;
    },
    hasUnread() {
      return unread > 0;
    },
    unreadCount() {
      return unread;
    },
  };
}
