// Playwright had no config in this repo, so it scanned from the repo root with
// the default `testDir: "."`. That sweeps in every `.worktrees/*/` checkout —
// each with its own node_modules/playwright — and dies before running anything:
//
//   Error: Requiring @playwright/test second time
//
// The failure is module identity, not our tests, and it hit every spec equally:
// the shipped `test:overlay-runtime` script failed the same way. So the browser
// gates in this repo were unrunnable-by-default while still looking like they
// were wired up.
//
// Scoping testDir to the extension's own tests is the fix. `testIgnore` is belt
// and braces for anyone who points Playwright somewhere else.
module.exports = {
  testDir: "extensions/chrome-overlay-runtime/tests",
  // Playwright's default testMatch also picks up `*.test.*`, which in this repo
  // means the ~90 node:test suites that live alongside the browser specs. Those
  // are run by `node --test` and import CommonJS in ways Playwright's ESM loader
  // rejects, so scanning them turns a green browser run into a wall of loader
  // errors that have nothing to do with the specs. Only `*.spec.js` is a
  // Playwright target here.
  testMatch: "**/*.spec.js",
  testIgnore: ["**/.worktrees/**", "**/node_modules/**"],
  // These specs stub the extension by routing https://actions-json.test/** to
  // files on disk; they do not launch a real browser profile or an unpacked
  // extension, so the default chromium project is all they need.
  use: {
    trace: "retain-on-failure",
  },
};
