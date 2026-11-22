import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeAgentAdapter } from "../src/embed/realtime-agent-adapter.mjs";

const dictionary = {
  version: 1,
  primitives: [
    { name: "database.page.read", summary: "Read a page.", input_schema: { type: "object" } },
    { name: "browser.open_tab", summary: "Open a tab.", input_schema: { type: "object" } },
  ],
};

test("catalog projection includes only host-advertised tools", () => {
  const host = { catalog: () => ({ advertised: ["database.page.read"] }), handleActionCall() {} };
  const adapter = new RealtimeAgentAdapter({ host, dictionary, send() {} });

  assert.deepEqual(adapter.tools(), [{
    type: "function",
    name: "database.page.read",
    description: "Read a page.",
    parameters: { type: "object" },
  }]);
});

test("model calls execute only through the authoritative host", async () => {
  const sent = [];
  const calls = [];
  const host = {
    catalog: () => ({ advertised: ["database.page.read"] }),
    async handleActionCall(call) {
      calls.push(call);
      return { type: "action_call_output", call_id: call.call_id, output: { title: "Page" } };
    },
  };
  const adapter = new RealtimeAgentAdapter({ host, dictionary, send: (event) => sent.push(event) });

  const result = await adapter.handleEvent({
    type: "response.done",
    response: { output: [{
      type: "function_call",
      call_id: "call-1",
      name: "database.page.read",
      arguments: JSON.stringify({ url: "/page" }),
    }] },
  });

  assert.deepEqual(result, { handled: true, calls: 1 });
  assert.deepEqual(calls, [{
    call_id: "call-1",
    primitive: "database.page.read",
    arguments: { url: "/page" },
  }]);
  assert.equal(sent[0].item.call_id, "call-1");
  assert.deepEqual(JSON.parse(sent[0].item.output), { title: "Page" });
  assert.deepEqual(sent[1], { type: "response.create" });
});

test("malformed calls are refused without reaching the host", async () => {
  let invoked = 0;
  const sent = [];
  const host = {
    catalog: () => ({ advertised: [] }),
    async handleActionCall() { invoked += 1; },
  };
  const adapter = new RealtimeAgentAdapter({ host, dictionary, send: (event) => sent.push(event) });

  await adapter.handleEvent({
    type: "response.done",
    response: { output: [{ type: "function_call", call_id: "", name: "bad name", arguments: "[" }] },
  });

  assert.equal(invoked, 0);
  assert.equal(JSON.parse(sent[0].item.output).error.code, "invalid_action_call");
});

test("a consumer-owned response queue can suppress adapter continuation", async () => {
  const sent = [];
  const observed = [];
  const host = {
    catalog: () => ({ advertised: ["database.page.read"] }),
    async handleActionCall(call) {
      return { type: "action_call_output", call_id: call.call_id, output: { ok: true } };
    },
  };
  const adapter = new RealtimeAgentAdapter({
    host,
    dictionary,
    send: (event) => sent.push(event),
    continueResponse: false,
    onToolEvent: (event) => observed.push(event),
  });

  await adapter.handleEvent({
    type: "response.done",
    response: { output: [{
      type: "function_call",
      call_id: "call-queue",
      name: "database.page.read",
      arguments: "{}",
    }] },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "conversation.item.create");
  assert.deepEqual(observed.map((event) => event.eventType), ["tool.call", "tool.result"]);
});

test("host exceptions and unserializable outputs become stable failures", async () => {
  for (const behavior of ["throw", "bigint"]) {
    const sent = [];
    const host = {
      catalog: () => ({ advertised: ["database.page.read"] }),
      async handleActionCall(call) {
        if (behavior === "throw") throw new Error("private failure");
        return { type: "action_call_output", call_id: call.call_id, output: 1n };
      },
    };
    const adapter = new RealtimeAgentAdapter({ host, dictionary, send: (event) => sent.push(event) });
    await adapter.handleEvent({
      type: "response.done",
      response: { output: [{
        type: "function_call",
        call_id: `call-${behavior}`,
        name: "database.page.read",
        arguments: "{}",
      }] },
    });
    const output = JSON.parse(sent[0].item.output);
    assert.equal(output.ok, false);
    assert.match(output.error.code, /^(action_host_call_failed|invalid_host_result)$/);
  }
});
