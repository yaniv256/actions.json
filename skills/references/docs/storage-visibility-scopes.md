# Storage Visibility Scopes

`actions.json.storage` separates artifacts by visibility:

- **private**: owner-only;
- **shared**: available to a named audience;
- **public**: reviewed and safe to publish.

Private is the default. Shared and public are promotion targets, not places an
agent should write by accident.

For workspace layout and file types, see [actions.json.storage](actions-json-storage.md).

## Why Scopes Exist

Different artifacts carry different risk.

Raw browsing observations can reveal account state, watch history, workspaces,
private URLs, names, and user behavior. They belong in private storage.

A redacted action map for a private workspace may be useful to collaborators,
but not safe for the public.

A generalized lesson about how to operate a public website component may be
safe to publish after private details are removed.

Git repository permissions are repository-level, so visibility scopes should map
to separate repositories or equivalent permission boundaries.

## Private

Use `private` for:

- raw page observations;
- authenticated-page run logs;
- account-specific URLs, IDs, names, or page state;
- watch history, feeds, messages, dashboards, or personal analytics;
- overlays generated from private data;
- failed attempts that reveal page state;
- unreviewed `actions.json` changes;
- anything not explicitly approved for sharing.

Private artifacts may still be useful and well-structured. Private does not mean
temporary; it means owner-controlled.

## Shared

Use `shared` for artifacts intended for a specific audience.

Shared is not one global bucket. Each audience should have its own repository,
mount, or permission boundary.

Examples:

- an action map for a private team workspace shared with that team;
- a report prepared for a named project group;
- a site lesson shared with another trusted agent operating for the same user;
- a redacted overlay shared with a collaborator.

A shared artifact must identify its audience. Access for one audience must not
imply access for another.

## Public

Use `public` for artifacts that are safe for anyone to read.

Examples:

- schema examples with no personal data;
- reusable action-map patterns;
- generalized selector and navigation lessons;
- public website action maps that do not include account-specific state;
- documentation and examples intended for the public package.

Public artifacts require review and redaction. They must not include private
browsing history, authenticated page state, private workspace names, secrets, or
personal account data.

## Promotion Flow

Promotion is deliberate:

```text
private -> shared:<audience> -> public
```

Direct `private -> public` promotion is allowed only when review confirms that
the artifact is already safe to publish.

Promotion review should ask:

- Does this contain personal browsing history?
- Does this include account-specific URLs, IDs, names, or screenshots?
- Does this include credentials, cookies, tokens, local storage, or secrets?
- Does this reveal private workspace structure or private user behavior?
- Is this raw observation data, or a generalized action/map/schema lesson?
- Has the target audience been named?
- Is the artifact useful outside the private context?

If the answer is unclear, keep the artifact private.

## Scope Metadata

Stored artifacts should be able to carry visibility metadata.

```json
{
  "visibility": {
    "scope": "shared",
    "audience": "project-team",
    "mount": "shared:project-team",
    "reviewed_by": "local-user",
    "reviewed_at": "2026-06-04T16:25:00Z"
  }
}
```

Fields:

- `scope`: `private`, `shared`, or `public`.
- `audience`: required for shared artifacts.
- `mount`: storage mount or repository boundary.
- `reviewed_by`: reviewer identity.
- `reviewed_at`: review timestamp.

Metadata does not replace repository permissions. It documents the decision and
helps agents avoid writing or promoting to the wrong place.

## Repository Boundary

Recommended repository model:

```text
actions.json.storage/
  scopes/
    private/                 # owner-only repository
    shared/
      project-team/          # shared with one named audience
      trusted-agents/        # shared with one named audience
    public/                  # public repository
```

The important invariant is access separation:

- access to one shared audience does not grant access to another;
- access to public does not grant access to private;
- the root workspace does not need to contain raw private observations;
- publishing is a promotion workflow, not a folder move by accident.

## Agent Rules

Agents writing storage should:

- default to private;
- write raw observations and run logs only to private unless instructed
  otherwise;
- require an explicit audience for shared writes;
- require review before public writes;
- avoid copying private data into generated public reports;
- preserve the original private artifact when creating a redacted public
  version;
- record reviewer and promotion metadata when available.
