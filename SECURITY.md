# Security

**If you are reviewing this repo before installing, start here.** A scan of
`manifest.json` will flag two things. Both are intentional, both are permanent,
and here is the short answer to each:

- **`debugger`** — Google Docs, Sheets, and Slides paint to `<canvas>` and
  ignore untrusted synthetic events. CDP `Input.dispatchKeyEvent` is the only
  way an extension can type into them, and the `debugger` permission is the only
  way to reach CDP. It attaches per-tab, only to tabs you explicitly authorized,
  and Chrome shows its own persistent warning banner the whole time. → §2
- **`<all_urls>`** — the product is a voice agent that operates *any* website;
  this permission is that sentence in manifest form. It is capability, not
  activity: nothing is controlled until you click **"Take control of this tab,"**
  per tab. → §3

Neither will be removed, because removing either deletes the product rather than
hardening it. What *has* changed is everything that could be fixed: the local
bridge no longer hands credentials to any page that dials it (§5), and the npm
installer verifies release binaries against published checksums (§6).

This document is written to be checked, not believed. Every claim cites a file
and a line, §8 lists the risks that are still unfixed, and §3, §5, and §6 each
end with a caveat that argues against us. If a section reads as reassurance
rather than evidence, it has failed and we would like to hear about it (§7).

---

## 1. Threat model

**What this software can do on your machine.** It drives a Chrome tab you have
explicitly authorized: it reads the page, moves the pointer, types (including as
trusted input via the Chrome DevTools Protocol), takes screenshots, navigates,
and uploads or downloads files you name. It runs a local HTTP/WebSocket bridge
on loopback. It holds your OpenAI API key and sends it to `api.openai.com`.

**What it deliberately does not do.**

- It has no server. There is no `actions.json` backend, no account, no
  telemetry, no analytics, and no crash reporting. Check it the direct way
  rather than by SDK name: enumerate every outbound host in the shipped sources
  with
  `grep -rhoE 'https?://[a-z0-9.-]+' extensions/chrome-overlay-runtime/src mcp/actions-json-mcp/src | sort -u`.
  It returns about two dozen hosts; all but the ones named here are test
  fixtures (`*.example.com`, `livekit.example`), documentation links, or site
  hostnames appearing inside `actions.json` maps as data the runtime never
  dials. The only hosts the runtime actually contacts are `api.openai.com`
  (`extensions/chrome-overlay-runtime/src/agent/realtime-webrtc-transport.mjs:1`,
  `.../agent/corpus-embedding.mjs:12`, `.../agent/usage-reconciler.mjs:11`) and,
  if you configure a LiveKit/Protoface avatar, the LiveKit URL you supply
  yourself (`mcp/actions-json-mcp/src/lib.rs:955`).
- It does not act on a tab you have not authorized. See §3.
- It does not exfiltrate your API key to us, because there is no "us" to
  exfiltrate to. See §4.

**Who it trusts.**

1. **You.** You choose which tab to hand over and when to stop.
2. **The local machine.** Credentials live in `chrome.storage.local` and in
   `.actions-json.local.json` on disk. Anyone with your OS user account can read
   both. This software does not defend against a local attacker who already has
   your user account.
3. **OpenAI.** Page content the agent reads and your spoken audio go to the
   OpenAI Realtime API under your own key and your own account terms.
4. **The model, partially.** The agent is an LLM operating a live browser
   session that carries your logged-in cookies. Prompt injection from page
   content is a real and unmitigated risk — see §8.

---

## 2. Why the extension requests `debugger`

`extensions/chrome-overlay-runtime/manifest.json:29` requests `debugger`. This
is the permission a reviewer flags hardest, so here is the exact reason.

**Synthetic DOM events are not accepted by canvas-based editors.** Google Docs,
Sheets, and Slides paint to a `<canvas>` and ignore events whose
`isTrusted` is `false`. A `dispatchEvent`-driven keystroke does nothing there.
The only way for an extension to produce a genuinely trusted keystroke is CDP
`Input.dispatchKeyEvent`, and the only way to reach CDP from an extension is the
`debugger` permission. Removing `debugger` does not weaken the product; it
deletes the ability to operate a whole class of applications.

