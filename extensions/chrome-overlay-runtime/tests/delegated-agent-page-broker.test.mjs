import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPageBroker } = require("../src/delegated-agent/page-broker.js");

const manifestOne = "https://github.com/example/agent/blob/0123456789abcdef0123456789abcdef01234567/agent.json";
const manifestTwo = "https://github.com/example/agent/blob/89abcdef0123456789abcdef0123456789abcdef/agent.json";

class FakeObserver {
  static instances = [];
  constructor(callback) { this.callback = callback; this.disconnected = false; FakeObserver.instances.push(this); }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
  fire(records = [{}]) { this.callback(records); }
}

class FakeWindow {
  constructor(origin = "https://course.example") {
    this.location = { origin, href: `${origin}/chapter` };
    this.top = this;
    this.listeners = new Map();
    this.posts = [];
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((candidate) => candidate !== listener));
  }
  postMessage(data, targetOrigin, transfer = []) { this.posts.push({ data, targetOrigin, transfer }); }
  fire(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
}

const harness = ({ href = manifestOne, sendMessage } = {}) => {
  FakeObserver.instances = [];
  const link = { href };
  const doc = {
    head: {},
    querySelector: () => link.href ? link : null,
  };
  const sent = [];
  let inbound = null;
  const runtime = {
    sendMessage: async (message) => {
      sent.push(message);
      if (sendMessage) return sendMessage(message);
      return { ok: true };
    },
    onMessage: { addListener: (listener) => { inbound = listener; } },
  };
  const win = new FakeWindow();
  const timers = [];
  const broker = createPageBroker({
    doc,
    win,
    runtime,
    MutationObserverCtor: FakeObserver,
    MessageChannelCtor: MessageChannel,
    cryptoLike: { randomUUID: () => "generated-nonce" },
    schedule: (fn) => { timers.push(fn); return timers.length; },
    cancelSchedule: () => {},
    maxObserverMutations: 2,
  });
  return { broker, doc, link, sent, win, timers, inbound: () => inbound };
};

const waitFor = async (predicate, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("top-level broker reports startup discovery and bounded head changes without opening UI", async () => {
  const h = harness();
  h.broker.start();
  await waitFor(() => h.sent.length === 1);
  assert.deepEqual(h.sent[0], { type: "actions-json:delegated-agent-discovery", href: manifestOne });
  assert.equal(h.win.posts.length, 0);
  const observer = FakeObserver.instances[0];
  assert.equal(observer.target, h.doc.head);
  assert.equal(observer.options.attributes, true);
  h.link.href = manifestTwo;
  observer.fire([{ type: "attributes" }]);
  await waitFor(() => h.sent.length === 2);
  assert.equal(h.sent[1].href, manifestTwo);
  observer.fire([{ type: "childList" }]);
  assert.equal(observer.disconnected, true, "observer disconnects at its mutation budget");
});

test("iframe brokers stay inert", () => {
  const h = harness();
  h.win.top = {};
  h.broker.start();
  assert.equal(h.sent.length, 0);
  assert.equal(FakeObserver.instances.length, 0);
});

test("approved activation creates one origin-bound private port and relays bounded calls only on that port", async () => {
  const h = harness({
    sendMessage: async (message) => message.type === "actions-json:delegated-agent-call"
      ? { ok: true, output: { echoed: message.arguments.value } }
      : { ok: true },
  });
  h.broker.start();
  await h.inbound()({
    type: "actions-json:delegated-agent-activate",
    portNonce: "nonce-one",
    sourceOrigin: "https://course.example",
  }, {}, () => {});
  assert.equal(h.win.posts.length, 1);
  const transfer = h.win.posts[0];
  assert.equal(transfer.targetOrigin, "https://course.example");
  assert.equal(transfer.data.portNonce, "nonce-one");
  assert.equal(transfer.transfer.length, 1);
  const pagePort = transfer.transfer[0];
  const replies = [];
  pagePort.onmessage = (event) => replies.push(event.data);
  pagePort.start();
  pagePort.postMessage({
    type: "call",
    portNonce: "nonce-one",
    sequence: 1,
    callId: "call-one",
    name: "x.timeline.read",
    arguments: { value: 7 },
  });
  await waitFor(() => replies.length === 1);
  assert.deepEqual(replies[0], {
    type: "result",
    portNonce: "nonce-one",
    sequence: 1,
    callId: "call-one",
    ok: true,
    output: { echoed: 7 },
  });
  assert.equal(h.sent.some((message) => message.type === "actions-json:delegated-agent-call"), true);
  pagePort.close();
  h.broker.stop();
});

test("private channel rejects replay, wrong nonce, oversized envelopes, and duplicate outstanding call IDs", async () => {
  let resolveCall;
  const h = harness({
    sendMessage: (message) => message.type === "actions-json:delegated-agent-call"
      ? new Promise((resolve) => { resolveCall = resolve; })
      : Promise.resolve({ ok: true }),
  });
  h.broker.start();
  await h.inbound()({ type: "actions-json:delegated-agent-activate", portNonce: "nonce-one", sourceOrigin: h.win.location.origin }, {}, () => {});
  const pagePort = h.win.posts[0].transfer[0];
  const replies = [];
  pagePort.onmessage = (event) => replies.push(event.data);
  pagePort.start();
  const base = { type: "call", portNonce: "nonce-one", sequence: 1, callId: "same", name: "safe.read", arguments: {} };
  pagePort.postMessage(base);
  await waitFor(() => typeof resolveCall === "function");
  pagePort.postMessage({ ...base, sequence: 2 });
  pagePort.postMessage({ ...base, portNonce: "wrong", sequence: 3, callId: "wrong" });
  pagePort.postMessage({ ...base, sequence: 4, callId: "large", arguments: { value: "x".repeat(40_000) } });
  await waitFor(() => replies.filter((reply) => reply.type === "error").length === 3);
  resolveCall({ ok: true, output: {} });
  await waitFor(() => replies.some((reply) => reply.type === "result"));
  assert.deepEqual(
    replies.filter((reply) => reply.type === "error").map((reply) => reply.code).sort(),
    ["call_already_outstanding", "envelope_too_large", "port_identity_mismatch"],
  );
  pagePort.close();
  h.broker.stop();
});

test("pagehide closes the channel and emits lifecycle without broadcasting a result", async () => {
  const h = harness();
  h.broker.start();
  await h.inbound()({ type: "actions-json:delegated-agent-activate", portNonce: "nonce-one", sourceOrigin: h.win.location.origin }, {}, () => {});
  const postsBeforeHide = h.win.posts.length;
  h.win.fire("pagehide", { persisted: true });
  await waitFor(() => h.sent.some((message) => message.type === "actions-json:delegated-agent-lifecycle"));
  assert.equal(h.win.posts.length, postsBeforeHide, "lifecycle and results never use a global broadcast");
  assert.equal(h.sent.at(-1).event, "pagehide");
  assert.equal(h.sent.at(-1).persisted, true);
  h.win.posts[0].transfer[0].close();
  h.broker.stop();
});
