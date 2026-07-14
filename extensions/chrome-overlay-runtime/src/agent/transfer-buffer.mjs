const DEFAULT_TTL_SECONDS = 7200;
const DEFAULT_MAX_BYTES = 256 * 1024;
const SUPPORTED_FORMATS = new Set(["text/plain", "application/json", "text/uri-list"]);

export const transferInsertValue = (rendered) => {
  const text = typeof rendered === "string" ? rendered : String(rendered ?? "");
  return { rendered_text: text, text };
};

export class TransferBufferError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TransferBufferError";
    this.code = code;
    this.details = details;
  }
}

const textEncoder = new TextEncoder();

function byteLength(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return textEncoder.encode(serialized).byteLength;
}

function recordCountFor(value, metadata = {}) {
  if (Number.isInteger(metadata.record_count)) return metadata.record_count;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function transferId() {
  if (globalThis.crypto?.randomUUID) return `transfer_${globalThis.crypto.randomUUID()}`;
  return `transfer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function assertLabel(label) {
  const normalized = String(label || "").trim();
  if (!normalized) {
    throw new TransferBufferError("transfer_label_required", "transfer label is required.");
  }
  return normalized;
}

function assertSupportedFormat(format) {
  const normalized = String(format || "").trim();
  if (!SUPPORTED_FORMATS.has(normalized)) {
    throw new TransferBufferError("transfer_format_unsupported", `Unsupported transfer format: ${normalized || "(empty)"}.`, {
      format: normalized || null,
    });
  }
  return normalized;
}

function renderTemplate(template, item) {
  return String(template || "{{value}}").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
    if (key === "value") return typeof item === "string" ? item : JSON.stringify(item);
    const value = key.split(".").reduce((current, part) => current?.[part], item);
    return value == null ? "" : String(value);
  });
}

export class TransferBuffer {
  constructor({
    now = () => new Date(),
    idFactory = transferId,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    this._now = now;
    this._idFactory = idFactory;
    this._maxBytes = maxBytes;
    this._itemsByLabel = new Map();
    this._itemsById = new Map();
  }

  setNow(now) {
    this._now = now;
  }

  count() {
    return this._itemsById.size;
  }

  write({
    label,
    format,
    value,
    source = {},
    metadata = {},
    redaction = {},
    ttl_seconds = DEFAULT_TTL_SECONDS,
    mode = "replace",
  } = {}) {
    const normalizedLabel = assertLabel(label);
    const normalizedFormat = assertSupportedFormat(format);
    const size = byteLength(value);
    if (size > this._maxBytes) {
      throw new TransferBufferError("transfer_payload_too_large", "Transfer payload exceeds the configured size limit.", {
        size_bytes: size,
        max_bytes: this._maxBytes,
      });
    }

    if (mode === "append") {
      const existing = this._itemsByLabel.get(normalizedLabel);
      if (existing) {
        this._assertNotExpired(existing);
        if (existing.format !== normalizedFormat || !Array.isArray(existing.value) || !Array.isArray(value)) {
          throw new TransferBufferError("transfer_append_incompatible", "Append requires matching formats and array payloads.", {
            existing_format: existing.format,
            format: normalizedFormat,
          });
        }
        existing.value = [...existing.value, ...clone(value)];
        existing.size_bytes = byteLength(existing.value);
        existing.metadata = {
          ...existing.metadata,
          ...metadata,
          record_count: recordCountFor(existing.value, metadata),
        };
        return this._metadata(existing, { includeValue: false });
      }
    } else if (mode !== "replace") {
      throw new TransferBufferError("transfer_mode_unsupported", `Unsupported transfer write mode: ${mode}.`, { mode });
    }

    const existing = this._itemsByLabel.get(normalizedLabel);
    if (existing) this._itemsById.delete(existing.id);

    const createdAt = this._now();
    const item = {
      id: this._idFactory(),
      label: normalizedLabel,
      format: normalizedFormat,
      value: clone(value),
      source: clone(source) || {},
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + Math.max(0, Number(ttl_seconds)) * 1000).toISOString(),
      size_bytes: size,
      redaction: {
        log_payload: false,
        ...clone(redaction),
      },
      metadata: {
        ...clone(metadata),
        ...(recordCountFor(value, metadata) === undefined ? {} : { record_count: recordCountFor(value, metadata) }),
      },
    };
    this._itemsByLabel.set(normalizedLabel, item);
    this._itemsById.set(item.id, item);
    return this._metadata(item, { includeValue: false });
  }

  read({ label, id, include_value = false } = {}) {
    const item = this._find({ label, id });
    this._assertNotExpired(item);
    return this._metadata(item, { includeValue: Boolean(include_value) });
  }

  render({ label, id, item_selector = {}, render = {} } = {}) {
    const item = this._find({ label, id });
    this._assertNotExpired(item);
    let value = item.value;
    if (Number.isInteger(item_selector.index)) {
      if (!Array.isArray(value)) {
        throw new TransferBufferError("transfer_item_selector_invalid", "Index selector requires an array payload.", {
          label: item.label,
        });
      }
      value = value[item_selector.index];
    }
    if (value === undefined) {
      throw new TransferBufferError("transfer_item_selector_invalid", "Selected transfer item was not found.", {
        label: item.label,
        item_selector,
      });
    }
    if (render.format && !["text/plain", "application/json"].includes(render.format)) {
      throw new TransferBufferError("transfer_format_unsupported", `Unsupported render format: ${render.format}.`, {
        format: render.format,
      });
    }
    if (render.template) return renderTemplate(render.template, value);
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  clear({ label, id, scope } = {}) {
    if (scope === "session") {
      const cleared = this._itemsById.size;
      this._itemsById.clear();
      this._itemsByLabel.clear();
      return { cleared_count: cleared };
    }
    const item = this._find({ label, id });
    this._itemsById.delete(item.id);
    this._itemsByLabel.delete(item.label);
    return { cleared_count: 1 };
  }

  _find({ label, id } = {}) {
    let item = null;
    if (id) item = this._itemsById.get(String(id));
    if (!item && label) item = this._itemsByLabel.get(assertLabel(label));
    if (!item) {
      throw new TransferBufferError("transfer_label_not_found", "Transfer item was not found.", {
        label: label || null,
        id: id || null,
      });
    }
    return item;
  }

  _assertNotExpired(item) {
    if (new Date(item.expires_at).getTime() <= this._now().getTime()) {
      this._itemsById.delete(item.id);
      this._itemsByLabel.delete(item.label);
      throw new TransferBufferError("transfer_expired", "Transfer item has expired.", {
        label: item.label,
        id: item.id,
      });
    }
  }

  _metadata(item, { includeValue }) {
    return {
      id: item.id,
      label: item.label,
      format: item.format,
      ...(includeValue ? { value: clone(item.value) } : {}),
      source: clone(item.source),
      created_at: item.created_at,
      expires_at: item.expires_at,
      size_bytes: item.size_bytes,
      safe_preview: item.redaction?.safe_preview,
      redaction: clone(item.redaction),
      metadata: clone(item.metadata),
      ...(Number.isInteger(item.metadata?.record_count) ? { record_count: item.metadata.record_count } : {}),
    };
  }
}
