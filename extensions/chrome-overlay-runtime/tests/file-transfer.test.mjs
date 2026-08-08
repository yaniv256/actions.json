import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FileTransferError,
  FileTransferStore,
  bytesToBase64,
} from "../src/agent/file-transfer.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("upload transfer accepts ordered chunks, verifies metadata, and consumes once", async () => {
  const bytes = new TextEncoder().encode("remote upload proof");
  const store = new FileTransferStore({ maxBytes: 1024, chunkBytes: 8 });
  const created = store.create({
    transfer_id: "upload-1",
    direction: "upload",
    filename: "proof.txt",
    mime_type: "text/plain",
    expected_size: bytes.byteLength,
    expected_sha256: sha256(bytes),
    origin: "https://trello.com",
  });

  assert.equal(created.state, "streaming");
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += 8, index += 1) {
    const chunk = bytes.slice(offset, offset + 8);
    const ack = store.appendChunk({
      transfer_id: "upload-1",
      index,
      base64: bytesToBase64(chunk),
    });
    assert.equal(ack.next_index, index + 1);
  }

  const ready = await store.finalize({ transfer_id: "upload-1" });
  assert.equal(ready.state, "ready");
  assert.equal(ready.sha256, sha256(bytes));

  const consumed = store.readUpload({
    transfer_id: "upload-1",
    origin: "https://trello.com",
  });
  assert.deepEqual(consumed.bytes, bytes);
  assert.equal(consumed.metadata.state, "ready");
  assert.equal(store.completeUpload({ transfer_id: "upload-1", origin: "https://trello.com" }).state, "complete");
  assert.throws(
    () => store.readUpload({ transfer_id: "upload-1", origin: "https://trello.com" }),
    (error) => error instanceof FileTransferError && error.code === "transfer_already_consumed",
  );
});

test("chunk replay is idempotent but conflicting or out-of-order chunks fail", () => {
  const store = new FileTransferStore({ maxBytes: 1024, chunkBytes: 8 });
  store.create({
    transfer_id: "upload-2",
    direction: "upload",
    filename: "proof.bin",
    mime_type: "application/octet-stream",
    expected_size: 4,
    expected_sha256: sha256(Uint8Array.of(1, 2, 3, 4)),
    origin: "https://trello.com",
  });
  const first = bytesToBase64(Uint8Array.of(1, 2));
  store.appendChunk({ transfer_id: "upload-2", index: 0, base64: first });
  assert.equal(store.appendChunk({ transfer_id: "upload-2", index: 0, base64: first }).replayed, true);
  assert.throws(
    () => store.appendChunk({ transfer_id: "upload-2", index: 0, base64: bytesToBase64(Uint8Array.of(9)) }),
    (error) => error.code === "transfer_chunk_conflict",
  );
  assert.throws(
    () => store.appendChunk({ transfer_id: "upload-2", index: 2, base64: first }),
    (error) => error.code === "transfer_chunk_out_of_order",
  );
});

test("transfer enforces bounds, authorization, cancellation, and expiry cleanup", async () => {
  let now = 1_000;
  const store = new FileTransferStore({ maxBytes: 4, chunkBytes: 4, ttlMs: 100, now: () => now });
  assert.throws(
    () => store.create({
      transfer_id: "too-big",
      direction: "upload",
      filename: "large.bin",
      mime_type: "application/octet-stream",
      expected_size: 5,
      expected_sha256: "0".repeat(64),
      origin: "https://trello.com",
    }),
    (error) => error.code === "transfer_oversize",
  );

  const bytes = Uint8Array.of(1, 2, 3, 4);
  store.create({
    transfer_id: "bounded",
    direction: "upload",
    filename: "bounded.bin",
    mime_type: "application/octet-stream",
    expected_size: 4,
    expected_sha256: sha256(bytes),
    origin: "https://trello.com",
  });
  store.appendChunk({ transfer_id: "bounded", index: 0, base64: bytesToBase64(bytes) });
  await store.finalize({ transfer_id: "bounded" });
  assert.throws(
    () => store.readUpload({ transfer_id: "bounded", origin: "https://example.com" }),
    (error) => error.code === "transfer_origin_mismatch",
  );
  assert.equal(store.cancel({ transfer_id: "bounded" }).state, "cancelled");
  assert.equal(store.status({ transfer_id: "bounded" }).bytes_retained, 0);

  store.create({
    transfer_id: "expiring",
    direction: "download",
    filename: "later.bin",
    mime_type: "application/octet-stream",
    expected_size: 0,
    expected_sha256: sha256(new Uint8Array()),
    origin: "https://trello.com",
  });
  now += 101;
  assert.equal(store.cleanupExpired(), 1);
  assert.throws(() => store.status({ transfer_id: "expiring" }), (error) => error.code === "transfer_expired");
});

