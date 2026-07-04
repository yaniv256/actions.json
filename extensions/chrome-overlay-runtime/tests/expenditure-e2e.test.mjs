import assert from "node:assert/strict";
import test from "node:test";

import { saveOpenAiApiKey } from "../src/agent/credential-store.mjs";
import { HostedRealtimeSessionManager } from "../src/agent/realtime-session-manager.mjs";
import { createCloudStore } from "../src/agent/cloud-store.mjs";

// Spec 037 T8: the full pipeline wired the way background+offscreen wire it —
// session manager → expenditureObserver → CloudStore spool → flush → S3 parts
// whose JSONL parses back to N usage records + 1 session summary.

function createStorage() {
  const data = {};
  return {
    async get(key) {
      if (typeof key === "string") return { [key]: data[key] };
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

function memorySpool() {
  const rows = new Map();
  let nextId = 1;
  return {
    async add(v) {
      rows.set(nextId, v);
      return nextId++;
    },
    async getAll(limit) {
      return [...rows.entries()].slice(0, limit).map(([id, v]) => ({ id, ...v }));
    },
    async delete(ids) {
      for (const id of ids) rows.delete(id);
    },
    async count() {
      return rows.size;
    },
  };
}

const usagePayload = () => ({
  input_tokens: 1000,
  output_tokens: 500,
  total_tokens: 1500,
  input_token_details: {
    text_tokens: 400,
    audio_tokens: 600,
    image_tokens: 0,
    cached_tokens: 100,
    cached_tokens_details: { text_tokens: 100, audio_tokens: 0, image_tokens: 0 },
  },
  output_token_details: { text_tokens: 100, audio_tokens: 400 },
});

test("session → records → spool → flush → S3 parts parse to N records + 1 summary", async () => {
  const puts = [];
  const cloudStore = createCloudStore({
    getConfig: async () => ({
      bucket: "b",
      region: "us-east-1",
      prefix: "actions-json",
      accessKeyId: "A",
      secretAccessKey: "S",
    }),
    idbFactory: memorySpool,
    fetchImpl: async (url, init) => {
      puts.push({ url, body: new TextDecoder().decode(init.body) });
      return { ok: true, status: 200, text: async () => "" };
    },
  });

  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-test");
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory: {
      create: () => ({
        async connect() {},
        async sendEvent() {},
        async close() {},
      }),
    },
    expenditureObserver: ({ record }) => {
      if (!record) return;
      const day = record.ts.slice(0, 10);
      cloudStore.appendLine(`expenditure/${day}/${record.session_id}`, JSON.stringify(record));
    },
  });

  await manager.start();
  for (const id of ["resp_1", "resp_2", "resp_3"]) {
    await manager.handleRealtimeEvent({
      type: "response.done",
      response: { id, usage: usagePayload(), output: [] },
    });
  }
  await manager.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await cloudStore.flush();

  assert.equal(puts.length, 1, "one stream → one part object");
  assert.match(puts[0].url, /\/actions-json\/expenditure\/\d{4}-\d{2}-\d{2}\/.+\/part-.+\.jsonl$/);
  const lines = puts[0].body.trim().split("\n").map((l) => JSON.parse(l));
  const usageRecords = lines.filter((l) => l.kind === "realtime_response_usage");
  const summaries = lines.filter((l) => l.kind === "realtime_session_summary");
  assert.equal(usageRecords.length, 3);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].responses, 3);
  assert.ok(Math.abs(summaries[0].total_cost_usd - 3 * 0.04844) < 1e-9);
  assert.equal(new Set(lines.map((l) => l.session_id)).size, 1);
});
