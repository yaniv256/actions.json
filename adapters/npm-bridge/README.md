# @actions-json/bridge

Run the [actions.json](https://yaniv256.github.io/actions.json/) MCP bridge with
`npx` — no Rust toolchain required. On first run this downloads the prebuilt
`actions-json-mcp` binary for your platform from the GitHub release, caches it,
and runs it. The primitive dictionary (browser-control tool catalog) is bundled,
so you don't pass `--actions`.

## Usage

```bash
npx @actions-json/bridge mcp --storage-root /path/to/.storage
```

Register it with a coding agent — for Claude Code:

```bash
claude mcp add actions-json -- \
  npx -y @actions-json/bridge mcp --storage-root /path/to/.storage
```

For Codex:

```bash
codex mcp add actions-json -- \
  npx -y @actions-json/bridge mcp --storage-root /path/to/.storage
```

All arguments after the binary pass straight through to `actions-json-mcp`. To
use a custom primitive dictionary, pass your own `--actions <file>` and the
bundled default is skipped. See
[Getting Started](https://yaniv256.github.io/actions.json/getting-started.html).

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
