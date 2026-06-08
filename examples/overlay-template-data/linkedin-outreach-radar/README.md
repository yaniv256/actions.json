# LinkedIn Outreach Radar Example

This example shows the template/data overlay pattern:

- `scopes/public/sites/linkedin.com/overlays/outreach-radar/template.html`
  contains reusable layout, CSS, and rendering code.
- `scopes/private/sites/linkedin.com/overlays/outreach-radar/data.json`
  contains private outreach data.

Open it with:

```json
{
  "title": "LinkedIn Outreach Radar",
  "template": {
    "scope": "public",
    "path": "sites/linkedin.com/overlays/outreach-radar/template.html"
  },
  "data": {
    "scope": "private",
    "path": "sites/linkedin.com/overlays/outreach-radar/data.json"
  }
}
```

The hosted agent can refresh this overlay by updating only `data.json`.
