# actions.json.storage

## Purpose

`actions.json.storage` is a user-owned storage workspace for `actions.json`.

`actions.json` describes how an agent can operate a website. `actions.json.storage`
remembers what agents learned and observed while operating websites for one user.

The motivating case is a browser overlay built from a website carousel. The
agent may scroll the carousel, extract titles, links, covers, categories, and DOM
lessons, then render an overlay. If the site later removes those items from the
carousel, the user should still have a private record of what was previously
observed.

The default scope is private because storage may contain browsing history,
watched titles, account-specific page state, extracted metadata, and learned DOM
procedures for authenticated websites. Those artifacts should not be published,
synced to the public `actions.json` repository, or shared by default. Shared and
public scopes are explicit promotion targets, not alternative defaults.

## Design Goal

The storage layer should let multiple agents collaborate around the same user's
web-browsing memory:

- Codex or another coding agent can inspect a page, create an overlay, and store
  observations.
- A browser extension can expose site-local actions and write page observations.
- A realtime page agent can learn from previous runs and add new DOM lessons.
- The user can open the storage and audit exactly what was captured, who wrote it,
  and what learned procedures might affect future browsing automation.

The storage must be human-observable, versioned, and easy to diff. It should use
plain files and schemas rather than an opaque database.

## Recommended Backend

The default backend should be a GitHub-backed storage workspace rooted at a
private repository named `actions.json.storage`.

GitHub is not required by the `actions.json` standard, but it is a strong default
because it provides:

- private repositories available to ordinary users;
- file-based storage for JSON, JSONL, Markdown, and generated HTML reports;
- commit history, diffs, blame, branches, pull requests, and reverts;
- GitHub Apps and fine-grained repository permissions;
- a familiar browser UI for human review;
- a common synchronization target for independent agents.

Other backends can be adapters. Notion, Dropbox, Google Drive, S3, local files,
or SQLite can all implement the same storage concepts, but the reference design
should start with GitHub because `actions.json` is already a file-oriented
protocol. Within GitHub, separate private, shared, and public repositories
provide the actual permission boundaries.

## Repository Topology

The logical storage workspace can be one checkout, but the permission boundaries
must be separate repositories mounted into that checkout.

GitHub permissions are repository-scoped, not folder-scoped. A single repository
cannot safely express "this folder is public, this folder is shared with Alice,
and this folder is never exposed." The reference topology should therefore use a
small root repository plus mounted scope repositories:

```text
actions.json.storage/                         # private root index / superproject
  README.md
  .gitmodules
  storage.json
  scopes/
    private/                                  # git submodule -> actions.json.storage.private
    shared/
      project-roomjinni/                      # git submodule -> actions.json.storage.shared.project-roomjinni
      trusted-agents/                         # git submodule -> actions.json.storage.shared.trusted-agents
      trusted-collaborators/                  # git submodule -> actions.json.storage.shared.trusted-collaborators
    public/                                   # git submodule -> actions.json.storage.public
```

Repository roles:

- `actions.json.storage`: a private root/index repository. It records the user's
  storage configuration, mounted scopes, schema pointers, sync policy, and
  agent/audience metadata. It should not be the default place for raw browsing
  data.
- `actions.json.storage.private`: an owner-only private repository for raw
  browsing observations, watch history, authenticated-page run logs, private
  overlays, and unrevealed action maps.
- `actions.json.storage.shared.<audience>`: one private repository per sharing
  audience. A user can mount many shared repositories side by side, such as
  `actions.json.storage.shared.project-roomjinni`,
  `actions.json.storage.shared.trusted-agents`, and
  `actions.json.storage.shared.trusted-collaborators`.
- `actions.json.storage.public`: a public repository for reviewed, redacted, and
  reusable artifacts that the user is comfortable sharing with the world.

The public scope is especially important for the ecosystem: it is where reusable
site action maps, generalized DOM lessons, schema examples, and redacted
patterns can graduate after review.

Git submodules are the preferred first mechanism because they preserve a single
source of truth and separate access control while still giving the user one local
workspace. A subtree copy would make sharing easier to browse but would duplicate
content into the parent repository, which is the wrong default for sensitive
data. A manifest-only mount can be supported later for agents that dislike
submodules, but the same rule should hold: each scope has one canonical
repository.

