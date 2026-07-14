import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const checker = path.join(repoRoot, 'scripts', 'verify-actions-json-launcher-config.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'actions-json-launcher-config-'));
  const stage = path.join(root, 'stage');
  await mkdir(stage);
  const command = path.join(stage, 'actions-json-mcp');
  const manifest = path.join(stage, 'overlay.actions.json');
  await writeFile(command, '#!/bin/sh\necho "actions.json MCP bridge for browser runtimes"\nexit 0\n');
  await chmod(command, 0o755);
  await writeFile(manifest, '{}\n');
  return { root, stage, command, manifest };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('validates the Codex actions_json launcher entry against the staged package', async () => {
  const { root, stage, command, manifest } = await fixture();
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = "${command}"`,
    `args = ["mcp", "--actions", "${manifest}"]`,
    '',
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.harness, 'codex');
  assert.equal(report.config_path, config);
  assert.equal(report.command, command);
  assert.equal(report.actions_manifest, manifest);
});

test('fails loudly when Codex still points at a stale staged directory', async () => {
  const { root, stage } = await fixture();
  const stale = path.join(root, 'old-stage');
  await mkdir(stale);
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = "${path.join(stale, 'actions-json-mcp')}"`,
    `args = ["mcp", "--actions", "${path.join(stale, 'overlay.actions.json')}"]`,
    '',
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /command.*staged package/i);
  assert.match(report.errors.join('\n'), /--actions.*staged package/i);
});

test('validates the Claude actions-json launcher entry against the staged package', async () => {
  const { root, stage, command, manifest } = await fixture();
  const config = path.join(root, 'claude.json');
  await writeFile(config, JSON.stringify({
    mcpServers: {
      'actions-json': {
        command,
        args: ['mcp', '--actions', manifest],
      },
    },
  }));

  const result = run(['--harness', 'claude', '--stage-dir', stage, '--config', config], {
    CODEX_CI: '',
    CODEX_THREAD_ID: '',
    CLAUDECODE: '1',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.harness, 'claude');
  assert.equal(report.command, command);
  assert.equal(report.actions_manifest, manifest);
});

test('rejects selecting Claude from an active Codex session', async () => {
  const { root, stage, command, manifest } = await fixture();
  const config = path.join(root, 'claude.json');
  await writeFile(config, JSON.stringify({
    mcpServers: { 'actions-json': { command, args: ['mcp', '--actions', manifest] } },
  }));

  const result = run(['--harness', 'claude', '--stage-dir', stage, '--config', config], {
    CODEX_THREAD_ID: 'codex-session',
    CLAUDECODE: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /active harness.*codex/i);
});

test('rejects a malformed staged actions manifest', async () => {
  const { root, stage, command, manifest } = await fixture();
  await writeFile(manifest, '{not json}\n');
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = "${command}"`,
    `args = ["mcp", "--actions", "${manifest}"]`,
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /manifest.*valid json/i);
});

test('rejects a staged manifest whose root is not an object', async () => {
  const { root, stage, command, manifest } = await fixture();
  await writeFile(manifest, '[]\n');
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = "${command}"`,
    `args = ["mcp", "--actions", "${manifest}"]`,
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /manifest.*json object/i);
});

test('rejects an executable file that is not a working bridge binary', async () => {
  const { root, stage, command, manifest } = await fixture();
  await writeFile(command, '#!/bin/sh\nexit 7\n');
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = "${command}"`,
    `args = ["mcp", "--actions", "${manifest}"]`,
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /bridge.*--help.*failed/i);
});

test('rejects an unrelated executable that returns success for --help', async () => {
  const { root, stage, command, manifest } = await fixture();
  await writeFile(command, '#!/bin/sh\nexit 0\n');
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = "${command}"`,
    `args = ["mcp", "--actions", "${manifest}"]`,
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /did not identify itself/i);
});

test('accepts valid multiline TOML arrays and literal strings', async () => {
  const { root, stage, command, manifest } = await fixture();
  const config = path.join(root, 'config.toml');
  await writeFile(config, [
    '[mcp_servers.actions_json]',
    `command = '${command}'`,
    'args = [',
    "  'mcp', # transport",
    "  '--actions',",
    `  '${manifest}',`,
    ']',
  ].join('\n'));

  const result = run(['--harness', 'codex', '--stage-dir', stage, '--config', config]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('the dev-cycle skill requires harness-aware launcher discovery before restart', async () => {
  const skill = await readFile(path.join(repoRoot, 'skills', 'actions-json-dev-cycle', 'SKILL.md'), 'utf8');

  assert.match(skill, /active MCP launcher config/i);
  assert.match(skill, /\.codex\/config\.toml/);
  assert.match(skill, /\.claude\.json/);
  assert.match(skill, /verify-actions-json-launcher-config\.mjs/);
  assert.match(skill, /before asking.*restart/is);
});

test('the development-cycle reference carries the same harness-aware pre-restart gate', async () => {
  const reference = await readFile(path.join(repoRoot, 'docs', 'development-cycle.md'), 'utf8');

  assert.match(reference, /active MCP launcher config/i);
  assert.match(reference, /\.codex\/config\.toml/);
  assert.match(reference, /\.claude\.json/);
  assert.match(reference, /verify-actions-json-launcher-config\.mjs/);
});

test('the actions.json authoring skill does not present Claude config as universal', async () => {
  const authoringSkill = await readFile(path.join(repoRoot, 'skills', 'write-actions-json', 'SKILL.md'), 'utf8');

  assert.match(authoringSkill, /active MCP launcher config/i);
  assert.match(authoringSkill, /\.codex\/config\.toml/);
  assert.match(authoringSkill, /\.claude\.json/);
});
