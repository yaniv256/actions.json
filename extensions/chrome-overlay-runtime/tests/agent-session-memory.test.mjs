import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MEMORY_STORAGE_KEY,
  clearAgentMemory,
  getAgentMemoryState,
  loadReturningSessionContext,
  recordAgentMemoryEvent,
} from "../src/agent/session-memory-store.mjs";

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (typeof key === "string") {
        return { [key]: data[key] };
      }
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

test("agent memory records bounded events and sanitizes screenshot payloads", async () => {
  const storage = createStorage();

  await recordAgentMemoryEvent(storage, {
    type: "screenshot",
    targetUrl: "https://www.linkedin.com/analytics/creator/content",
    purpose: "inspect visible graph",
    dataUrl: "data:image/png;base64,secret-image-payload",
    width: 1200,
    height: 800,
  });

  const stored = storage.data[AGENT_MEMORY_STORAGE_KEY];
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0].type, "screenshot");
  assert.equal(stored.events[0].targetUrl, "https://www.linkedin.com/analytics/creator/content");
  assert.equal(stored.events[0].metadata.width, 1200);
  assert.equal(stored.events[0].metadata.height, 800);
  assert.equal(JSON.stringify(stored).includes("secret-image-payload"), false);
  assert.match(stored.visitorId, /^local-agent-/);
});

test("agent memory keeps a larger diagnostic log while bounding returning context", async () => {
  const storage = createStorage();

  for (let index = 0; index < 2105; index += 1) {
    await recordAgentMemoryEvent(storage, {
      type: "transcript",
      role: index % 2 === 0 ? "user" : "assistant",
      text: `event ${index}`,
    });
  }

  const stored = storage.data[AGENT_MEMORY_STORAGE_KEY];
  assert.equal(stored.events.length, 2000);
  assert.equal(stored.events[0].text, "event 105");
  assert.equal(stored.events.at(-1).text, "event 2104");

  const defaultLog = await import("../src/agent/session-memory-store.mjs").then((module) =>
    module.getAgentSessionLog(storage),
  );
  assert.equal(defaultLog.eventCount, 2000);
  assert.equal(defaultLog.events.length, 2000);

  const boundedLog = await import("../src/agent/session-memory-store.mjs").then((module) =>
    module.getAgentSessionLog(storage, { limit: 25 }),
  );
  assert.equal(boundedLog.events.length, 25);
  assert.equal(boundedLog.events[0].text, "event 2080");

  const context = await loadReturningSessionContext(storage);
  const contextText = context.item.content[0].text;
  assert.match(contextText, /event 2025/);
  assert.match(contextText, /event 2104/);
  assert.doesNotMatch(contextText, /event 2024/);
});

test("agent memory summary is concise and includes transcript and tool outcomes", async () => {
  const storage = createStorage();

  await recordAgentMemoryEvent(storage, {
    type: "transcript",
    role: "user",
    text: "Collect LinkedIn post impressions by horizon.",
  });
  await recordAgentMemoryEvent(storage, {
    type: "tool",
    name: "actions.site",
    targetUrl: "https://www.linkedin.com/analytics/creator/content",
    ok: true,
    summary: "Read 7, 14, and 28 day impressions.",
  });

  const context = await loadReturningSessionContext(storage);

  assert.equal(context.type, "conversation.item.create");
  assert.equal(context.item.role, "system");
  assert.match(context.item.content[0].text, /Previous local actions\.json agent context/);
  assert.match(context.item.content[0].text, /user: Collect LinkedIn post impressions/);
  assert.match(context.item.content[0].text, /tool actions\.site ok/);
  assert.equal(JSON.stringify(context).includes("sk-proj"), false);
});

test("agent memory can be cleared and reports empty state", async () => {
  const storage = createStorage();

  await recordAgentMemoryEvent(storage, {
    type: "transcript",
    role: "assistant",
    text: "I found the analytics export button.",
  });

  assert.equal((await getAgentMemoryState(storage)).eventCount, 1);
  await clearAgentMemory(storage);

  assert.deepEqual(await getAgentMemoryState(storage), {
    configured: false,
    eventCount: 0,
    visitorId: null,
  });
  assert.equal(await loadReturningSessionContext(storage), null);
});