The root repository can remain private even when it mounts a public scope. It may
contain sensitive metadata such as which audiences exist, which sites have
private memory, and which agents are authorized. The highest-risk data should not
need to live in the root repository at all; it belongs in
`actions.json.storage.private`.

Submodules pin commits. That is useful for auditability, but it means sync tools
must update the root pointer when a mounted scope advances. The storage runtime
should treat that pointer update as a normal part of committing a storage write.

## Scope Repository Layout

Each scope repository should use the same internal file layout so agents can move
or promote artifacts without changing their shape:

```text
actions.json.storage.private/
  README.md
  scope.json
  schemas/
    observation.schema.json
    action-map.schema.json
    overlay.schema.json
    run.schema.json
    agent.schema.json
  agents/
    codex.json
    chrome-extension.json
    realtime-page-agent.json
  sites/
    amazon.com/
      prime-video/
        actions.json
        observations/
          continue-watching.jsonl
        items/
          continue-watching.items.json
        runs/
          2026-06-02T231245Z.json
        overlays/
          continue-watching.overlay.json
        reports/
          continue-watching.html
```

### Root Manifest

The root `storage.json` identifies the workspace, mounted repositories, and
supported schemas:

```json
{
  "protocol": "actions.json.storage",
  "version": "0.1.0",
  "owner": {
    "type": "person",
    "id": "local-user"
  },
  "visibility": "root-private",
  "default_mount": "private",
  "mounts": {
    "private": {
      "path": "scopes/private",
      "repo": "git@github.com:<owner>/actions.json.storage.private.git",
      "mount_type": "git_submodule",
      "visibility": "private",
      "default": true
    },
    "shared:project-roomjinni": {
      "path": "scopes/shared/project-roomjinni",
      "repo": "git@github.com:<owner>/actions.json.storage.shared.project-roomjinni.git",
      "mount_type": "git_submodule",
      "visibility": "shared",
      "audience": "project-roomjinni"
    },
    "shared:trusted-agents": {
      "path": "scopes/shared/trusted-agents",
      "repo": "git@github.com:<owner>/actions.json.storage.shared.trusted-agents.git",
      "mount_type": "git_submodule",
      "visibility": "shared",
      "audience": "trusted-agents"
    },
    "shared:trusted-collaborators": {
      "path": "scopes/shared/trusted-collaborators",
      "repo": "git@github.com:<owner>/actions.json.storage.shared.trusted-collaborators.git",
      "mount_type": "git_submodule",
      "visibility": "shared",
      "audience": "trusted-collaborators"
    },
    "public": {
      "path": "scopes/public",
      "repo": "https://github.com/<owner>/actions.json.storage.public.git",
      "mount_type": "git_submodule",
      "visibility": "public"
    }
  },
  "default_policy": {
    "observations": "append",
    "action_maps": "reviewed",
    "reports": "generated"
  }
}
```

Each mounted scope can also declare its own `scope.json` so agents can validate
where they are writing:

```json
{
  "protocol": "actions.json.storage.scope",
  "version": "0.1.0",
  "scope": "private",
  "parent": "actions.json.storage",
  "write_policy": {
    "observations": "append",
    "action_maps": "reviewed"
  }
}
```

### Agent Identity

Each collaborating agent should have a stable identity file:

```json
{
  "id": "chrome-extension",
  "display_name": "Chrome Extension Runtime",
  "actor_type": "browser_extension",
  "allowed_writes": [
    "scopes/private/sites/*/*/observations/*.jsonl",
    "scopes/private/sites/*/*/runs/*.json"
  ],
  "requires_review_for": [
    "scopes/private/sites/*/*/actions.json",
    "scopes/shared/*/sites/*/*/actions.json",
    "scopes/public/sites/*/*/actions.json"
  ]
}
```

The goal is not strong cryptographic identity in the first draft. The goal is a
clear audit trail: every write should say which agent produced it, what page it
was looking at, and which action or observation schema it used.

## Data Classes

### Observations

Observations are facts captured from a site at a time. They are append-only by
default.

For the Prime Video carousel case:

```json
{
  "type": "observation",
  "schema": "actions.storage.observation.v1",
  "observed_at": "2026-06-02T23:12:45Z",
  "site": "amazon.com",
  "surface": "prime-video.continue-watching",
  "agent_id": "codex",
  "source_url": "https://www.amazon.com/gp/video/storefront",
  "items": [
    {
      "title": "Westworld",
      "url": "https://www.amazon.com/gp/video/detail/...",
      "cover_url": "https://images-na.ssl-images-amazon.com/...",
      "source": "continue_watching_carousel"
    }
  ]
}
```

