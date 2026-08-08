const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 192 * 1024;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_AGGREGATE_BYTES = 50 * 1024 * 1024;

export class FileTransferError extends Error {
  constructor(code, message, evidence = {}) {
    super(message);
    this.name = "FileTransferError";
    this.code = code;
    this.evidence = evidence;
  }
}

export const bytesToBase64 = (bytes) => {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64");
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const base64ToBytes = (value) => {
  if (typeof value !== "string") {
    throw new FileTransferError("transfer_chunk_invalid", "Chunk payload must be base64 text.");
  }
  try {
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64"));
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new FileTransferError("transfer_chunk_invalid", "Chunk payload is not valid base64.", {
      cause: error?.message || String(error),
    });
  }
};

const sha256Hex = async (bytes) => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const normalizeOrigin = (origin) => {
  try {
    return new URL(origin).origin;
  } catch {
    throw new FileTransferError("transfer_origin_invalid", "Transfer origin must be an absolute HTTP(S) origin.");
  }
};

const validateFilename = (filename) => {
  const value = typeof filename === "string" ? filename.trim() : "";
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new FileTransferError("transfer_filename_invalid", "Filename must be one non-empty basename.");
  }
  return value;
};

const metadataFor = (entry) => ({
  transfer_id: entry.transferId,
  direction: entry.direction,
  filename: entry.filename,
  mime_type: entry.mimeType,
  expected_size: entry.expectedSize,
  expected_sha256: entry.expectedSha256,
  size: entry.bytesReceived,
  sha256: entry.actualSha256,
  origin: entry.origin,
  state: entry.state,
  next_index: entry.nextIndex,
  chunk_count: entry.chunks.length,
  consumed: entry.consumed,
  bytes_retained: entry.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  updated_at_ms: entry.updatedAt,
});

export class FileTransferStore {
  constructor({
    maxBytes = DEFAULT_MAX_BYTES,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    ttlMs = DEFAULT_TTL_MS,
    terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxAggregateBytes = DEFAULT_MAX_AGGREGATE_BYTES,
    now = () => Date.now(),
  } = {}) {
    this.maxBytes = maxBytes;
    this.chunkBytes = chunkBytes;
    this.ttlMs = ttlMs;
    this.terminalTtlMs = terminalTtlMs;
    this.maxEntries = maxEntries;
    this.maxAggregateBytes = maxAggregateBytes;
    this.now = now;
    this.entries = new Map();
  }

  exportSnapshot() {
    return Array.from(this.entries.values(), (entry) => ({
      ...entry,
      chunks: entry.chunks.map((chunk) => Uint8Array.from(chunk)),
      chunkHashes: [...entry.chunkHashes],
    }));
  }

  importSnapshot(snapshot) {
    this.entries.clear();
    for (const candidate of Array.isArray(snapshot) ? snapshot : []) {
      if (!candidate || typeof candidate.transferId !== "string") continue;
      this.entries.set(candidate.transferId, {
        ...candidate,
        chunks: Array.isArray(candidate.chunks)
          ? candidate.chunks.map((chunk) => Uint8Array.from(chunk || []))
          : [],
        chunkHashes: Array.isArray(candidate.chunkHashes) ? [...candidate.chunkHashes] : [],
      });
    }
    this.cleanupExpired();
  }

  create(input = {}) {
    this.cleanupExpired();
    const transferId = typeof input.transfer_id === "string" ? input.transfer_id.trim() : "";
    const direction = input.direction;
    const expectedSize = Number(input.expected_size);
    const expectedSha256 = typeof input.expected_sha256 === "string" ? input.expected_sha256.toLowerCase() : "";
    if (!transferId) throw new FileTransferError("transfer_id_invalid", "transfer_id is required.");
    if (!['upload', 'download'].includes(direction)) {
      throw new FileTransferError("transfer_direction_invalid", "direction must be upload or download.");
    }
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new FileTransferError("transfer_size_invalid", "expected_size must be a non-negative integer.");
    }
    if (expectedSize > this.maxBytes) {
      throw new FileTransferError("transfer_oversize", "Declared transfer exceeds the configured size limit.", {
        expected_size: expectedSize,
        max_bytes: this.maxBytes,
      });
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new FileTransferError("transfer_hash_invalid", "expected_sha256 must be a lowercase SHA-256 hex digest.");
    }
    const normalized = {
      transferId,
      direction,
      filename: validateFilename(input.filename),
      mimeType: typeof input.mime_type === "string" && input.mime_type.trim()
        ? input.mime_type.trim()
        : "application/octet-stream",
      expectedSize,
      expectedSha256,
      origin: normalizeOrigin(input.origin),
    };
    const existing = this.entries.get(transferId);
    if (existing) {
      const same = ["direction", "filename", "mimeType", "expectedSize", "expectedSha256", "origin"]
        .every((key) => existing[key] === normalized[key]);
      if (!same) {
        throw new FileTransferError("transfer_id_conflict", "transfer_id is already bound to different metadata.");
      }
      return { ...metadataFor(existing), replayed: true };
    }
    if (this.entries.size >= this.maxEntries) {
      throw new FileTransferError("transfer_capacity_exceeded", "Too many transfer records are retained.", {
        max_entries: this.maxEntries,
      });
    }
    const retainedBytes = Array.from(this.entries.values())
      .reduce((total, entry) => total + (["streaming", "ready"].includes(entry.state) ? entry.expectedSize : 0), 0);
    if (retainedBytes + expectedSize > this.maxAggregateBytes) {
      throw new FileTransferError("transfer_capacity_exceeded", "Aggregate retained transfer bytes would exceed the configured limit.", {
        retained_bytes: retainedBytes,
        requested_bytes: expectedSize,
        max_aggregate_bytes: this.maxAggregateBytes,
      });
    }
    const timestamp = this.now();
    const entry = {
      ...normalized,
      state: "streaming",
      chunks: [],
      chunkHashes: [],
      nextIndex: 0,
      bytesReceived: 0,
      actualSha256: null,
      consumed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.entries.set(transferId, entry);
    return metadataFor(entry);
  }

