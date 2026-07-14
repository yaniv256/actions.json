import assert from "node:assert/strict";
import test from "node:test";

import {
  TransferBuffer,
  TransferBufferError,
  transferInsertValue,
} from "../src/agent/transfer-buffer.mjs";

const source = {
  runtime_id: "actions-json-runtime-linear",
  tab_id: 101,
  url: "https://linear.app/actionsjson/team/ACT/active",
  origin: "https://linear.app",
  site_surface: "linear.app.issues",
};

const bytes = (value) => new TextEncoder().encode(
  typeof value === "string" ? value : JSON.stringify(value),
).byteLength;

test("transfer buffer writes and reads metadata without payload by default", () => {
  const buffer = new TransferBuffer({
    now: () => new Date("2026-06-09T20:50:00Z"),
    idFactory: () => "transfer_test_1",
  });

  const item = buffer.write({
    label: "linear-active-issues",
    format: "application/json",
    value: [{ id: "ACT-123", title: "Add pointer.drag primitive" }],
    source,
    metadata: { purpose: "linear_to_trello_import", record_count: 1 },
    redaction: {
      log_payload: false,
      safe_preview: "1 Linear issue: ACT-123 Add pointer.drag primitive",
    },
  });

  assert.equal(item.id, "transfer_test_1");
  assert.equal(item.label, "linear-active-issues");
  assert.equal(item.format, "application/json");
  assert.equal(item.size_bytes, bytes([{ id: "ACT-123", title: "Add pointer.drag primitive" }]));
  assert.equal(item.metadata.record_count, 1);
  assert.equal(item.expires_at, "2026-06-09T22:50:00.000Z");

  const read = buffer.read({ label: "linear-active-issues" });
  assert.equal(read.id, "transfer_test_1");
  assert.equal(read.safe_preview, "1 Linear issue: ACT-123 Add pointer.drag primitive");
  assert.equal(read.value, undefined);

  const withValue = buffer.read({ label: "linear-active-issues", include_value: true });
  assert.deepEqual(withValue.value, [{ id: "ACT-123", title: "Add pointer.drag primitive" }]);
});

test("transfer buffer replaces by default and appends compatible arrays", () => {
  const buffer = new TransferBuffer({ idFactory: () => `transfer_${buffer.count() + 1}` });

  buffer.write({
    label: "items",
    format: "application/json",
    value: [{ id: "one" }],
    source,
  });
  buffer.write({
    label: "items",
    format: "application/json",
    value: [{ id: "two" }],
    source,
  });
  assert.deepEqual(buffer.read({ label: "items", include_value: true }).value, [{ id: "two" }]);

  buffer.write({
    label: "items",
    format: "application/json",
    value: [{ id: "three" }],
    source,
    mode: "append",
  });
  assert.deepEqual(buffer.read({ label: "items", include_value: true }).value, [
    { id: "two" },
    { id: "three" },
  ]);
});

test("transfer buffer rejects missing labels, expired items, oversized payloads, and bad formats", () => {
  const buffer = new TransferBuffer({
    maxBytes: 10,
    now: () => new Date("2026-06-09T20:50:00Z"),
  });

  assert.throws(
    () => buffer.read({ label: "missing" }),
    (error) => error instanceof TransferBufferError && error.code === "transfer_label_not_found",
  );

  assert.throws(
    () => buffer.write({ label: "bad", format: "text/html", value: "<b>x</b>", source }),
    (error) => error instanceof TransferBufferError && error.code === "transfer_format_unsupported",
  );

  assert.throws(
    () => buffer.write({ label: "large", format: "text/plain", value: "this is too long", source }),
    (error) => error instanceof TransferBufferError && error.code === "transfer_payload_too_large",
  );

  const expiring = new TransferBuffer({
    now: () => new Date("2026-06-09T20:50:00Z"),
    idFactory: () => "transfer_expiring",
  });
  expiring.write({
    label: "soon",
    format: "text/plain",
    value: "hello",
    source,
    ttl_seconds: 1,
  });
  expiring.setNow(() => new Date("2026-06-09T20:50:02Z"));
  assert.throws(
    () => expiring.read({ label: "soon" }),
    (error) => error instanceof TransferBufferError && error.code === "transfer_expired",
  );
});

test("transfer buffer renders simple templates and clears entries", () => {
  const buffer = new TransferBuffer({ idFactory: () => "transfer_template" });
  buffer.write({
    label: "linear-active-issues",
    format: "application/json",
    value: [{ id: "ACT-123", title: "Add pointer.drag primitive" }],
    source,
  });

  assert.equal(
    buffer.render({
      label: "linear-active-issues",
      item_selector: { index: 0 },
      render: { template: "{{id}} {{title}}" },
    }),
    "ACT-123 Add pointer.drag primitive",
  );

  assert.deepEqual(buffer.clear({ label: "linear-active-issues" }), { cleared_count: 1 });
  assert.throws(
    () => buffer.read({ label: "linear-active-issues" }),
    (error) => error instanceof TransferBufferError && error.code === "transfer_label_not_found",
  );
});

test("transfer insert adapter preserves rendered strings as insertable text", () => {
  assert.deepEqual(transferInsertValue("rendered payload"), {
    rendered_text: "rendered payload",
    text: "rendered payload",
  });
});

test("cross-app transfer preserves Sheets provenance and renders a row for Docs", () => {
  const buffer = new TransferBuffer({ idFactory: () => "transfer_sheets_to_docs" });
  const sheetsSource = {
    runtime_id: "actions-json-runtime-sheets",
    tab_id: 202,
    url: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
    origin: "https://docs.google.com",
    site_surface: "google.sheets.grid",
  };
  buffer.write({
    label: "quarterly-summary",
    format: "application/json",
    value: [{ quarter: "Q2", revenue: "$125,000", margin: "41%" }],
    source: sheetsSource,
    metadata: { destination: "google.docs", record_count: 1 },
  });

  const staged = buffer.read({ label: "quarterly-summary", include_value: true });
  assert.deepEqual(staged.source, sheetsSource);
  assert.equal(staged.metadata.destination, "google.docs");
  assert.equal(
    buffer.render({
      label: "quarterly-summary",
      item_selector: { index: 0 },
      render: { template: "{{quarter}} revenue {{revenue}} at {{margin}} margin" },
    }),
    "Q2 revenue $125,000 at 41% margin",
  );
});
