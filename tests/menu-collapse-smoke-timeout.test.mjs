import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

const runSmoke = (env) => {
  const child = spawn("npm", ["run", "test:menu-collapse-live"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
};

const processGroupExists = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

test("menu collapse smoke removes the exact profile created before a forced timeout", { timeout: 30_000 }, async () => {
  const { status, output } = await runSmoke({ ACTIONS_JSON_SMOKE_TIMEOUT_AFTER_PROFILE_MS: "500" });
  const createdProfile = output.match(/menu-collapse-smoke: profile created ([^\r\n]+)/)?.[1].trim() || null;

  assert.notEqual(status, 0, "the forced-timeout smoke must fail");
  assert.match(output, /Menu collapse live smoke exceeded 500 milliseconds after profile creation/);
  assert.ok(createdProfile, `the smoke never emitted its created profile:\n${output}`);
  assert.equal(existsSync(createdProfile), false, `forced-timeout cleanup leaked ${createdProfile}`);
});

test("menu collapse watchdog reaps the Chromium process group after a post-launch hang", { timeout: 40_000 }, async () => {
  const { status, output } = await runSmoke({
    ACTIONS_JSON_SMOKE_HANG_AFTER_LAUNCH: "1",
    ACTIONS_JSON_SMOKE_TIMEOUT_MS: "12000",
  });
  const group = Number(output.match(/menu-collapse-smoke: owned process group=(\d+)/)?.[1]);
  const createdProfile = output.match(/menu-collapse-smoke: profile created ([^\r\n]+)/)?.[1].trim() || null;

  assert.equal(status, 124, `the watchdog must return its timeout status:\n${output}`);
  assert.match(output, /last_phase=forced-hang:after-launch/);
  assert.ok(Number.isInteger(group) && group > 0, `the smoke never reported its owned process group:\n${output}`);
  assert.equal(processGroupExists(group), false, `watchdog leaked process group ${group}`);
  assert.ok(createdProfile, `the smoke never emitted its created profile:\n${output}`);
  assert.equal(existsSync(createdProfile), false, `watchdog cleanup leaked ${createdProfile}`);
});
