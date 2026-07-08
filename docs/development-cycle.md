# Development Cycle

## The repo model: PRIVATE dev repo → PUBLIC repo (READ THIS FIRST)

**`actions.json.dev` (this repo) is PRIVATE — it is our DEV BRANCH.** All development and
testing happens here. It is NOT made public and never will be; it stays the private working repo.

**`github.com/yaniv256/actions.json` is the PUBLIC repo — the release surface.** The public
project already exists (the README badges point at it). "Releasing" does NOT mean flipping
`actions.json.dev` public. **Releasing = syncing `main` from `actions.json.dev` → `actions.json`
via a reviewed PR.**

### The release cycle (dev → public sync), step by step
1. **Develop + test** on `actions.json.dev` (private). Cut extension/bridge pre-releases here as
   needed (see the pre-release sections below).
2. When a release is ready and tested, prepare a **sync** = copy `main` from `actions.json.dev`
   into `actions.json` (public).
3. **BEFORE syncing or opening the PR, ANALYZE the sync:** determine every file that would be
   copied, the **diff** on each changed file, and **all new files** being created. READ them.
   Summarize what the sync brings in — features, changes, fixes — into **PR text**.
4. **Show Yaniv the PR text first.** Do NOT sync or open the PR yet. Yaniv reviews and says OK.
5. **Only after Yaniv's OK:** do the sync (copy the content into `actions.json`) and **open the
   PR on `actions.json`** with that PR text.
6. **Yaniv merges** the PR. That is the release.

**Gate:** never sync-then-ask. The order is *analyze → draft PR text → Yaniv approves → sync +
open PR → Yaniv merges.* The PR text is the deliverable Yaniv signs off on before anything lands
publicly. (This applies to promoting private storage maps and any public-facing artifact too:
analyze what goes public, summarize it, get the OK, then push.)

**Sanitize on the way out.** Before content crosses from the private dev repo to the public repo,
scrub anything private: browsing logs, client/consulting names, personal emails/test accounts, and
private-repo submodule links (they dangle on a public parent — publish the ones that are real
public dependencies, exclude dev-only ones). See `investigations/storage-public-transition-exposure.md`
for a worked leak audit.

**Dev-only files that never release → the `internal-docs` branch.** Certain file types accumulate on
`actions.json.dev` that we do NOT release: internal investigations (`investigations/`), plan artifacts
(`docs/plans/`), agent config (`CLAUDE.md`), and similar internal working docs. **We do not just
"exclude" them ad-hoc — we move them onto a branch named `internal-docs`.** So the release sync copies
main *minus* these internal-only file types (which live on `internal-docs`), keeping the public repo
clean of internal material. When analyzing a sync, treat `investigations/`, `docs/plans/`, `CLAUDE.md`,
and other internal-only docs as the `internal-docs` set — they stay on that branch, not in the
dev→public sync.

---

## Extension + Bridge Pre-releases

How to build, pre-release, and live-test an actions.json runtime change
(a new primitive, handler, or bridge/runtime behavior). Most agents working
in this repo are NOT in this mode — read this only when you are actually
changing runtime/bridge code and need to test it in a real browser.

## Release gate — run this checklist EVERY release (AGENTS.md makes reading this mandatory)

Do NOT skip any line under momentum — each is a failure that actually happened:

1. [ ] **Run the Playwright live test** (`npm run test:a11y-live`, or the harness
   covering your change) and confirm it passes on the code you're about to ship —
   BEFORE asking a human to install. Give yourself eyes; don't make a human your oracle.
2. [ ] **Package + publish the extension** (`scripts/package-extension.sh` + `gh
   release create ... --prerelease` with the zip + `SHA256SUMS.txt`). Staging the
   bridge is NOT releasing the extension.
3. [ ] **Verify the fix is in the packaged zip** (`unzip -p <zip> src/<file> | grep <marker>`)
   BEFORE publishing — the package can build from stale/pre-merge main.
4. [ ] **New runtime FILES** added to the change → add them to the explicit list in
   `scripts/package-extension.sh` or the zip ships broken.
5. [ ] **The human ask MUST contain the GitHub release URL** with verified assets
   (`gh release view <tag> --json assets`). No URL = step 2 wasn't done.

The full rationale for each is below. Read it; then act on the checklist.


You cannot meaningfully test a runtime change from an unmerged working tree —
the pieces load out of band. Cutting **development pre-releases is a routine part
of the workflow, not a milestone.** So do **not** treat "cut a release" as a
heavyweight, merge-first, only-when-final act.

**A change usually needs two artifacts before it is testable, and adding a
primitive typically needs both:**

