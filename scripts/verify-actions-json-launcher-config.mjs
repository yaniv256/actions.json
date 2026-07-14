#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('usage: verify-actions-json-launcher-config.mjs --harness codex|claude --stage-dir PATH [--config PATH]');
    }
    values[flag.slice(2)] = value;
  }
  if (!['codex', 'claude'].includes(values.harness) || !values['stage-dir']) {
    throw new Error('usage: verify-actions-json-launcher-config.mjs --harness codex|claude --stage-dir PATH [--config PATH]');
  }
  return values;
}

function decodeTomlString(value, field) {
  const literal = value.trim();
  if (literal.startsWith("'") && literal.endsWith("'")) {
    return literal.slice(1, -1);
  }
  if (literal.startsWith('"') && literal.endsWith('"')) {
    try {
      return JSON.parse(literal);
    } catch {
      // Fall through to the common diagnostic below.
    }
  }
  throw new Error(`invalid ${field} string in Codex actions_json entry`);
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (quote === '"' && character === '\\') {
      escaped = true;
    } else if (quote && character === quote) {
      quote = null;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    } else if (!quote && character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function assignment(table, key) {
  const lines = table.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(stripTomlComment(line)));
  if (start === -1) return null;
  let value = stripTomlComment(lines[start]).replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '');
  if (!value.trimStart().startsWith('[')) return value.trim();

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]);
    const fragment = index === start ? value : line;
    if (index !== start) value += `\n${fragment}`;
    for (const character of fragment) {
      if (escaped) escaped = false;
      else if (quote === '"' && character === '\\') escaped = true;
      else if (quote && character === quote) quote = null;
      else if (!quote && (character === '"' || character === "'")) quote = character;
      else if (!quote && character === '[') depth += 1;
      else if (!quote && character === ']') depth -= 1;
    }
    if (depth === 0) return value.trim();
  }
  throw new Error(`unterminated ${key} array in Codex actions_json entry`);
}

function decodeTomlStringArray(value, field) {
  const body = value.trim().slice(1, -1);
  const values = [];
  let index = 0;
  while (index < body.length) {
    while (/[\s,]/.test(body[index] ?? '')) index += 1;
    if (index >= body.length) break;
    const quote = body[index];
    if (quote !== '"' && quote !== "'") throw new Error(`invalid ${field} array in Codex actions_json entry`);
    const start = index;
    index += 1;
    let escaped = false;
    while (index < body.length) {
      const character = body[index];
      if (escaped) escaped = false;
      else if (quote === '"' && character === '\\') escaped = true;
      else if (character === quote) break;
      index += 1;
    }
    if (index >= body.length) throw new Error(`invalid ${field} array in Codex actions_json entry`);
    values.push(decodeTomlString(body.slice(start, index + 1), field));
    index += 1;
    while (/\s/.test(body[index] ?? '')) index += 1;
    if (index < body.length && body[index] !== ',') throw new Error(`invalid ${field} array in Codex actions_json entry`);
  }
  return values;
}

function parseCodexConfig(source) {
  const heading = source.match(/^\[mcp_servers\.actions_json\]\s*$/m);
  if (!heading) throw new Error('missing [mcp_servers.actions_json] entry');
  const remainder = source.slice(heading.index + heading[0].length);
  const nextHeading = remainder.search(/^\[/m);
  const table = nextHeading === -1 ? remainder : remainder.slice(0, nextHeading);
  const commandLiteral = assignment(table, 'command');
  const argsLiteral = assignment(table, 'args');
  if (!commandLiteral) throw new Error('missing command in [mcp_servers.actions_json]');
  if (!argsLiteral) throw new Error('missing args in [mcp_servers.actions_json]');
  return {
    command: decodeTomlString(commandLiteral, 'command'),
    args: decodeTomlStringArray(argsLiteral, 'args'),
  };
}

function parseClaudeConfig(source) {
  const config = JSON.parse(source);
  const entry = config?.mcpServers?.['actions-json'];
  if (!entry) throw new Error('missing mcpServers.actions-json entry');
  if (typeof entry.command !== 'string') throw new Error('missing command in mcpServers.actions-json');
  if (!Array.isArray(entry.args)) throw new Error('missing args in mcpServers.actions-json');
  return { command: entry.command, args: entry.args };
}

function actionsManifest(args) {
  const index = args.indexOf('--actions');
  if (index === -1 || typeof args[index + 1] !== 'string') {
    throw new Error('launcher args do not contain --actions PATH');
  }
  return args[index + 1];
}

async function exists(target, mode = constants.F_OK) {
  try {
    await access(target, mode);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const harness = options.harness;
  const stageDir = path.resolve(options['stage-dir']);
  const configPath = path.resolve(options.config ?? (harness === 'codex'
    ? path.join(os.homedir(), '.codex', 'config.toml')
    : path.join(os.homedir(), '.claude.json')));
  const expectedCommand = path.join(stageDir, 'actions-json-mcp');
  const expectedManifest = path.join(stageDir, 'overlay.actions.json');
  const errors = [];
  let entry;

  const codexActive = Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_CI);
  const claudeActive = Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);
  const activeHarness = codexActive && !claudeActive ? 'codex' : claudeActive && !codexActive ? 'claude' : null;
  if (activeHarness && harness !== activeHarness) {
    errors.push(`active harness is ${activeHarness}, but --harness selected ${harness}`);
  }

  try {
    const source = await readFile(configPath, 'utf8');
    entry = harness === 'codex' ? parseCodexConfig(source) : parseClaudeConfig(source);
  } catch (error) {
    errors.push(error.message);
  }

  let manifest = null;
  if (entry) {
    try {
      manifest = actionsManifest(entry.args);
    } catch (error) {
      errors.push(error.message);
    }
    if (path.resolve(entry.command) !== expectedCommand) {
      errors.push(`command does not point at the staged package: expected ${expectedCommand}, got ${entry.command}`);
    }
    if (manifest && path.resolve(manifest) !== expectedManifest) {
      errors.push(`--actions does not point at the staged package: expected ${expectedManifest}, got ${manifest}`);
    }
  }

  if (!(await exists(expectedCommand, constants.X_OK))) {
    errors.push(`staged bridge is missing or not executable: ${expectedCommand}`);
  }
  if (!(await exists(expectedManifest, constants.R_OK))) {
    errors.push(`staged actions manifest is missing or unreadable: ${expectedManifest}`);
  } else {
    try {
      const parsed = JSON.parse(await readFile(expectedManifest, 'utf8'));
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        errors.push(`staged actions manifest root must be a JSON object: ${expectedManifest}`);
      }
    } catch {
      errors.push(`staged actions manifest is not valid JSON: ${expectedManifest}`);
    }
  }
  if (await exists(expectedCommand, constants.X_OK)) {
    const probe = spawnSync(expectedCommand, ['--help'], { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) {
      const reason = probe.error?.message ?? `exit ${probe.status}`;
      errors.push(`staged bridge --help probe failed (${reason}): ${expectedCommand}`);
    } else if (!`${probe.stdout}\n${probe.stderr}`.includes('actions.json MCP bridge')) {
      errors.push(`staged bridge --help did not identify itself as actions.json MCP bridge: ${expectedCommand}`);
    }
  }

  const report = {
    ok: errors.length === 0,
    harness,
    active_harness: activeHarness,
    config_path: configPath,
    stage_dir: stageDir,
    command: entry?.command ?? null,
    actions_manifest: manifest,
    errors,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, errors: [error.message] }, null, 2)}\n`);
  process.exitCode = 1;
});
