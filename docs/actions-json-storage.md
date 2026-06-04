# actions.json.storage

`actions.json.storage` is a user-owned file workspace for website operating
memory.

An `actions.json` file describes how an agent can operate a website. Storage
keeps the durable evidence and artifacts that agents create while learning or
using those actions:

- observations from web pages;
- run logs and lessons;
- deduplicated item indexes;
- generated overlays and reports;
- site-specific `actions.json` maps.

Storage should be readable, auditable, versioned, and easy to diff. The
reference design uses plain files in Git repositories rather than an opaque
database.

## What Storage Is For

Use storage when an agent learns something that should survive the current
browser session.

Examples:

- A carousel scan discovers titles, URLs, and cover images. Store the raw
  observation and update an item index so removed items are not forgotten.
- A site action fails because the selector drifted. Store a run log with the
  failed selector, page state, and corrected target.
- An overlay is generated from stored data. Store the source data and the
  generated report so it can be reviewed or rebuilt.
- A debugger probe reveals a reliable page operation. Convert the lesson into a
  reviewed `actions.json` action map update.

## Recommended Workspace

The recommended local checkout is:

```text
actions.json.storage/
  README.md
  .gitmodules
  storage.json
  scopes/
    private/
    shared/
    public/
```

The root checkout is a workspace and mount table. The data for each visibility
scope should live in a separate repository mounted under `scopes/`.

Why separate repositories:

- GitHub permissions are repository-scoped, not folder-scoped.
- Private observations should not share access rules with public examples.
- Shared artifacts often need one repository per audience.
- Git history stays auditable for each scope.

The root repository can stay private even when it mounts a public scope.

## Scope Repositories

Each scope repository should use the same internal layout:

```text
scopes/private/
  scope.json
  agents/
    codex.json
    chrome-extension.json
  sites/
    example.com/
      search/
        actions.json
        observations/
          search-results.jsonl
        items/
          search-results.items.json
        runs/
          2026-06-04T162500Z.json
        overlays/
          categories.overlay.json
        reports/
          categories.html
```

Use the same shape under `scopes/shared/<audience>/` and `scopes/public/` so
artifacts can be promoted without changing their internal structure.

## Root Manifest

`storage.json` identifies the workspace and mounted scope repositories.

```json
{
  "protocol": "actions.json.storage",
  "version": "0.1.0",
  "owner": {
    "type": "person",
    "id": "local-user"
  },
  "default_mount": "private",
  "mounts": {
    "private": {
      "path": "scopes/private",
      "repo": "git@github.com:<owner>/actions.json.storage.private.git",
      "mount_type": "git_submodule",
      "visibility": "private"
    },
    "public": {
      "path": "scopes/public",
      "repo": "https://github.com/<owner>/actions.json.storage.public.git",
      "mount_type": "git_submodule",
      "visibility": "public"
    }
  }
}
```

The mount table should contain only the information needed to locate and
validate mounted scopes. Raw browsing data should live inside the scope
repositories, not in the root workspace.

## Scope Manifest

Each mounted scope can include a `scope.json` file:

```json
{
  "protocol": "actions.json.storage.scope",
  "version": "0.1.0",
  "scope": "private",
  "parent": "actions.json.storage",
  "write_policy": {
    "observations": "append",
    "items": "merge",
    "runs": "write",
    "actions": "review"
  }
}
```

The scope manifest tells agents where they are writing and which artifact types
require review.

## Agent Identity

Every writer should have an identity file under `agents/`.

```json
{
  "id": "chrome-extension",
  "display_name": "Chrome Extension Runtime",
  "actor_type": "browser_extension",
  "allowed_writes": [
    "sites/*/*/observations/*.jsonl",
    "sites/*/*/runs/*.json"
  ],
  "requires_review_for": [
    "sites/*/*/actions.json"
  ]
}
```

The first goal is an audit trail, not cryptographic identity. Every observation
and run should say which agent produced it, what page it observed, and what
action or schema it used.

