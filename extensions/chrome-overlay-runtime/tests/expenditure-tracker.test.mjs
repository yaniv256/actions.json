import assert from "node:assert/strict";
import test from "node:test";

import { saveOpenAiApiKey } from "../src/agent/credential-store.mjs";
import { HostedRealtimeSessionManager } from "../src/agent/realtime-session-manager.mjs";
import { PRICING_VERSION } from "../src/agent/realtime-cost.mjs";

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
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

function createFakeTransportFactory() {
  const transports = [];
  return {
    transports,
    create() {
      const transport = {
        connected: false,
        events: [],
        async connect() {
          this.connected = true;
        },
        async sendEvent(event) {
          this.events.push(event);
        },
        async close() {
          this.closed = true;
        },
      };
      transports.push(transport);
      return transport;
    },
  };
}

async function startedManager(expenditures) {
  const storage = createStorage();
  await saveOpenAiApiKey(storage, "sk-test");
  const transportFactory = createFakeTransportFactory();
  const manager = new HostedRealtimeSessionManager({
    storage,
    transportFactory,
    expenditureObserver: (payload) => expenditures.push(payload),
  });
  await manager.start();
  return manager;
}

const usagePayload = (over = {}) => ({
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
  ...over,
});

test("each response.done with usage emits a D-7 record and a meter update", async () => {
  const expenditures = [];
  const manager = await startedManager(expenditures);

  await manager.handleRealtimeEvent({
    type: "response.done",
    response: { id: "resp_1", usage: usagePayload(), output: [] },
  });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: { id: "resp_2", usage: usagePayload(), output: [] },
  });

  const records = expenditures.filter((e) => e.record?.kind === "realtime_response_usage");
  assert.equal(records.length, 2);
  const r = records[0].record;
  assert.equal(r.response_id, "resp_1");
  assert.equal(r.model, manager.model);
  assert.equal(r.input_text, 300);
  assert.equal(r.input_audio, 600);
  assert.equal(r.cached_text, 100);
  assert.equal(r.output_audio, 400);
  assert.equal(r.total_tokens, 1500);
  assert.ok(Math.abs(r.estimated_cost_usd - 0.04844) < 1e-9);
  assert.equal(r.pricing_version, PRICING_VERSION);
  assert.equal(typeof r.session_id, "string");
  assert.equal(typeof r.ts, "string");
  assert.equal(r.cache_hit, false);
  assert.equal(r.usage_observed, true);

  const meters = expenditures.filter((e) => e.meter);
  assert.ok(meters.length >= 2);
  const lastMeter = meters.at(-1).meter;
  assert.ok(Math.abs(lastMeter.sessionUsd - 0.09688) < 1e-9);
  assert.ok(Math.abs(lastMeter.lastUsd - 0.04844) < 1e-9);
  assert.equal(lastMeter.cacheState, "ok");
});

test("drain usage flags the meter cacheState", async () => {
  const expenditures = [];
  const manager = await startedManager(expenditures);
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      id: "resp_d",
      usage: usagePayload({
        input_token_details: {
          text_tokens: 5000,
          audio_tokens: 0,
          image_tokens: 0,
          cached_tokens: 0,
          cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
        },
      }),
      output: [],
    },
  });
  const meter = expenditures.filter((e) => e.meter).at(-1).meter;
  assert.equal(meter.cacheState, "drain");
  const record = expenditures.find((e) => e.record)?.record;
  assert.equal(record.cache_hit, false);
});

test("response.done without usage emits no record", async () => {
  const expenditures = [];
  const manager = await startedManager(expenditures);
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: { id: "resp_nousage", output: [] },
  });
  assert.equal(expenditures.filter((e) => e.record).length, 0);
});

test("stop emits a session summary with totals and cache-hit rate", async () => {
  const expenditures = [];
  const manager = await startedManager(expenditures);
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: { id: "resp_1", usage: usagePayload(), output: [] },
  });
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: {
      id: "resp_2",
      usage: usagePayload({
        input_token_details: {
          text_tokens: 1000,
          audio_tokens: 0,
          image_tokens: 0,
          cached_tokens: 600,
          cached_tokens_details: { text_tokens: 600, audio_tokens: 0, image_tokens: 0 },
        },
      }),
      output: [],
    },
  });
  await manager.stop();

  const summary = expenditures.find((e) => e.record?.kind === "realtime_session_summary")?.record;
  assert.ok(summary, "summary record expected on stop");
  assert.equal(summary.responses, 2);
  assert.equal(summary.cache_hits, 1);
  assert.equal(summary.cache_hit_rate, 0.5);
  assert.ok(summary.total_cost_usd > 0);
  assert.equal(summary.first_response_id, "resp_1");
  assert.equal(summary.last_response_id, "resp_2");
  assert.equal(typeof summary.duration_ms, "number");
  assert.equal(summary.pricing_version, PRICING_VERSION);
});

test("session ids differ across start cycles", async () => {
  const expenditures = [];
  const manager = await startedManager(expenditures);
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: { id: "r1", usage: usagePayload(), output: [] },
  });
  const firstSession = expenditures.find((e) => e.record).record.session_id;
  await manager.stop();
  await manager.start();
  await manager.handleRealtimeEvent({
    type: "response.done",
    response: { id: "r2", usage: usagePayload(), output: [] },
  });
  const records = expenditures.filter((e) => e.record?.kind === "realtime_response_usage");
  const secondSession = records.at(-1).record.session_id;
  assert.notEqual(firstSession, secondSession);
});
