import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDay, reconcileWindow } from "../src/agent/usage-reconciler.mjs";

const costsResponse = (amountUsd) => ({
  ok: true,
  status: 200,
  json: async () => ({
    object: "page",
    data: [
      {
        object: "bucket",
        start_time: 0,
        end_time: 0,
        results: [
          {
            object: "organization.costs.result",
            amount: { value: amountUsd, currency: "usd" },
          },
        ],
      },
    ],
    has_more: false,
  }),
});

test("reconcileDay computes the signed tracking error", async () => {
  const calls = [];
  const result = await reconcileDay({
    dateStr: "2026-07-03",
    estimatedUsd: 9.7,
    apiKey: "sk-admin-usage",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return costsResponse(10.0);
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.openai\.com\/v1\/organization\/costs\?/);
  assert.match(calls[0].url, /start_time=\d+/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-admin-usage");
  assert.equal(result.date, "2026-07-03");
  assert.equal(result.actualUsd, 10.0);
  assert.equal(result.estimatedUsd, 9.7);
  assert.ok(Math.abs(result.errorPct - -3.0) < 1e-9, `errorPct=${result.errorPct}`);
});

test("reconcileDay throws reconciler_disabled without a key", async () => {
  await assert.rejects(
    () => reconcileDay({ dateStr: "2026-07-03", estimatedUsd: 1 }),
    /reconciler_disabled/,
  );
});

test("reconcileDay reports null errorPct when actual is zero", async () => {
  const result = await reconcileDay({
    dateStr: "2026-07-03",
    estimatedUsd: 0.5,
    apiKey: "k",
    fetchImpl: async () => costsResponse(0),
  });
  assert.equal(result.actualUsd, 0);
  assert.equal(result.errorPct, null);
});

test("reconcileWindow sums 1-minute usage buckets across the window", async () => {
  const calls = [];
  const usageResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      object: "page",
      data: [
        { object: "bucket", results: [{ input_tokens: 1000, output_tokens: 100 }] },
        { object: "bucket", results: [{ input_tokens: 2000, output_tokens: 200 }] },
      ],
      has_more: false,
    }),
  };
  const result = await reconcileWindow({
    startTs: Date.parse("2026-07-04T10:00:00Z"),
    endTs: Date.parse("2026-07-04T10:05:00Z"),
    apiKey: "sk-admin-usage",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return usageResponse;
    },
  });
  assert.match(calls[0].url, /bucket_width=1m/);
  assert.match(calls[0].url, /usage\/completions/);
  assert.equal(result.inputTokens, 3000);
  assert.equal(result.outputTokens, 300);
});
