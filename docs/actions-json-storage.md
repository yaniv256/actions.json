# actions.json.storage

`actions.json.storage` is a user-owned file workspace for website operating
memory.

An `actions.json` file tells an agent how to operate a website. Storage keeps
the durable context that makes those actions useful over time:

- site action maps;
- page and product knowledge;
- observations captured from browser sessions;
- run logs and lessons;
- generated overlays and reports;
- shared or public maps that can be reviewed and reused.

The reference storage format uses ordinary files in Git repositories so users
can read, diff, branch, review, and share the memory that agents use.

## When To Use Storage

Use storage when an agent learns something that should survive the current
browser session.

Examples:

- A site guide learns what every menu page contains.
- A product guide stores product descriptions, buying advice, and cart actions.
- A carousel scan stores every item it saw, including items that later scroll out
  of view.
- A navigation action fails and the corrected selector should be remembered.
- A generated overlay should be available next time the same site is opened.

## Workspace Layout

The recommended root checkout is:

```text
actions.json.storage/
  README.md
  storage.json
  scopes/
    private/
    shared/
    public/
```

The root repository is the workspace and mount table. Each visibility scope can
be a separate repository mounted under `scopes/`.

Separate scope repositories help because:

- private browsing observations do not need the same access rules as public
  examples;
- shared site maps can be given to a specific website owner or collaborator;
- public maps can be published without exposing private history;
- Git history stays reviewable by audience.

## Scope Layout

Each mounted scope should use the same internal shape:

```text
scopes/shared/example-owner/
  scope.json
  agents/
    chrome-extension.json
    codex.json
  sites/
    example.com/
      actions.json
      observations/
      items/
      runs/
      overlays/
      reports/
```

Use the same layout under `scopes/private/` and `scopes/public/` so artifacts can
move between scopes without being reshaped.

## Root Manifest

`storage.json` describes the workspace and mounted scopes.

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
      "mount_type": "git_submodule",
      "visibility": "private"
    },
    "public": {
      "path": "scopes/public",
      "mount_type": "git_submodule",
      "visibility": "public"
    }
  }
}
```

The manifest should describe where scopes live. Raw browsing data belongs inside
the scope repositories, not in the root manifest.

## Site Folders

A site folder is the unit the browser runtime uploads, reads, and updates.

```text
sites/example.com/
  actions.json
  context/
    overview.md
  observations/
    2026-06-07T140000Z.jsonl
  items/
    products.items.json
  runs/
    2026-06-07T141500Z.json
  overlays/
    product-guide.overlay.json
  reports/
    product-guide.html
```

The exact artifact set depends on the site. A simple site may only need
`actions.json`; a product or content site may need context, product inventory,
navigation maps, overlays, and run history.

## Data Classes

### Action Maps

`actions.json` stores reusable actions and context for the site.

Good action maps include:

- what the site is for;
- important pages and sections;
- reliable navigation actions;
- product or content explanations;
- when to use point-based actions versus DOM inspection;
- any site policy limits, such as blocked page JavaScript.

Action maps guide future automation, so edits should be reviewed before they are
shared or published.

### Observations

Observations are raw facts captured from a page at a time. They are usually
append-only JSONL.

```json
{
  "type": "observation",
  "observed_at": "2026-06-07T14:00:00Z",
  "site": "example.com",
  "surface": "products",
  "source_url": "https://example.com/products",
  "items": [
    {
      "title": "Example product",
      "url": "https://example.com/products/example"
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
  "surface": "products",
  "items": {
    "product:https://example.com/products/example": {
      "title": "Example product",
      "url": "https://example.com/products/example",
      "first_seen_at": "2026-06-07T14:00:00Z",
      "last_seen_at": "2026-06-07T14:00:00Z"
    }
  }
}
```

Items answer: what do we remember across sessions?

### Runs

Runs record what an agent did and what happened.

```json
{
  "type": "run",
  "run_id": "2026-06-07T141500Z-example-navigation",
  "site": "example.com",
  "actions_taken": [
    {
      "action": "navigation.open_products",
      "result": "products_page_visible"
    }
  ],
  "lessons": [
    {
      "type": "navigation",
      "text": "The products page should be opened by link URL, not by approximate scroll position."
    }
  ]
}
```

Runs answer: what did the agent do, what failed, and what should improve?

### Reports And Overlays

Reports and overlays are human-facing views generated from stored data.

```text
reports/product-guide.html
overlays/product-guide.overlay.json
```

The canonical source should remain structured actions, observations, items, and
runs. Generated views can be rebuilt from that source.

## Upload And Download In The Extension

The Chrome extension can upload a local `actions.json.storage` checkout into
browser storage. The hosted agent can then use `actions.site` to read matching
site maps without a local bridge.

Typical workflow:

1. Pull the storage repository and its mounted scope repositories.
2. Open the target website in Chrome.
3. Open the extension `actions.json` menu.
4. Open **Settings**.
5. Press **Upload** and choose the root `actions.json.storage` folder.
6. Start or restart the hosted agent.
7. Ask what actions are available for the current site.
8. After the agent creates or updates useful artifacts, press **Download** to
   write them back to the selected local checkout.
9. Review and commit the storage changes.

The upload should send the whole storage checkout, not a single site folder, so
the runtime can resolve scopes and related sites.

## Bridge Sync

External coding agents can also load storage through the MCP-shaped bridge.
Use this path when a coding agent outside the extension is authoring, testing,
or validating maps.

The bridge path and extension upload path should produce the same current-site
catalog for `actions.site`.

## Write Policy

Recommended default policy:

| Data | Default write mode | Reason |
| --- | --- | --- |
| `observations/*.jsonl` | Direct append | Captures what was seen; easy to audit. |
| `runs/*.json` | Direct write | Captures one execution trace. |
| `items/*.json` | Deterministic merge | Derived memory from observations. |
| `reports/*` | Generated artifact | Human-facing view. |
| `overlays/*` | Generated or reviewed artifact | May be shown to the user. |
| `actions.json` | Review before sharing | Changes future automation behavior. |
| `schemas/*.json` | Review before sharing | Changes compatibility and validation. |

## Visibility And Sharing

Use scopes to decide who should see the memory:

- **private**: personal observations, debugging runs, private browsing memory;
- **shared**: maps or overlays prepared for a specific collaborator or website
  owner;
- **public**: reviewed examples intended for broad reuse.

Do not publish internal development notes, private customer observations, or
unreviewed browser logs as public storage.

## Security Rules

Never store:

- passwords;
- cookies;
- access tokens;
- session storage;
- payment data;
- private keys;
- private messages or personal data that the user did not intend to preserve.

The browser runtime should not need credentials from storage. It operates the
page that the user has already opened and authorized.

## Verify Storage Is Working

1. Upload the storage root from the extension Settings tab.
2. Open a website that has a matching site folder.
3. Start the hosted agent.
4. Ask it what actions are available.
5. If you inspect the log, confirm the agent used `actions.site` and received
   site-specific actions.
6. Create or update one harmless artifact.
7. Press **Download** and confirm the local checkout changed.

If actions are missing, see [Troubleshooting](troubleshooting.md).

## Read Next

- [Hosted Agent Tools](hosted-agent-tools.md)
- [Storage Visibility Scopes](storage-visibility-scopes.md)
- [Getting Started](getting-started.md)
