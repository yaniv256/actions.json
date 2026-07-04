import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateRealtimeCost,
  PRICING_VERSION,
  PRICING_CONFIRMED_ON,
} from "../src/agent/realtime-cost.mjs";

// Parity vectors computed from RoomJinni's Rust estimator
// (heycode crates/b3-server/src/roomjinni.rs
// estimated_openai_cost_cents_for_gpt_realtime_usage + its funnel tests),
// converted cents -> USD (/100) since this module reports costUsd.

// Vector 1 — roomjinni_funnel_tests.rs "charges_gpt_realtime_not_legacy_voice_types":
// text_in=400 (100 cached), audio_in=600, out text=100, audio=400.
// cents = (300*4 + 100*0.4 + 600*32 + 100*24 + 400*64) * 100 / 1e6 = 4.844 → USD 0.04844
test("parity: detailed usage with cached text", () => {
  const r = estimateRealtimeCost({
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
  assert.ok(Math.abs(r.costUsd - 0.04844) < 1e-9, `costUsd=${r.costUsd}`);
  assert.equal(r.usageObserved, true);
  assert.equal(r.pricingVersion, PRICING_VERSION);
  assert.deepEqual(r.breakdown, {
    input_text: 300, input_audio: 600, input_image: 0,
    cached_text: 100, cached_audio: 0, cached_image: 0,
    output_text: 100, output_audio: 400,
  });
});

// Vector 2 — "conservative_audio_fallback_without_details": aggregate only → bill as audio.
// cents = (1*32 + 1*64) * 100 / 1e6 = 0.0096 → USD 0.000096
test("parity: aggregate-only fallback bills as audio", () => {
  const r = estimateRealtimeCost({ input_tokens: 1, output_tokens: 1, total_tokens: 2 });
  assert.ok(Math.abs(r.costUsd - 0.000096) < 1e-12, `costUsd=${r.costUsd}`);
  assert.equal(r.usageObserved, true);
});

// Vector 3 — "bills_detail_only_events": input detail audio=1, no aggregates.
// cents = 1*32*100/1e6 = 0.0032 → USD 0.000032
test("parity: detail-only event bills", () => {
  const r = estimateRealtimeCost({ input_token_details: { audio_tokens: 1 } });
  assert.ok(Math.abs(r.costUsd - 0.000032) < 1e-12, `costUsd=${r.costUsd}`);
});

test("all-zero usage is flagged unobserved with zero cost", () => {
  const r = estimateRealtimeCost({});
  assert.equal(r.costUsd, 0);
  assert.equal(r.usageObserved, false);
  assert.equal(r.cacheHit, false);
  assert.equal(r.drainSignature, false);
});

test("cacheHit true when cached >= 50% of input", () => {
  const r = estimateRealtimeCost({
    input_tokens: 1000,
    input_token_details: {
      text_tokens: 1000,
      cached_tokens: 600,
      cached_tokens_details: { text_tokens: 600 },
    },
  });
  assert.equal(r.cacheHit, true);
  assert.equal(r.drainSignature, false);
});

test("drainSignature: zero cached with input over the floor", () => {
  const r = estimateRealtimeCost({
    input_tokens: 5000,
    input_token_details: { text_tokens: 5000, cached_tokens: 0 },
  });
  assert.equal(r.drainSignature, true);
  assert.equal(r.cacheHit, false);
});

test("small uncached input does NOT fire the drain signature", () => {
  const r = estimateRealtimeCost({
    input_token_details: { text_tokens: 500, cached_tokens: 0 },
  });
  assert.equal(r.drainSignature, false);
});

// Anti-drift gate (spec 037 Q-3): shipping stale prices must fail the suite.
test("anti-drift gate: pricing confirmed within 60 days", () => {
  const ageDays = (Date.now() - Date.parse(PRICING_CONFIRMED_ON)) / 86400000;
  assert.ok(
    ageDays <= 60,
    `PRICING_CONFIRMED_ON (${PRICING_CONFIRMED_ON}) is ${Math.floor(ageDays)} days old — ` +
      `re-confirm constants against https://openai.com/api/pricing, bump the date ` +
      `(and constants + PRICING_VERSION if prices changed)`,
  );
});
