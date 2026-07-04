import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the 2026-07-03 memory-contamination finding.
//
// The hosted agent persists a rolling event memory (ACTIONS_JSON_AGENT_MEMORY_V1)
// and rehydrates the tail of it into EVERY new session as a system message
// (loadReturningSessionContext). During the Lloyd acceptance test this silently
// injected a previous run's wrong conclusion into "fresh" sessions — the agent
// executed its remembered answer instead of re-reasoning. The only clear path
// was a sidepanel button, unreachable for the bridge. v0.1.142 adds
// runtime.agent.memory_clear so acceptance tests can start truly clean.
//
// Separately, background.js kept its own copy of the memory-append logic with
// an 80-event cap (MAX_AGENT_LOG_EVENTS) that shadowed session-memory-store's
// 2000-event retention AND clamped runtime.session.log responses to 80 — too
// small to hold one full task run (~150 events), which blinded post-hoc
// debugging. The cap is now 500 for retention and log responses; rehydration
// stays bounded by REHYDRATION_EVENT_LIMIT in session-memory-store.mjs.

const backgroundSource = await readFile(
  new URL("../src/background.js", import.meta.url),
  "utf8",
);
const contentSource = await readFile(
  new URL("../src/content.js", import.meta.url),
  "utf8",
);
const overlayActions = JSON.parse(
  await readFile(new URL("../actions/overlay.actions.json", import.meta.url), "utf8"),
);

test("background.js handles actions-json:agent-memory-clear and removes the memory key", () => {
  assert.ok(
    backgroundSource.includes('"actions-json:agent-memory-clear"'),
    "background message dispatch must accept actions-json:agent-memory-clear",
  );
  const fnStart = backgroundSource.indexOf("const respondWithAgentMemoryClear");
  assert.ok(fnStart >= 0, "respondWithAgentMemoryClear must exist");
  const fnBody = backgroundSource.slice(fnStart, fnStart + 800);
  assert.ok(
    fnBody.includes("chrome.storage.local.remove(AGENT_MEMORY_STORAGE_KEY)"),
    "memory clear must remove the agent memory storage key",
  );
  assert.ok(
    fnBody.includes("cleared_event_count"),
    "memory clear must report how many events were discarded",
  );
});

test("content.js exposes runtime.agent.memory_clear and forwards it to the background", () => {
  assert.ok(
    contentSource.includes('message.name === "runtime.agent.memory_clear"'),
    "content executeAction dispatch must handle runtime.agent.memory_clear",
  );
  const fnStart = contentSource.indexOf("const runtimeAgentMemoryClear");
  assert.ok(fnStart >= 0, "runtimeAgentMemoryClear handler must exist");
  const fnBody = contentSource.slice(fnStart, fnStart + 400);
  assert.ok(
    fnBody.includes('"actions-json:agent-memory-clear"'),
    "handler must send the agent-memory-clear runtime message",
  );
});

test("overlay.actions.json declares runtime.agent.memory_clear next to the other agent tools", () => {
  const names = overlayActions.tools.map((tool) => tool.name);
  assert.ok(
    names.includes("runtime.agent.memory_clear"),
    "runtime.agent.memory_clear must be advertised in overlay.actions.json",
  );
  const tool = overlayActions.tools.find((entry) => entry.name === "runtime.agent.memory_clear");
  assert.equal(tool.x_actions.handler, "actionsJsonOverlay.runtimeAgentMemoryClear");
  assert.match(tool.description, /rehydrat/i, "description must explain the rehydration hazard");
});

test("agent log retention holds a full task run and no longer clamps reads to 80", () => {
  const capMatch = backgroundSource.match(/const MAX_AGENT_LOG_EVENTS = (\d+);/);
  assert.ok(capMatch, "MAX_AGENT_LOG_EVENTS must be declared");
  const cap = Number(capMatch[1]);
  assert.ok(
    cap >= 300,
    `MAX_AGENT_LOG_EVENTS is ${cap}; one full task run is ~150 events, so retention must comfortably exceed that`,
  );
});
