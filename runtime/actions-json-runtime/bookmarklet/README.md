# actions.json Bookmarklet

This bookmarklet opens an in-page `actions.json` panel for the current website.

It imports and exports page-relevant `actions.json.storage` files and executes
the portable page-JavaScript primitive surface used to test future website
embeds.

In browsers that support the File System Access API, such as Chrome, the
bookmarklet can also ask you to choose your local `actions.json.storage` folder.
After that explicit permission, it can load page-relevant files from that folder
and write the current local bundle back into the same folder. It does not commit
to Git; `git diff` remains the review step.

## Build The Bookmarklet URL

```bash
npm run build:storage-bookmarklet
```

The command writes:

```text
runtime/actions-json-runtime/bookmarklet/install.html
runtime/actions-json-runtime/bookmarklet/storage-bookmarklet.url
```

Open `install.html` in Chrome and drag the `actions.json` link into the
bookmarks bar.

If drag-and-drop is unavailable, create a browser bookmark manually and paste
the single `javascript:` URL from `storage-bookmarklet.url` into the bookmark URL
field.

## Import Rules

The bookmarklet imports files relevant to the current page host.

Accepted upload shapes:

```text
actions.json.storage/scopes/private/sites/amazon.com/prime-video/actions.json
actions.json.storage/scopes/shared/trusted-agents/sites/amazon.com/prime-video/actions.json
actions.json.storage/scopes/public/sites/amazon.com/prime-video/actions.json
actions.json.storage.private/sites/amazon.com/prime-video/actions.json
sites/amazon.com/prime-video/actions.json
```

On `www.amazon.com`, those Amazon paths are accepted. A path such as
`scopes/private/sites/linear.app/workspace/actions.json` is ignored.

Bare `sites/...` uploads are stored under the private scope fallback.

## Primitive Runtime

The bookmarklet implements the portable Stage 1 primitives:

```text
pointer.move
pointer.click
pointer.double_click
pointer.drag
viewport.scroll
text.insert
keyboard.press          # page-level unmodified keys only
page.info
dom.observe.visible
dom.snapshot_text
locator.element_info
locator.text_content
locator.wait_for
```

It also implements `browser.extract_elements` for storage maps that need
structured visible-element extraction, such as carousel cards or analytics rows.

The bookmarklet does not have autonomous browser privilege. `browser.screenshot`
requires a user-approved `getDisplayMedia` browser prompt, and host-page Content
Security Policy can block the direct local bridge transport. When that happens,
the bookmarklet may need an extension relay for development, but the executed
primitive semantics are still page-JavaScript semantics.

## Folder Write Flow

In Chrome:

1. Click the bookmarklet on a target page.
2. Click `Choose storage folder` and select your local `actions.json.storage`
   checkout.
3. Click `Load from folder` to import files relevant to the current page.
4. After editing or testing, click `Write to folder`.
5. Review the working tree yourself:

```bash
git status
git diff
```

`Load from folder` does not recursively read the whole storage checkout. It
probes only folders that can match the current page host:

```text
scopes/private/sites/<current-host>/
scopes/public/sites/<current-host>/
scopes/shared/<audience>/sites/<current-host>/
sites/<current-host>/                       # when the chosen folder is a scope repo
```

For `www.amazon.com`, it also tries `amazon.com`.

You can also select the exact site folder, such as `sites/amazon.com` or the
`amazon.com` folder itself. In that case the bookmarklet reads only that selected
folder and stores it under the UI's default scope.

## Export Shape

Export downloads one JSON bundle:

```text
actions-json-storage-<page-host>.bundle.json
```

The bundle preserves canonical storage paths under `files`, for example:

```json
{
  "files": {
    "scopes/private/sites/amazon.com/prime-video/actions.json": {
      "text": "{}",
      "scope": "private",
      "siteHost": "amazon.com",
      "sitePath": "prime-video/actions.json"
    }
  }
}
```
