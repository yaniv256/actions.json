#!/usr/bin/env node
'use strict';

import("../src/cli.mjs")
  .then(({ runCli }) => runCli(process.argv.slice(2)))
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
