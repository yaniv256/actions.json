'use strict';

// `npx @actions-json/bridge install` — register the actions-json MCP server with
// whatever coding agents are present, by calling each agent's own `mcp add`
// command. This removes the manual "copy the right claude/codex command" step
// from the install: we detect the agent, run its registrar, and report.
//
// Design: we shell out to each agent's OWN CLI (`claude mcp add …`,
// `codex mcp add …`) rather than hand-editing their config files, so the agent
// stays the source of truth for its own config format. Idempotent-ish: agents
// treat re-adding an existing server as an error, which we catch and report as
// "already registered" rather than failing the whole run.

const { execFileSync, execSync } = require('node:child_process');

// The canonical launch command every agent should register.
const SERVER_NAME = 'actions-json';
const LAUNCH = ['npx', '-y', '@actions-json/bridge', 'mcp'];

// Each supported agent: how to detect its CLI, and how to register a stdio MCP
// server with it. `addArgs` produces the argv for a spawn of `bin`.
const AGENTS = [
  {
    key: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    listArgs: () => ['mcp', 'list'],
    addArgs: () => ['mcp', 'add', SERVER_NAME, '--', ...LAUNCH],
    manual: `claude mcp add ${SERVER_NAME} -- ${LAUNCH.join(' ')}`,
  },
  {
    key: 'codex',
    label: 'Codex',
    bin: 'codex',
    listArgs: () => ['mcp', 'list'],
    addArgs: () => ['mcp', 'add', SERVER_NAME, '--', ...LAUNCH],
    manual: `codex mcp add ${SERVER_NAME} -- ${LAUNCH.join(' ')}`,
  },
];

// Is a CLI on PATH? Cross-platform: `command -v` on posix, `where` on win32.
function onPath(bin) {
  try {
    if (process.platform === 'win32') {
      execSync(`where ${bin}`, { stdio: 'ignore' });
    } else {
      execSync(`command -v ${bin}`, { stdio: 'ignore', shell: '/bin/sh' });
    }
    return true;
  } catch (_e) {
    return false;
  }
}

// Is the actions-json server ALREADY registered with this agent? We check first
// and never overwrite an existing config — a re-run must be a no-op, not a
// clobber (an install should only touch config when there's a reason to).
function alreadyRegistered(agent) {
  if (!agent.listArgs) return false;
  try {
    const out = execFileSync(agent.bin, agent.listArgs(), { stdio: 'pipe' }).toString();
    return out.includes(SERVER_NAME);
  } catch (_e) {
    // If listing fails we can't confirm; fall through to the add path, which
    // still catches an "already exists" error rather than overwriting.
    return false;
  }
}

// Register with one agent. Returns { agent, status, detail }.
function registerOne(agent) {
  if (!onPath(agent.bin)) {
    return { agent: agent.label, status: 'absent' };
  }
  // Never replace an existing registration — skip if it's already there.
  if (alreadyRegistered(agent)) {
    return { agent: agent.label, status: 'already' };
  }
  try {
    execFileSync(agent.bin, agent.addArgs(), { stdio: 'pipe' });
    return { agent: agent.label, status: 'registered' };
  } catch (e) {
    // Belt-and-suspenders: if the add still reports the name exists (race, or an
    // agent we couldn't list), treat as already — do NOT clobber. Anything else
    // is a real failure we surface with the manual command.
    const out = `${e.stdout || ''}${e.stderr || ''}`.toLowerCase();
    if (out.includes('already') || out.includes('exist')) {
      return { agent: agent.label, status: 'already' };
    }
    return { agent: agent.label, status: 'failed', detail: agent.manual };
  }
}

// Detect + register across all known agents; print a human summary. Returns an
// exit code (0 if at least one agent got the server, 1 if none did).
function install() {
  const results = AGENTS.map(registerOne);
  const present = results.filter((r) => r.status !== 'absent');

  process.stdout.write('\nactions.json — MCP registration\n');
  for (const r of results) {
    if (r.status === 'absent') continue;
    const mark =
      r.status === 'registered' ? '✓ registered' :
      r.status === 'already' ? '✓ already registered' :
      '✗ failed';
    process.stdout.write(`  ${mark}: ${r.agent}\n`);
    if (r.status === 'failed') {
      process.stdout.write(`      run manually: ${r.detail}\n`);
    }
  }

  if (present.length === 0) {
    process.stdout.write(
      '  No supported coding agent (Claude Code or Codex) found on PATH.\n' +
        '  Install one, then re-run `npx @actions-json/bridge install`, or add it manually:\n'
    );
    for (const a of AGENTS) {
      process.stdout.write(`      ${a.manual}\n`);
    }
  } else {
    const ok = present.some((r) => r.status === 'registered' || r.status === 'already');
    if (ok) {
      process.stdout.write(
        '\nDone. Restart (or reconnect) your agent so it launches the server, then\n' +
          'install the browser extension and connect it. See:\n' +
          '  https://yaniv256.github.io/actions.json/getting-started.html\n'
      );
    }
  }
  process.stdout.write('\n');

  return present.length > 0 &&
    present.some((r) => r.status === 'registered' || r.status === 'already')
    ? 0
    : 1;
}

module.exports = { install, AGENTS, SERVER_NAME, onPath, registerOne };
