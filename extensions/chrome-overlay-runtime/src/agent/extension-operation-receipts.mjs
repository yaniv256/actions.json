const STORAGE_KEY = "actionsJsonDurableOperationReceipts.v1";
const DEFAULT_MAX_RECEIPTS = 512;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const compactOutcome = (outcome) => ({
  type: typeof outcome?.type === "string" ? outcome.type : null,
  ok: outcome?.type === "action_error" ? false : outcome?.output?.ok !== false,
  error_code: typeof outcome?.error?.code === "string" ? outcome.error.code : null,
  failure_class: typeof outcome?.error?.failure_class === "string"
    ? outcome.error.failure_class
    : (typeof outcome?.output?.failure_class === "string" ? outcome.output.failure_class : null),
});

export class ExtensionOperationReceiptStore {
  constructor({ storageArea, now = () => Date.now(), maxReceipts = DEFAULT_MAX_RECEIPTS, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!storageArea?.get || !storageArea?.set) throw new Error("A chrome.storage-compatible storageArea is required.");
    this.storageArea = storageArea; this.now = now; this.maxReceipts = maxReceipts; this.ttlMs = ttlMs;
    this.mutation = Promise.resolve();
  }

  async query(operationId) {
    if (!operationId) return null;
    await this.mutation;
    const records = await this.#load();
    return clone(records[operationId] || null);
  }

  async receive(operationId, metadata = {}) {
    if (!operationId) throw new Error("operation_id is required");
    return this.#mutate((records, now) => {
      const existing = records[operationId];
      if (existing) return { receipt: clone(existing), duplicate: true };
      records[operationId] = { operation_id: operationId, state: "received", received_at_ms: now, updated_at_ms: now,
        runtime_id: metadata.runtime_id || null, call_id: metadata.call_id || null };
      return { receipt: clone(records[operationId]), duplicate: false };
    });
  }

  async markStarted(operationId) { return this.#advance(operationId, "started"); }

  async markTerminal(operationId, outcome) {
    return this.#mutate((records, now) => {
      const record = records[operationId];
      if (!record) throw new Error(`Unknown durable operation ${operationId}`);
      if (record.state === "terminal") return clone(record);
      record.state = "terminal"; record.updated_at_ms = now; record.terminal_at_ms = now;
      // Receipt persistence is a dedupe/status authority, not a second result
      // archive. Never retain page output, arguments, or private result bodies.
      record.outcome = compactOutcome(outcome);
      return clone(record);
    });
  }

  async #advance(operationId, state) {
    return this.#mutate((records, now) => {
      const record = records[operationId];
      if (!record) throw new Error(`Unknown durable operation ${operationId}`);
      if (record.state === "terminal") return clone(record);
      record.state = state; record.updated_at_ms = now;
      if (state === "started") record.started_at_ms ||= now;
      return clone(record);
    });
  }

  async #load() { return (await this.storageArea.get(STORAGE_KEY))?.[STORAGE_KEY] || {}; }

  #mutate(fn) {
    const work = this.mutation.then(async () => {
      const now = this.now(); const records = await this.#load();
      for (const [id, record] of Object.entries(records)) {
        if (record.state === "terminal" && now - (record.updated_at_ms || 0) > this.ttlMs) delete records[id];
      }
      const result = fn(records, now);
      const terminal = Object.values(records)
        .filter((record) => record.state === "terminal")
        .sort((a, b) => (b.updated_at_ms || 0) - (a.updated_at_ms || 0));
      for (const record of terminal.slice(this.maxReceipts)) delete records[record.operation_id];
      await this.storageArea.set({ [STORAGE_KEY]: records });
      return result;
    });
    this.mutation = work.then(() => undefined, () => undefined);
    return work;
  }
}

export const createExtensionOperationReceiptStore = (options) => new ExtensionOperationReceiptStore(options);
export { STORAGE_KEY as EXTENSION_OPERATION_RECEIPTS_STORAGE_KEY };
