import assert from "node:assert/strict";
import test from "node:test";

import { createTaskQueue } from "../src/agent/task-queue.mjs";

test("add accepts a single text and a tasks array, preserving order", () => {
  const q = createTaskQueue();
  const r1 = q.add({ text: "first" });
  assert.equal(r1.ok, true);
  assert.equal(r1.added.length, 1);
  assert.equal(r1.added[0].text, "first");
  assert.equal(r1.added[0].status, "pending");

  const r2 = q.add({ tasks: ["second", "third"] });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.tasks.map((t) => t.text), ["first", "second", "third"]);
  assert.equal(r2.total, 3);
  assert.equal(r2.pending, 3);
});

test("add rejects empty input and blank strings", () => {
  const q = createTaskQueue();
  assert.equal(q.add({}).error.code, "invalid_task");
  assert.equal(q.add({ tasks: [] }).error.code, "invalid_task");
  assert.equal(q.add({ tasks: ["ok", "   "] }).error.code, "invalid_task");
});

test("next pulls tasks in order and marks them in_progress", () => {
  const q = createTaskQueue();
  q.add({ tasks: ["a", "b"] });
  const n1 = q.next();
  assert.equal(n1.done, false);
  assert.equal(n1.task.text, "a");
  assert.equal(n1.task.status, "in_progress");
  assert.equal(n1.remaining, 1);
});

test("a task left in_progress is returned again by next, not skipped", () => {
  const q = createTaskQueue();
  q.add({ tasks: ["a", "b"] });
  const first = q.next();
  // Do NOT complete it; calling next again must return the same task.
  const again = q.next();
  assert.equal(again.task.id, first.task.id);
  assert.equal(again.task.text, "a");
});

test("complete advances the queue and next moves to the following task", () => {
  const q = createTaskQueue();
  q.add({ tasks: ["a", "b"] });
  q.next();
  const c = q.complete({ result: "did a" });
  assert.equal(c.ok, true);
  assert.equal(c.task.status, "done");
  assert.equal(c.task.result, "did a");
  const n2 = q.next();
  assert.equal(n2.task.text, "b");
});

test("complete with status failed records a failure", () => {
  const q = createTaskQueue();
  q.add({ text: "risky" });
  q.next();
  const c = q.complete({ status: "failed", result: "blocked" });
  assert.equal(c.task.status, "failed");
  assert.equal(c.failed, 1);
});

test("complete without an active task errors clearly", () => {
  const q = createTaskQueue();
  q.add({ text: "a" });
  assert.equal(q.complete({}).error.code, "no_active_task");
});

test("complete targets a specific id when provided", () => {
  const q = createTaskQueue();
  const added = q.add({ tasks: ["a", "b"] }).added;
  const r = q.complete({ id: added[1].id, result: "out of order" });
  assert.equal(r.task.id, added[1].id);
  assert.equal(r.task.status, "done");
});

test("next on an empty queue returns done with a grounded summary", () => {
  const q = createTaskQueue();
  q.add({ tasks: ["a", "b"] });
  q.next(); q.complete({ result: "ra" });
  q.next(); q.complete({ status: "failed", result: "rb" });
  const fin = q.next();
  assert.equal(fin.done, true);
  assert.equal(fin.remaining, 0);
  assert.equal(fin.completed, 1);
  assert.equal(fin.failed, 1);
  assert.deepEqual(
    fin.tasks.map((t) => [t.text, t.status, t.result]),
    [["a", "done", "ra"], ["b", "failed", "rb"]],
  );
});

test("full add->next->complete loop drains the queue exactly once", () => {
  const q = createTaskQueue();
  q.add({ tasks: ["one", "two", "three"] });
  const processed = [];
  for (let i = 0; i < 10; i += 1) {
    const n = q.next();
    if (n.done) break;
    processed.push(n.task.text);
    q.complete({ result: `done ${n.task.text}` });
  }
  assert.deepEqual(processed, ["one", "two", "three"]);
  assert.equal(q.list().completed, 3);
});

test("clear resets the queue", () => {
  const q = createTaskQueue();
  q.add({ tasks: ["a", "b"] });
  q.next();
  const r = q.clear();
  assert.equal(r.cleared, true);
  assert.equal(r.total, 0);
  assert.equal(q.next().done, true);
});
