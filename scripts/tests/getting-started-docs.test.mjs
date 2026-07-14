import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const pagesPath = path.join(root, "docs/getting-started.md");
const skillPath = path.join(root, "skills/write-actions-json/references/getting-started.md");

test("Getting Started is a regular Pages file and an identical regular skill reference", async () => {
  const [pagesStat, skillStat, pages, skill] = await Promise.all([
    lstat(pagesPath),
    lstat(skillPath),
    readFile(pagesPath, "utf8"),
    readFile(skillPath, "utf8"),
  ]);
  assert.equal(pagesStat.isSymbolicLink(), false, "GitHub Pages source must not be a symlink");
  assert.equal(pagesStat.isFile(), true);
  assert.equal(skillStat.isSymbolicLink(), false, "packaged skill reference must not be a symlink");
  assert.equal(skillStat.isFile(), true);
  assert.equal(pages, skill, "Pages and skill copies must stay byte-identical");
});

test("Getting Started addresses the ten onboarding contracts", async () => {
  const text = await readFile(skillPath, "utf8");
  const required = [
    "## Prerequisites",
    "Google Chrome",
    "Node.js 18",
    "OpenAI API",
    "ACTIONS_JSON_OPENAI_API_KEY",
    ".actions-json.local.json",
    "SHA256SUMS.txt",
    "sha256sum",
    "extension version",
    "bridge version",
    "actions-json://bridge/launch",
    "actions-json://bridge/runtimes",
    "Expected result",
    "0.0.0.0",
    "public internet",
    "## Current Limitations",
  ];
  for (const phrase of required) {
    assert.ok(text.toLowerCase().includes(phrase.toLowerCase()), `missing onboarding contract: ${phrase}`);
  }
  assert.doesNotMatch(text, /## Bookmarklet \(Not Yet Available\)/);
  assert.doesNotMatch(text, /\*\*TODO:\*\*/);
});

test("Getting Started puts successful activation before optional verification", async () => {
  const text = await readFile(skillPath, "utf8");
  const install = text.indexOf("## Fastest Path: Connect The Bridge And Start Voice");
  const success = text.indexOf("**Success:**");
  const optionalVerification = text.indexOf("### Optional: Verify The Download");

  assert.ok(install >= 0, "missing combined activation path");
  assert.ok(success > install, "activation path must define success");
  assert.ok(optionalVerification > success, "optional checksum verification must follow the success path");
  assert.match(text, /Download `actions-json-overlay-runtime-<version>\.zip`/);
  assert.match(text, /Do not download an `actions-json-mcp-\*\.tar\.gz` file/);
});

test("every relative Markdown link in Getting Started resolves inside docs", async () => {
  const text = await readFile(pagesPath, "utf8");
  const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const href of links) {
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const pathname = href.split("#", 1)[0];
    if (!pathname) continue;
    const resolved = path.resolve(path.dirname(pagesPath), pathname);
    assert.ok(
      resolved.startsWith(`${path.join(root, "docs")}${path.sep}`),
      `relative link escapes the Pages source: ${href}`,
    );
    const stat = await lstat(resolved).catch(() => null);
    assert.ok(stat?.isFile(), `relative link target does not exist: ${href}`);
  }
});
