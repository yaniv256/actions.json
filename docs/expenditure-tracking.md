# Expenditure Tracking (spec 037)

The extension tracks every hosted gpt-realtime-2.1 response's cost: a live meter in the
page overlay, per-response JSONL records persisted to your own S3 bucket, session
summaries, and an optional tracking-error readout comparing our estimates against what
OpenAI actually charged.

## The live meter

A chip appears bottom-left on claimed tabs after the first hosted-agent response:

```
● session $0.42 · last $0.0031 · today $1.50
```

- **session** — running estimated cost of the current hosted session.
- **last** — the most recent response's estimated cost.
- **today** — a this-browser day total (local counter, resets at midnight; sessions on
  other machines are not included).
- **The dot** — green when caching looks healthy; **pulsing red** when a response fires
  the cache-miss drain signature (zero cached input tokens on a context ≥ 4k tokens —
  the pattern that drains credit fastest). If it pulses red repeatedly, something is
  busting the prompt cache; that is worth investigating immediately.

The meter works with no storage configured. Only persistence needs setup.

## S3 setup (options page)

Open the extension's options (chrome://extensions → actions.json → Extension options):

1. Fill bucket, region, key prefix (default `actions-json`), access key id, secret.
2. Click **Test write** — it round-trips a probe object and shows the S3 error verbatim
   on failure.
3. Use a scoped IAM key. Minimal policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/actions-json/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET",
      "Condition": { "StringLike": { "s3:prefix": "actions-json/*" } }
    }
  ]
}
```

The key lives in extension local storage on this machine — scope it accordingly.

Records spool locally (IndexedDB) and flush every minute in batched part objects, so
offline periods and service-worker restarts lose nothing. Keys look like:

```
actions-json/expenditure/2026-07-04/<session_id>/part-<ts>-<rand>.jsonl
```

## Record schema

One JSON object per line. `kind: "realtime_response_usage"`:

| field | meaning |
|---|---|
| `ts`, `response_id`, `session_id`, `model` | provenance |
| `input_text/audio/image` | fresh (uncached) input tokens per modality |
| `cached_text/audio/image` | cached input tokens per modality |
| `output_text/audio`, `total_tokens` | output + total |
| `estimated_cost_usd` | per-modality priced estimate |
| `pricing_version` | pricing table the estimate used |
| `cache_hit` | cached ≥ 50% of input |
| `usage_observed` | false ⇒ zero-usage payload, zero-cost record |

`kind: "realtime_session_summary"` (one per session): `responses`, `cache_hits`,
`cache_hit_rate`, `total_tokens`, `total_cost_usd`, `duration_ms`, first/last response
ids. `kind: "reconciliation"` (daily, optional): `estimatedUsd`, `actualUsd`, `errorPct`.

## Analyzing the JSONL

Day total:

```bash
cat part-*.jsonl | jq -s 'map(select(.kind=="realtime_response_usage").estimated_cost_usd) | add'
```

Cache-hit rate:

```bash
cat part-*.jsonl | jq -s '[.[] | select(.kind=="realtime_response_usage")] | (map(select(.cache_hit)) | length) / length'
```

Most expensive responses:

```bash
cat part-*.jsonl | jq -s '[.[] | select(.kind=="realtime_response_usage")] | sort_by(-.estimated_cost_usd) | .[0:5] | .[] | {response_id, estimated_cost_usd, cache_hit}'
```

## Tracking error (optional)

Paste a **restricted OpenAI admin key with only the `api.usage.read` scope** into the
options page (the runtime project key cannot read usage). Every ~6 hours the extension
reconciles the previous completed UTC day: our summed estimates vs the Costs API actual,
written as a `reconciliation` record and kept in `actionsJsonTrackingError`. A persistent
error beyond ±10% means pricing drift, an estimator bug, or another consumer on the
project — all worth knowing. Without the key, no OpenAI usage calls are ever made.

## Pricing drift protection

Pricing constants are bundled (`src/agent/realtime-cost.mjs`) with a
`PRICING_CONFIRMED_ON` date. A unit test fails the suite when that date is older than 60
days, so a release cannot ship unconfirmed prices: re-check https://openai.com/api/pricing,
bump the date, and bump the constants + `PRICING_VERSION` if prices changed. Historical
records stay auditable because every record carries the `pricing_version` it was priced
with.
