# Actions Bridge Protocol

## Purpose

The Actions Bridge Protocol carries website action requests, page signals, runtime status, and structured results between an agent-side adapter and an injected browser runtime.

The protocol is transport-independent. It can run over direct calls, WebSocket, browser extension ports, Playwright/CDP, tunnels, hosted relays, or other transports.

## Primary Semantic Model

The protocol is modeled on OpenAI Responses-style item semantics.

The Responses API uses items rather than only chat messages. Official OpenAI documentation describes `message`, `function_call`, and `function_call_output` as item types, and function calls use a `call_id` that must be carried back with the tool output:

- Responses API reference: <https://platform.openai.com/docs/api-reference/responses>
- Function calling guide: <https://platform.openai.com/docs/guides/function-calling?api-mode=responses>
- Migration guide: <https://platform.openai.com/docs/guides/migrate-to-responses>

`actions.json` does not require callers to use the OpenAI Responses API directly. Responses-style semantics are the canonical internal shape. Adapters can map that shape to OpenAI Responses, OpenAI Realtime, Anthropic Messages, MCP tools, browser extension agents, or website-owned embedded agents.

## Runtime Boundary

The injected browser runtime is the interpreter of `actions.json`.

The MCP adapter or model adapter is not the interpreter. It translates between an agent runtime and the Actions Bridge Protocol.

The browser runtime is responsible for:

- validating the manifest;
- composing imports;
- tracking connected runtime identity and authorization;
- diagnosing page state;
- dispatching handlers or execution steps;
- installing and maintaining attachments;
- validating signals before forwarding them;
- returning structured outputs and errors.

## Core Item Types

### `runtime_ready`

Sent by a browser runtime after authorization and manifest load.

```json
{
  "type": "runtime_ready",
  "runtime_id": "actions-json-runtime-abc",
  "runtime_key": "chrome-tab:190776585",
  "authorization_id": "authorization-123",
  "url": "https://linear.app/actionsjson/issue/ACT-5/design-schema-for-actionjson-files",
  "manifest": {
    "protocol": "actions.json",
    "version": 1
  }
}
```

Fields:

- `runtime_id`: unique runtime connection id.
- `runtime_key`: stable browser-surface key when available, such as a tab id.
- `authorization_id`: user authorization session id.
- `url`: current runtime URL.
- `manifest`: validated or declared manifest.

### `runtime_status`

Sent by either side as a heartbeat or state report.

```json
{
  "type": "runtime_status",
  "runtime_id": "actions-json-runtime-abc",
  "url": "https://linear.app/actionsjson/issue/ACT-5/design-schema-for-actionjson-files",
  "states": ["issue_page_visible"],
  "attachments": [
    {
      "id": "linear-act5-execution-path",
      "state": "attached"
    }
  ],
  "observed_at": "2026-06-02T12:00:00Z"
}
```

### `action_call`

Sent by an agent adapter to request a declared `tools[]` entry.

```json
{
  "type": "action_call",
  "call_id": "call_123",
  "runtime_id": "actions-json-runtime-abc",
  "name": "contact.submit_name",
  "arguments": {
    "name": "Ada"
  },
  "target": {
    "runtime_id": "actions-json-runtime-abc"
  }
}
```

Fields:

- `call_id`: required correlation id for the call.
- `runtime_id`: selected browser runtime.
- `name`: declared tool name.
- `arguments`: JSON object validated against the tool's `input_schema`.
- `target`: optional routing metadata when several runtimes are connected.

Responses adapter mapping:

- `action_call` maps naturally from a Responses `function_call` item.
- `name` maps to the function/tool name.
- `arguments` maps from the JSON-decoded function arguments.
- `call_id` should preserve the Responses call id where available.

### `action_call_output`

Sent by the browser runtime after successful action execution.

```json
{
  "type": "action_call_output",
  "call_id": "call_123",
  "runtime_id": "actions-json-runtime-abc",
  "output": {
    "ok": true,
    "result": "Submitted Ada"
  }
}
```

