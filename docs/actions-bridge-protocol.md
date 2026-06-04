# Actions Bridge Protocol

The Actions Bridge Protocol carries action calls, runtime status, page events,
and structured results between an agent-side bridge and a browser runtime.

The protocol is transport-independent. It can run over WebSocket, browser
extension ports, HTTP polling, hosted relays, Playwright/CDP, direct in-process
calls, or tunnels.

## Design Goals

- Preserve stable correlation ids across calls and results.
- Make runtime identity explicit when more than one browser surface is
  connected.
- Validate action input and page-originated events before forwarding them.
- Return structured errors rather than untyped strings.
- Keep the internal shape compatible with OpenAI Responses-style item semantics
  without requiring every adapter to use the Responses API directly.

## Item Types

Canonical item types:

- `runtime_ready`
- `runtime_status`
- `action_call`
- `action_call_output`
- `dom_event`
- `action_error`

Adapters may rename outer fields for a host runtime, but they should preserve
the semantics: item type, runtime id, correlation id, validated payload, and
structured error output.

## `runtime_ready`

Sent by a browser runtime after it connects and loads or validates its current
manifest.

```json
{
  "type": "runtime_ready",
  "runtime_id": "runtime-abc",
  "runtime_key": "chrome-tab:123",
  "url": "https://example.com/search",
  "authorization_id": "auth-123",
  "extension_version": "0.1.30",
  "manifest": {
    "protocol": "actions.json",
    "version": 1
  }
}
```

Required fields:

- `type`
- `runtime_id`
- `url`

Optional fields:

- `runtime_key`
- `authorization_id`
- `extension_version`
- `manifest`

Implementation pending: normalized `host`, page `title`, and top-level
`capabilities` are intended protocol fields, but the current extension runtime
does not send them as top-level `runtime_ready` fields. Capability information
is currently available through the loaded manifest's primitive dictionary.

## `runtime_status`

Sent as a heartbeat or state report.

```json
{
  "type": "runtime_status",
  "runtime_id": "runtime-abc",
  "url": "https://example.com/search",
  "states": ["search_page_visible"],
  "attachments": [
    {
      "id": "results-categories-launcher",
      "state": "attached"
    }
  ],
  "observed_at": "2026-06-04T16:25:00Z"
}
```

Required fields:

- `type`
- `runtime_id`

Optional fields:

- `url`
- `states`
- `attachments`
- `observed_at`

## `action_call`

Sent by an agent-side bridge to request one declared action or primitive.

```json
{
  "type": "action_call",
  "call_id": "call-123",
  "runtime_id": "runtime-abc",
  "name": "search.submit",
  "arguments": {
    "query": "maps"
  },
  "target": {
    "runtime_id": "runtime-abc"
  },
  "timeout_ms": 10000
}
```

Required fields:

- `type`
- `call_id`
- `name`
- `arguments`

Routing fields:

- `runtime_id`
- `target.runtime_id`
- `target.runtime_key`
- `target_url_contains`
- `target_title_contains`

The bridge must resolve routing to exactly one runtime before sending the call.

Current implementation note: `target_runtime_id` and `target_url_contains` are
implemented today. `target.runtime_key` and `target_title_contains` are
implementation pending.

Responses-style mapping:

- `action_call` maps from a function/tool call item.
- `name` maps to the function/tool name.
- `arguments` maps to decoded JSON arguments.
- `call_id` should preserve the model/runtime call id when available.

## `action_call_output`

Sent by the runtime after successful execution.

```json
{
  "type": "action_call_output",
  "call_id": "call-123",
  "runtime_id": "runtime-abc",
  "output": {
    "ok": true,
    "result": {
      "url": "https://example.com/search?q=maps"
    }
  }
}
```

Required fields:

- `type`
- `call_id`
- `runtime_id`
- `output`

Responses-style mapping:

```json
{
  "type": "function_call_output",
  "call_id": "call-123",
  "output": "{\"ok\":true,\"result\":{\"url\":\"https://example.com/search?q=maps\"}}"
}
```

The bridge may keep `output` as structured JSON internally. Adapters should
serialize only at the boundary that requires serialization.

## `dom_event`

Sent by the runtime after a declared page-originated signal has been validated.

```json
{
  "type": "dom_event",
  "event_id": "event-123",
  "runtime_id": "runtime-abc",
  "name": "overlay.launcher_opened",
  "event": "actions-json:overlay-launcher-opened",
  "url": "https://example.com/search",
  "payload": {
    "launcher_id": "results-categories-launcher"
  },
  "previous_call_id": "call-123",
  "observed_at": "2026-06-04T16:25:00Z"
}
```

