import { promises as fs } from "node:fs";
import path from "node:path";

import { runAudit } from "./audit.mjs";
import { loadAcceptedGapLedger } from "./ledger.mjs";
import { writeProofPackage } from "./proof-package.mjs";
import { writeReviewBundle } from "./review-bundle.mjs";
import { readScoreInput, runScore } from "./score.mjs";
import { loadPipelineTarget } from "./storage-loader.mjs";

const COMMANDS = new Set(["audit", "score", "package", "promotion-prep"]);

export async function runCli(argv = []) {
  const { command, target, options } = parseArgs(argv);
  const context = await loadPipelineTarget(target);
  if (command === "audit") {
    const ledger = await loadAcceptedGapLedger(context.siteFolder, options.ledger);
    const report = runAudit(context, { ledger });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === "score") {
    const scoreInput = await readScoreInput(options);
    const ledger = await loadAcceptedGapLedger(context.siteFolder, options.ledger);
    const auditReport = scoreInput.auditReport || runAudit(context, { ledger });
    const report = runScore(context, {
      auditReport,
      semantic: scoreInput.semantic,
      before: options.before,
      after: options.after,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (command === "package") {
    const ledger = await loadAcceptedGapLedger(context.siteFolder, options.ledger);
    const auditReport = runAudit(context, { ledger });
    const scoreReport = options.score
      ? JSON.parse(await readTextFile(options.score))
      : runScore(context, { auditReport });
    const report = await writeProofPackage(context, {
      packageName: options.name,
      taskListPath: options.taskList,
      actionLogPath: options.actionLog,
      failuresPath: options.failures,
      scoreReport,
      ledger,
      screenshotsPath: options.screenshots,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === "promotion-prep") {
    const report = await writeReviewBundle(context, {
      bundleName: options.name,
      proofPackagePath: options.proof,
      redactionStatus: options.redactionStatus,
      attributionStatus: options.attributionStatus,
      draft: options.draft === true,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
}

export function parseArgs(argv = []) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new Error("Usage: actions-json <audit|score|package> <map-path|site-folder>");
  }

  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--ledger") {
      options.ledger = rest[index + 1];
      index += 1;
    } else if (arg === "--audit") {
      options.audit = rest[index + 1];
      index += 1;
    } else if (arg === "--semantic") {
      options.semantic = rest[index + 1];
      index += 1;
    } else if (arg === "--before") {
      options.before = Number(rest[index + 1]);
      index += 1;
    } else if (arg === "--after") {
      options.after = Number(rest[index + 1]);
      index += 1;
    } else if (arg === "--name") {
      options.name = rest[index + 1];
      index += 1;
    } else if (arg === "--task-list") {
      options.taskList = rest[index + 1];
      index += 1;
    } else if (arg === "--action-log") {
      options.actionLog = rest[index + 1];
      index += 1;
    } else if (arg === "--failures") {
      options.failures = rest[index + 1];
      index += 1;
    } else if (arg === "--score") {
      options.score = rest[index + 1];
      index += 1;
    } else if (arg === "--screenshots") {
      options.screenshots = rest[index + 1];
      index += 1;
    } else if (arg === "--proof") {
      options.proof = rest[index + 1];
      index += 1;
    } else if (arg === "--redaction-status") {
      options.redactionStatus = rest[index + 1];
      index += 1;
    } else if (arg === "--attribution-status") {
      options.attributionStatus = rest[index + 1];
      index += 1;
    } else if (arg === "--draft") {
      options.draft = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  const target = positional[0];
  if (!target) {
    throw new Error("Usage: actions-json <audit|score|package> <map-path|site-folder>");
  }
  return { command, target, options };
}

async function readTextFile(filePath) {
  return fs.readFile(path.resolve(filePath), "utf8");
}