1. **The extension** — installed from a GitHub release; that is the only way the
   extension gets into the browser. A new primitive's content-script handler is
   not live until a build carrying it is published and loaded. Bump
   `extensions/chrome-overlay-runtime/manifest.json`, package with
   `scripts/package-extension.sh --version <v> --out-dir dist`, and publish it in
   the pre-release.
2. **The bridge** — the Rust MCP bridge (`mcp/actions-json-mcp/`). A new primitive
   usually needs the bridge updated too, in one or both ways:
   - the **operations/`--actions` manifest** the bridge advertises from — add the
     primitive to `primitive_dictionary.primitives[]` in
     `extensions/chrome-overlay-runtime/actions/overlay.actions.json` (the
     bridge's default `--actions` file), and **relaunch the bridge** (it reads
     `--actions` once at startup);
   - a **bridge rebuild** when routing is gated in Rust — e.g.
     `extension_executor_supports_primitive` in `mcp/actions-json-mcp/src/lib.rs`
     is a hardcoded allow-list of primitives the bridge routes to the extension;
     a new primitive missing from it is rejected, so add it and
     `cargo build --manifest-path mcp/actions-json-mcp/Cargo.toml`.

The normal loop for extension/runtime changes. **The golden rule: do EVERY
agent-side preparation step, and VERIFY it by contract, BEFORE you ask the human
for the one thing only they can do (install the extension / restart the session).
Each human round-trip is expensive and interrupt-driven — batch all your prep so
one human action makes everything live at once.**

1. **Make the change on a branch** — all of: extension content.js handler +
   `executeAction` dispatch; `primitive_dictionary.primitives[]` entry in
   `overlay.actions.json`; any Rust routing (`extension_executor_supports_primitive`
   in `mcp/actions-json-mcp/src/lib.rs`). Run focused tests + `cargo build`.

2. **Package + publish the extension** — bump `manifest.json`, `scripts/package-extension.sh
   --version <v> --out-dir dist`, `gh release create extension-v<v> --target
   <branch> --prerelease` with the zip + `SHA256SUMS.txt`. (This is what the human
   installs.)

3. **Stage the bridge and repoint the config — DO THIS BEFORE ASKING FOR A
   RESTART.** The running bridge is spawned by `~/.claude.json`
   `mcpServers.actions-json` from a STAGED dir
   `~/.local/share/actions-json-mcp/<ver>/`; a session restart reloads the bridge
   FROM THAT CONFIG. A working-tree `cargo build` does NOT reach it. So a restart
   only tests your new code if you have already staged it:
   ```bash
   STAGE=~/.local/share/actions-json-mcp/<newver>-<slug>
   mkdir -p "$STAGE"
   cp mcp/actions-json-mcp/target/debug/actions-json-mcp "$STAGE/actions-json-mcp"
   cp extensions/chrome-overlay-runtime/actions/overlay.actions.json "$STAGE/overlay.actions.json"
   chmod +x "$STAGE/actions-json-mcp"
   # then repoint BOTH command and --actions in ~/.claude.json mcpServers.actions-json to $STAGE
   ```
   Sanity-check the staged artifacts before the restart:
   `strings "$STAGE/actions-json-mcp" | grep <primitive>` and
   `grep <primitive> "$STAGE/overlay.actions.json"`.

4. **Ask the human for the single combined action** — "install extension-v<v>
   and restart my session." One ask, everything staged, so it all comes live
   together. **The ask MUST contain the GitHub release URL.** If you cannot
   paste a release URL with verified assets (`gh release view extension-v<v>
   --json assets`), you have not done step 2 — staging the bridge is NOT
   releasing the extension, and the human has nothing to install. (Recurring
   failure: an agent completes steps 1 and 3, reports "ready for restart," and
   the release does not exist.) Do NOT ask for a restart before step 3 — that tests stale code and
   wastes a round-trip (this is the exact failure this section exists to prevent).

5. **VERIFY BY CONTRACT before testing — mandatory gate, do not skip.** After the
   restart, confirm the new build is actually live before you run any site test:
   - `actions-json://bridge/launch` — `actions_manifest` path is the NEW staged
     dir (not a stale older one);
   - `actions-json://bridge/tools` — the new primitive name is present (parse the
     JSON; a substring grep can miss it);
   - `actions-json://bridge/runtimes` — the tab is connected on the expected
     `extension_version`.
   If any of these is stale, the delivery failed — fix the staging/config, do not
   proceed to test (a stale artifact makes a delivery bug look like a code bug and
   burns an investigation cycle).

6. **Validate end-to-end live**, then only after it is proven, merge and cut the
   non-prerelease release. **Prefer the autonomous Playwright live test
   (`npm run test:a11y-live`, see below) BEFORE asking a human to install** —
   run it yourself, iterate until green, and reserve the human install/restart
   for the final verified build. Escalate to a human live-test only for cases
   the harness can't cover.