**Where it is used.** The extension has exactly one CDP call surface, defined at
`extensions/chrome-overlay-runtime/src/background.js:2937-2944`
(`chrome.debugger.attach` / `detach` / `sendCommand`), routed through a single
refcounted owner, `DebuggerSessionManager`
(`extensions/chrome-overlay-runtime/src/agent/debugger-session-manager.mjs`),
acquired at `background.js:2961`. The trusted-key dispatch itself is at
`background.js:3046` (`Input.dispatchKeyEvent`).

**What bounds it.**

- **It is per-tab, never browser-wide.** Every attach target is `{ tabId }`
  (`background.js:2938`). There is no browser-level or `chrome://` attach path;
  `claimAuthorizedTab` refuses `chrome://` URLs outright
  (`background.js:1808-1810`).
- **The tab id comes from the authorized-tab record, not from the agent.**
  Routing resolves through `getClaimedActiveTab()`
  (`background.js:4432`), which reads the persisted claim store and re-checks
  ownership via `requireOrdinaryTabOwnership` before returning a tab.
- **Trusted input is opt-in per call.** `keyboard.press`, `text.type`, and
  `pointer.drag` default to the synthetic content-script path; only
  `trusted: true` routes to CDP (`background.js:153-174`).
- **Chrome tells the user.** An attached debugger shows the persistent
  "actions.json Overlay Runtime started debugging this browser" infobar. This
  capability cannot be used covertly under Chrome's own UI.

---

## 3. Why the extension requests `<all_urls>`

`manifest.json:36-38` requests `host_permissions: ["<all_urls>"]`.

**The product is "a voice agent that operates any website."** Host permission
for all URLs is that sentence expressed as a manifest field. An extension that
can only operate a fixed allow-list of sites is a different product. There is no
narrower permission that preserves the capability, because the set of sites is
exactly "whichever site the user is on."

Host permission is *capability*, not *activity*. `<all_urls>` means the
extension **may** act on any origin when instructed. What it actually acts on is
gated separately, and that gate is a per-tab user action:

**A tab is not controlled until the user clicks a button.** The only paths that
create a control claim are the popup button labeled **"Take control of this
tab"** (`extensions/chrome-overlay-runtime/popup.html:183`, handler at
`src/popup.js:105`) and the equivalent side-panel authorize control
(`src/sidepanel.js:1032`). Both send
`actions-json:authorize-tab` to the background worker
(`src/background.js:6563`), which is the sole entry to `claimAuthorizedTab`
(`src/background.js:1798`). There is no auto-claim on install, on navigation, or
on bridge connect: grep for `authorize-tab` and you will find those four sites
and nothing else.

Authorization is **per tab**, not per origin and not global. Authorizing
`docs.google.com` in one tab does not authorize a second Google Docs tab.
Authorized tabs are visibly grouped into a blue Chrome tab group titled by the
session (`background.js:1763-1786`, `color: "blue"` at line 1784), so which tabs are under agent control is
legible at a glance in the tab strip.

**Honest caveat — one script does load on every page.** The manifest declares a
content script matching `http://*/*` and `https://*/*` at `document_start`
(`manifest.json:14-24`): `src/delegated-agent/page-broker.js`. It loads on every
page you visit, before you authorize anything. If your review's bar is "no code
from this extension runs on unauthorized origins," this does not meet it.

Because that is the one unavoidable always-on surface, here is exactly what it
does — the file is 259 lines and worth reading in full:

- **It reads one selector, not the page.** Until activated it only queries
  `link[rel~="actions-json-agent"]` (line 8) and reports that link's `href`
  (`scanDiscovery`, line 49). It does not read page text, forms, cookies, or
  storage, and there is no code path in the file that could.
- **It cannot activate itself.** The private `MessagePort` opens only on an
  `actions-json:delegated-agent-activate` message from the extension's own
  background worker (line 189, `activate` at line 172). A page cannot send that
  message; `chrome.runtime.onMessage` does not deliver page-originated messages.
- **Top frame only.** `start()` returns immediately when `win !== win.top`
  (line 219), so despite `all_frames: true` it does not run in iframes.
