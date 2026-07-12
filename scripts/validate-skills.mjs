import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

const canonicalSkillPath = "skills/write-actions-json/SKILL.md";
const openAiMetadataPath = "skills/write-actions-json/agents/openai.yaml";
const gettingStartedPath = "skills/write-actions-json/references/getting-started.md";
const gettingStartedPagesPath = "docs/getting-started.md";
// Skills under skills/ that are standalone submodules with their own repo and
// validation. They are not this repo's canonical inline authoring skill, so the
// canonical-skill discovery below must ignore them.
const submoduleSkillDirs = ["skills/actions-json-dev-cycle", "skills/incident-investigation"];
const publicDocReferences = [
  "actions-bridge-protocol.md",
  "actions-json-format.md",
  "actions-json-storage.md",
  "bridge-architecture.md",
  "index.md",
  "primitive-dictionary-architecture.md",
  "repo-structure.md",
  "schema-v1-proposal.md",
  "storage-visibility-scopes.md",
];

async function findSkillFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findSkillFiles(path));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(path);
    }
  }
  return results.sort();
}

function parseFrontmatter(path, text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error(`${path}: missing YAML frontmatter`);
  }
  const fields = Object.fromEntries(
    match[1]
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        if (index === -1) {
          throw new Error(`${path}: invalid frontmatter line: ${line}`);
        }
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
  if (fields.name !== "write-actions-json") {
    throw new Error(`${path}: expected name write-actions-json`);
  }
  if (!fields.description?.startsWith("Use when ")) {
    throw new Error(`${path}: description must start with "Use when "`);
  }
}

const skillPaths = (await findSkillFiles("skills")).filter(
  (path) => !submoduleSkillDirs.some((dir) => path.startsWith(`${dir}/`)),
);
if (skillPaths.length !== 1 || skillPaths[0] !== canonicalSkillPath) {
  throw new Error(
    `Expected exactly one inline installable skill at ${canonicalSkillPath}; found ${skillPaths.join(", ")}`,
  );
}

for (const path of skillPaths) {
  const text = await readFile(path, "utf8");
  parseFrontmatter(path, text);
  if (!text.includes("# Write actions.json")) {
    throw new Error(`${path}: missing title`);
  }
}

const core = await readFile(canonicalSkillPath, "utf8");
for (const phrase of [
  "Chrome Extension",
  "Bookmarklet / Embed",
  "Setup Reference",
  "skills/write-actions-json/references/getting-started.md",
  "Documentation Routing",
  "skills/write-actions-json/references/docs/actions-json-format.md",
  "skills/write-actions-json/references/docs/primitive-dictionary-architecture.md",
  "internal-docs",
  "Stable MCP-Shaped Tool Pattern",
  "not a fully conforming MCP server",
  "Use the debugger to learn. Use `actions.json` to operate.",
  "Syncing Private/Dev Work To Public",
  "explicitly approved public promotion",
  "Verification Checklist",
]) {
  if (!core.includes(phrase)) {
    throw new Error(`${canonicalSkillPath}: missing required section or phrase: ${phrase}`);
  }
}

for (const filename of publicDocReferences) {
  const path = `skills/write-actions-json/references/docs/${filename}`;
  const target = await readlink(path);
  const expected = `../../../../docs/${filename}`;
  if (target !== expected) {
    throw new Error(`${path}: expected symlink to ${expected}, found ${target}`);
  }
  if (!core.includes(path)) {
    throw new Error(`${canonicalSkillPath}: missing documentation routing entry for ${path}`);
  }
}

for (const internalTopic of [
  "private-public-sync.md",
  "open-browser-use-primitive-inventory.md",
  "overlay-runtime-prototype.md",
]) {
  if (core.includes(`docs/${internalTopic}`) || core.includes(`skills/write-actions-json/references/docs/${internalTopic}`)) {
    throw new Error(`${canonicalSkillPath}: should not route public skill users to ${internalTopic}`);
  }
}

const gettingStarted = await readFile(gettingStartedPath, "utf8");
const gettingStartedPagesStat = await lstat(gettingStartedPagesPath);
if (!gettingStartedPagesStat.isFile() || gettingStartedPagesStat.isSymbolicLink()) {
  throw new Error(`${gettingStartedPagesPath}: expected a regular GitHub Pages source file`);
}
const gettingStartedPages = await readFile(gettingStartedPagesPath, "utf8");
if (gettingStartedPages !== gettingStarted) {
  throw new Error(`${gettingStartedPagesPath}: must be byte-identical to ${gettingStartedPath}`);
}
for (const phrase of [
  "# Getting Started",
  "Prerequisites",
  "Path A: Use The Hosted Browser Agent",
  "Path B: Connect An External Coding Agent",
  "Install And Verify The Chrome Extension",
  "Verify the complete bridge path",
  "Current Limitations",
  "127.0.0.1:17345",
  "SHA256SUMS.txt",
]) {
  if (!gettingStarted.includes(phrase)) {
    throw new Error(`${gettingStartedPath}: missing required section or phrase: ${phrase}`);
  }
}

const openAiMetadata = await readFile(openAiMetadataPath, "utf8");
for (const phrase of [
  "write-actions-json",
  "skills/write-actions-json/SKILL.md",
]) {
  if (!openAiMetadata.includes(phrase)) {
    throw new Error(`${openAiMetadataPath}: missing required phrase: ${phrase}`);
  }
}

console.log(`Validated canonical skill at ${canonicalSkillPath}.`);
