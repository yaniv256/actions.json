# actions-json-mcp

`actions-json-mcp` is the MCP bridge for `actions.json`.

It gives local coding agents a real Model Context Protocol server while also
hosting the browser WebSocket endpoint used by the Chrome extension runtime.
Agents should use MCP `tools/list`, `tools/call`, `resources/list`, and
`resources/read`. The browser extension connects to `/extension`.

## Run As MCP

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- mcp \
  --bind 127.0.0.1:17345 \
  --actions extensions/chrome-overlay-runtime/actions/overlay.actions.json \
  --storage-root /path/to/actions.json.storage
```

Use `0.0.0.0:17345` only for cross-machine operation, and only behind a host
firewall and a private network such as Tailscale. It binds every interface, and
`GET /runtimes` requires no credential — it reports the URL and title of every
authorized tab, so a non-loopback bind publishes your browsing to anything that
can route to the port. Never expose 17345 to the public internet. See
[Security](../../SECURITY.md).

When Chrome runs on another machine, configure the extension WebSocket with the
coding-agent host address, for example:

```text
ws://<tailscale-ip>:17345/extension
```

## MCP Surface

Tools:

- `actions.site`
- `storage.sync`
- `storage.read_file`
- `runtime.session.log`
- connected-tab tools
- browser/runtime primitives advertised by the active manifest

Resources:

- `actions-json://bridge/launch`
- `actions-json://bridge/runtimes`
- `actions-json://bridge/tools`
- `actions-json://storage/files`
- `actions-json://storage/file/<storage-path>`

Read `actions-json://bridge/launch` before operating. It records how the bridge
was launched, where the extension should connect, which manifest was loaded,
and where storage is rooted.

## Legacy Debug Mode

The `serve` command remains as a temporary debug/compatibility path for the old
HTTP-shaped tool API:

```bash
cargo run --manifest-path mcp/actions-json-mcp/Cargo.toml -- serve
```

Do not use `GET /mcp/tools/list` or `POST /mcp/tools/call` as the normal agent
interface. Use the MCP server mode instead.

## Companion Runtime

The matching Chrome extension lives at:

```text
extensions/chrome-overlay-runtime
```