test("download capture exposes bounded chunks and completes after bridge acknowledgement", async () => {
  const bytes = new TextEncoder().encode("downloaded attachment");
  const store = new FileTransferStore({ maxBytes: 1024, chunkBytes: 7 });
  const ready = await store.captureDownload({
    transfer_id: "download-1",
    filename: "attachment.txt",
    mime_type: "text/plain",
    origin: "https://trello.com",
    bytes,
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.chunk_count, Math.ceil(bytes.byteLength / 7));

  const rebuilt = [];
  for (let index = 0; index < ready.chunk_count; index += 1) {
    rebuilt.push(store.readChunk({ transfer_id: "download-1", index }).bytes);
  }
  assert.deepEqual(Uint8Array.from(rebuilt.flatMap((chunk) => [...chunk])), bytes);
  assert.equal(store.completeDownload({ transfer_id: "download-1" }).state, "complete");
  assert.equal(store.status({ transfer_id: "download-1" }).bytes_retained, 0);
});

test("snapshot restores transfer bytes across extension worker lifecycles", async () => {
  const bytes = new TextEncoder().encode("survives worker restart");
  const first = new FileTransferStore({ maxBytes: 1024, chunkBytes: 64 });
  first.create({
    transfer_id: "restart-safe",
    direction: "upload",
    filename: "restart.txt",
    mime_type: "text/plain",
    expected_size: bytes.byteLength,
    expected_sha256: sha256(bytes),
    origin: "https://trello.com",
  });
  first.appendChunk({ transfer_id: "restart-safe", index: 0, base64: bytesToBase64(bytes) });
  await first.finalize({ transfer_id: "restart-safe" });

  const restored = new FileTransferStore({ maxBytes: 1024, chunkBytes: 64 });
  restored.importSnapshot(first.exportSnapshot());
  const consumed = restored.readUpload({ transfer_id: "restart-safe", origin: "https://trello.com" });
  assert.deepEqual(consumed.bytes, bytes);
  assert.equal(consumed.metadata.state, "ready");
});

test("download replay binds origin, filename, and MIME metadata", async () => {
  const bytes = new TextEncoder().encode("same bytes");
  const store = new FileTransferStore({ maxBytes: 1024 });
  await store.captureDownload({ transfer_id: "bound-download", filename: "one.txt", mime_type: "text/plain", origin: "https://trello.com", bytes });
  await assert.rejects(
    store.captureDownload({ transfer_id: "bound-download", filename: "two.txt", mime_type: "text/plain", origin: "https://trello.com", bytes }),
    (error) => error.code === "transfer_id_conflict",
  );
  await assert.rejects(
    store.captureDownload({ transfer_id: "bound-download", filename: "one.txt", mime_type: "text/plain", origin: "https://example.com", bytes }),
    (error) => error.code === "transfer_id_conflict",
  );
});

test("aggregate bytes, entry count, and terminal retention stay bounded", async () => {
  let now = 0;
  const store = new FileTransferStore({ maxBytes: 8, maxAggregateBytes: 8, maxEntries: 2, terminalTtlMs: 10, now: () => now });
  const bytes = Uint8Array.of(1, 2, 3, 4, 5);
  store.create({ transfer_id: "first", direction: "upload", filename: "first.bin", expected_size: 5, expected_sha256: sha256(bytes), origin: "https://trello.com" });
  assert.throws(() => store.create({ transfer_id: "over-capacity", direction: "upload", filename: "second.bin", expected_size: 4, expected_sha256: sha256(Uint8Array.of(1, 2, 3, 4)), origin: "https://trello.com" }), (error) => error.code === "transfer_capacity_exceeded");
  store.cancel({ transfer_id: "first" });
  now = 11;
  store.cleanupExpired();
  assert.throws(() => store.status({ transfer_id: "first" }), (error) => error.code === "transfer_not_found");
});
