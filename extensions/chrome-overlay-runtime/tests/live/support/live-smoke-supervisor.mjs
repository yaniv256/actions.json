import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const delay = (ms, { unref = true } = {}) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (unref) timer.unref?.();
});

const readLastPhase = (progressFile) => {
  try {
    return fs.readFileSync(progressFile, 'utf8').trim() || 'not-reported';
  } catch (_error) {
    return 'not-reported';
  }
};

const require = createRequire(import.meta.url);
const childProcessModule = require('node:child_process');

export const assertProcessGroupSupport = (platform = process.platform) => {
  if (platform === 'win32') {
    throw new Error('live-smoke supervision requires POSIX process-group ownership');
  }
};

const processTable = () => {
  const result = spawnSync('ps', ['-e', '-o', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('unable to inspect process-group ownership');
  return result.stdout.trim().split('\n').map((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid, pgid };
  }).filter(({ pid, ppid, pgid }) => [pid, ppid, pgid].every(Number.isInteger));
};

const descendantRows = (rows, rootPid) => {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(({ pid }) => descendants.has(pid));
};

export async function runWithInheritedProcessGroup(operation) {
  const originalSpawn = childProcessModule.spawn;
  childProcessModule.spawn = (command, args, options = {}) => originalSpawn(
    command,
    args,
    options?.detached ? { ...options, detached: false } : options,
  );
  try {
    return await operation();
  } finally {
    childProcessModule.spawn = originalSpawn;
  }
}

export const assertDescendantsShareProcessGroup = (rootPid = process.pid) => {
  const rows = processTable();
  const root = rows.find(({ pid }) => pid === rootPid);
  if (!root) throw new Error(`process ${rootPid} is absent from the process table`);
  const offenders = descendantRows(rows, rootPid)
    .filter(({ pid, pgid }) => pid !== rootPid && pgid !== root.pgid);
  if (offenders.length) {
    throw new Error(`descendants escaped process group ${root.pgid}: ${offenders.map(({ pid, pgid }) => `${pid}:${pgid}`).join(', ')}`);
  }
  return { pgid: root.pgid, descendantCount: descendantRows(rows, rootPid).length - 1 };
};

const processGroupExists = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const waitForGroupToExit = async (pgid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pgid) && Date.now() < deadline) {
    await delay(20, { unref: false });
  }
  return !processGroupExists(pgid);
};

export const terminateProcessTree = (pid, signal = 'SIGTERM') => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

export async function superviseLiveSmoke({
  scriptPath,
  args = [],
  cwd = process.cwd(),
  env = {},
  timeoutMs,
  killGraceMs = 2000,
  stdio = 'inherit',
  progressFile,
  signal,
  onSpawn,
} = {}) {
  if (!scriptPath) throw new Error('scriptPath is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }
  assertProcessGroupSupport();

  const ownsProgressFile = !progressFile;
  const resolvedProgressFile = progressFile || path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'actions-json-live-smoke-')),
    'last-phase.txt',
  );
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      ACTIONS_JSON_LIVE_SMOKE_CHILD: '1',
      ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE: resolvedProgressFile,
    },
    stdio,
    detached: process.platform !== 'win32',
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  let abortListener;
  const abortPromise = signal
    ? new Promise((resolve) => {
      abortListener = () => resolve({ type: 'abort', reason: signal.reason });
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    })
    : new Promise(() => {});

  let timedOut = false;
  let aborted = false;
  let abortReason = null;
  let outcome;
  const terminateOwnedGroup = (killSignal) => terminateProcessTree(child.pid, killSignal);
  try {
    try {
      onSpawn?.(child.pid);
    } catch (error) {
      terminateOwnedGroup('SIGTERM');
      await Promise.race([exitPromise, delay(killGraceMs)]);
      terminateOwnedGroup('SIGKILL');
      await waitForGroupToExit(child.pid, killGraceMs);
      throw error;
    }
    const first = await Promise.race([
      exitPromise.then((exit) => ({ type: 'exit', exit })),
      delay(timeoutMs).then(() => ({ type: 'timeout' })),
      abortPromise,
    ]);
    if (first.type === 'exit') {
      outcome = first.exit;
    } else {
      timedOut = first.type === 'timeout';
      aborted = first.type === 'abort';
      abortReason = aborted ? String(first.reason || 'aborted') : null;
      terminateOwnedGroup('SIGTERM');
      await Promise.race([exitPromise, delay(killGraceMs)]);
      // Always address the process group after the grace period. The group
      // leader may already have exited while a descendant remains alive.
      terminateOwnedGroup('SIGKILL');
      outcome = await Promise.race([
        exitPromise,
        delay(killGraceMs).then(() => ({ code: null, signal: 'SIGKILL' })),
      ]);
    }

    // A worker can be SIGKILLed before it reaps or terminates descendants.
    // Address the run-owned group on every terminal path, including success.
    terminateOwnedGroup('SIGKILL');
    const groupExited = await waitForGroupToExit(child.pid, killGraceMs);
    if (!groupExited) {
      throw new Error(`live-smoke process group survived cleanup: ${child.pid}`);
    }

    return {
      childPid: child.pid,
      code: outcome?.code ?? null,
      signal: outcome?.signal ?? null,
      timedOut,
      aborted,
      abortReason,
      lastPhase: readLastPhase(resolvedProgressFile),
      progressFile: resolvedProgressFile,
    };
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    if (ownsProgressFile) {
      fs.rmSync(path.dirname(resolvedProgressFile), { recursive: true, force: true });
    }
  }
}

export function createPhaseReporter(progressFile = process.env.ACTIONS_JSON_LIVE_SMOKE_PROGRESS_FILE) {
  return (phase) => {
    const normalized = String(phase || 'unknown');
    if (progressFile) {
      fs.writeFileSync(progressFile, normalized);
    }
    console.error(`[a11y-live] phase=${normalized}`);
  };
}

export const exitCodeForAbortReason = (reason) => (
  String(reason) === 'SIGTERM' ? 143 : 130
);
