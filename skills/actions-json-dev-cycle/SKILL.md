---
name: actions-json-dev-cycle
description: The mandatory release gate for any actions.json extension/bridge/runtime change (new primitive, handler, manifest edit, or runtime behavior). Use before ANY dev pre-release, version bump, package, or gh release in actions.json.dev. Phased so it can run as a no-skip chained-prompt — each phase is a gate that must complete before the next.
---

<!-- chained-prompts-redirect -->
> **If the `chained-prompts` MCP is available, run this skill as a chained-prompt instead of executing these phases inline.** The release gate is a no-skip protocol — running it as a chain serves the phases one at a time and will not let you skip ahead. Start with `chain_start("actions-json-dev-cycle")`, do the returned phase, then `chain_complete("actions-json-dev-cycle", "<phase>")` for the next. If `chained-prompts` is not available, run the phases below inline.

# actions.json Dev Cycle — the release gate

How to build, pre-release, and live-test an actions.json runtime change so a human install/restart validates the FINAL build, not the Nth guess. Every phase below is a gate that has failed in a real incident when skipped — do not skip any under momentum.

The golden rule: **do EVERY agent-side preparation step, and VERIFY it by contract, BEFORE you ask the human for the one thing only they can do (install the extension / restart the session).** Each human round-trip is expensive; batch all prep so one human action makes everything live at once.

## Public-Release Conventions (ABSOLUTE — learned the hard way, Yaniv 2026-07-08)

These govern anything that becomes PUBLIC (the `yaniv256/actions.json` repo, its public storage repos, the public
skills, the GitHub release). Break none of them.

### Authorship & attribution — Yaniv, not the agent
- **Every commit in Yaniv's repos is authored + committed by `Yaniv Ben-Ami <yaniv@realtimevoice.dev>`** (GitHub
  `yaniv256`). Set `git config user.name/user.email` per repo, or use `-c` flags. Never "Zara Chen" / agent identity.
- **PUBLIC repos must show ONLY Yaniv as a contributor.** Do NOT add `Co-Authored-By: Claude` (or Zara/Anthropic)
  trailers to anything that lands in a public repo. (This overrides the harness default of appending that trailer.)
  If a public repo already shows Claude as a contributor, rewrite its history clean (author/committer=Yaniv, strip
  the trailers), delete stale branches, force-push, and re-point every superproject submodule pin that referenced it.
- **No "Generated with Claude Code" / no Claude attribution** on public artifacts (PR bodies, notes, README).

### Visibility — PRIVATE by default; a license does NOT make a repo public
- **Visibility is a deliberate, per-repo decision, SEPARATE from license.** An MIT/open-source LICENSE does NOT make
  a repo public — e.g. `actions.json.dev` is MIT-friendly but PRIVATE (it is the internal dev cycle).
- **Default PRIVATE.** Only the specific ecosystem repos Yaniv chose to ship are public (actions.json + its public
  storage repos + the public skills he promoted). Internal dev repos, product code, infra/tooling, experiments,
  `*-test`/`*-rogue` repos are PRIVATE — flag and ask before ever leaving one public. Don't just operate on a repo;
  question whether it should be public at all.

### Public-facing text (PR body / release notes / README) — changelog only, authorized text
- **Use the text Yaniv authorized VERBATIM.** Do not overwrite approved copy with your own "improved" version; if it
  needs changing, propose the edit and get his OK.
- **Describe ONLY what is in THIS change.** Never present a pre-existing capability as new (e.g. the voice agent
  predates this release — do not headline it in a sync PR). Build notes by READING every commit since the last
  public release (see release-notes rule), not from memory.
- **Never leak internal machinery.** No mention of the private→public sync, the private dev repo, scrubbing client
  names, internal-docs, or submodule/pin reconciliation. A public PR reads as a normal changelog of the diff.
- **Name the real VERSION, never a placeholder** ("v0.1.x" is unacceptable). The version is the dev extension
  manifest version: `extensions/chrome-overlay-runtime/manifest.json` → `"version"` (this release = 0.1.186).

### Release notes — read EVERY commit since the last public release, in batches
- Do NOT write release notes from memory (it misses major shipped features). List every commit
  `git log --oneline <last-public-tag>..HEAD`, process in batches (~5-20), take consumer-facing notes per batch, then
  synthesize. The README/pitch leads with the **product** (the voice agent that runs on any website); the a11y layer,
  editing stack, markers, and the map are the infrastructure that makes it reliable.

