# actions.json.storage

Your `actions.json.storage` workspace — the root/index that records storage configuration, mounted
scopes, and layout. It was created here on first run of `@actions-json/bridge`.

## Layout

```text
storage.json     Root manifest (mounts, visibility, sync policy)
scopes/
  public/        Reviewed, reusable public site maps (cloned from the public maps repo)
  private/       Your OWN owner-only storage — local by default (see its README)
```

## ⚠️ Privacy

`scopes/private` is where your browsing memory, observations, and unreviewed maps live. It is **local
and private by default** here in your home directory. If you later put this workspace under version
control, putting files in `scopes/private` does NOT make them private on its own — keep the repo
private, or mount `scopes/private` from your own **private** repo. See `scopes/private/README.md`.

## The public maps

`scopes/public` is cloned from
[actions.json.storage.public](https://github.com/yaniv256/actions.json.storage.public) so you have
working site maps to try immediately. Update them with `git -C scopes/public pull`, or repoint the
`public` mount in `storage.json` at your own public repo.
