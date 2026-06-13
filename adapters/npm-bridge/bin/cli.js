#!/usr/bin/env node
'use strict';

// Thin launcher: ensure the prebuilt actions-json-mcp binary is present
// (downloading it on first run), then exec it with whatever args were passed.
// Example:
//   npx @actions-json/bridge mcp --storage-root .storage

const path = require('node:path');
const { spawn } = require('node:child_process');
const { ensureBinary } = require('../lib/install');

// The primitive dictionary (browser-control tool catalog) ships with this
// package — it's a fixed runtime file, not user config. When the caller runs a
// subcommand that needs it and didn't pass --actions, default to the bundled
// copy so users don't have to know its path.
const BUNDLED_ACTIONS = path.join(__dirname, '..', 'dictionary', 'overlay.actions.json');
const SUBCOMMANDS_NEEDING_ACTIONS = new Set(['mcp', 'serve']);

function withDefaultActions(args) {
  const sub = args[0];
  if (!SUBCOMMANDS_NEEDING_ACTIONS.has(sub)) return args;
  if (args.includes('--actions')) return args;
  if (args.includes('--help') || args.includes('-h')) return args;
  // Insert right after the subcommand.
  return [args[0], '--actions', BUNDLED_ACTIONS, ...args.slice(1)];
}

async function main() {
  let bin;
  try {
    bin = await ensureBinary();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.code === 'UNSUPPORTED_PLATFORM' ? 2 : 1);
    return;
  }

  const args = withDefaultActions(process.argv.slice(2));
  const child = spawn(bin, args, { stdio: 'inherit' });

  // Forward termination signals so the bridge shuts down cleanly.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code == null ? 0 : code);
    }
  });
  child.on('error', (err) => {
    process.stderr.write(`failed to launch actions-json-mcp: ${err.message}\n`);
    process.exit(1);
  });
}

main();
