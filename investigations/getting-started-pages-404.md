# Getting Started GitHub Pages 404 Investigation

## Phase 1 — Symptom and impact

- **Symptom:** `https://yaniv256.github.io/actions.json/getting-started.html` returns GitHub Pages HTTP 404.
- **Impact:** a prospective user cannot follow the primary onboarding link. GitHub Pages is serving a stale July 4 build because every deployment since July 8 has failed.
- **Severity:** High for acquisition/onboarding; the rest of the previously deployed documentation remains available.

### Established timeline

| Time (UTC) | Event | Confidence | Source |
|---|---|---:|---|
| 2026-07-04 21:17 | Last successful Pages deployment | High | GitHub Actions run 28719921431 |
| 2026-07-08 16:53 | Public sync reorganized the authoring skill and added the current symlink | High | Commit 74927fe78bbc and Git tree |
| 2026-07-08 17:43 | First observed failed Pages deployment in the current failure series | High | GitHub Actions run 28963471087 |
| 2026-07-11 13:10 | Fifth consecutive deployment failed | High | GitHub Actions run 29153854999 |
| 2026-07-12 17:45 | User reported the 404; direct probe reproduced HTTP 404 | High | User report and `curl` response headers |

## Phase 1.5 — Generative prior

Most first-pass hypotheses are expected to be wrong, and the true cause may not be listed. Passive evidence is not enough by itself: the repair must be exercised through the same Jekyll/GitHub Pages build path that failed.

## Phase 2 — Initial hypotheses

| # | Hypothesis | Category | Initial P |
|---|---|---|---:|
| H1 | GitHub Pages is configured for a different branch or source directory | Configuration | 15% |
| H2 | The requested `.html` permalink does not match Jekyll output | Routing | 10% |
| H3 | `docs/getting-started.md` is missing or unreadable in the deployed revision | Repository layout | 25% |
| H4 | Jekyll rejects a symlink that escapes the configured `/docs` source | Build/platform | 25% |
| H5 | CDN caching is retaining a deleted page | Delivery/cache | 5% |
| H6 | The true cause is not yet listed | Unknown | 20% |

Maximum-pain choice: test H3/H4 first because the public-sync layout is our own recent change and accepting it implicates our release process rather than GitHub infrastructure.

## Phase 3 — Evidence

1. **E1:** The failing URL returns HTTP 404 while the site root returns HTTP 200 with `Last-Modified: Sat, 04 Jul 2026`.
2. **E2:** Pages configuration is legacy build from `main:/docs`; this refutes H1.
3. **E3:** `docs/getting-started.md` is Git mode `120000` and targets `../skills/references/getting-started.md`.
4. **E4:** That target no longer exists. The real source moved to `skills/write-actions-json/references/getting-started.md`.
5. **E5:** The latest Pages log fails in Jekyll `entry_filter.rb` with `Errno::ENOENT` while resolving `/github/workspace/docs/getting-started.md`.
6. **E6:** Five consecutive Pages workflows failed after the reorganization; the July 4 deployment is the last successful one.
7. **E7:** GitHub Pages documentation defines the publishing source as a branch plus root or `/docs`; files must be present in that source tree at build time.

## Phase 4 — Revised hypotheses

H4 is confirmed at 99% and subsumes H3: the stale, source-escaping symlink is both unreadable and rejected by the Pages build. H1, H2, H5, and H6 fall below 1% given the exact build exception.

## Phase 5 — Experiments

### X1: Reproduce the deployed revision

- **Prediction if H4 is true:** the GitHub Pages Jekyll container fails while resolving `docs/getting-started.md`.
- **Prediction if false:** the build succeeds and the 404 must arise after build.
- **Observed:** GitHub Actions already provides the controlled reproduction; run 29153854999 failed exactly at symlink resolution.

### X2: Build the repaired tree

- **Prediction if H4 is true:** replacing the symlink with a regular Markdown file makes the same Pages build complete and produce `_site/getting-started.html`.
- **Status:** pending implementation.

## Phase 6 — Final hypothesis

Pending X2. Root-cause confidence is 99%; the experiment will prove the proposed repair rather than merely restating the log.

## Phase 7 — Blame

### Level 1: lines and artifacts

| Severity | Location | Problem |
|---|---|---|
| Critical | `docs/getting-started.md` | Source-escaping symlink points to a deleted pre-reorganization path. |
| High | `scripts/validate-skills.mjs` | Validates only the skill copy and has no Pages-source regular-file/parity invariant. |

### Level 2: anti-pattern

The public sync created a convenience symlink across independently packaged/published surfaces. The link encoded repository layout as runtime build behavior and had no consumer-side validation.

### Level 3: process deficiency

Release verification checked repository content and extension packaging but did not gate promotion on a Pages build or the existence of the rendered onboarding route. A self-reported successful public sync was treated as delivery proof.

## Phases 8–10

The immediate repair, recurrence search, verification results, and remediation plan will be filled with executed evidence before this investigation is closed.
