# @actions-json/bridge

Run the [actions.json](https://yaniv256.github.io/actions.json/) MCP bridge with
`npx` — no Rust toolchain required. On first run this downloads the prebuilt
`actions-json-mcp` binary for your platform from the GitHub release, caches it,
and runs it with the arguments you pass.

## Usage

```bash
npx @actions-json/bridge mcp \
  --bind 0.0.0.0:17345 \
  --actions /abs/path/to/overlay.actions.json \
  --storage-root /abs/path/to/actions.json.storage
```

Register it with a coding agent the same way — for Claude Code:

```bash
claude mcp add actions-json -- \
  npx -y @actions-json/bridge mcp \
  --bind 0.0.0.0:17345 \
  --actions /abs/path/to/overlay.actions.json \
  --storage-root /abs/path/to/actions.json.storage
```

For Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.actions-json]
command = "npx"
args = [
  "-y", "@actions-json/bridge", "mcp",
  "--bind", "0.0.0.0:17345",
  "--actions", "/abs/path/to/overlay.actions.json",
  "--storage-root", "/abs/path/to/actions.json.storage",
]
```

All arguments after the binary are passed straight through to `actions-json-mcp`.
See [Getting Started](https://yaniv256.github.io/actions.json/getting-started.html).

## Platforms

Prebuilt binaries are published for **linux-x64**, **macos-x64**,
**macos-arm64**, and **win-x64**. On any other platform/arch the wrapper prints
build-from-source instructions (clone the repo and
`cargo build --release --manifest-path mcp/actions-json-mcp/Cargo.toml`).

## How it works

The package ships no binary. On first invocation it downloads
`actions-json-mcp-<version>-<platform>.tar.gz` from the matching
`extension-v<version>` GitHub release, extracts the binary into a local cache
(`.bin/<version>-<slug>/`), and execs it. Subsequent runs reuse the cached
binary.
