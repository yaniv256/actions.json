import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertDescendantsShareProcessGroup,
  assertProcessGroupSupport,
  exitCodeForAbortReason,
  runWithInheritedProcessGroup,
  superviseLiveSmoke,
} from './live/support/live-smoke-supervisor.mjs';

const require = createRequire(import.meta.url);
const childProcessModule = require('node:child_process');

const processExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const waitForFile = async (file, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
};

test('unsupported platforms fail before spawning an unowned worker', () => {
  assert.throws(
    () => assertProcessGroupSupport('win32'),
    /requires POSIX process-group ownership/,
  );
});

test('signal abort reasons retain conventional shell exit status', () => {
  assert.equal(exitCodeForAbortReason('SIGINT'), 130);
  assert.equal(exitCodeForAbortReason('SIGTERM'), 143);
});

test('the launch wrapper keeps a requested detached child in the worker group', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }
  let child;
  try {
    child = await runWithInheritedProcessGroup(() => childProcessModule.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', detached: true },
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ownership = assertDescendantsShareProcessGroup(process.pid);
    assert.ok(ownership.descendantCount >= 1);
  } finally {
    child?.kill('SIGKILL');
  }
});

test('deadline kills the full run-owned process group and reports the last phase', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-supervisor-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'hang-child.mjs');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(fixture, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    grandchild.unref();
    fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
    fs.writeFileSync(process.env.ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE, 'fixture:hang');
    setInterval(() => {}, 1000);
  `);

  const startedAt = Date.now();
  const result = await superviseLiveSmoke({
    scriptPath: fixture,
    timeoutMs: 300,
    killGraceMs: 100,
    stdio: 'ignore',
    env: { GRANDCHILD_PID_FILE: grandchildPidFile },
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.lastPhase, 'fixture:hang');
  assert.ok(Date.now() - startedAt < 2000, 'supervisor must return within a bounded interval');

  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
  assert.ok(Number.isInteger(grandchildPid));
  assert.equal(processExists(grandchildPid), false, `grandchild ${grandchildPid} survived`);
  assert.equal(processExists(result.childPid), false, `worker ${result.childPid} survived`);
});

test('a worker SIGKILL still triggers residual process-group cleanup', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-supervisor-kill-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'killed-child.mjs');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(fixture, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
    fs.writeFileSync(process.env.ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE, 'fixture:await-sigkill');
    setInterval(() => {}, 1000);
  `);

  let workerPid;
  const result = await superviseLiveSmoke({
    scriptPath: fixture,
    timeoutMs: 5000,
    killGraceMs: 100,
    stdio: 'ignore',
    env: { GRANDCHILD_PID_FILE: grandchildPidFile },
    onSpawn: (pid) => {
      workerPid = pid;
      setTimeout(() => process.kill(pid, 'SIGKILL'), 150);
    },
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.childPid, workerPid);
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
  assert.equal(processExists(grandchildPid), false, `grandchild ${grandchildPid} survived worker SIGKILL`);
});

test('a normally exiting worker cannot leave a run-owned descendant behind', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-supervisor-exit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'exited-child.mjs');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(fixture, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    grandchild.unref();
    fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
    fs.writeFileSync(process.env.ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE, 'fixture:normal-exit');
  `);

  const result = await superviseLiveSmoke({
    scriptPath: fixture,
    timeoutMs: 5000,
    killGraceMs: 100,
    stdio: 'ignore',
    env: { GRANDCHILD_PID_FILE: grandchildPidFile },
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.lastPhase, 'fixture:normal-exit');
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
  assert.equal(processExists(grandchildPid), false, `grandchild ${grandchildPid} survived normal worker exit`);
});

test('abort tears down the full process group before returning', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-supervisor-abort-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'aborted-child.mjs');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(fixture, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
    fs.writeFileSync(process.env.ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE, 'fixture:await-abort');
    setInterval(() => {}, 1000);
  `);

  const abortController = new AbortController();
  const result = await superviseLiveSmoke({
    scriptPath: fixture,
    timeoutMs: 5000,
    killGraceMs: 100,
    stdio: 'ignore',
    env: { GRANDCHILD_PID_FILE: grandchildPidFile },
    signal: abortController.signal,
    onSpawn: () => setTimeout(() => abortController.abort('SIGTERM'), 150),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, 'SIGTERM');
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
  assert.equal(processExists(grandchildPid), false, `grandchild ${grandchildPid} survived abort`);
});

test('a throwing spawn hook cannot leak the worker', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-supervisor-hook-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'hook-child.mjs');
  fs.writeFileSync(fixture, 'setInterval(() => {}, 1000);');
  let workerPid;
  await assert.rejects(
    superviseLiveSmoke({
      scriptPath: fixture,
      timeoutMs: 5000,
      killGraceMs: 100,
      stdio: 'ignore',
      onSpawn: (pid) => {
        workerPid = pid;
        throw new Error('spawn hook failed');
      },
    }),
    /spawn hook failed/,
  );
  assert.equal(processExists(workerPid), false, `worker ${workerPid} survived spawn-hook failure`);
});

test('the production SIGTERM handler exits 143 and reaps an owned descendant', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group contract is tested on Linux and macOS');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-smoke-supervisor-signal-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'signal-child.mjs');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(fixture, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));
    fs.writeFileSync(process.env.ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE, 'fixture:await-signal');
    setInterval(() => {}, 1000);
  `);

  const entrypoint = path.resolve('extensions/chrome-overlay-runtime/tests/live/a11y-live-smoke.mjs');
  const supervisor = spawn(process.execPath, [entrypoint], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      ACTIONS_JSON_LIVE_SMOKE_CHILD: '',
      ACTIONS_JSON_A11Y_SMOKE_WORKER_SCRIPT: fixture,
      GRANDCHILD_PID_FILE: grandchildPidFile,
    },
    stdio: 'ignore',
  });
  await waitForFile(grandchildPidFile);
  await new Promise((resolve) => setTimeout(resolve, 100));
  supervisor.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    supervisor.once('error', reject);
    supervisor.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 143, signal: null });
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
  assert.equal(processExists(grandchildPid), false, `grandchild ${grandchildPid} survived SIGTERM`);
});