Responses adapter mapping:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"ok\":true,\"result\":\"Submitted Ada\"}"
}
```

The bridge may keep `output` as structured JSON internally. A Responses adapter should serialize the output according to the target API's expected item shape.

### `dom_event`

Sent by the browser runtime after a declared `signals[]` entry has been validated.

```json
{
  "type": "dom_event",
  "event_id": "evt_123",
  "runtime_id": "actions-json-runtime-abc",
  "name": "overlay.launcher_opened",
  "event": "actions-json:overlay-launcher-opened",
  "url": "https://linear.app/actionsjson/issue/ACT-5/design-schema-for-actionjson-files",
  "payload": {
    "launcher_id": "linear-act5-execution-path"
  },
  "previous_call_id": "call_123",
  "observed_at": "2026-06-02T12:00:00Z"
}
```

Signal payloads are structured page data, not human instructions. An adapter may expose them as model input, an application event, or agent memory, but it should preserve their origin and schema validation status.

### `action_error`

Sent by the runtime or bridge when a call, signal, attachment, state diagnostic, or protocol operation fails.

```json
{
  "type": "action_error",
  "call_id": "call_123",
  "runtime_id": "actions-json-runtime-abc",
  "error": {
    "code": "target_not_found",
    "message": "Could not find #submit in the current page context.",
    "severity": "major",
    "recoverable": true,
    "evidence": {
      "url": "https://example.test/form",
      "selector": "#submit"
    }
  }
}
```

Stable error codes:

- `unknown_action`: no declared tool matches the requested name.
- `invalid_input`: arguments do not match `input_schema`.
- `runtime_not_ready`: runtime has not loaded or validated the manifest.
- `permission_denied`: user authorization or source trust policy blocks the operation.
- `missing_handler`: handler was selected but could not be resolved.
- `handler_failed`: handler threw or returned an unrecoverable error.
- `handler_timeout`: handler exceeded its timeout.
- `invalid_result`: output does not match `result_schema`.
- `target_not_found`: target descriptor did not match the live DOM.
- `state_mismatch`: required state was not present.
- `drift_detected`: a check or runtime diagnostic found site drift.
- `unsafe_state`: runtime detected a dangerous context or prohibited surface.

## Correlation Rules

- Every action call gets a `call_id`.
- Every successful action result includes the same `call_id`.
- Every call-scoped error includes the same `call_id`.
- Page-originated signals get an `event_id`.
- Signals caused by an action may include `previous_call_id`.
- Runtime ids distinguish connected browser surfaces.
- Authorization ids distinguish user approvals.
- Item ordering must be monotonic per runtime connection.

## Routing Rules

When multiple browser runtimes are connected, an adapter must select a target explicitly.

Acceptable selectors include:

- `runtime_id`;
- `runtime_key`;
- URL predicates such as `target_url_contains`, when they match exactly one runtime;
- source/namespace routing policy from imports.

If routing is ambiguous, the bridge must return an error without sending the action to any runtime.

## Handler and Step Execution

A runtime should execute according to the tool's `x_actions.execution.mode`:

- `handler_first`: call the handler, then use steps for trace, checks, or fallback.
- `steps_first`: execute declared steps directly.
- `documentary`: do not execute steps during normal calls.
- `test_only`: execute steps only inside `checks[]`.

If `handler_first` is selected but the handler is missing, the runtime may fall back to steps only when `fallback` explicitly allows that behavior.

## Attachment Events

Attachments should emit lifecycle events when the runtime can observe them:

- `attachment.attached`;
- `attachment.removed`;
- `attachment.reattached`;
- `attachment.drifted`;
- domain-specific activation signals such as `overlay.launcher_opened`.

Attachment events should include:

- attachment id;
- target selector used;
- URL;
- lifecycle state;
- evidence on drift.

## Adapter Targets

Expected adapters:

- OpenAI Responses;
- OpenAI Realtime;
- Anthropic Messages / Claude Code-style tool use;
- MCP tools;
- browser extension agents;
- website-owned embedded agents.

Adapters may rename outer protocol fields to match their host runtime, but they should preserve the item semantics: typed item, correlation id, validated payload, runtime identity, and structured error output.
