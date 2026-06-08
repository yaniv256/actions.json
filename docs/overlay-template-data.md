# Overlay Templates And Data

Overlays can be stored as two separate files:

- a reusable HTML template; and
- a JSON data file that the template renders.

Use this pattern when you want to share the visual design of an overlay without
sharing the private data that fills it.

## When To Use This

Use a template/data overlay when:

- the same report layout will be reused over time;
- the hosted agent should refresh a report by updating data only;
- a public or shared template should render private scan results;
- a downloaded overlay should be preserved as a standalone artifact.

Use inline `html` with `overlay.open` for one-off overlays that do not need to
be refreshed or shared as a reusable template.

The Chrome extension, bookmarklet, and future first-party embeds should use the
same overlay shape wherever possible. The bookmarklet is useful as a design and
testing tool, but it runs under the current page's browser policies. If a page
blocks a bookmarklet capability, that does not automatically mean a production
embed cannot support it. A website owner can choose to grant the permissions or
integration points that the embed needs.

## Storage Layout

The common layout is a public template with private data:

```text
actions.json.storage/
  scopes/
    public/
      sites/example.com/overlays/outreach-radar/template.html
    private/
      sites/example.com/overlays/outreach-radar/data.json
```

The template and data may come from different scopes:

- public template + private data;
- public template + shared data;
- shared template + private data;
- private template + private data.

Private data should stay private unless the user deliberately exports or shares
a rendered report.

## Opening A Template Overlay

A coding agent or hosted browser agent can open the overlay with `overlay.open`:

```json
{
  "title": "Outreach Radar",
  "template": {
    "scope": "public",
    "path": "sites/example.com/overlays/outreach-radar/template.html"
  },
  "data": {
    "scope": "private",
    "path": "sites/example.com/overlays/outreach-radar/data.json"
  }
}
```

The runtime resolves both files from the uploaded storage bundle. The template
receives the parsed JSON through:

```html
<script type="application/json" data-actions-json-overlay-data>...</script>
```

Template JavaScript can read that data and render the view:

```html
<script>
  const data = JSON.parse(
    document.querySelector("[data-actions-json-overlay-data]").textContent
  );
  document.querySelector("h1").textContent = data.title;
</script>
```

Inline overlays are still script-stripped. Storage-backed templates run only in
the controlled template mode inside a sandboxed report frame.

## Download And Upload

When the overlay was opened from a template and data file, **Download** creates a
standalone HTML bundle. The bundle contains:

- the resolved template HTML;
- the resolved data JSON;
- metadata recording the original scopes and paths;
- local bootstrap code so the file can render outside the extension.

When the user uploads that bundle later, the runtime imports both files into the
private scope. This is deliberate: uploaded bundles may contain private data, and
private is the safe default.

## Agent Guidance

Ask your agent to:

- keep reusable layout and CSS in the template;
- keep scan results, counts, names, evidence, and next actions in `data.json`;
- update `data.json` after a fresh scan instead of rewriting the template;
- use a public or shared template only when the template contains no private
  data;
- download the rendered bundle when the user wants a portable copy of the
  current report.

## Example

See `examples/overlay-template-data/linkedin-outreach-radar/` for a minimal
public-template/private-data overlay.
