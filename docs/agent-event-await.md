# Awaiting agent events (`runtime.agent.await_event`)

The supervising MCP client learns each hosted-agent output event event-driven, instead of
polling `runtime.session.log`. The extension forwards agent-output events to the bridge
over its WebSocket; the bridge queues them per runtime with a monotonic cursor; a blocking
`await_event` tool returns them.

## The await-loop

```
cursor = null            # first call: watch only future events
loop:
    r = runtime.agent.await_event(target_url_contains=..., cursor=cursor, timeout_ms=25000)
    if r.value.idle:
        # the agent has been silent for timeout_ms — this IS the stall signal.
        # act on it (screenshot, nudge, report) then loop again with the same cursor.
    else:
        for event in r.value.events:
            handle(event)        # report to the user / correct the agent / etc.
        cursor = r.value.cursor  # advance so the next call returns only newer events
```

- **`cursor`** — the last event `seq` you have seen. The call returns events with
  `seq > cursor`. Omit it on the first call to watch only future events; pass `-1` to
  replay the retained queue from the start.
- **`timeout_ms`** — how long to block before returning idle (default 25000, clamped
  [1000, 60000]).
- **Returned `idle: true`** after silence is the stall signal — the case where the agent
  went quiet with work unfinished. Screenshot / nudge / report on it.

## Event shape

Each event: `{ seq, ts, kind, payload }`.

| kind | payload | meaning |
|---|---|---|
| `transcript` | `{ role: "assistant", text }` | an agent response |
| `tool` | `{ name, ok, error }` | a completed tool call |
| `refusal` | `{ tool, reason }` | a policy-exception refusal |
| `lifecycle` | `{ state }` | session started/stopped/idle/error |
| `events_dropped` | `{ count }` | queue overflow marker (you fell > cap behind) |

Realtime deltas, audio-transcript chunks, user-role transcripts (your own injected
prompts), and heartbeats are NOT forwarded — the stream is agent output only.

## Notes

- The queue is in-memory and per runtime; a bridge restart resets cursors.
- `await_event` never consumes events (read-only cursor); multiple reads with the same
  cursor return the same backlog.
- Routing: pass `target_runtime_id` or `target_url_contains` to pick the runtime, else the
  active tab is used. An unresolvable runtime returns an error immediately (it does not
  block waiting for one to appear).
