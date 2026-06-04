# actions-json-runtime

Injectable JavaScript runtime for `actions.json`.

The runtime runs in or beside a browser page. It loads `actions.json`, validates the action map, attaches to the DOM, and exposes the Actions Bridge Protocol.

The runtime is the interpreter of `actions.json`.

The Actions Bridge Protocol is modeled primarily on OpenAI Responses-style item semantics.

## Bookmarklet Storage And Primitive Runtime

The bookmarklet opens an in-page `actions.json` UI that can import the
`actions.json.storage` files relevant to the current page, save them into
browser `localStorage`, and execute the portable Stage 1 primitive surface from
page JavaScript.

It accepts these upload shapes:

- a root checkout containing `scopes/private/sites/<site>/...`,
  `scopes/shared/<audience>/sites/<site>/...`, or
  `scopes/public/sites/<site>/...`;
- a selected scope repository such as `actions.json.storage.private/sites/<site>/...`;
- a bare `sites/<site>/...` folder, stored under the private scope fallback.

Files for unrelated sites are ignored. For example, on `www.amazon.com`, files
under `sites/amazon.com/...` are imported and files under `sites/linear.app/...`
are rejected.

The bookmarklet/embed runtime implements these Stage 1 primitives:

- `pointer.move`
- `pointer.click`
- `pointer.double_click`
- `pointer.drag`
- `viewport.scroll`
- `text.insert`
- `keyboard.press` with page-level, unmodified-key semantics
- `page.info`
- `dom.observe.visible`
- `dom.snapshot_text`
- `locator.element_info`
- `locator.text_content`
- `locator.wait_for`

It also implements `browser.extract_elements` for actions.json storage maps that
need structured visible-element extraction.

The bookmarklet cannot autonomously capture a true rendered screenshot. Its
`browser.screenshot` path must ask the user for browser capture permission. On
some websites, Content Security Policy can also block the bookmarklet's direct
local bridge transport; that is a transport capability boundary, not a selector
or actions.json failure.

For local development, paste the contents of `bookmarklet/storage-bookmarklet.js`
into the browser console, or create a bookmarklet from
`bookmarklet/storage-bookmarklet.url`.
