#!/usr/bin/env node
'use strict';

// Thin launcher: ensure the prebuilt actions-json-mcp binary is present
// (downloading it on first run), then exec it with whatever args were passed.
// Example:
//   npx @actions-json/bridge mcp --bind 0.0.0.0:17345 --actions ... --storage-root ...

const { spawn } = require('node:child_process');
const { ensureBinary } = require('../lib/install');

async function main() {
  let bin;
  try {
    bin = await ensureBinary();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.code === 'UNSUPPORTED_PLATFORM' ? 2 : 1);
    return;
  }

  const args = process.argv.slice(2);
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
