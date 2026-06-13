# actions.json storage

This **is** your `actions.json.storage` workspace — operational, not an example.
The bridge created it on first run (default: `~/.actions-json/storage`) and reads
and writes here as your agent browses. Your browsing memory, observations, and
action maps live in these folders.

## Scopes

Storage is organized by visibility. Each scope is a folder under `scopes/`; the
runtime discovers site maps under `scopes/<scope>/sites/<host>/`.

| Scope | What goes here | Git |
|---|---|---|
| `private/` | Your owner-only browsing memory, observations, run logs, and unreviewed maps. | Local by default. Opt in: back it with your own **private** repo to sync across your machines and agents. |
| `public/` | Reviewed, redacted maps **you publish** openly. | Opt in: point it at your own public repo. |
| `shared/<name>/` | Maps shared with a specific collaborator, **and** maps you pull **from** a source. | Opt in: one git remote per source. |

`private` and `public` are set up. Add `shared/<name>/` when you need it.

## Versioning a scope

Each scope is an ordinary folder, local until you choose to version it. Turn one
into a git repo when you want to sync or share it.

**Sync your private memory across machines** — back `scopes/private/` with your
own **private** repo so the same browsing memory follows your agent everywhere:

```bash
cd ~/.actions-json/storage/scopes/private
git init && git add . && git commit -m "my private actions.json memory"
git remote add origin https://github.com/<you>/<your-private-storage>.git  # private!
git push -u origin main
# on another machine: clone it into scopes/private instead of git init
```

This stays private — it is your repo, set to private. It only ever leaves your
machine if you point it at a remote, and `public`/`shared` promotion still
requires explicit review.

**Publish your public maps** — make `scopes/public/` your own public repo:

```bash
cd ~/.actions-json/storage/scopes/public
git init && git add . && git commit -m "my public actions.json maps"
git remote add origin https://github.com/<you>/<your-public-storage>.git
git push -u origin main
```

**Pull the official map library** — vendor maps *from* a source into a shared
scope (the runtime discovers maps under `scopes/shared/<name>/`):

```bash
cd ~/.actions-json/storage/scopes/shared
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
    sites/<host>/         Per-site maps, observations, overlays (local; sync via a private repo)
  public/
    scope.json            Public scope manifest
    sites/<host>/         Reviewed, redacted maps you publish
  shared/<name>/          Add per-collaborator or per-source as needed
```