- **It is rate- and size-bounded even once active**: 32 KiB per envelope, 16
  outstanding calls, 30 calls/minute, a 30-second observer lifetime, and a
  strictly increasing sequence number that rejects replay (lines 9-15; enforced in `handlePortMessage`, line 114).

What authorization gates is *control*: CDP attach, input dispatch, and bridge
routing. What the always-on script gates is *nothing it can reach without the
background worker first choosing to activate it.*

---

## 4. Credential custody

**Where the OpenAI key lives.** In one place in the browser:
`chrome.storage.local` under the key `ACTIONS_JSON_OPENAI_API_KEY`
(`extensions/chrome-overlay-runtime/src/agent/credential-store.mjs:1`). That
module is the only reader and writer — `loadOpenAiApiKey` (line 21),
`saveOpenAiApiKey` (line 37), `clearOpenAiApiKey` (line 46). Anything that
reports credential state gets a redaction, not the key
(`redactedOpenAiKey`, line 3, returns `sk...abcd`).

If you also run the bridge, the key may instead come from
`.actions-json.local.json` or the environment on your own machine, and is pushed
to the extension over the local socket at bridge connect
(`send_credential_hydration_to_extension`, `mcp/actions-json-mcp/src/lib.rs:1358`;
the OpenAI branch reads the local credential at line 1362 and emits a
`credential_hydration` frame at line 1379). Every hydration outcome — including
"no credential found" — is recorded in bridge state
(`record_credential_hydration_status`, `lib.rs:1275`), so a silent credential
path does not exist.

**Which endpoints receive the key.** Exactly three, all `api.openai.com`, all
under your own OpenAI account:

| Endpoint | Purpose | Source |
| --- | --- | --- |
| `POST /v1/realtime/client_secrets` | Mint a short-lived ephemeral secret for the voice session | `agent/realtime-webrtc-transport.mjs:192-199` |
| `POST /v1/embeddings` | Embed corpus text for `corpus.search` / `corpus.build` | `agent/corpus-embedding.mjs:12,35` |
| `GET /v1/organization/...` | Optional usage reconciliation | `agent/usage-reconciler.mjs:11,16` |

Note the first row: the long-lived key is used **once**, to mint an ephemeral
client secret. The WebRTC SDP exchange that actually carries the session is
authenticated with the ephemeral secret, not your key
(`realtime-webrtc-transport.mjs:140` mints it; line 180 uses it for
`/v1/realtime/calls`). Your standing API key never rides the media path.

**What never leaves the machine.** There is no destination for it to leave to.
No `actions.json`-operated server exists in this codebase. The key is never
written to an `actions.json` map, never included in storage bundles synced
between agents, and never logged — hydration status logging carries the redacted
form only (`lib.rs:1370-1375`).

---

## 5. The local bridge, and why loopback is not the argument

The bridge binds `127.0.0.1:17345` by default
(`mcp/actions-json-mcp/src/lib.rs:55` for `serve`, `:68` for `mcp`).

**Loopback binding is not, by itself, a security boundary, and we do not treat
it as one.** Unlike `fetch`/XHR, a `new WebSocket("ws://127.0.0.1:17345/extension")`
issued from an ordinary web page is **not** blocked by the same-origin policy.
Any page you happen to have open can dial a loopback WebSocket. An earlier
version of this bridge answered such a dial with raw credentials. That was a
real vulnerability and it is fixed.

Two independent checks now run at **upgrade time, before any socket is
established and therefore before any credential frame can be sent**
(`extension_ws`, `lib.rs:10257`; the check itself at `lib.rs:10268`):

1. **Origin allow-list.** The browser-attested `Origin` header must equal
   `chrome-extension://<id>` for a configured extension id
   (`origin_allowed`, `lib.rs:1140-1144`). Chrome sets this header for
   extension-originated sockets and page JavaScript cannot forge it. Ids come
   from `extension_ids` in `.actions-json.local.json`, defaulting to the packed
   install id (`DEFAULT_EXTENSION_ID`, `lib.rs:1005`).
