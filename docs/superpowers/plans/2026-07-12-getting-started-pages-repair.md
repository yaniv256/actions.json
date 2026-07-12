# Getting Started Pages Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the public Getting Started page and address all ten confirmed onboarding defects with executable regression gates.

**Architecture:** Publish a regular Markdown file under `/docs`, retain a regular skill-packaged copy, and enforce byte parity plus structural/content/link contracts in a focused Node test. Verify through the same GitHub Pages Jekyll build surface that failed in production.

**Tech Stack:** Markdown, Node.js test runner, GitHub Pages/Jekyll, GitHub Actions, shell HTTP probes.

---

### Task 1: Encode the failure contract

**Files:**
- Create: `scripts/tests/getting-started-docs.test.mjs`

- [x] Assert both guide paths are regular files rather than symbolic links.
- [x] Assert the two copies are byte-identical.
- [x] Assert all relative Markdown links from the Pages copy resolve inside `docs/`.
- [x] Assert the guide contains exact contracts for prerequisites, credential sources, version checks, checksums, concrete verification, network security, and limitations.
- [x] Run `node --test scripts/tests/getting-started-docs.test.mjs` and capture the expected red failure against the symlink.

### Task 2: Rewrite the canonical onboarding guide

**Files:**
- Replace: `docs/getting-started.md`
- Modify: `skills/write-actions-json/references/getting-started.md`

- [x] Replace the Pages symlink with a regular Markdown file.
- [x] Reframe path selection around hosted-agent use versus map authoring.
- [x] Add the prerequisites and security contracts.
- [x] Correct OpenAI credential hydration instructions.
- [x] Add extension download checksum verification and version inspection.
- [x] Add bridge/runtime verification with expected outputs and ordered diagnostics.
- [x] Move the bookmarklet note into a concise limitations section.
- [x] Copy the reviewed guide byte-for-byte to the skill reference.
- [x] Run the focused test and require all assertions to pass.

### Task 3: Integrate the regression gate

**Files:**
- Modify: `package.json`
- Modify: `scripts/validate-skills.mjs`

- [x] Add `test:getting-started-docs` to package scripts.
- [x] Make validation check the Pages copy as a regular file and enforce parity without widening unrelated canonical-skill discovery.
- [x] Run the focused test and release-script test suite.
- [x] Record the two unrelated release-script baseline failures without misattributing them to this change.

### Task 4: Verify the publishing surface

**Files:**
- Modify: `investigations/getting-started-pages-404.md`

- [x] Run the GitHub Pages Jekyll build container against `./docs`.
- [x] Assert `_site/getting-started.html` exists and contains the expected title.
- [x] Serve `_site` locally and require HTTP 200 from `/getting-started.html`.
- [x] Complete investigation phases 6–10 with experiment, blame, recurrence search, and remediation evidence.

### Task 5: Review and deliver

**Files:**
- Review all changed files.

- [ ] Run `git diff --check`, focused tests, link checks, and Pages build once more.
- [ ] Commit with the investigation reference.
- [ ] Push the branch and open a pull request with the ten-issue checklist and verification evidence.
- [ ] Merge after checks pass.
- [ ] Confirm the Pages workflow succeeds and the production Getting Started URL returns HTTP 200.