### Sanitize on the way out
- Before content crosses to a public repo, scrub client/consulting names (e.g. real client domains) from test
  fixtures and data, browsing/telemetry logs, personal emails/test accounts, and private-submodule links.

### GitHub binary release — ONE release only
- People download the extension + the per-platform MCP bridge from ONE GitHub release. When cutting a new release,
  **delete the older releases** (`gh release delete <tag> --cleanup-tag`) so exactly one exists.
- Build real binaries on real machines via `scripts/release-binaries.sh --version <v> --tag extension-v<v>`
  (extension zip on this host; linux-x64 native; win-x64 over PowerShell; macos-arm64/x64 over SSH to the Mac).
  Verify each artifact + SHA256SUMS before upload. The **`chrome-launcher-helper.exe`** (the native-Windows pipe owner) ships as its **OWN standalone release asset** — `chrome-launcher-helper-<v>-win-x64.tar.gz` — NOT inside the bridge tarball. Why (Yaniv 2026-07-09): the helper must be installed where the **BROWSER** runs, which in the WSL→Windows topology is a DIFFERENT machine than the one that pulls the bridge tarball (the agent host, typically linux-x64). Bundling it in the win-x64 bridge tarball only serves an all-Windows setup and hides it from the split setup it exists for. `release-binaries.sh` builds it natively on the Windows host (`build_windows`) and emits it via `package_helper()` as its own asset. After a release, CONFIRM it's a listed asset on the PUBLIC repo: `gh release view extension-v<v> --repo yaniv256/actions.json --json assets` must include `chrome-launcher-helper-<v>-win-x64.tar.gz`. (0.1.186 shipped the helper only *inside* the win-x64 tarball — the standalone-asset design is the corrected shape for the next release.)

Two artifacts are usually involved and load out of band: **the extension** (installed from a GitHub release — the only way it reaches the browser) and **the bridge** (the Rust MCP bridge: its `--actions` manifest, read once at launch, and its Rust routing allow-list `extension_executor_supports_primitive`). A working-tree `cargo build` does NOT reach the running bridge — it is spawned by `~/.claude.json` from a STAGED dir.

### Phase 1: Make the change on a branch and pass focused tests

Make ALL of the change on a feature branch: extension `content.js` handler + `executeAction` dispatch; `primitive_dictionary.primitives[]` (and `tools[]`) entry in `overlay.actions.json` for a new primitive; any Rust routing (`extension_executor_supports_primitive` in `mcp/actions-json-mcp/src/lib.rs`). Run the focused unit tests for the changed surface and `cargo build --manifest-path mcp/actions-json-mcp/Cargo.toml`. Do not proceed on a broken tree; a pre-existing unrelated failure must be confirmed pre-existing (test it on `main`) and noted, not fixed here.

### Phase 2: Run the Playwright live test BEFORE any human round-trip

Run the live harness that loads the UNPACKED extension into real Chromium and drives the runtime end-to-end from Node — no human install, no restart:

```bash
npm run test:a11y-live   # xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/a11y-live-smoke.mjs
```

Exit 0 = the live pipeline works. This is the gate that stops "fix-forward one release per guess" — integration-seam bugs the unit tests structurally cannot catch (the mocks ARE the seam) surface here. If your change has a behavior the a11y smoke doesn't cover, add a live smoke in the same shape (see the dev-cycle doc's harness section). Iterate until green BEFORE cutting a pre-release. Give yourself eyes; don't make a human your oracle.

**For a change to hosted-agent Docs editing (map/primitives/navigation), also run the hosted-agent eval harness** (`extensions/chrome-overlay-runtime/tests/live/eval/`). It measures the embedded GPT-Realtime agent's real Docs-editing error rate against 20 human-phrased tasks — the number you iterate to <5%. It exercises the REAL feature: tasks like the paragraph-split (#18) and word-level edits (#20) force the gated word/paragraph navigation, not spot fixes. See the Hosted-Agent Eval Harness section below for how to run + connect it.

### Phase 2b: Launching a Chrome you own — the chrome-launcher

