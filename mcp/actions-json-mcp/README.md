# actions-json-mcp

MCP-shaped bridge for `actions.json`.

This package currently exposes website actions through MCP-shaped HTTP
tool-list/tool-call endpoints and translates those calls into the Actions Bridge
Protocol spoken by the injected browser runtime. It is not yet a fully
conforming MCP server.

It is not the interpreter of `actions.json`. The browser runtime interprets the file and executes DOM operations.

## Experimental Overlay Bridge

It is intentionally **MCP-shaped**, not a production MCP server yet:

- `GET /mcp/tools/list` returns tools derived from an `actions.json` manifest.
- `POST /mcp/tools/call` accepts `{ "name": "...", "arguments": { ... } }`.
  When more than one browser tab is connected, the call must include either
  `target_runtime_id` or `target_url_contains`; otherwise the bridge returns an
  error without sending the action to any tab.
- `GET /runtimes` returns the connected extension runtimes and their URLs.
- `GET /extension` upgrades to a WebSocket used by the Chrome extension runtime.
- Messages sent to the extension use Responses-style item names such as
  `runtime_ready`, `action_call`, `action_call_output`, `action_error`, and
  `dom_event`. This is not yet a conforming OpenAI Responses API protocol.

Run the bridge:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve
```

List declared tools:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- list-tools
```

Open an HTML overlay in an authorized browser tab:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- open-overlay \
  --html path/to/report.html \
  --target-url-contains example.com
```

The matching Chrome extension lives at:

```text
extensions/chrome-overlay-runtime
```
