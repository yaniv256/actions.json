# Actions Bridge Protocol

## Purpose

The Actions Bridge Protocol carries website action requests and results between an agent-side adapter and an injected browser runtime.

The protocol is transport-independent. It can run over direct calls, WebSocket, browser extension ports, Playwright/CDP, tunnels, hosted relays, or other transports.

## Primary Semantic Model

The protocol is modeled primarily on OpenAI Responses-style item semantics.

That means the bridge should prefer:

- typed input/output items
- explicit action/tool request items
- structured action result items
- stable `call_id` or equivalent correlation identifiers
- explicit error and timeout items
- stateful multi-turn compatibility
- transport-neutral delivery

This project does not require callers to use the OpenAI Responses API directly. Responses-style semantics are the canonical internal shape. Adapters can map that shape to OpenAI Responses, OpenAI Realtime, Anthropic Messages, MCP tools, or other agent runtimes.

## Core Item Types

The first protocol draft should include item types equivalent to:

- `message`
- `action_call`
- `action_call_output`
- `dom_event`
- `action_error`
- `runtime_ready`
- `runtime_status`
- `injected_user_request`

Names may change as the schema hardens, but the shape should remain item-based rather than plain chat-message-only.

## Adapter Targets

Expected adapters:

- OpenAI Responses
- OpenAI Realtime
- Anthropic Messages / Claude Code-style tool use
- MCP tools
- browser extension agents
- website-owned embedded agents

## Runtime Boundary

The injected browser runtime is the interpreter of `actions.json`.

The MCP adapter or model adapter is not the interpreter. It translates between an agent runtime and the Actions Bridge Protocol.
