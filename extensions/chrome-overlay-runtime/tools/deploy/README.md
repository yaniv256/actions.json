# Extension deployment machinery

How the repo takes a **new (unpacked) extension build and loads it into a real Chrome**
for testing, then makes the extension take control of a tab — with no human install and
no browser-store round-trip. This is support/deployment machinery for the eval harness
(`../../tests/live/eval/`): *"new extension version → load it into a Chrome → run the
tests."* It lives here because loading the extension is part of the testing story.

## Why it isn't just `--load-extension`

Chrome 137+ removed `--load-extension` in **branded** Chrome (security). The portable
runtime replacement is the CDP `Extensions.loadUnpacked` command, which requires a
`--remote-debugging-pipe` connection. The pipe's file descriptors can only be owned by a
**native** process that spawns Chrome directly (on WSL, the fds don't cross into a Windows
`chrome.exe` — you get "Remote debugging pipe file descriptors are not open"). So the pipe
work is done by three small native-node helpers here:

| File | Role |
|------|------|
| `load_unpacked.mjs` | one-shot: `Extensions.loadUnpacked` an unpacked ext into a headless pipe-Chrome, verify by manifest name, exit cleanly (flushes signed prefs). |
| `pipe_session.mjs` | long-lived: pipe-Chrome + a pipe↔WebSocket relay, so the SAME instance the ext is loaded into is driveable over CDP (Chrome 149 won't auto-load an unpacked ext across launches). |
| `claim_tab.mjs` | headless equivalent of the popup claim: opens `popup.html` to wake+hold the MV3 SW, fires `authorize-tab` at the target tab so the extension takes control. |

`deploy.mjs` wraps these as importable functions (`deployExtensionSession`, `claimTab`)
the harness uses.

## Config (env, so nothing machine-specific is baked in)

| Env | Meaning |
|-----|---------|
| `DEPLOY_CHROME` | path to `chrome.exe` / `chrome` |
| `DEPLOY_NODE` | a **native** node that can own the pipe fds (on WSL: a Windows `node.exe`) |
| `DEPLOY_USER_DATA` | Chrome `--user-data-dir` — a **Google-logged-in profile** for authed Docs tests |
| `DEPLOY_CDP_HOST` | `host:port` the launched relay is reachable at from the test runner (over a tunnel if remote) |

## How the harness uses it

The eval harness's **Mode A** (`EVAL_CDP_ENDPOINT`) connects to the CDP endpoint this
returns. So the full loop lives in one repo: **new build → `deployExtensionSession(ext)`
loads it into a Chrome + returns a CDP endpoint → the harness claims the Doc tab
(`claimTab`) → runs the eval.** The authenticated Chrome is a real logged-in browser
(`DEPLOY_USER_DATA`), which also solves auth without cookie transplant.

> Note: these helpers were prototyped in a separate MCP server; they are pure node (only
> `ws`) and now live here as the extension's own deployment machinery.
