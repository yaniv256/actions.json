#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const forbiddenPaths = [
  /^CLAUDE\.md$/,
  /^investigations\//,
  /^docs\/(?:plans|brainstorms|design|verification)\//,
  /^docs\/solutions\//,
  /^docs\/superpowers\/(?:plans|specs)\//,
  /^docs\/development-cycle\.md$/,
  /^docs\/architecture\/empowered-website-agents-state-inventory\.md$/,
  /^docs\/reliability\/instrument-bounds\.md$/,
  /^docs\/release-notes\//,
  /^plans\//,
  /^scratchpad\//,
  /^extensions\/chrome-overlay-runtime\/prototypes\//,
  /^tests\/live\/eval\/runs\//,
];

const forbiddenContent = [
  { label: "agent home path", pattern: /\/home\/agent-[A-Za-z0-9_-]+/ },
  { label: "private development repository URL", pattern: /github\.com\/ActionsJson\/actions\.json\.dev/ },
  { label: "internal record path", pattern: /(?:^|[(`/])(?:investigations|docs\/plans)\//m },
  { label: "real Trello card URL", pattern: /trello\.com\/c\/(?!example\b)[A-Za-z0-9]{6,}/ },
  {
    label: "private participant name",
    pattern: new RegExp(`\\b(?:${[
      "Greg" + " Benz",
      "To" + "mas",
      "El" + "ena",
      "Da" + "kota",
      "Za" + "ra",
    ].join("|")})\\b`),
  },
  { label: "GitHub token", pattern: /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/ },
  {
    label: "OpenAI secret key",
    pattern: /(?:sk-proj-(?!(?:test|session|agent|background|actions-json|secret|abcdefghijklmnopqrstuvwxyz))[A-Za-z0-9_-]{20,}|sk-(?!(?:test|env|local|home))(?=[A-Za-z0-9]{40,}\b)[A-Za-z0-9]+)/,
  },
  { label: "private network address", pattern: /\b(?:10|192\.168)\.(?:\d{1,3}\.){2}\d{1,3}\b/ },
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const failures = [];

for (const file of files) {
  for (const pattern of forbiddenPaths) {
    if (pattern.test(file)) failures.push(`${file}: forbidden private path`);
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;

  for (const { label, pattern } of forbiddenContent) {
    if (pattern.test(content)) failures.push(`${file}: ${label}`);
  }
}

if (failures.length) {
  console.error("Public-boundary audit failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Public-boundary audit passed (${files.length} tracked paths).`);
