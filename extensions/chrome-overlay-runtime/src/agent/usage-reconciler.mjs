// Spec 037 D-9: tracking-error reconciliation against OpenAI's Costs/Usage
// APIs. Requires an OPTIONAL usage-read admin key (project runtime keys lack
// api.usage.read — verified 2026-07-04); every entry point throws
// reconciler_disabled without one so callers stay inert by default.
//
// Verified against OpenAI's published OpenAPI spec: usage endpoints group by
// project/user/api_key/model/batch/service_tier only (no session dimension),
// with bucket_width down to 1m — hence day-level reconciliation as the
// headline and 1-minute-window sums for near-session error.

const API_BASE = "https://api.openai.com/v1/organization";

async function getJson(url, apiKey, fetchImpl) {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`openai_usage_api_failed status=${res.status}`);
  }
  return res.json();
}

const sumAmounts = (page) =>
  (page.data ?? []).reduce(
    (total, bucket) =>
      total +
      (bucket.results ?? []).reduce(
        (sub, result) => sub + (Number(result.amount?.value) || 0),
        0,
      ),
    0,
  );

// Completed-day tracking error: our summed estimates for the day vs the
// Costs API actual. Signed percentage; null when actual is zero (no
// meaningful ratio).
export async function reconcileDay({
  dateStr,
  estimatedUsd,
  apiKey,
  fetchImpl = globalThis.fetch?.bind(globalThis),
}) {
  if (!apiKey) throw new Error("reconciler_disabled: no usage-read key configured");
  const start = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
  const end = start + 86400;
  const page = await getJson(
    `${API_BASE}/costs?start_time=${start}&end_time=${end}&limit=31`,
    apiKey,
    fetchImpl,
  );
  const actualUsd = sumAmounts(page);
  const errorPct =
    actualUsd > 0 ? ((estimatedUsd - actualUsd) / actualUsd) * 100 : null;
  return { date: dateStr, estimatedUsd, actualUsd, errorPct };
}

// Session-window actuals: sum 1-minute usage buckets across [startTs, endTs]
// (epoch ms). Boundary minutes smear; callers compare against the session's
// summed estimates.
export async function reconcileWindow({
  startTs,
  endTs,
  apiKey,
  fetchImpl = globalThis.fetch?.bind(globalThis),
}) {
  if (!apiKey) throw new Error("reconciler_disabled: no usage-read key configured");
  const start = Math.floor(startTs / 1000);
  const end = Math.ceil(endTs / 1000);
  const page = await getJson(
    `${API_BASE}/usage/completions?start_time=${start}&end_time=${end}&bucket_width=1m&limit=60`,
    apiKey,
    fetchImpl,
  );
  let inputTokens = 0;
  let outputTokens = 0;
  for (const bucket of page.data ?? []) {
    for (const result of bucket.results ?? []) {
      inputTokens += Number(result.input_tokens) || 0;
      outputTokens += Number(result.output_tokens) || 0;
    }
  }
  return { startTs, endTs, inputTokens, outputTokens };
}
