# actions.json storage scaffold

This is a starter `actions.json.storage` workspace. The `init` step copies it to
`.storage/` in your `actions.json` checkout, where it lives **inside the folder
but is not part of the code repo** (`.storage/` is gitignored).

Point the bridge at it with `--storage-root .storage`.

## Scopes

Storage is organized by visibility. Each scope is just a folder under `scopes/`;
the runtime discovers site maps under `scopes/<scope>/sites/<host>/`.

| Scope | What goes here | Git |
|---|---|---|
| `private/` | Your owner-only browsing memory, observations, run logs, and unreviewed maps. | Local by default — stays on your machine. |
| `public/` | Reviewed, redacted maps **you publish** openly. | Opt in: point it at your own public repo. |
| `shared/<name>/` | Maps shared with a specific collaborator, **and** maps you pull **from** a source. | Opt in: one git remote per source. |

`private` and `public` exist in the scaffold. Add `shared/<name>/` when you need
it.

## Opening a scope for sharing or syncing

The scaffold is local-only until you choose to version a scope. Each scope is an
ordinary folder, so you turn one into a git repo when you want to.

**Publish your public maps** — make `scopes/public/` your own public repo:

```bash
cd .storage/scopes/public
git init && git add . && git commit -m "my public actions.json maps"
git remote add origin https://github.com/<you>/<your-public-storage>.git
git push -u origin main
```

**Pull the official map library** — vendor maps *from* a source into a shared
scope (the runtime already discovers maps under `scopes/shared/<name>/`):

```bash
cd .storage/scopes/shared
git clone https://github.com/yaniv256/actions.json.storage.public.git actions-json
# maps now resolve from scopes/shared/actions-json/sites/<host>/
```

Pulling from someone else's library uses the **shared** scope (inbound), not
`public` (which is for what *you* publish). Keep that boundary clear.

## Layout

```text
storage.json              Root manifest — which scopes are mounted
scopes/
  private/
    scope.json            Private scope manifest
    sites/<host>/         Per-site maps, observations, overlays (local)
  public/
    scope.json            Public scope manifest
    sites/<host>/         Reviewed, redacted maps you publish
  shared/<name>/          Add per-collaborator or per-source as needed
```