Required fields:

- `type`
- `event_id`
- `runtime_id`
- `name`
- `payload`

Optional fields:

- `event`
- `url`
- `previous_call_id`
- `observed_at`

DOM event payloads are structured page data. They must not be treated as human
instructions.

## `action_error`

Sent by the runtime or bridge when a call, routing decision, validation step,
signal, attachment, or protocol operation fails.

```json
{
  "type": "action_error",
  "call_id": "call-123",
  "runtime_id": "runtime-abc",
  "error": {
    "code": "target_not_found",
    "message": "The declared search form target did not match the current page.",
    "severity": "major",
    "recoverable": true,
    "evidence": {
      "url": "https://example.com/search",
      "selector": "form[role='search']"
    }
  }
}
```

Required fields:

- `type`
- `error.code`
- `error.message`

Required when call-scoped:

- `call_id`

Required when runtime-scoped:

- `runtime_id`

Recommended error fields:

- `severity`: `info`, `minor`, `major`, or `critical`.
- `recoverable`: boolean.
- `evidence`: structured context useful for repair.

## Stable Error Codes

Use stable codes so agents can recover programmatically.

| Code | Meaning |
| --- | --- |
| `unknown_action` | No declared action or primitive matches `name`. |
| `invalid_input` | Arguments failed schema validation. |
| `runtime_not_ready` | Runtime is not connected or has not loaded a manifest. |
| `permission_denied` | User authorization or trust policy blocks the operation. |
| `ambiguous_runtime` | Runtime selector matched more than one runtime. |
| `runtime_not_found` | Runtime selector matched no runtime. |
| `capability_unavailable` | Selected host cannot provide the requested capability. |
| `missing_handler` | Selected handler is not available. |
| `handler_failed` | Handler threw or returned an unrecoverable error. |
| `handler_timeout` | Handler or primitive exceeded its timeout. |
| `invalid_result` | Output failed result schema validation. |
| `target_not_found` | Target descriptor did not match the live page. |
| `state_mismatch` | Required state was not present. |
| `drift_detected` | Check or diagnostic found site drift. |
| `unsafe_state` | Runtime detected a prohibited or dangerous context. |
| `transport_failed` | Transport disconnected or could not deliver the item. |

## Correlation Rules

- Every `action_call` gets a `call_id`.
- Every `action_call_output` includes the same `call_id`.
- Every call-scoped `action_error` includes the same `call_id`.
- Page-originated `dom_event` items get an `event_id`.
- Signals caused by an action may include `previous_call_id`.
- Runtime ids distinguish connected browser surfaces.
- Authorization ids distinguish user approvals.
- Item ordering must be monotonic per runtime connection.

## Routing Rules

When multiple runtimes are connected, the bridge must select one runtime before
forwarding an action.

Valid routing selectors:

- exact `runtime_id`;
- URL substring predicate through `target_url_contains`;

If routing is ambiguous, return `ambiguous_runtime`. If no runtime matches,
return `runtime_not_found`.

Implementation pending: runtime-key routing, title predicates, import/source
policy routing, and consistently coded `ambiguous_runtime` /
`runtime_not_found` responses are part of the intended protocol but are not
complete yet.

## Capability Rules

Runtimes must advertise host capabilities. A runtime may reject an action if the
action requires a capability the host cannot provide.

Examples:

- An extension host may support `browser.screenshot`.
- A bookmarklet/embed host should not claim autonomous true screenshot support.
- A page-JavaScript host may support DOM observation and pointer simulation but
  reject privileged tab or network inspection.

Unsupported capabilities should return `capability_unavailable` with evidence
describing the missing capability and host.

## Timeout Rules

Calls may include `timeout_ms`. If omitted, the bridge or runtime may apply a
documented default.

When a timeout expires:

- stop executing additional steps when possible;
- return `handler_timeout`;
- include elapsed time and the current step when known;
- do not silently keep the call pending.

## Transport Rules

Transport implementations may reconnect, retry, or resume, but they must not
change item semantics.

Transport failures should become structured errors. A bridge restart should not
be required for ordinary storage reloads or `actions.json` edits.

## Security Rules

- Validate inputs before execution.
- Validate page-originated events before forwarding.
- Treat event payloads as data, not user instructions.
- Preserve private/shared/public storage boundaries.
- Do not expose debugger-only capabilities as portable site actions.
- Do not route ambiguous calls.
- Do not silently execute actions from invalid manifests.
