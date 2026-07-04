const DEFAULT_TTL_MS = 120000;
const DELIVERABLE_TYPES = new Set(["action_call_output", "action_error"]);

const deliveryKeyFor = (item) => {
  if (!DELIVERABLE_TYPES.has(item?.type)) return null;
  if (typeof item?.call_id !== "string" || item.call_id.length === 0) return null;
  const runtimeId = typeof item?.runtime_id === "string" ? item.runtime_id : "";
  return `${item.type}:${runtimeId}:${item.call_id}`;
};

const summarizeItem = (item) => ({
  message_type: item?.type || null,
  runtime_id: item?.runtime_id || null,
  call_id: item?.call_id || null,
});

export class BridgeOutputDeliveryQueue {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
    emitDiagnostic = () => {},
  } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.emitDiagnostic = emitDiagnostic;
    this.pending = new Map();
  }

  get size() {
    return this.pending.size;
  }

  deliver(item, send) {
    if (send(item)) return true;
    this.queue(item);
    return false;
  }

  queue(item) {
    const key = deliveryKeyFor(item);
    if (!key) return false;

    const existing = this.pending.get(key);
    if (existing) {
      this.emitDiagnostic({
        type: "transport",
        name: "background.bridge.output_duplicate",
        ok: false,
        summary: "Extension background suppressed duplicate pending bridge output.",
        input: summarizeItem(item),
        output: {
          queued_age_ms: Math.max(0, this.now() - existing.queuedAt),
        },
      });
      return false;
    }

    this.pending.set(key, {
      item,
      queuedAt: this.now(),
    });
    this.emitDiagnostic({
      type: "transport",
      name: "background.bridge.output_queued",
      ok: false,
      summary: "Extension background queued bridge output until the WebSocket reconnects.",
      input: summarizeItem(item),
      output: {
        pending_count: this.pending.size,
      },
    });
    return true;
  }

  flush(send) {
    let sent = 0;
    let expired = 0;
    const now = this.now();

    for (const [key, record] of Array.from(this.pending.entries())) {
      const ageMs = Math.max(0, now - record.queuedAt);
      if (ageMs > this.ttlMs) {
        this.pending.delete(key);
        expired += 1;
        this.emitDiagnostic({
          type: "transport",
          name: "background.bridge.output_expired",
          ok: false,
          summary: "Extension background expired undelivered bridge output.",
          input: summarizeItem(record.item),
          output: {
            failure_class: "output_delivery_failed",
            retryable: false,
            safe_recovery: "Check the runtime session log for pending_missing or reconnect events, then verify page state before re-running the mutation.",
            queued_age_ms: ageMs,
            ttl_ms: this.ttlMs,
            pending_count: this.pending.size,
          },
        });
        continue;
      }

      if (!send(record.item)) {
        continue;
      }

      this.pending.delete(key);
      sent += 1;
      this.emitDiagnostic({
        type: "transport",
        name: "background.bridge.output_delivered",
        ok: true,
        summary: "Extension background delivered queued bridge output after reconnect.",
        input: summarizeItem(record.item),
        output: {
          queued_age_ms: ageMs,
          pending_count: this.pending.size,
        },
      });
    }

    return { sent, remaining: this.pending.size, expired };
  }
}