Observations should preserve what was seen, not only the current derived view.
They answer: "What did an agent see on this page during this run?"

### Items

Item indexes deduplicate observations into a stable memory:

```json
{
  "type": "item_index",
  "surface": "prime-video.continue-watching",
  "items": {
    "amazon-video-detail:B0B8QV2SJG": {
      "title": "Westworld",
      "url": "https://www.amazon.com/gp/video/detail/B0B8QV2SJG",
      "first_seen_at": "2026-06-02T23:12:45Z",
      "last_seen_at": "2026-06-02T23:12:45Z",
      "seen_count": 1,
      "latest_cover_url": "https://images-na.ssl-images-amazon.com/..."
    }
  }
}
```

Indexes answer: "What does this user remember having seen before?"

### Runs

Runs record operational context, including failures and lessons:

```json
{
  "type": "run",
  "schema": "actions.storage.run.v1",
  "run_id": "2026-06-02T231245Z-codex-prime-video",
  "agent_id": "codex",
  "site": "amazon.com",
  "surface": "prime-video.continue-watching",
  "actions_taken": [
    {
      "type": "carousel_scroll",
      "direction": "left",
      "method": "horizontal_scroll_gesture",
      "rate_limit_ms": 1200,
      "result": "new cards discovered"
    }
  ],
  "lessons": [
    {
      "type": "correction",
      "text": "Carousel movement requires horizontal scrolling, not a left-side click."
    },
    {
      "type": "extraction",
      "text": "Cover URLs were exposed on carousel cards after scrolling them into the carousel state."
    }
  ]
}
```

Runs answer: "What did the agent do, and what did it learn about operating this
page?"

### Action Maps

Per-site `actions.json` files store learned procedures that can guide future
agents. These are more sensitive than observations because they can influence
automation.

For that reason, direct writes to `actions.json` should be treated as reviewed
changes:

```json
{
  "protocol": "actions.json",
  "version": "0.1.0",
  "surface": {
    "origin": "https://www.amazon.com",
    "name": "Prime Video storefront"
  },
  "tools": [
    {
      "name": "collect_continue_watching",
      "description": "Collect visible and scroll-revealed cards from the Continue Watching carousel.",
      "input_schema": {
        "type": "object",
        "properties": {
          "max_scrolls": {
            "type": "integer",
            "minimum": 0
          },
          "min_scroll_interval_ms": {
            "type": "integer",
            "minimum": 1000
          }
        }
      },
      "x_actions": {
        "dom_strategy": {
          "target": "Continue Watching carousel",
          "movement": "horizontal_scroll",
          "do_not_use": [
            "left-side click for carousel movement"
          ],
          "rate_limit": {
            "min_interval_ms": 1000
          }
        },
        "extract": [
          "title",
          "detail_url",
          "cover_url"
        ]
      }
    }
  ]
}
```

Action maps answer: "How should agents operate this page next time?"

## Write Policy

The storage design should distinguish low-risk append-only data from higher-risk
learned automation.

| Data | Default write mode | Reason |
| --- | --- | --- |
| `observations/*.jsonl` | Direct append | Captures what was seen; easy to audit and revert. |
| `runs/*.json` | Direct write | Captures a single execution trace. |
| `items/*.json` | Direct update with deterministic merge | Maintains deduplicated memory derived from observations. |
| `reports/*.html` | Generated artifact | Human-facing view derived from stored data. |
| `actions.json` | Branch or pull request | Can change future automation behavior. |
| `schemas/*.json` | Branch or pull request | Changes validation and compatibility. |

This split lets lightweight page agents deposit useful observations without
turning every carousel scrape into a review workflow, while still requiring
review for executable or semi-executable action learning.

## GitHub App Model

A GitHub App is an application installed on a GitHub account or repository. The
app requests specific permissions, such as read/write access to repository
contents. After installation, the app can mint short-lived installation access
tokens scoped to the repositories and permissions granted by the installation.

For `actions.json.storage`, a GitHub App is preferable to one shared long-lived
personal token because:

- permissions are explicit and repository-scoped;
- tokens can be short-lived;
- each application can have a distinct identity;
- installation can be revoked without rotating a user's broad credentials;
- future hosted or local agents can share the same storage protocol without
  sharing one secret.