## Data Classes

### Observations

Observations are raw facts captured from a page at a time. They are usually
append-only JSONL.

```json
{
  "type": "observation",
  "schema": "actions.storage.observation.v1",
  "observed_at": "2026-06-04T16:25:00Z",
  "site": "example.com",
  "surface": "search.results",
  "agent_id": "codex",
  "source_url": "https://example.com/search?q=maps",
  "items": [
    {
      "title": "Example result",
      "url": "https://example.com/results/1",
      "source": "visible_results"
    }
  ]
}
```

Observations answer: what did the agent see?

### Items

Item indexes deduplicate observations into stable memory.

```json
{
  "type": "item_index",
  "surface": "search.results",
  "items": {
    "result:https://example.com/results/1": {
      "title": "Example result",
      "url": "https://example.com/results/1",
      "first_seen_at": "2026-06-04T16:25:00Z",
      "last_seen_at": "2026-06-04T16:25:00Z",
      "seen_count": 1
    }
  }
}
```

Items answer: what does this user remember having seen before?

### Runs

Runs record what an agent did and what happened.

```json
{
  "type": "run",
  "schema": "actions.storage.run.v1",
  "run_id": "2026-06-04T162500Z-codex-example-search",
  "agent_id": "codex",
  "site": "example.com",
  "surface": "search.results",
  "actions_taken": [
    {
      "action": "search.submit",
      "arguments": { "query": "maps" },
      "result": "results_visible"
    }
  ],
  "lessons": [
    {
      "type": "selector",
      "text": "Result links are exposed as article a[href]."
    }
  ]
}
```

Runs answer: what did the agent do, and what did it learn?

### Action Maps

Per-site `actions.json` files store reusable operations for future agents.
Because they can change future automation behavior, they require more review
than append-only observations.

```text
sites/example.com/search/actions.json
```

Action maps answer: how should an agent operate this page next time?

### Reports And Overlays

Reports and overlays are generated views derived from stored data.

```text
sites/example.com/search/reports/categories.html
sites/example.com/search/overlays/categories.overlay.json
```

Generated views are useful for humans, but the canonical source should remain
the structured observations, items, runs, and action maps that produced them.

## Write Policy

Default policy:

| Data | Default write mode | Reason |
| --- | --- | --- |
| `observations/*.jsonl` | Direct append | Captures what was seen; easy to audit. |
| `runs/*.json` | Direct write | Captures one execution trace. |
| `items/*.json` | Deterministic merge | Derived memory from observations. |
| `reports/*` | Generated artifact | Human-facing view. |
| `overlays/*` | Generated or reviewed artifact | May be shown to the user. |
| `actions.json` | Branch or review | Changes future automation behavior. |
| `schemas/*.json` | Branch or review | Changes validation and compatibility. |

## Sync Workflow

Recommended loop:

1. Pull the root storage checkout and mounted scope repositories.
2. Load the site folder relevant to the current browser page when using the
   browser runtime UI.
3. Let the runtime read existing actions before using debugger tools.
4. Write observations, runs, and derived item indexes into the selected scope.
5. Propose `actions.json` changes through review when learned procedures should
   guide future agents.
6. Commit scope repository changes.
7. If using submodules, update and commit the root pointer for any mounted scope
   that advanced.

Submodules pin commits. A complete sync includes both the scope commit and the
root pointer update.

Implementation pending: the bridge-side `storage.sync` tool currently imports
the configured storage root as one bundle. Page-relevant bridge sync should
replace that broader import path.

## Security Rules

Never store:

- passwords;
- cookies;
- access tokens;
- session storage;
- payment data;
- secrets or private keys.

Prefer:

- URLs visible to the user;
- titles and public metadata;
- page observations the user asked to retain;
- selector and runtime lessons;
- generated reports from already-stored data.

Keep private browsing observations private by default. Promotion to shared or
public scopes must be explicit. See [Storage Visibility Scopes](storage-visibility-scopes.md).
