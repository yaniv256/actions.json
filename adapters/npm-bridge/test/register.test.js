'use strict';

// Unit tests for the `install` registrar. We do NOT invoke real agent CLIs here
// (that would mutate the tester's actual MCP config); instead we test the pure
// pieces: the manual-command strings, the agent table shape, and the launch
// command, plus registerOne's classification against a fake agent whose `bin`
// is a tiny script we control.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AGENTS, SERVER_NAME, registerOne } = require('../lib/register');

test('every agent advertises a manual command that adds the server via its own CLI', () => {
  for (const a of AGENTS) {
    assert.ok(a.manual.includes(`${a.bin} mcp add ${SERVER_NAME}`), `${a.key} manual cmd`);
    assert.ok(a.manual.includes('npx -y @actions-json/bridge mcp'), `${a.key} launch cmd`);
  }
});

test('claude and codex are both supported', () => {
  const keys = AGENTS.map((a) => a.key).sort();
  assert.deepStrictEqual(keys, ['claude', 'codex']);
});

test('registerOne reports absent when the agent CLI is not on PATH', () => {
  const fake = { key: 'nope', label: 'Nope', bin: 'definitely-not-a-real-binary-xyz', addArgs: () => [], manual: 'x' };
  assert.deepStrictEqual(registerOne(fake), { agent: 'Nope', status: 'absent' });
});

test('registerOne classifies a successful add as registered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const bin = path.join(dir, 'fakeagent');
  // A fake agent CLI: `list` prints nothing (not registered), any other cmd exits 0.
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$2" = "list" ]; then exit 0; fi\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const agent = { key: 'fake', label: 'Fake', bin, listArgs: () => ['mcp', 'list'], addArgs: () => ['mcp', 'add'], manual: 'x' };
  assert.deepStrictEqual(registerOne(agent), { agent: 'Fake', status: 'registered' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerOne SKIPS (already) when the server is present in the agent\'s list — never clobbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const bin = path.join(dir, 'fakeagent');
  // `list` reports actions-json present; `add` would FAIL loudly if ever called.
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$2" = "list" ]; then echo "actions-json: ..."; exit 0; fi\necho "ADD SHOULD NOT RUN" >&2; exit 99\n');
  fs.chmodSync(bin, 0o755);
  const agent = { key: 'fake', label: 'Fake', bin, listArgs: () => ['mcp', 'list'], addArgs: () => ['mcp', 'add'], manual: 'x' };
  assert.deepStrictEqual(registerOne(agent), { agent: 'Fake', status: 'already' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerOne classifies an "already exists" error as already, not failed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const bin = path.join(dir, 'fakeagent');
  fs.writeFileSync(bin, '#!/bin/sh\necho "server already exists" >&2\nexit 1\n');
  fs.chmodSync(bin, 0o755);
  const agent = { key: 'fake', label: 'Fake', bin, addArgs: () => [], manual: 'manual-cmd' };
  assert.deepStrictEqual(registerOne(agent), { agent: 'Fake', status: 'already' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerOne surfaces a real failure with the manual command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const bin = path.join(dir, 'fakeagent');
  fs.writeFileSync(bin, '#!/bin/sh\necho "boom: permission denied" >&2\nexit 2\n');
  fs.chmodSync(bin, 0o755);
  const agent = { key: 'fake', label: 'Fake', bin, addArgs: () => [], manual: 'manual-cmd' };
  assert.deepStrictEqual(registerOne(agent), { agent: 'Fake', status: 'failed', detail: 'manual-cmd' });
  fs.rmSync(dir, { recursive: true, force: true });
});