Pre-releases are cheap and expected — reach for one whenever you need code in a
browser to test it. This is a private/dev repo, so dev pre-releases are not gated;
only promotion to distribution surfaces needs the usual approval. Mark them
clearly as pre-releases so an unvalidated build is never mistaken for a shipped
one.

## Autonomous live testing with Playwright — run this BEFORE a human round-trip

An agent can load the **unpacked** extension into a real Chromium via Playwright
and drive the runtime end-to-end from Node — no human install, no restart. This
is the gate that stops the "fix-forward one release per guess" thrash: a live
integration test you run yourself, so each human install validates the FINAL
build, not the Nth attempt. (Motivating incident:
`investigations/a11y-release-thrash.md` — six releases, all integration-seam
bugs the unit tests structurally could not catch because the mocks ARE the
seam. The MV3 `import()`-in-a-service-worker bug that broke the whole a11y
pipeline was caught by this harness on its first green run and is invisible to
Node-ESM unit tests.)

### The one command
```bash
npm run test:a11y-live   # xvfb-run -a node extensions/chrome-overlay-runtime/tests/live/a11y-live-smoke.mjs
```
Exit 0 = the live pipeline works; non-zero = it doesn't. Iterate the fix and
re-run in seconds; only cut a pre-release + ask a human to install once this is
green.

### How the harness works (copy this shape for any new live test)
`extensions/chrome-overlay-runtime/tests/live/a11y-live-smoke.mjs`:

1. **Build any bundles first** — `execFileSync('node', [esbuild.a11y.mjs])` so
   the loaded extension carries current code.
2. **Serve an http fixture** — a tiny `node:http` server returning the test
   page. Use `http://127.0.0.1:<port>/`, NOT `setContent`/`data:`/`about:blank`
   — the extension cannot inject into those (host-permission denied), and a
   pre-commit tab reads as `about:blank`.
3. **Launch a persistent context with the unpacked extension** (MV3 needs a full
   browser; `xvfb-run` supplies the display):
   ```js
   const EXT = 'extensions/chrome-overlay-runtime';       // the dir, not a zip
   const ctx = await chromium.launchPersistentContext(userDataDir, {
     headless: false,
     args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
   });
   ```
4. **Grab the MV3 service worker** — `ctx.serviceWorkers()[0] ||
   await ctx.waitForEvent('serviceworker')`. `sw.evaluate(...)` runs code IN the
   background worker; `sw.on('console', ...)` surfaces its logs (essential — the
   worker swallows errors otherwise).
5. **Navigate `ctx.pages()[0]`** to the fixture url, `waitForSelector('#x',
   {state:'attached'})` (NOT visible — offscreen a11y nodes are "hidden"), then
   resolve the fixture tabId in the SW by exact committed url:
   `(await chrome.tabs.query({})).find(t => t.url === url)?.id`.
6. **Drive the runtime** through a guarded test hook the background exposes
   (`self.__a11yTest` — inert unless a test reads it): `sw.evaluate(id =>
   self.__a11yTest.watch(id), tabId)`, mutate the page with `page.evaluate`,
   then `self.__a11yTest.read(id)` and assert.
7. **Tear down** — `ctx.close()`, `server.close()`, remove the temp userDataDir.

### Gotchas that cost iterations (so you skip them)
- **MV3 service workers forbid dynamic `import()`** (HTML spec). Static-import at
  the top of `background.js` instead; a dynamic import fails silently at runtime
  and Node tests never see it.
- **Injection targets need a real http(s) origin.** `about:blank`/`data:` are
  denied; `allFrames:true` rejects the whole call if ANY frame is inaccessible.
- **`sw.evaluate` reaches module-scoped functions only via an exposed hook** —
  add a guarded `self.__a11yTest`-style surface; don't try to reach internals.
- **Prereqs:** `@playwright/test` + a cached Chromium (`~/.cache/ms-playwright`)
  and `xvfb-run` (headed MV3 needs a display). All present on the dev box.

## a11y bundle build step (U2, phase-1 a11y layer)

The overlay runtime now has one build step: `npm run build:a11y-bundle` bundles
the ChromeVox policy core from `third_party/chromevox` (unmodified, Tier-B
platform seams stubbed — see `docs/a11y-shim-spec.md`) into
`extensions/chrome-overlay-runtime/dist/a11y-bundle.js` (gitignored). Run it
after touching `src/a11y/` or bumping the fork submodule; `npm run test:a11y`
builds + smoke-tests. The extension zip packaging must include the built
bundle once the background worker imports it (U5 wiring).