The reference shape should define an `actions.json.storage` GitHub App with:

- repository access: selected repositories only;
- repository contents: read/write;
- metadata: read;
- no administration, workflow, secrets, or organization-wide permissions;
- optional pull-request write permission if the app creates reviewed action-map
  updates through PRs.

In the first implementation, the browser extension can either:

1. talk to a local bridge that owns the GitHub App credentials; or
2. hold an installation token in extension-private storage and write only through
   a narrow storage API implemented in the extension background process.

The second option is acceptable if page scripts never receive the token and the
extension exposes only structured storage operations, not arbitrary GitHub API
access.

## Agent Collaboration Flow

```text
User opens authenticated website
  -> Browser extension detects or receives a site action map
  -> Agent collects page data for an overlay
  -> Agent writes observations and run logs to the private scope
  -> Agent updates derived item indexes and generated reports in that scope
  -> Agent proposes action-map lessons as a branch or PR in the appropriate scope
  -> Other agents read storage before operating the same site
```

Example:

1. Codex collects Prime Video Continue Watching cards.
2. It records the 18 observed cards in
   `scopes/private/sites/amazon.com/prime-video/observations/continue-watching.jsonl`.
3. It updates
   `scopes/private/sites/amazon.com/prime-video/items/continue-watching.items.json`
   so titles remain remembered even if the carousel later changes.
4. It writes a run log noting that carousel navigation required horizontal
   scrolling with a one-second minimum interval.
5. It proposes a change to
   `scopes/private/sites/amazon.com/prime-video/actions.json` so future agents
   operating for the same user know the correct navigation and extraction
   strategy.
6. If the lesson becomes a generalized carousel pattern with private details
   removed, it can be promoted into `scopes/public/...` or the public
   `actions.json` package.

## Human Review Views

Raw JSON and JSONL are good canonical storage formats, but users also need
comfortable review surfaces.

Each scope repository should support generated views:

- `reports/*.html` for rich local or GitHub Pages-style browsing;
- Markdown summaries checked into `reports/*.md`;
- JSON schemas for editor validation and folding;
- optional Notion mirrors for high-level browsing, without making Notion the
  source of truth.

GitHub's normal file viewer and diffs are enough for the first pass. Richer JSON
folding can come from opening the repo in an editor, using `github.dev`, or
generating HTML reports from the stored JSON.

## Visibility Scopes

Private is the safe default, but the storage workspace should support three
artifact scopes:

- `private`: owner-only data, including raw browsing observations and account
  specific run logs.
- `shared`: artifacts available to explicitly defined people, groups, or trusted
  agents.
- `public`: reviewed and redacted artifacts that can be shared with the world.

The canonical `actions.json.storage` checkout remains the user's logical
workspace while the actual storage for each scope lives in a separate mounted
repository. Publishing is a promotion workflow, not an accident of where a file
happens to live.

See [storage-visibility-scopes.md](storage-visibility-scopes.md) for the detailed
scope model.

## Security Posture

The workspace may contain sensitive browsing memory even when it also mounts a
public scope. The design should assume private and shared scopes contain
sensitive data.

Rules:

- Never write secrets, cookies, tokens, passwords, payment data, or session
  storage.
- Prefer URLs, titles, public cover URLs, DOM selector lessons, and user-approved
  page observations.
- Store the minimum account-specific data needed to satisfy the user's memory and
  overlay goals.
- Keep write operations structured and schema-validated.
- Treat `actions.json` updates as higher risk than observations.
- Preserve commit history for auditability.
- Make agent identity visible in every run and observation record.
- Require review before moving artifacts from `private` to `shared`, from
  `shared` to `public`, or directly from `private` to `public`.
- Keep the root repository free of raw observations unless there is a specific
  reason to place them there.

## Open Questions

- Should the reference GitHub App be part of the public `actions.json` package or
  a separate companion project?
- Should direct extension writes be supported in v1, or should the first version
  require a local bridge?
- What schema should distinguish personal observations from site-level reusable
  action lessons?
- How should agents merge conflicting action-map lessons from different runs?
- Should generated reports be committed, ignored, or published through a separate
  view layer?
- Should the root `actions.json.storage` repository contain any site artifacts,
  or should it be restricted to manifests, schema pointers, and mounted
  repository metadata?
