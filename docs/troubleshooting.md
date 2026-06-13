---
title: Troubleshooting
nav_order: 8
---

# Troubleshooting

Use this guide when the extension, hosted agent, bridge, storage, or bookmarklet
does not behave as expected.

Start with the shortest useful diagnostic:

1. Confirm the tab is authorized in the Chrome extension.
2. Confirm the extension popup can open the agent overlay.
3. If you are using the hosted agent, confirm the popup settings say the OpenAI
   key is saved and the popup Session card can start a voice session.
4. If you are using an external coding agent, confirm the bridge can list the
   connected runtime.
5. If storage-backed tools are missing, upload or sync the storage checkout and
   ask the agent what actions are available for the current site. In the log,
   that should appear as an `actions.site` list request.
6. If a session behaved strangely, inspect `runtime.session.log`.

## The Agent Says A Key Is Missing

Cause: the session started before the key was saved, or different surfaces are
reading different saved state.

Fix:

1. Click the extension icon to open the popup.
2. The **OpenAI API key** settings section is open by default.
3. Paste the OpenAI API key.
4. Save it.
5. Confirm the status says the key is saved.
6. Start a new session from the **Session** card.

If it still fails, check `runtime.session.log` for key-state events.

## Microphone Permission Is Prompt, Dismissed, Or Blocked

Cause: Chrome controls microphone permission for extension pages. The page
cannot grant it for you.

Fix:

1. Press the voice control again.
2. Choose **Allow** if Chrome shows a prompt.
3. If no prompt appears, open Chrome site settings for the extension page and
   allow microphone access.
4. Stop the voice session from the popup if a hidden offscreen session remains
   active.

The extension popup includes direct voice controls so Stop can end the offscreen
session even when no page overlay is visible.

## Tools Are Unavailable

Cause: the hosted agent could not load a tool catalog, or an external coding
agent is not connected to a runtime.

Fix:

- For the hosted agent, check the popup settings. The hosted agent should load
  tools from the extension runtime and uploaded storage even when no local
  bridge is connected.
- For an external agent, start the bridge, authorize a tab, and verify the
  bridge lists that runtime.
- Upload or sync `actions.json.storage` again if only site-specific actions are
  missing.

Verify by asking the agent what site actions are available. If you inspect the
log, the underlying agent-facing request should be `actions.site` with
`mode: "list"`.

## Storage Uploaded But Site Actions Are Missing

Cause: the uploaded bundle does not contain a matching site folder, or the
runtime did not reload storage after upload.

Fix:

1. Upload the whole `actions.json.storage` checkout from the popup's
   **Storage folder** settings section, not a single site folder.
2. Confirm the checkout contains the relevant scope repository and site folder.
3. Open the target website.
4. Reopen the agent overlay, or upload again from the popup.
5. Ask the agent what site actions are available. In logs, confirm it uses
   `actions.site` with `mode: "list"`.

If the page is on a related domain, make sure the site map explicitly includes
that domain or cross-domain relationship.

## Site Actions Fail With `Bridge returned 404`

Symptom: `actions.site` calls fail with `bridge_tool_call_failed: Bridge
returned 404.`, and the routing log shows `route: "bridge"` instead of
`extension_local`.

A bridge 404 here is almost never the root cause — it means the
extension-local execution failed or threw and the routing fell back to the
bridge's HTTP tool endpoint, which the running bridge build may not serve. Read
the routing log entry *before* the 404: a `local_execution_exception` entry
names the real local failure (and from 0.1.115 the final error carries
`local_exception` so the fallback can never mask it).

Do not start from a storage theory: when the bridge runs with
`--storage-root`, it automatically hydrates the extension's storage bundle on
every runtime reconnect, so an empty store self-heals within seconds — confirm
via the `storage_hydration` field of the `actions-json://bridge/runtimes`
resource. Manual re-sync (`storage.sync` or the popup's **Storage folder**
upload) is only needed when no bridge storage root is configured.

## Bridge Status Looks Like A Failure But Local Storage Works

The local bridge is optional for the hosted extension agent. If the bridge is
not connected, the extension should load tools from local extension state and
uploaded storage. That is not a product failure.

Treat it as a failure only when both are true:

- the bridge is unavailable; and
- local extension tools or uploaded storage tools are also unavailable.

## Bookmarklet Cannot Connect

Cause: many HTTPS websites block local HTTP or insecure WebSocket connections
from page JavaScript. This is a browser security rule, not an `actions.json`
bug.

Common console messages include:

- mixed content warnings for `http://.../mcp/tools/list`;
- insecure WebSocket warnings for `ws://.../extension`;
- Content Security Policy failures.

Fix:

- Prefer the Chrome extension on those sites.
- Use an HTTPS/WSS bridge endpoint if you are intentionally testing a remote
  bookmarklet connection.
- Use the extension relay only when you are testing bookmarklet UI behavior and
  accept that the transport is no longer pure page JavaScript.

## Screenshot Fails Or Hangs

Cause: the host may not support screenshots, the tab may not be active, or a
tool call may not have returned a structured result.

