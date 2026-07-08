---
module: memory-layer
tags: [memory, knowledge-graph, codebase-memory-mcp, experiment]
problem_type: evaluation
date: 2026-07-08
---

# Experiment: indexing the agent memory repo into codebase-memory-mcp

**Question (task #75 / the "free experiment"):** can `codebase-memory-mcp` give my markdown memory
repo (`~/.claude/projects/-home-agent-zara/memory/`, 122 files, 676K, git repo, **325 `[[wikilinks]]`**)
a useful semantic knowledge-graph / better recall than the current MEMORY.md-index + grep?

## What I did
`index_repository(repo_path=<memory dir>, mode=full)` → indexed: **247 nodes, 246 edges**. Then
`search_code("checklist", …, mode=files)` and `get_architecture(aspects=["all"])`.

## Findings (decisive)
- **`search_code` works as fast graph-augmented grep:** "checklist" → 11 ranked memory files in **4ms**,
  2.7x dedup. Genuinely handy for "which memories mention X" across all 122.
- **BUT the graph is trivial for prose.** Node labels: File(122), Module(122), Section(2), Project(1).
  Edge types: ONLY `DEFINES`(124) + `CONTAINS_FILE`(122) — pure structural scaffolding, no semantic nodes.
- **The 325 `[[wikilinks]]` — the ACTUAL latent knowledge graph — were NOT captured as edges.** The
  indexer resolves *code* references (LSP call/import graph); it does not parse markdown wikilinks, so the
  richest signal in my memory is ignored.
- No semantic clustering of related learnings; `search_code` is grep, not embedding similarity, for prose.

## Verdict
codebase-memory-mcp on the memory repo = **fast file-search only** (marginal over MEMORY.md + `grep -r`).
It does **NOT** deliver the semantic/wikilink knowledge-graph the memory-layer goal wants. It's the wrong
tool for prose memory — it's built for code call-graphs. **Recommendation for #75:** don't adopt
codebase-memory-mcp as the memory layer. If we want a real memory knowledge-graph, the promising directions
are: (a) a purpose-built index that parses the `[[wikilinks]]` into edges + embeds each memory body for
semantic recall (this is essentially the `local-skills-embeddings-db` design already scoped —
[[local-skills-embeddings-db-project]]); or (b) Obsidian (native wikilink graph) / Mem0 (vector+graph). The
wikilink graph is the asset to exploit; a code indexer throws it away.

## Cleanup note
The index persists as project `home-agent-zara-.claude-projects-home-agent-zara-memory` in codebase-memory-mcp.
Harmless (local, small). Can `delete_project` it if we want a clean slate; leaving it gives free fast search.