Two things need a browser *you* control, never the human's: the live gate above, and any
isolated-world debugging (a content-script bug is invisible to `debug.run_javascript`, which runs in
the page's **main** world). Never commandeer the human's tab to debug — a wedged tab costs them
their session.

**The five launcher tools live in the `actions-json` MCP.** They are Rust, they are current, and
they are the only ones you should call:

| tool | use |
|---|---|
| `mcp__actions-json__chrome_endpoint` | launch/reuse a visible Chrome, get its CDP `webSocketDebuggerUrl` (hand to puppeteer) |
| `mcp__actions-json__start_extension_session` | launch a visible Chrome **with our unpacked extension already loaded**, driveable over CDP. The self-install flow; no human clicks |
| `mcp__actions-json__load_extension` | install the unpacked extension into an existing debug profile |
| `mcp__actions-json__claim_tab` | headless claim/authorize a tab |
| `mcp__actions-json__chrome_kill` | stop Chrome on Windows |

```
mcp__actions-json__start_extension_session
  extension_dir  = "C:\\temp\\ext-probe"        <-- a WINDOWS path
  user_data_dir  = "C:\\temp\\chrome-zprobe"    <-- dedicated profile
->  {"ok":true, "name":"actions.json Overlay Runtime", "version":"0.1.189",
     "id":"dbbg…", "launch":"interactive (schtasks /IT)",
     "webSocketDebuggerUrl":"ws://192.168.176.1:9223"}
```

Identity is **verified by manifest name**, never by id prefix. `ok:true` plus that name is your
proof the extension you meant is the extension that loaded.

**Gotchas, each of which has cost a session:**

- **Pass a Windows path.** Chrome runs on Windows; a WSL `/tmp/...` path fails with
  `loadUnpacked failed: File path cannot be resolved`. Copy the unpacked dir to `/mnt/c/temp/<name>`
  and pass `C:\temp\<name>`.
- **`mcp__chrome-launcher__*` is a RETIRED server.** If your MCP config still registers a
  `chrome-launcher` server (Python, from the legacy `agent-flow` tree), it *shadows* the Rust tools
  by owning that namespace, and its `start_extension_session` has never worked — it raises
  `NameError: name 'proc' is not defined` on every call, relabelled by a catch-all `except` as an
  opaque `{"stage":"session-invoke"}`. **Delete the server from the config; do not patch it.**
  Verify what a tool actually runs by reading the config (`~/.mcp.json` → `mcpServers`), not by
  `find`-ing a file with a matching name.
- **Chrome 149+ will not auto-load a self-installed unpacked extension on a later normal launch.**
  You must drive the very instance you installed into — which is exactly what
  `start_extension_session` returns. Don't launch, install, then relaunch.
- **Validate the instrument before you trust the experiment.** An unpacked extension whose entry
  points fail to parse as ES modules registers its service worker and executes **zero statements**,
  silently — no exception, nothing on `chrome://extensions`. Before loading a hand-edited copy,
  `acorn`-parse every entry point with `sourceType:"module"` (`scripts/tests/package-extension-completeness.test.mjs`
  does this). Otherwise "no console output" reads as "it hung before my first checkpoint."

### Phase 3: Package the extension and VERIFY the fix is in the zip

Bump `extensions/chrome-overlay-runtime/manifest.json`, then package:

```bash
bash scripts/package-extension.sh --version <v> --out-dir dist
```

**New runtime FILES** added by the change → add them to the explicit list in `scripts/package-extension.sh` or the zip ships broken.

Then **verify the fix is actually in the packaged zip** before publishing — the package can build from stale/pre-merge main:

```bash
unzip -p dist/actions-json-overlay-runtime-<v>.zip src/<file> | grep <marker>
```

Confirm the version and every changed file's marker are present. Do not publish a zip you haven't grepped.

### Phase 4: Publish the pre-release with verified assets

Publish, targeting the branch, with the zip + `SHA256SUMS.txt`:

```bash
gh release create extension-v<v> --target <branch> --prerelease \
  --title "..." --notes "..." dist/actions-json-overlay-runtime-<v>.zip dist/SHA256SUMS.txt
```

Then verify the assets exist: `gh release view extension-v<v> --json assets`. Staging the bridge is NOT releasing the extension — if you cannot produce a release URL with verified assets, the human has nothing to install. Mark it clearly as a pre-release. Dev pre-releases in this private repo are routine and ungated; only promotion to distribution surfaces needs approval.

### Phase 5: Stage the bridge and repoint the config

Do this BEFORE asking for a restart — a restart only tests your new code if it is already staged:

```bash
STAGE=~/.local/share/actions-json-mcp/<newver>-<slug>
mkdir -p "$STAGE"
cp mcp/actions-json-mcp/target/debug/actions-json-mcp "$STAGE/actions-json-mcp"
cp extensions/chrome-overlay-runtime/actions/overlay.actions.json "$STAGE/overlay.actions.json"
chmod +x "$STAGE/actions-json-mcp"
# then repoint BOTH command and --actions in ~/.claude.json mcpServers.actions-json to $STAGE
```

Sanity-check: `strings "$STAGE/actions-json-mcp" | grep <primitive>` and `grep <marker> "$STAGE/overlay.actions.json"`. Skip the binary copy only if `mcp/` did not change (reuse the prior binary, swap the manifest).

### Phase 6: Ask the human for the single combined action

One ask, everything staged: **"install extension-v<v> and restart my session."** The ask MUST contain the GitHub release URL with verified assets (Phase 4). Recurring failure: an agent completes the build + staging, reports "ready for restart," and the release does not exist — do not do that. Do NOT ask for a restart before Phase 5 (that tests stale code and wastes a round-trip).

### Phase 7: Verify by contract before testing

After the restart, confirm the new build is actually live BEFORE running any site test — a stale artifact makes a delivery bug look like a code bug and burns an investigation:

- `actions-json://bridge/launch` — `actions_manifest` is the NEW staged dir (not a stale one);
- `actions-json://bridge/tools` — the new primitive/tool is present (parse the JSON; a substring grep can miss it);
- `actions-json://bridge/runtimes` — the tab is connected on the expected `extension_version`.

If any is stale, the delivery failed: fix staging/config, do not proceed to test.

### Phase 8: Validate end-to-end live, then promote

Drive the actual changed behavior against a real runtime and confirm it works. Only after it is proven live: merge the branch and cut the non-prerelease release. Prefer the autonomous Playwright path (Phase 2) for as much as possible; reserve the human install/restart for the final verified build. Escalate to a human live-test only for cases the harness can't cover.

---

## Hosted-Agent Eval Harness — run + connect

Lives in `extensions/chrome-overlay-runtime/tests/live/eval/`. Measures the embedded
GPT-Realtime agent's real Docs-editing **error rate** (the number you drive to <5%). Runs
the 20 goal-run tasks against a real agent editing a real Google Doc, exact-substring
scored, per-trial artifacts under `runs/<ts>/` (gitignored). It is **self-contained in the
repo** — the extension-deployment machinery ships in `tools/deploy/` (it is deployment
machinery for *this* extension, not private tooling).

### Files

| File | Role |
|------|------|
| `fixtures/docs-edit-tasks.mjs` | 20 tasks + pristine baseline + `must`/`must_not`/`must_any`/`must_para_start` assertions |
| `scorer.mjs` | pure substring scorer + neighborhood diff (unit-tested) |
| `baseline.mjs` | per-trial reset to pristine + `isPristine` guard |
| `harness-env.mjs` | stands up the browser + claims the Doc tab; auto-selects the auth mode |
| `session-driver.mjs` | one real task: `runtime.agent.start` → `user_message` → `await_event` (idle-after-quiet + ceiling) via the inert `self.__agentTest` SW hook |
| `run-eval.mjs` | the loop: reset → drive → read → score → record → aggregate |
| `hosted-agent-eval-live.mjs` | the one live entry (`npm run test:hosted-agent-eval-live`) |
| `../../tools/deploy/` | deployment machinery: `deploy.mjs` (`deployExtensionSession`/`claimTab`) + native-node helpers (`load_unpacked.mjs`, `pipe_session.mjs`, `claim_tab.mjs`) |

### Two ways to connect (both ship; only the endpoint/cookies are the gitignored secret)

**Mode A — connect to your own logged-in Chrome (recommended, reliable).** Bring a Chrome
signed into Google, on a screen, with a normal `--remote-debugging-port` reachable over a
tunnel, and set `EVAL_CDP_ENDPOINT` (gitignored) to its CDP url (`http://<host>:<port>` —
a real Chrome endpoint that serves `/json/version`, NOT a WS-only relay). The extension
must be loaded in that Chrome (or let Mode A' deploy it, below). A genuinely authed browser
sidesteps Google's cookie-transplant flakiness.

**Mode A' — the repo deploys its own build (the "new release → test" loop).** No endpoint;
set `DEPLOY_CHROME` + `DEPLOY_USER_DATA` (a logged-in profile) and the harness calls
`tools/deploy/deployExtensionSession()` to load the unpacked extension into a Chrome and
returns a CDP endpoint it then connects to. This is why the deployment machinery lives in
the repo: Chrome 137+ removed `--load-extension` in branded Chrome, so a new build is loaded
via CDP `Extensions.loadUnpacked` over a `--remote-debugging-pipe`, whose fds only a native
process can own (on WSL, they don't cross into a Windows `chrome.exe`).

**Mode B — self-contained cookie injection (portable fallback).** No endpoint/deploy config:
Playwright launches a fresh Chromium with `--load-extension` and injects your Google cookies
from the gitignored secret (`eval-secrets.cookies.json`, override `EVAL_COOKIES_FILE`;
populate via `scripts/extract-google-cookies.mjs`). Subject to Google's account-chooser
flakiness — prefer Mode A.

### Run

```bash
# Mode A' example (repo deploys its own build into your logged-in Windows Chrome):
export DEPLOY_CHROME='C:\Program Files\Google\Chrome\Application\chrome.exe'
export DEPLOY_NODE='/mnt/c/Program Files/nodejs/node.exe'   # a NATIVE node (owns the pipe fds)
export DEPLOY_USER_DATA='C:\temp\chrome-debug'              # your Google-logged-in profile (seed source)
export DEPLOY_CDP_HOST='192.168.176.1:9223'                 # WSL-reachable relay host:port (portproxy)
export EVAL_BRIDGE_WS_URL='ws://<tunnel-ip>:17346/extension'# addr the Windows ext reaches the WSL bridge at
export EVAL_TASK_IDS='18,20'   # prove on navigation-forcing tasks before the full 20 (costs OpenAI $)

npm run test:hosted-agent-eval-live   # exit 0 = error rate clears <5%; ONE pid, kill it to stop everything
```

The run **owns its own serve-mode bridge** (starts + tears down `/mcp/tools/call` for
`await_event`) and its own Chrome on a dedicated `EVAL_CHROME_USER_DATA` profile — you do NOT
start a bridge yourself, and killing the run's pid tears the whole tree down. **Never launch a
bridge from bash** (`&`/`nohup`/`setsid`) — it wedges the shell; set `EVAL_TRACE=<file>` for a
non-wedging step trace. Only set `EVAL_BRIDGE_URL` to reuse a bridge you manage.

Env summary: `EVAL_CDP_ENDPOINT` (Mode A) | `DEPLOY_CHROME`/`DEPLOY_NODE`/`DEPLOY_USER_DATA`/`DEPLOY_CDP_HOST`/`EVAL_CHROME_USER_DATA`/`EVAL_BRIDGE_WS_URL` (Mode A') | `EVAL_COOKIES_FILE` (Mode B) | `EVAL_DOC_URL`, `EVAL_TASK_IDS`, `EVAL_TRACE` (all modes). Unit tests (no cost/browser): `npm run test:hosted-agent-eval`.

### Status (2026-07-07)

Built, self-contained, deployment machinery in-repo. The full Mode A' pipeline runs
end-to-end — deploy → connect (raw CDP) → open doc → claim → baseline → real `gpt-realtime-2.1`
agent → read (`/mobilebasic`) → score — and produces a real scored result. Process lifecycle
is **run-owned** (plan `docs/plans/2026-07-07-007-*`): the run starts/kills its serve bridge +
eval Chrome, pre-cleans leaked processes, and never wedges the shell. Remaining before the
green navigation run that gates merging `feat/eval-plus-gated-nav` to main: confirm the
integrated `await_event` path records real tool_call events (the agent acts) on tasks #18/#20 —
diagnose via `EVAL_TRACE` if it still times out.