2. **Per-installation handshake secret.** 256 bits of randomness
   (`generate_handshake_secret`, `lib.rs:1174`), generated on first run,
   persisted into the existing local config
   (`persist_handshake_secret`, `lib.rs:1185`), and compared in constant time
   (`constant_time_eq`, `lib.rs:1209`). A web page has no way to read it.

Order matters and is deliberate: origin is checked first, so a hostile page is
refused on the header it cannot forge and never gets to probe the secret at all
(`authorize`, `lib.rs:1148-1170`). Failure is a plain HTTP 403 with a
discriminating reason string — `origin_rejected`, `handshake_secret_missing`, or
`handshake_secret_mismatch` (`lib.rs:1022-1024`) — logged identically
server-side.

**Both checks fail closed, and neither can be skipped.** There is no
"unauthenticated if unconfigured" branch. An empty or absent `Origin` is
`origin_rejected` (`lib.rs:1153-1158`). An empty or absent secret is
`handshake_secret_missing` (`lib.rs:1160-1165`). The secret is generated
unconditionally on first run — there is no configuration that leaves it unset,
so "the user didn't set a secret" does not degrade into "no secret is required."
Pairing is a one-time, user-mediated step: the bridge issues and persists the
secret, and the extension settings page accepts it through the masked **Bridge
handshake secret** field. The extension stores it in Chrome extension-local
storage as `bridgeHandshakeSecret`, never displays the saved value again, and
reuses it across browser, service-worker, bridge, and extension-update
restarts. An unpaired extension is *refused*, not silently admitted.

The same commit removed the HTTP surface's `Access-Control-Allow-Origin: *` and
its `access-control-allow-private-network: true` opt-in, which together had let
arbitrary public pages reach the loopback HTTP endpoints. CORS now names exactly
one origin, the extension's (`cors_headers`, `lib.rs:6593`).

All of the above is landed, not planned: commit `06981a9`, *"fix(bridge):
authenticate the extension WebSocket before sending credentials."*

**The legacy HTTP tool routes are gated too.** The bridge has two entry points.
`mcp` — the documented install path, `npx @actions-json/bridge mcp` — serves
only `/health`, `/runtimes`, and the authenticated `/extension` socket
(`app_from_state(state, false)`, `lib.rs:4718`). The older `serve` command
additionally exposes `/actions` and `/mcp/tools/*`, including
`POST /mcp/tools/call`, which can drive an authorized tab.

Those routes require the same per-installation secret, presented as
`Authorization: Bearer <secret>` or `?secret=<secret>`, refused with
`bridge_secret_missing` or `bridge_secret_mismatch`. The gate is attached to the
sub-router carrying exactly those routes rather than to the app-wide middleware,
so a route added to that group inherits the gate instead of quietly escaping it.

Two deliberate exemptions: `OPTIONS` preflight is not gated, because browsers
send it *without* `Authorization` by design and gating it would break the very
credentialed caller the gate exists to admit; and `/health` and `/runtimes` stay
open as a liveness surface that drives nothing.

`/runtimes` is worth naming precisely, because "drives nothing" is not "reveals
nothing": it discloses the URL and page title of every connected tab to any
local process. That is a browsing-history oracle for the tabs you have
authorized. It is open on purpose — a liveness probe that needs a credential is
a liveness probe people route around — but if that trade is wrong for your
threat model, do not run the bridge.

Landed in commit `70acdb0`.

**The secret is stored owner-only.** `.actions-json.local.json` is written
`0600` on every write, not only on create, so an existing world-readable file is
narrowed rather than left as it was (`restrict_local_config_permissions`,
`lib.rs:1296`). This matters more than it first appears: the secret's purpose is
to stop a *local* process, and a world-readable secret does not need to be
guessed — it can simply be read. The same file has always held the OpenAI and
Protoface keys, so this hardens all three.

---

## 6. Binary verification

`npx @actions-json/bridge` downloads a prebuilt bridge binary from the GitHub
release rather than compiling Rust on your machine. That download is verified
before it is trusted.

The installer (`adapters/npm-bridge/lib/install.js`) fetches the release's
published `SHA256SUMS.txt`, computes the SHA-256 of the downloaded archive, and
compares it against the entry for that exact asset filename. The guarantee is
**fail closed** in all three failure modes:

