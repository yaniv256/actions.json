#!/usr/bin/env node

// Destructive live acceptance for the CLI-first interface. This test intentionally
// has no MCP fallback. It creates one uniquely named Trello card and archives only
// that card during cleanup. Run only against a claimed throwaway/test board tab.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const enabled = process.env.ACTIONS_JSON_AGENT_KANBAN_LIVE === "1";
if (!enabled) {
  console.log("SKIP: set ACTIONS_JSON_AGENT_KANBAN_LIVE=1 to run the Trello mutation acceptance test");
  process.exit(0);
}

const cli = process.env.ACTIONS_JSON_CLI || "actions-json";
const listFrom = process.env.ACTIONS_JSON_KANBAN_SOURCE_LIST || "Next";
const listTo = process.env.ACTIONS_JSON_KANBAN_TARGET_LIST || "In Progress";
const targetId = process.env.ACTIONS_JSON_KANBAN_TARGET_ID;
const forcedIndeterminate = parseOptionalJson("ACTIONS_JSON_KANBAN_INDETERMINATE_JSON");
assert(targetId, "ACTIONS_JSON_KANBAN_TARGET_ID is required; never rely on a daemon-global active tab");
assert(forcedIndeterminate?.operation && forcedIndeterminate?.arguments,
  "ACTIONS_JSON_KANBAN_INDETERMINATE_JSON must name a safe test operation and arguments that intentionally produce an indeterminate outcome");

const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
const title = `[aj-cli-live ${runId}]`;
const description = `Owned acceptance fixture ${runId}. Safe to archive after this run.`;
const comment = `CLI acceptance comment ${runId}`;
const checklist = `CLI acceptance ${runId}`;
const item = `Independent readback ${runId}`;
const ownedOperationIds = [];
let cardCreated = false;

function parseOptionalJson(name) {
  const value = process.env[name];
  if (!value) return null;
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`${name} is not valid JSON: ${error.message}`); }
}

