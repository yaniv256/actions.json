# scopes/private/ — placeholder

This is a **placeholder folder**, intentionally empty in the public example. Your private scope holds
owner-only browsing memory, observations, run logs, item indexes, and unreviewed action maps — content
that should never be public.

## ⚠️ Enforce privacy — two options

Putting files in this folder does NOT make them private on its own. Choose one:

1. **Keep the whole `actions.json.storage` repo private** (set the forked repo to Private). Then this
   folder and its contents stay private along with everything else.
2. **Mount this folder from your OWN private repo** as a submodule, so private content lives in a
   separate private repository even if the root repo is public:

   ```bash
   git submodule add https://github.com/YOUR-ORG/your-actions.json.storage.private.git scopes/private
   ```

   and add a matching `private` mount to `storage.json`.

If you do neither and commit private files into a public repo, they will be exposed. The public example
links to no private repo, so nothing here is exposed by default.
