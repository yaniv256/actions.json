// gpt-realtime-2.1 cost estimator, ported from RoomJinni
// (heycode crates/b3-server/src/roomjinni.rs
// estimated_openai_cost_cents_for_gpt_realtime_usage), reporting USD.
// Parity with the Rust implementation is pinned by tests/realtime-cost.test.mjs
// whose vectors are derived from RoomJinni's own unit tests.

// USD per 1M tokens. Verbatim from RoomJinni's constants. When OpenAI changes
// prices: update these, bump PRICING_VERSION, and set PRICING_CONFIRMED_ON to
// the day you re-checked https://openai.com/api/pricing — the anti-drift test
// fails any release whose confirmation is older than 60 days.
export const PRICING_VERSION = "openai-gpt-realtime-2.1-2026-07-09";
export const PRICING_CONFIRMED_ON = "2026-07-09";
export const DRAIN_INPUT_FLOOR_TOKENS = 4000;

const PRICES = {
  textIn: 4.0,
  textCachedIn: 0.4,
  textOut: 24.0,
  audioIn: 32.0,
  audioCachedIn: 0.4,
  audioOut: 64.0,
  imageIn: 5.0,
  imageCachedIn: 0.5,
};

const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

export function estimateRealtimeCost(usage = {}) {
  const inD = usage.input_token_details ?? {};
  const cachedD = inD.cached_tokens_details ?? {};
  const outD = usage.output_token_details ?? {};

  const usageObserved =
    n(usage.input_tokens) +
      n(usage.output_tokens) +
      n(usage.total_tokens) +
      n(inD.text_tokens) +
      n(inD.audio_tokens) +
      n(inD.image_tokens) +
      n(inD.cached_tokens) +
      n(cachedD.text_tokens) +
      n(cachedD.audio_tokens) +
      n(cachedD.image_tokens) +
      n(outD.text_tokens) +
      n(outD.audio_tokens) >
    0;

  const inputDetailsPresent =
    n(inD.text_tokens) > 0 ||
    n(inD.audio_tokens) > 0 ||
    n(inD.image_tokens) > 0 ||
    n(inD.cached_tokens) > 0;
  const outputDetailsPresent = n(outD.text_tokens) > 0 || n(outD.audio_tokens) > 0;

  const cachedText = n(cachedD.text_tokens);
  const cachedAudio = n(cachedD.audio_tokens);
  const cachedImage = n(cachedD.image_tokens);

  // Aggregate-only fallback: bill input/output as audio, the most expensive
  // modality, until detailed usage is available (RoomJinni semantics).
  const [textIn, audioIn, imageIn, cText, cAudio, cImage] = inputDetailsPresent
    ? [
        Math.max(0, n(inD.text_tokens) - cachedText),
        Math.max(0, n(inD.audio_tokens) - cachedAudio),
        Math.max(0, n(inD.image_tokens) - cachedImage),
        cachedText,
        cachedAudio,
        cachedImage,
      ]
    : [0, n(usage.input_tokens), 0, 0, 0, 0];

  const [textOut, audioOut] = outputDetailsPresent
    ? [n(outD.text_tokens), n(outD.audio_tokens)]
    : [0, n(usage.output_tokens)];

  const priced = [
    [textIn, PRICES.textIn],
    [cText, PRICES.textCachedIn],
    [audioIn, PRICES.audioIn],
    [cAudio, PRICES.audioCachedIn],
    [imageIn, PRICES.imageIn],
    [cImage, PRICES.imageCachedIn],
    [textOut, PRICES.textOut],
    [audioOut, PRICES.audioOut],
  ];
  const costUsd = usageObserved
    ? priced.reduce((sum, [tokens, perMillion]) => sum + (tokens * perMillion) / 1e6, 0)
    : 0;

  const totalInput = inputDetailsPresent
    ? n(inD.text_tokens) + n(inD.audio_tokens) + n(inD.image_tokens)
    : n(usage.input_tokens);
  const totalCached = inputDetailsPresent ? n(inD.cached_tokens) : 0;

  return {
    costUsd,
    breakdown: {
      input_text: textIn,
      input_audio: audioIn,
      input_image: imageIn,
      cached_text: cText,
      cached_audio: cAudio,
      cached_image: cImage,
      output_text: textOut,
      output_audio: audioOut,
    },
    cacheHit: totalInput > 0 && totalCached >= totalInput * 0.5,
    drainSignature: totalCached === 0 && totalInput >= DRAIN_INPUT_FLOOR_TOKENS,
    usageObserved,
    pricingVersion: PRICING_VERSION,
  };
}