- checksum mismatch → abort;
- `SHA256SUMS.txt` missing or unfetchable → abort;
- no entry in `SHA256SUMS.txt` matching the downloaded asset name → abort.

In none of those cases is the archive extracted or executed. There is no
"verify if available" fallback and no environment variable that skips the check.

Each failure throws a distinct, named error (`CHECKSUM_MISMATCH` and siblings)
rather than warning and continuing, and every failure path deletes the temp
archive so a rejected download is not left on disk. There is no environment
variable that disables verification — grep `install.js` for `process.env` and
you will find no bypass.

Verify it yourself rather than taking this paragraph's word for it: read
`adapters/npm-bridge/lib/install.js`, confirm the `tar -xzf` call sits *below*
the digest comparison in `download()`, and note the regression test at
`adapters/npm-bridge/test/install-checksum.test.js`. The published
`SHA256SUMS.txt` is an asset on each release, so you can also check a downloaded
archive by hand with `sha256sum` before installing.

If you would rather not trust a prebuilt binary at all, the bridge builds from
source with `cargo build --release` in `mcp/actions-json-mcp` — see *Building
From Source* in the README.

---

## 7. Reporting a vulnerability

Use **GitHub private security advisories** on the public repository:

> https://github.com/yaniv256/actions.json/security/advisories/new

That is the reporting channel. This project has no security@ mailbox, and we are
not going to print an address that does not receive mail. If the advisory form
is unavailable to you, open a public issue containing only *"security report,
requesting a private channel"* and no details, and a private thread will be
opened.

Please include the commit or release you tested, the reproduction, and the
impact you believe it has. There is no bug bounty. Reports that change the code
get credited in the release notes unless you ask otherwise.

---

## 8. Known residual risks

These are unfixed. They are listed because a reviewer will find them anyway, and
finding them undisclosed is worse than reading them here.

- **Prompt injection.** The agent reads live page content and acts on a browser
  session carrying your logged-in cookies. Hostile text on a page can attempt to
  redirect the agent's behavior. There is no injection filter. The mitigations
  are structural, not cryptographic: per-tab authorization limits blast radius
  to tabs you handed over, authorized tabs are visibly grouped, and the session
  stops when you stop it. Do not authorize a tab holding an account whose
  compromise you could not tolerate, on a site you do not trust.
- **Local credential storage.** `chrome.storage.local` and
  `.actions-json.local.json` hold your OpenAI key. The config file is written
  `0600`, so another *account* on a shared machine cannot read it — but any
  process running **as you** can. This is the standard posture for developer
  tooling that holds an API key, and it is not defended against here.
- **`/runtimes` discloses open tab URLs and titles** to any local process,
  without a credential. See §5.
- **Unpacked extension installation.** The documented install path is Chrome
  "Load unpacked" from a release ZIP, which means the extension is not
  Web-Store-reviewed and gets a machine-derived extension id rather than the
  packed one — which is why `extension_ids` in `.actions-json.local.json`
  overrides the default (`ExtensionAuthConfig::load`, `lib.rs:1005` and `lib.rs:1076-1089`). Verify the ZIP against the release
  checksums before loading it.
- **Content script on all pages.** See the caveat at the end of §3.

---

## Scope

This document covers the Chrome extension
(`extensions/chrome-overlay-runtime`), the bridge/MCP server
(`mcp/actions-json-mcp`), and the npm installer (`adapters/npm-bridge`).
`actions.json` *maps* are data, not code: they are declarative descriptions of a
site's actions, executed by the runtime's fixed set of primitives. A map cannot
introduce new executable behavior — `grep -rE '\beval\(|new Function\('` over
`extensions/chrome-overlay-runtime/src` and `runtime/actions-json-runtime/src`
returns nothing.

To be precise about what a reviewer will find next: the runtime *does* expose
JavaScript-execution primitives (`browser.run_javascript`,
`debug.run_javascript`), and CDP `Runtime.evaluate` appears in
`background.js`. Those are agent-invoked tools that run script in an authorized
tab — that is their declared purpose, and they are subject to the same per-tab
authorization as everything else in §3. The narrow claim above is only that
loading a map does not itself execute anything.