Fix:

1. Switch to the target tab.
2. Confirm it is authorized.
3. Retry `browser.screenshot`.
4. If the hosted agent hangs, stop the voice session from the popup.
5. Inspect `runtime.session.log` for the screenshot request, timeout, and error.

Screenshots should travel through the same runtime tool path as other browser
operations. Avoid adding direct one-off screenshot hooks that bypass logging.

## Navigation Closes The Overlay

The extension should recreate the agent overlay after navigation because
state is stored in extension storage and the voice session is owned by an
offscreen document.

If navigation still interrupts the user experience:

1. Reopen the extension popup.
2. Use the popup **Session** card to check whether the offscreen session is
   still live.
3. Reopen the agent overlay.
4. Inspect `runtime.session.log` for navigation, overlay reinjection, and
   session-continuity events.

## A Tool Call Fails With A Missing Parameter

Cause: the Realtime function-call schema and runtime action schema did not agree,
or the agent called a site action without the required wrapper.

Fix for an agent or tool author:

- For current-site actions, use `actions.site` with `mode`, `action`, and
  `arguments`.
- For direct primitives, call the primitive tool exactly as advertised in the
  runtime catalog.
- Inspect `runtime.session.log`; it should include tool name, arguments, result,
  and error.

## A Tool Call Fails With `policy_exception_report_required`

Symptom: a direct generic primitive call from the hosted agent is rejected.

Meaning: direct fallback calls outside `actions.site` must carry a valid
`policy_exception_report` object with `kind`, `intended_tool`,
`actions_json_path`, and `reason`.

Fix: use a stored `actions.site` action when one exists; otherwise include the
report in the call arguments. Internal primitive steps inside a stored compound
action do not need reports.

## A Workflow Fails With `invalid_workflow`

Symptom: `invalid_workflow` with a message like "has unrecognized field <x>" or
"uses unknown primitive <x>".

Meaning: workflow validation is strict. Unknown workflow or step fields are
rejected, and step primitives must exist in the runtime primitive dictionary.

Fix: use only the recognized step fields (`id`, `primitive`, `args`, `when`,
`for_each` with `max_items`, `retry_until` with `max_attempts` and
`after_each`, `settle_after`, `on_error`) and real primitive names.

## A State Read Fails With `state_payload_too_large` Or `expression_output_too_large`

Symptom: `actions.site` state reads or workflow expressions fail with one of
these codes.

Meaning: the projection or expression output exceeded the configured payload
budget.

Fix: narrow the projection selectors, or use `state_summary` instead of
`state_read`.

## A Bridge Result Says `payload_spilled: true`

Symptom: instead of inline output, the envelope contains `payload_spilled:
true` with `payload_path`, `payload_bytes`, `payload_hash`, and a `preview`.

Meaning: this is not an error. The result was larger than the bridge's
`inline_limit_bytes`, so it was written to a file to protect agent context.

Fix: read or grep the file at `payload_path`. Adjust the threshold with the
`bridge.payloads.configure` tool if needed.

## `task.next` Returns `done: true`

Symptom: `task.next` returns `done: true` with a summary instead of a task.

Meaning: the queue is empty, not broken. The summary grounds the agent on what
was completed or failed.

Fix: nothing to fix. Add tasks with `task.add` if more work remains.

## A Task Tool Fails With `task_queue_unavailable`

Symptom: task primitives fail with `task_queue_unavailable`.

Meaning: the task-queue module could not load on this page. Strict page
Content Security Policy can block script loading for the page-injected
runtime; extension content scripts are unaffected.

Fix: use the extension runtime on that site, or run the task queue from a page
whose CSP allows it.

## Clicks Report Success But Nothing Happens

Symptom: click results come back successful, but the page does not change.

Meaning: the `actions.json` overlay itself can cover the page target, so the
click lands on the overlay instead of the page.

Fix: hide the overlay first (`overlay.menu.hide`), perform the page
operations, then restore it (`overlay.menu.show`).

## `browser.run_javascript` Is Missing

Some sites block page JavaScript evaluation or make it unsafe as a portable
action. On those sites, the site map should remove `browser.run_javascript` from
the agent-facing action set.

The extension may still expose `debug.run_javascript` for authoring because it
uses Chrome Debugger Protocol. Use it to learn the page, then encode the result
as portable actions.

## Pull A Session Log

Use `runtime.session.log` when you need evidence. A useful log includes:

- user and agent transcript turns;
- tool catalog loading;
- tool call arguments;
- tool call results;
- navigation events;
- screenshot events;
- storage upload/import events;
- warnings and structured errors.

Call `runtime.session.log` through MCP `tools/call` (pass `limit`, and a
runtime selector such as `target_runtime_id` when more than one runtime is
connected). The bridge wraps primitive output under `output.value`: read
`output.value.eventCount` and `output.value.events`. Do not infer failure
from an `error` key unless it is non-null or top-level `ok` is false.

If you are preparing a bug report, include the smallest log excerpt that shows
the request, tool call, result or timeout, and visible symptom.