function invoke(args, input, expectedCodes = [0]) {
  const result = spawnSync(cli, args, {
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert(expectedCodes.includes(result.status), `${cli} ${args.join(" ")} exited ${result.status}; stderr=${result.stderr}`);
  assert.equal(result.stderr, "", "the CLI must keep stderr quiet during normal structured operation");
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON result, got ${lines.length}`);
  const body = JSON.parse(lines[0]);
  assert.equal(body.protocol_version, 1);
  if (body.operation_id) ownedOperationIds.push(body.operation_id);
  return { body, exitCode: result.status };
}

function profileArgs(profile) {
  return ["--profile", profile.name, "--profile-token", profile.token, "--target-id", targetId];
}

function action(profile, operation, arguments_, expectedCodes = [0]) {
  return invoke([operation, ...profileArgs(profile)], arguments_, expectedCodes);
}

function findKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function objects(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (!Array.isArray(value)) output.push(value);
  for (const child of Object.values(value)) objects(child, output);
  return output;
}

function text(value) { return JSON.stringify(value); }
function proves(value, ...needles) {
  const haystack = text(value);
  for (const needle of needles) assert(haystack.includes(needle), `independent read omitted ${JSON.stringify(needle)}`);
}

function createProfile(name) {
  const { body } = invoke(["profile", "create", "--name", name, "--label", `Agent Kanban live ${runId}`]);
  const token = findKey(body, "token");
  assert.equal(typeof token, "string", "profile create did not return a token");
  return { name, token };
}

function readBoard(profile) {
  return action(profile, "trello.board.visible_cards_by_list.read", {}).body;
}

function openAndRead(profile) {
  action(profile, "trello.card.by_title.open", { title });
  return action(profile, "trello.card.detail.read", {}).body;
}

let profileA;
let profileB;

try {
  profileA = createProfile(`kanban-a-${runId}`);
  profileB = createProfile(`kanban-b-${runId}`);
  // Discovery is part of acceptance: no operation name is assumed to exist merely
  // because it appears in a checked-in map.
  const catalog = invoke(["list", "--target-id", targetId]).body;
  proves(catalog, "trello.card.create", "trello.card.checklist.read");
  const descriptionResult = invoke(["describe", "trello.card.create", "--target-id", targetId]).body;
  proves(descriptionResult, "list_name", "title");

  // The same explicit target is selected independently for both cooperative profiles.
  invoke(["target", "set", "--profile", profileA.name, "--profile-token", profileA.token, "--target-id", targetId]);
  invoke(["target", "set", "--profile", profileB.name, "--profile-token", profileB.token, "--target-id", targetId]);

  action(profileA, "trello.card.create", { list_name: listFrom, title });
  cardCreated = true;
  proves(readBoard(profileB), listFrom, title); // independent profile + projection

  action(profileA, "trello.card.by_title.open", { title });
  action(profileA, "trello.card.description.set", { card_title: title, text: description, verify_contains: runId });
  proves(openAndRead(profileB), runId);

  const firstMutation = action(profileA, "trello.card.comment.add", { card_title: title, text: comment }).body;
  const secondComment = `Second profile mutation ${runId}`;
  const secondMutation = action(profileB, "trello.card.comment.add", { card_title: title, text: secondComment }).body;
  const firstRevision = Number(findKey(firstMutation, "mutation_revision"));
  const secondRevision = Number(findKey(secondMutation, "mutation_revision"));
  assert(Number.isFinite(firstRevision) && Number.isFinite(secondRevision) && secondRevision > firstRevision,
    "target mutation revision did not advance across profiles");
  assert(findKey(secondMutation, "interference") !== undefined,
    "second profile mutation omitted interference metadata");
  proves(openAndRead(profileB), comment, secondComment);

  action(profileA, "trello.card.checklist.create", { title: checklist });
  action(profileA, "trello.card.checklist.item_composer.open", {});
  action(profileA, "trello.card.checklist_item.add", { item_text: item });
  proves(action(profileB, "trello.card.checklist.read", {}).body, checklist, item, "false");

  action(profileA, "trello.card.checklist_item.complete", { item_text: item });
  proves(action(profileB, "trello.card.checklist.read", {}).body, item, "true");

  action(profileA, "trello.card.move_to_list_from_open_card", { card_title: title, target_list: listTo });
  proves(readBoard(profileB), listTo, title);

  // A short lease makes a multi-step mutation window explicit. Another profile
  // must fail quickly instead of waiting or silently interleaving.
  const lease = invoke(["lease", "acquire", "--profile", profileA.name, "--profile-token", profileA.token,
    "--target-id", targetId, "--duration-ms", "60000"]).body;
  const leaseToken = findKey(lease, "lease_token");
  assert.equal(typeof leaseToken, "string");
  const refused = action(profileB, "trello.card.comment.add", { card_title: title, text: `must-not-commit ${runId}` }, [4]);
  assert.equal(refused.body.outcome, "refused");
  invoke(["lease", "release", "--profile", profileA.name, "--profile-token", profileA.token,
    "--target-id", targetId, "--lease-token", leaseToken]);
  proves(openAndRead(profileA), comment);
  assert(!text(openAndRead(profileA)).includes(`must-not-commit ${runId}`));

  // A deterministic map/operation failure remains structured and terminal.
  const failed = action(profileA, `acceptance.nonexistent.${runId}`, {}, [5]);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.status, "terminal");

  // The caller supplies a deliberately indeterminate, safe fixture operation for
  // the installed map/runtime. Recovery is by operation id, never blind retry.
  const uncertain = action(profileA, forcedIndeterminate.operation, forcedIndeterminate.arguments, [6]);
  assert.equal(uncertain.body.outcome, "indeterminate");
  assert(uncertain.body.operation_id);
  const recovered = invoke(["operation", "status", "--operation-id", uncertain.body.operation_id]).body;
  assert.equal(findKey(recovered, "operation_id"), uncertain.body.operation_id);

  // Every owned call must be attributable to the CLI adapter. The live interval
  // must contain no MCP attribution for these exact operation ids.
  const expectedAuditIds = [...ownedOperationIds];
  const audit = invoke(["logs"]).body;
  const auditRows = objects(audit).filter((row) => row.operation_id);
  for (const operationId of expectedAuditIds) {
    const rows = auditRows.filter((row) => row.operation_id === operationId);
    assert(rows.length > 0, `bounded audit omitted owned operation ${operationId}`);
    assert(rows.some((row) => row.adapter === "cli"),
      `audit row for ${operationId} is not attributed to CLI`);
    assert(!rows.some((row) => row.adapter === "mcp"),
      `audit row for ${operationId} was attributed to MCP`);
  }

  console.log(JSON.stringify({ ok: true, run_id: runId, title, target_id: targetId, operation_ids: ownedOperationIds }));
} finally {
  if (cardCreated && profileA && profileB) {
    // Cleanup is recoverable and restricted to the exact unique fixture title.
    try {
      action(profileA, "trello.card.by_title.open", { title });
      action(profileA, "trello.card.archive", { card_title: title });
      assert(!text(readBoard(profileB)).includes(title), "owned fixture remained visible after archive");
    } catch (error) {
      console.error(`CLEANUP REQUIRED: archive only ${JSON.stringify(title)}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  for (const profile of [profileA, profileB].filter(Boolean)) {
    try { invoke(["profile", "delete", "--name", profile.name, "--token", profile.token]); }
    catch (error) { console.error(`profile cleanup failed for ${profile.name}: ${error.message}`); }
  }
}
