import assert from "node:assert/strict";
import test from "node:test";

import { DebuggerSessionManager } from "../src/agent/debugger-session-manager.mjs";

function createHarness() {
  let attached = false;
  let attaches = 0;
  let detaches = 0;
  let probeCalls = 0;

  const manager = new DebuggerSessionManager({
    attach: async () => {
      if (attached) throw new Error("Another debugger is already attached to the tab with id: 7.");
      attached = true;
      attaches += 1;
    },
    detach: async () => {
      if (!attached) throw new Error("Debugger is not attached to the tab with id: 7.");
      attached = false;
      detaches += 1;
    },
    sendCommand: async (_target, method) => {
      probeCalls += 1;
      assert.equal(method, "Runtime.evaluate");
      if (!attached) throw new Error("Debugger is not attached to the tab with id: 7.");
      return { result: { type: "undefined" } };
    },
  });

  return {
    manager,
    get attached() { return attached; },
    set attached(value) { attached = value; },
    get attaches() { return attaches; },
    get detaches() { return detaches; },
    get probeCalls() { return probeCalls; },
  };
}

test("nested holders attach once and detach only after the final release", async () => {
  const h = createHarness();
  await h.manager.acquire(7);
  await h.manager.acquire(7);

  assert.equal(h.attaches, 1);
  await h.manager.release(7);
  assert.equal(h.detaches, 0);
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("concurrent first acquires serialize ownership and preserve both holders", async () => {
  const h = createHarness();
  await Promise.all([h.manager.acquire(7), h.manager.acquire(7)]);

  assert.equal(h.attaches, 1);
  await h.manager.release(7);
  assert.equal(h.detaches, 0);
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("a stale tracked attachment is probed and reattached before acquire succeeds", async () => {
  const h = createHarness();
  await h.manager.acquire(7);
  h.attached = false;

  await h.manager.acquire(7);

  assert.equal(h.probeCalls, 1);
  assert.equal(h.attaches, 2);
  assert.equal(h.attached, true);
  await h.manager.release(7);
  assert.equal(h.detaches, 0);
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("an already-attached session is adopted only when this extension can command it", async () => {
  let detaches = 0;
  const manager = new DebuggerSessionManager({
    attach: async () => { throw new Error("Another debugger is already attached to the tab with id: 7."); },
    detach: async () => { detaches += 1; },
    sendCommand: async () => ({ result: { type: "undefined" } }),
  });

  await manager.acquire(7);
  await manager.release(7);

  assert.equal(detaches, 0);
});

test("an external debugger is not misclassified as an adoptable extension session", async () => {
  const manager = new DebuggerSessionManager({
    attach: async () => { throw new Error("Another debugger is already attached to the tab with id: 7."); },
    detach: async () => {},
    sendCommand: async () => { throw new Error("Debugger is not attached to the tab with id: 7."); },
  });

  await assert.rejects(manager.acquire(7), (error) => {
    assert.equal(error.code, "debugger_owned_externally");
    assert.equal(error.recoverable, true);
    assert.equal(error.retryable, false);
    assert.match(error.next_step, /Close DevTools/);
    return true;
  });
});

test("a failed external adoption does not poison a later owned acquisition", async () => {
  let canAttach = false;
  let attached = false;
  let attaches = 0;
  let detaches = 0;
  const manager = new DebuggerSessionManager({
    attach: async () => {
      if (!canAttach) throw new Error("Another debugger is already attached to the tab with id: 7.");
      attached = true;
      attaches += 1;
    },
    detach: async () => {
      attached = false;
      detaches += 1;
    },
    sendCommand: async () => {
      if (!attached) throw new Error("Debugger is not attached to the tab with id: 7.");
      return { result: { type: "undefined" } };
    },
  });

  await assert.rejects(manager.acquire(7), (error) => error.code === "debugger_owned_externally");
  canAttach = true;
  await manager.acquire(7);
  await manager.release(7);

  assert.equal(attaches, 1);
  assert.equal(detaches, 1);
});

test("a non-attachment probe failure propagates without reattaching", async () => {
  let probeError = null;
  const h = createHarness();
  const originalSendCommand = h.manager.sendCommand;
  h.manager.sendCommand = async (...args) => {
    if (probeError) throw probeError;
    return originalSendCommand(...args);
  };
  await h.manager.acquire(7);
  probeError = new Error("Target closed while evaluating");

  await assert.rejects(h.manager.acquire(7), /Target closed/);

  assert.equal(h.attaches, 1);
  probeError = null;
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("browser detach preserves logical holders and repairs the physical session", async () => {
  const h = createHarness();
  await h.manager.acquire(7);
  h.attached = false;
  h.manager.handleDetach(7);

  await h.manager.acquire(7);

  assert.equal(h.attaches, 2);
  await h.manager.release(7);
  assert.equal(h.detaches, 0, "the original logical holder must survive detach recovery");
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("a long-lived holder can attest and repair its session without adding a holder", async () => {
  const h = createHarness();
  await h.manager.acquire(7);
  h.attached = false;

  await h.manager.attestHeld(7);

  assert.equal(h.attaches, 2);
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("attestHeld restores a browser-detached long-lived holder", async () => {
  const h = createHarness();
  await h.manager.acquire(7);
  h.attached = false;
  h.manager.handleDetach(7);

  await h.manager.attestHeld(7);

  assert.equal(h.attaches, 2);
  await h.manager.release(7);
  assert.equal(h.detaches, 1);
});

test("a detach event during an awaited probe cannot publish a stale successful acquire", async () => {
  let attached = true;
  let attaches = 0;
  let probeStarted;
  let resumeProbe;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  const blocked = new Promise((resolve) => { resumeProbe = resolve; });
  let blockNextProbe = true;
  const manager = new DebuggerSessionManager({
    attach: async () => {
      attached = true;
      attaches += 1;
    },
    detach: async () => { attached = false; },
    sendCommand: async () => {
      if (blockNextProbe) {
        blockNextProbe = false;
        const callbackWillSucceed = attached;
        probeStarted();
        await blocked;
        if (callbackWillSucceed) return { result: { type: "undefined" } };
      }
      if (!attached) throw new Error("Debugger is not attached to the tab with id: 7.");
      return { result: { type: "undefined" } };
    },
  });

  await manager.acquire(7);
  const nestedAcquire = manager.acquire(7);
  await started;
  attached = false;
  manager.handleDetach(7);
  resumeProbe();
  await nestedAcquire;

  assert.equal(attaches, 2, "the acquire must retry after the detach generation changes");
  await manager.release(7);
  await manager.release(7);
});

test("unexpected detach failure is surfaced and cleanup is retried before reuse", async () => {
  let attached = false;
  let attaches = 0;
  let detachAttempts = 0;
  let manager;
  manager = new DebuggerSessionManager({
    attach: async () => {
      if (attached) throw new Error("Another debugger is already attached to the tab with id: 7.");
      attached = true;
      attaches += 1;
    },
    detach: async () => {
      detachAttempts += 1;
      if (detachAttempts === 1) throw new Error("Transient debugger transport failure");
      attached = false;
      manager.handleDetach(7);
    },
    sendCommand: async () => {
      if (!attached) throw new Error("Debugger is not attached to the tab with id: 7.");
      return { result: { type: "undefined" } };
    },
  });

  await manager.acquire(7);
  await assert.rejects(manager.release(7), /Transient debugger transport failure/);
  await manager.acquire(7);

  assert.equal(detachAttempts, 2, "reuse must first finish the failed owned-session cleanup");
  assert.equal(attaches, 2, "reuse must establish a fresh owned attachment");
  await manager.release(7);
  assert.equal(attached, false, "final release must detach the fresh owned attachment");
});

test("tab removal clears preserved logical holders after queued work settles", async () => {
  const h = createHarness();
  await h.manager.acquire(7);
  await h.manager.handleTabRemoved(7);

  assert.equal(h.manager.holderCount(7), 0);
});
