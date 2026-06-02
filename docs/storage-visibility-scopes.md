# Storage Visibility Scopes

`actions.json.storage` should not be modeled as only one private bucket.

The canonical working repository may be private, but the storage design needs
three artifact modes:

1. private;
2. shared with selected people, groups, or trusted agents;
3. public.

This design belongs in `actions.json.private`, not in a user's storage repo. A
specific `actions.json.storage` repository should primarily contain the user's
stored data, manifests, action maps, observations, overlays, and run logs. The
policy and schema thinking should live in the design repository.

## Why The Distinction Matters

Different artifacts have different risk profiles.

Raw Prime Video Continue Watching records are private browsing history. They
should remain private.

A Linear action map derived from a private workspace may be shareable with a
collaborator who works in that workspace, but not with the world.

A generalized lesson like "a carousel collection action needs visible-card
diagnostics, rate-limited scroll transitions, and convergence criteria" is public
schema knowledge once it is separated from personal data.

## Scopes

### Private

Use `private` for:

- raw browsing observations;
- watch history, continue-watching lists, account-specific page state;
- raw run logs that mention authenticated pages;
- failed attempts that reveal account-specific DOM or page state;
- overlays generated from private data;
- anything not explicitly reviewed for sharing.

Private is the default.

### Shared

Use `shared` for artifacts meant for specific people, groups, or trusted agents.
Shared is not one global sharing bucket. Each shared audience should have its own
repository, mount, and access policy.

Examples:

- a redacted action map for a private SaaS workspace shared with collaborators;
- an overlay report prepared for a named project group;
- a storage-backed action map shared with a realtime page agent;
- a site automation lesson shared with another agent operating for the same user.

Shared artifacts must name an audience, and that audience should map to the
shared repository that stores the artifact. For example:

- `actions.json.storage.shared.family`
- `actions.json.storage.shared.project-roomjinni`
- `actions.json.storage.shared.trusted-agents`
- `actions.json.storage.shared.trusted-collaborators`

### Public

Use `public` for generalized artifacts that are safe to publish.

Examples:

- schema examples with no personal data;
- generalized DOM navigation lessons;
- reusable action-map patterns;
- public website action maps that do not include account-specific state.

Public artifacts should usually be promoted into a public repo/package after
review. They should not expose private browsing history or authenticated page
state.

## Promotion

Promotion is a deliberate review step:

```text
private -> shared:<audience> -> public
```

There can be multiple shared promotion targets. Promoting an artifact to
`shared:project-roomjinni` does not imply access for
`shared:trusted-collaborators`; those are separate repositories with separate
permissions.

A promotion review should check:

- Does the artifact contain personal browsing history?
- Does it include account-specific URLs, IDs, names, or screenshots?
- Does it include tokens, cookies, local storage, or secrets? If yes, do not
  promote.
- Is the artifact a raw observation or run log? If yes, keep private unless
  heavily redacted.
- Is the artifact a generalized action map or schema lesson? It may be a public
  candidate after redaction.

## Repository Implication

The user's canonical checkout can be a root `actions.json.storage` repository,
but the actual permission boundaries should be separate repositories mounted
into it.

Recommended shape:

```text
actions.json.storage/
  storage.json
  scopes/
    private/                         # submodule: actions.json.storage.private
    shared/
      family/                        # submodule: actions.json.storage.shared.family
      project-roomjinni/             # submodule: actions.json.storage.shared.project-roomjinni
      trusted-agents/                # submodule: actions.json.storage.shared.trusted-agents
      trusted-collaborators/         # submodule: actions.json.storage.shared.trusted-collaborators
    public/                          # submodule: actions.json.storage.public
```

This avoids pretending that one Git repository permission can express all useful
artifact sharing. GitHub permissions are repository-level. Submodules let the
root checkout feel like one storage workspace while each scope keeps its own
access policy and canonical history.

Use the scope repositories this way:

- `actions.json.storage.private`: owner-only raw observations, browsing history,
  account-specific run logs, private overlays, and unreviewed action maps.
- `actions.json.storage.shared.<audience>`: artifacts shared with exactly one
  named audience, such as family, project collaborators, or trusted agents. A
  user can have many shared repositories mounted under `scopes/shared/`.
- `actions.json.storage.public`: reviewed and redacted artifacts intended for
  publication, reuse, or eventual promotion into the public `actions.json`
  package.

The root `actions.json.storage` repository may still be private. It can contain
the storage manifest, mount table, schema pointers, agent identities, and sync
policy. The most private browsing data does not need to live there; it belongs in
`actions.json.storage.private`.

Submodules preserve one source of truth, but they pin commits. A storage sync
runtime must commit both the scoped repository update and the root pointer update
when a mounted scope changes.

The important invariant is that access boundaries remain repository boundaries:
adding a collaborator to `actions.json.storage.shared.project-roomjinni` should
not grant access to `actions.json.storage.shared.family`, the private scope, or
any other shared audience.

## Schema Implication

Every stored artifact should eventually carry scope metadata:

```json
{
  "visibility": {
    "scope": "shared",
    "audience": "project-roomjinni",
    "mount": "shared:project-roomjinni",
    "reviewed_by": "yaniv",
    "reviewed_at": "2026-06-02T00:00:00Z"
  }
}
```

The storage prototype can contain operational scope metadata such as an audience
manifest. The design repository should define the policy, schema, and promotion
semantics.

The root manifest should also record mount metadata:

```json
{
  "mounts": {
    "private": {
      "path": "scopes/private",
      "repo": "git@github.com:yaniv256/actions.json.storage.private.git",
      "visibility": "private"
    },
    "shared:project-roomjinni": {
      "path": "scopes/shared/project-roomjinni",
      "repo": "git@github.com:yaniv256/actions.json.storage.shared.project-roomjinni.git",
      "visibility": "shared",
      "audience": "project-roomjinni"
    },
    "shared:trusted-agents": {
      "path": "scopes/shared/trusted-agents",
      "repo": "git@github.com:yaniv256/actions.json.storage.shared.trusted-agents.git",
      "visibility": "shared",
      "audience": "trusted-agents"
    },
    "public": {
      "path": "scopes/public",
      "repo": "https://github.com/yaniv256/actions.json.storage.public.git",
      "visibility": "public"
    }
  }
}
```

## Current Prototype Classification

Prime Video Continue Watching observations and item indexes are `private`.

Linear workspace actions are currently `private` because they reference a private
workspace and issue identifiers. A generalized Linear action-map pattern may
later be promoted to `public`.

The ACT-5 x PR #1 comparison report is a candidate for `shared` or `public`
after review because it is mostly schema design content, but the specific overlay
artifact can still live in storage as a private generated artifact until
promotion.
