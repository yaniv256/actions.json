# Hosted-Agent End-to-End Eval Harness

Measures the embedded hosted GPT-Realtime agent's real Docs-editing **error rate** so the
map and primitives can be iterated against a real number until it's under 5%.

**Self-contained** — any actions.json.dev developer can run it from a clone with one
command. It loads the unpacked extension into Playwright's Chromium (the same
`--load-extension` + service-worker pattern as `tests/live/a11y-live-smoke.mjs`), claims a
real Google Doc via the inert `self.__claimTest` hook, and runs each task through a **real**
GPT-Realtime session (real OpenAI key, WebRTC transport — no fakes). No private tooling.

## Two ways to authenticate (both ship in the repo; only the endpoint/cookies are secret)

**Mode A — connect to your own logged-in Chrome (recommended, reliable).** Run a Chrome
that's signed into Google, on a screen, with `--remote-debugging-port` reachable over a
tunnel, and set `EVAL_CDP_ENDPOINT` (gitignored config/secret) to its CDP url
(`http://<tunnel-host>:<port>`). The harness `connectOverCDP`s to it — a genuinely authed
browser, so it sidesteps Google's cookie-transplant flakiness. The extension must be
loaded in that Chrome. `EVAL_CDP_ENDPOINT` must be a real Chrome remote-debugging endpoint
(exposes `/json/version`), not a custom relay.

**Mode B — self-contained cookie injection (portable fallback).** No endpoint: Playwright
launches a fresh Chromium with the unpacked extension and injects your Google cookies from
the gitignored secret (below). Subject to Google's account-chooser flakiness.

## One-time setup

1. **Prereqs:** `@playwright/test` + a cached Chromium (`~/.cache/ms-playwright`) and
   `xvfb-run` (headed MV3 needs a display). Same as the other `*-live` tests.
2. **Your Google auth cookies — a gitignored SECRET you supply.** A real Doc needs a real
   login, so the harness reads Google cookies YOU provide from a gitignored file
   (`tests/live/eval/eval-secrets.cookies.json`, override with `EVAL_COOKIES_FILE`).
   Nothing account-specific lives in the repo; each developer drops in their own. Populate
   it however you like — the built-in way pulls the cookies from your own logged-in Chrome:
   ```bash
   node extensions/chrome-overlay-runtime/scripts/extract-google-cookies.mjs
   # a window opens → sign into the Google account you want the harness to use → it writes
   # the cookies to the secret file. CHROME_CHANNEL=chrome uses your installed Chrome.
   ```
   The harness injects them via Playwright `addCookies` into a throwaway profile. If a run
   hits a sign-in wall it fails loudly (`ProfileNotAuthenticatedError`) — cookies expired;
   repopulate them.
3. **OpenAI key** — the extension's hosted-agent session uses the real key configured in
   the extension. No separate harness key.
4. **A bridge** the extension connects to. By default **the run starts its own serve-mode
   bridge** (mounts `/mcp/tools/call`, which `runtime.agent.await_event` needs) as a tracked
   child and tears it down on exit — you don't start one yourself. Only set `EVAL_BRIDGE_URL`
   if you deliberately manage your own bridge; then the run uses it and does not spawn one.

## Run

```bash
# populate the cookies secret once (above), then:
# optional: an existing sandbox doc to edit (else a new doc is created each run)
export EVAL_DOC_URL='https://docs.google.com/document/d/<your-sandbox-doc>/edit'
# optional: prove the loop cheaply on a subset before the full 20-task keyed run
export EVAL_TASK_IDS='1,2,3'

npm run test:hosted-agent-eval-live
```

Exit 0 = error rate clears <5%; non-zero = it doesn't (or a run error). Prints the
aggregate error rate and writes per-trial artifacts.

## Process ownership — one command, one pid, one kill

The run is the **sole owner** of every process it starts. It launches its serve-mode bridge
and the deployed Chrome as tracked children, and on exit (or Ctrl-C / SIGTERM) it tears the
whole tree down. So:

- **Run it as one process:** `npm run test:hosted-agent-eval-live` (or `node .../hosted-agent-eval-live.mjs`).
- **Kill it as one pid:** `kill <that pid>` (or Ctrl-C). Everything it started dies with it.
- **Crash-safe:** each run **pre-cleans** any serve bridge or eval Chrome a prior crashed
  run leaked, then launches fresh — a `kill -9`'d run's orphans get swept at the next start.
- **The eval's Chrome uses a dedicated `--user-data-dir`** (`EVAL_CHROME_USER_DATA`, default
  `C:\temp\chrome-eval`, seeded once from the authed `DEPLOY_USER_DATA`). Cleanup targets
  **only** that profile — it never touches your real, logged-in browser.

**NEVER launch the bridge from bash** (`nohup`/`setsid`/`&`, or curl-testing a hand-started
bridge). A long-lived process whose stdout the shell inherits wedges the shell until it's
killed. If you're typing `&` around a bridge, stop — run the node entry instead; it owns the
lifecycle. To debug an integrated run without watching inherited stdout, set
`EVAL_TRACE=<file>` — the run appends a structured step trace (bridge up, env ready, runtimes,
drive begin/done, teardown) you read from that file.

## Files

| File | Role |
|------|------|
| `../fixtures/docs-edit-tasks.mjs` | the 20 goal-run tasks + pristine baseline + assertions |
| `scorer.mjs` | pure substring scorer (`must`/`must_any`/`must_not`/`must_para_start`) + neighborhood diff |
| `baseline.mjs` | per-trial reset to pristine (Ctrl+A + type) + `isPristine` guard |
| `harness-env.mjs` | **self-contained** Playwright launch (unpacked ext) + `__claimTest` claim + CDP helpers |
| `session-driver.mjs` | one real task: start → inject → await-until-idle (with a slow-start guard) + ceiling |
| `run-eval.mjs` | the loop: reset → drive → read → score → record → aggregate |
| `hosted-agent-eval-live.mjs` | the self-contained live entry (`npm run test:hosted-agent-eval-live`) |

## Unit tests (no cost, no browser)

```
npm run test:hosted-agent-eval
```

## Reading a run

`runs/<timestamp>/summary.json` has the aggregate error rate and the goal check.
`runs/<timestamp>/trial-NN-{pass,FAIL}.json` has per-trial `prompt`, `actual` doc text,
`fails`, `diff` (neighborhood), and `toolCalls` — enough to root-cause without re-running.
Runs are gitignored.

## Cost note

Each task runs a real GPT-Realtime response (~80k input tokens per response). Use
`EVAL_TASK_IDS='1,2,3'` to prove the loop on a subset before a full 20-task keyed run.