  appendChunk({ transfer_id: transferId, index, base64 } = {}) {
    const entry = this.requireActive(transferId);
    if (entry.state !== "streaming") {
      throw new FileTransferError("transfer_state_invalid", "Chunks are accepted only while streaming.", { state: entry.state });
    }
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new FileTransferError("transfer_chunk_index_invalid", "Chunk index must be a non-negative integer.");
    }
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength > this.chunkBytes) {
      throw new FileTransferError("transfer_chunk_oversize", "Chunk exceeds the configured chunk limit.", {
        chunk_bytes: bytes.byteLength,
        max_chunk_bytes: this.chunkBytes,
      });
    }
    const fingerprint = bytesToBase64(bytes);
    if (index < entry.nextIndex) {
      if (entry.chunkHashes[index] !== fingerprint) {
        throw new FileTransferError("transfer_chunk_conflict", "Repeated chunk index carried different bytes.", { index });
      }
      return { ...metadataFor(entry), replayed: true };
    }
    if (index !== entry.nextIndex) {
      throw new FileTransferError("transfer_chunk_out_of_order", "Chunk index did not match the next acknowledged index.", {
        index,
        next_index: entry.nextIndex,
      });
    }
    if (entry.bytesReceived + bytes.byteLength > entry.expectedSize || entry.bytesReceived + bytes.byteLength > this.maxBytes) {
      throw new FileTransferError("transfer_oversize", "Chunk would exceed the declared or configured transfer size.");
    }
    entry.chunks.push(bytes);
    entry.chunkHashes.push(fingerprint);
    entry.nextIndex += 1;
    entry.bytesReceived += bytes.byteLength;
    entry.updatedAt = this.now();
    return { ...metadataFor(entry), replayed: false };
  }

  async finalize({ transfer_id: transferId } = {}) {
    const entry = this.requireActive(transferId);
    if (entry.state === "ready" || entry.state === "complete") return metadataFor(entry);
    if (entry.bytesReceived !== entry.expectedSize) {
      throw new FileTransferError("transfer_size_mismatch", "Received byte count does not match expected_size.", {
        expected_size: entry.expectedSize,
        size: entry.bytesReceived,
      });
    }
    const bytes = this.join(entry);
    const actual = await sha256Hex(bytes);
    if (actual !== entry.expectedSha256) {
      this.failAndClear(entry, "failed");
      throw new FileTransferError("transfer_hash_mismatch", "Received bytes do not match expected_sha256.", {
        expected_sha256: entry.expectedSha256,
        actual_sha256: actual,
      });
    }
    entry.actualSha256 = actual;
    entry.state = "ready";
    entry.updatedAt = this.now();
    return metadataFor(entry);
  }

  readUpload({ transfer_id: transferId, origin } = {}) {
    const entry = this.requireActive(transferId, "upload");
    this.assertOrigin(entry, origin);
    if (entry.consumed || entry.state === "complete") throw new FileTransferError("transfer_already_consumed", "Upload transfer has already been consumed.");
    if (entry.state !== "ready") {
      throw new FileTransferError("transfer_not_ready", "Upload transfer is not ready for consumption.", { state: entry.state });
    }
    const bytes = this.join(entry);
    return { metadata: metadataFor(entry), bytes };
  }

  completeUpload({ transfer_id: transferId, origin } = {}) {
    const entry = this.requireActive(transferId, "upload");
    this.assertOrigin(entry, origin);
    if (entry.state === "complete") return { ...metadataFor(entry), replayed: true };
    if (entry.state !== "ready") throw new FileTransferError("transfer_not_ready", "Upload transfer is not ready for completion.", { state: entry.state });
    entry.consumed = true;
    entry.state = "complete";
    entry.updatedAt = this.now();
    this.clearBytes(entry);
    return metadataFor(entry);
  }

  async captureDownload({ transfer_id, filename, mime_type, origin, bytes } = {}) {
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const digest = await sha256Hex(value);
    const normalizedFilename = validateFilename(filename);
    const normalizedMimeType = typeof mime_type === "string" && mime_type.trim() ? mime_type.trim() : "application/octet-stream";
    const normalizedOrigin = normalizeOrigin(origin);
    const existing = this.entries.get(transfer_id);
    if (existing) {
      if (existing.direction !== "download" || existing.expectedSha256 !== digest || existing.expectedSize !== value.byteLength
        || existing.filename !== normalizedFilename || existing.mimeType !== normalizedMimeType || existing.origin !== normalizedOrigin) {
        throw new FileTransferError("transfer_id_conflict", "transfer_id is already bound to different download bytes.");
      }
      return { ...metadataFor(existing), replayed: true };
    }
    this.create({
      transfer_id,
      direction: "download",
      filename: normalizedFilename,
      mime_type: normalizedMimeType,
      expected_size: value.byteLength,
      expected_sha256: digest,
      origin: normalizedOrigin,
    });
    const entry = this.entries.get(transfer_id);
    for (let offset = 0; offset < value.byteLength; offset += this.chunkBytes) {
      entry.chunks.push(value.slice(offset, offset + this.chunkBytes));
    }
    entry.nextIndex = entry.chunks.length;
    entry.bytesReceived = value.byteLength;
    entry.actualSha256 = digest;
    entry.state = "ready";
    entry.updatedAt = this.now();
    return metadataFor(entry);
  }

  readChunk({ transfer_id: transferId, index } = {}) {
    const entry = this.requireActive(transferId, "download");
    if (entry.state !== "ready") {
      throw new FileTransferError("transfer_not_ready", "Download transfer is not ready.", { state: entry.state });
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= entry.chunks.length) {
      throw new FileTransferError("transfer_chunk_index_invalid", "Requested download chunk does not exist.", {
        index,
        chunk_count: entry.chunks.length,
      });
    }
    const bytes = entry.chunks[index];
    return { ...metadataFor(entry), index, base64: bytesToBase64(bytes), bytes };
  }

  completeDownload({ transfer_id: transferId } = {}) {
    const entry = this.requireActive(transferId, "download");
    if (entry.state === "complete") return metadataFor(entry);
    if (entry.state !== "ready") {
      throw new FileTransferError("transfer_not_ready", "Download transfer is not ready for completion.");
    }
    entry.state = "complete";
    entry.consumed = true;
    entry.updatedAt = this.now();
    this.clearBytes(entry);
    return metadataFor(entry);
  }

  status({ transfer_id: transferId } = {}) {
    const entry = this.entries.get(transferId);
    if (!entry) throw new FileTransferError("transfer_not_found", "Transfer was not found.", { transfer_id: transferId });
    if (entry.state === "expired") throw new FileTransferError("transfer_expired", "Transfer has expired.", { transfer_id: transferId });
    return metadataFor(entry);
  }

  cancel({ transfer_id: transferId } = {}) {
    const entry = this.entries.get(transferId);
    if (!entry) throw new FileTransferError("transfer_not_found", "Transfer was not found.", { transfer_id: transferId });
    if (!["complete", "cancelled", "expired"].includes(entry.state)) entry.state = "cancelled";
    entry.updatedAt = this.now();
    this.clearBytes(entry);
    return metadataFor(entry);
  }

  cleanupExpired() {
    let expired = 0;
    const timestamp = this.now();
    for (const entry of this.entries.values()) {
      if (!["complete", "cancelled", "expired"].includes(entry.state) && timestamp - entry.updatedAt > this.ttlMs) {
        entry.state = "expired";
        entry.updatedAt = timestamp;
        this.clearBytes(entry);
        expired += 1;
      } else if (["complete", "cancelled", "expired", "failed"].includes(entry.state)
        && timestamp - entry.updatedAt > this.terminalTtlMs) {
        this.entries.delete(entry.transferId);
      }
    }
    return expired;
  }

  requireActive(transferId, direction = null) {
    this.cleanupExpired();
    const entry = this.entries.get(transferId);
    if (!entry) throw new FileTransferError("transfer_not_found", "Transfer was not found.", { transfer_id: transferId });
    if (entry.state === "expired") throw new FileTransferError("transfer_expired", "Transfer has expired.", { transfer_id: transferId });
    if (entry.state === "cancelled") throw new FileTransferError("transfer_cancelled", "Transfer was cancelled.", { transfer_id: transferId });
    if (direction && entry.direction !== direction) {
      throw new FileTransferError("transfer_direction_mismatch", "Transfer direction does not match this operation.", {
        expected: direction,
        actual: entry.direction,
      });
    }
    return entry;
  }

  assertOrigin(entry, origin) {
    const actual = normalizeOrigin(origin);
    if (actual !== entry.origin) {
      throw new FileTransferError("transfer_origin_mismatch", "Transfer origin does not match the authorized origin.", {
        expected_origin: entry.origin,
        actual_origin: actual,
      });
    }
  }

  join(entry) {
    const bytes = new Uint8Array(entry.bytesReceived);
    let offset = 0;
    for (const chunk of entry.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  clearBytes(entry) {
    entry.chunks = [];
    entry.chunkHashes = [];
  }

  failAndClear(entry, state) {
    entry.state = state;
    entry.updatedAt = this.now();
    this.clearBytes(entry);
  }
}
