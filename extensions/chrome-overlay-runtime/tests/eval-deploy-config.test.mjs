// U1/U2 — deploy config + cleanup targeting unit tests. Covers R3 (dedicated eval
// user-data-dir as the cleanup boundary) and R3's guard that cleanup never targets the
// operator's real profile. Pure — no processes, no browser.
import { test } from 'node:test';
import assert from 'node:assert';
import { deployConfig, evalChromeKillCommand } from '../tools/deploy/deploy.mjs';

test('deployConfig exposes an eval-scoped user-data-dir distinct from the operator profile', () => {
  const cfg = deployConfig({ userDataDir: 'C:\\temp\\chrome-debug', evalUserDataDir: 'C:\\temp\\chrome-eval' });
  assert.equal(cfg.evalUserDataDir, 'C:\\temp\\chrome-eval');
  assert.notEqual(cfg.evalUserDataDir, cfg.userDataDir, 'eval dir must differ from the operator profile');
});

test('evalUserDataDir falls back to a distinct default when unset (never the operator dir)', () => {
  const cfg = deployConfig({ userDataDir: 'C:\\temp\\chrome-debug' });
  assert.ok(cfg.evalUserDataDir, 'a default eval dir must exist');
  assert.notEqual(cfg.evalUserDataDir, cfg.userDataDir, 'default eval dir must not equal the operator profile');
});

test('the Chrome-kill command targets ONLY the eval user-data-dir (never a bare all-chrome kill)', () => {
  const dir = 'C:\\temp\\chrome-eval-xyz';
  const cmd = evalChromeKillCommand(dir);
  // The marker (the eval dir) must appear in the command...
  assert.ok(cmd.includes('chrome-eval-xyz'), `kill command must reference the eval dir: ${cmd}`);
  // ...and it must NOT be an unscoped kill of every chrome process.
  assert.ok(!/Stop-Process\s+-Name\s+chrome\b/i.test(cmd), `kill must be marker-scoped, not name-wide: ${cmd}`);
  assert.ok(!/taskkill\s+\/IM\s+chrome\.exe/i.test(cmd), `kill must be marker-scoped, not /IM chrome.exe: ${cmd}`);
});

test('evalChromeKillCommand refuses an empty/whitespace marker (never kill unscoped)', () => {
  assert.throws(() => evalChromeKillCommand(''), /marker|user-data-dir|required/i);
  assert.throws(() => evalChromeKillCommand('   '), /marker|user-data-dir|required/i);
});
