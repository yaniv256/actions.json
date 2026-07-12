# Getting Started Pages Repair Design

## Goal

Restore the public Getting Started URL and turn the guide into a reliable, security-conscious path from zero setup to a verified connected tab.

## Architecture

Keep two regular-file copies of the guide: the Pages-owned copy at `docs/getting-started.md` and the skill-packaged copy at `skills/write-actions-json/references/getting-started.md`. A focused Node test requires both to be regular files, byte-identical, internally linkable, and free of the ten confirmed content defects. This deliberately favors robust Pages, archive, npm, and Windows behavior over a cross-tree symlink or a generation-only build artifact.

## Ten issues and required corrections

1. Replace the broken source-escaping Pages symlink with a regular file.
2. Add a focused pre-deploy documentation test that catches Pages-source symlinks and missing rendered inputs.
3. Enforce byte-for-byte parity between the Pages and skill copies.
4. Add an explicit prerequisites section covering Chrome, Node/npm, a supported MCP client, and OpenAI API access/billing.
5. Correct credential hydration: document `ACTIONS_JSON_OPENAI_API_KEY` and `.actions-json.local.json`; do not imply the bridge discovers an arbitrary coding-agent key.
6. Add extension/bridge version inspection and compatibility guidance, acknowledging that release and npm versions can differ.
7. Add SHA-256 verification for the downloaded extension using the release `SHA256SUMS.txt`.
8. Replace abstract verification with concrete bridge health, runtime inventory, and expected-result checks plus a diagnostic order.
9. Add a prominent security warning for `0.0.0.0`, reachable bridge addresses, firewall/VPN restriction, and the absence of a public-Internet deployment recommendation.
10. Remove the duplicate bookmarklet headings and visible TODO from the success path; move the unavailable path into a concise limitations section.

## Verification

- Focused Node tests begin red against the current symlink and stale content, then pass after the rewrite.
- `scripts/validate-skills.mjs` is run and its pre-existing unrelated canonical-skill-count failure is recorded separately.
- The GitHub Pages Jekyll build runs against the repaired worktree and must generate `_site/getting-started.html`.
- A local HTTP probe of the built site must return 200 for `/getting-started.html` and contain the expected title and verification sections.
- After merge/deployment, the public URL must return 200 and the Pages workflow must be green.

## Delivery

Commit the investigation, content, tests, and verification evidence on an isolated branch. Open a pull request to `yaniv256/actions.json`, merge only after checks pass, then verify the production URL independently.
