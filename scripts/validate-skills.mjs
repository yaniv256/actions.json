import { readFile } from "node:fs/promises";

const skillPaths = [
  "skills/core/SKILL.md",
  "skills/codex/SKILL.md",
  "skills/claude-code/SKILL.md",
  "skills/openclaw/SKILL.md",
  "skills/pi/SKILL.md",
];

const wrapperPaths = skillPaths.filter((path) => path !== "skills/core/SKILL.md");

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

for (const path of skillPaths) {
  const text = await readFile(path, "utf8");
  parseFrontmatter(path, text);
  if (!text.includes("# Write actions.json")) {
    throw new Error(`${path}: missing title`);
  }
}

for (const path of wrapperPaths) {
  const text = await readFile(path, "utf8");
  if (!text.includes("Follow the portable core skill at `../core/SKILL.md`.")) {
    throw new Error(`${path}: wrapper must reference the core skill`);
  }
}

const core = await readFile("skills/core/SKILL.md", "utf8");
for (const phrase of [
  "Chrome Extension",
  "Bookmarklet / Embed",
  "Stable MCP Tool Pattern",
  "Use the debugger to learn. Use `actions.json` to operate.",
  "Syncing Private/Dev Work To Public",
  "Verification Checklist",
]) {
  if (!core.includes(phrase)) {
    throw new Error(`skills/core/SKILL.md: missing required section or phrase: ${phrase}`);
  }
}

console.log(`Validated ${skillPaths.length} skill files.`);
