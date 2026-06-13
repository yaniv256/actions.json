# @actions-json/bridge

Run the [actions.json](https://yaniv256.github.io/actions.json/) MCP bridge with
`npx` — no Rust toolchain, no setup. On first run it downloads the prebuilt
`actions-json-mcp` binary for your platform, bundles the primitive dictionary
(so you don't pass `--actions`), and scaffolds a storage workspace at
`~/.actions-json/storage` (so you don't pass `--storage-root`).

## Usage

```bash
npx @actions-json/bridge mcp
```

Register it with a coding agent — Claude Code:

```bash
claude mcp add actions-json -- npx -y @actions-json/bridge mcp
```

Codex:

```bash
codex mcp add actions-json -- npx -y @actions-json/bridge mcp
```

Overrides (the defaults are skipped when you pass your own):

- `--storage-root <dir>` — use a different storage workspace. Or set
  `ACTIONS_JSON_STORAGE`.
- `--actions <file>` — use a custom primitive dictionary instead of the bundled
  one.

All arguments after the binary pass straight through to `actions-json-mcp`. See
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
