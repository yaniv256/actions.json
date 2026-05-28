# Claude Code Plugin Adapter

This adapter will package the portable skill, MCP adapter, and runtime references for Claude Code.

Claude Code plugins can include skills, MCP configuration, binaries, settings, and arbitrary supporting files. The injected runtime remains a first-class package under `runtime/`; this adapter only wires it into Claude Code conventions.
