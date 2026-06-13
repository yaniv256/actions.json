// Generic in-session task queue for agent-driven multi-step plans.
//
// Externalizes a plan so an agent does not have to hold the whole loop in
// context: seed tasks with add(), pull one at a time with next(), do the work,
// report complete(), and pull the next. On an empty next() the agent learns the
// run is done and gets a summary of every completed/failed task to ground its
// final report. State is encapsulated per instance; createTaskQueue() is called
// once per content-script session.

export function createTaskQueue() {
  let tasks = [];
  let seq = 0;
  let activeId = null;

  const view = (task) => ({
    id: task.id,
    text: task.text,
    status: task.status,
    result: task.result ?? null,
  });

  const summary = () => {
    const done = tasks.filter((t) => t.status === "done").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    const pending = tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
    return {
      total: tasks.length,
      completed: done,
      failed,
      pending,
      tasks: tasks.map(view),
    };
  };

  const ok = (value) => ({ ok: true, ...value });
  const err = (code, message) => ({ ok: false, error: { code, message } });

  const add = (args = {}) => {
    const items = Array.isArray(args.tasks)
      ? args.tasks
      : typeof args.text === "string"
        ? [args.text]
        : null;
    if (!items || items.length === 0) {
      return err("invalid_task", "task.add requires a non-empty 'text' string or a 'tasks' array of strings.");
    }
    const added = [];
    for (const item of items) {
      const text = typeof item === "string" ? item.trim() : "";
      if (!text) {
        return err("invalid_task", "Each task must be a non-empty string.");
      }
      seq += 1;
      const task = { id: `task-${seq}`, text, status: "pending", result: null };
      tasks.push(task);
      added.push(view(task));
    }
    return ok({ added, ...summary() });
  };

  const next = () => {
    // A task left in_progress (agent never reported it) is returned again rather
    // than skipped, so nothing is silently dropped.
    const stale = activeId ? tasks.find((t) => t.id === activeId && t.status === "in_progress") : null;
    const target = stale || tasks.find((t) => t.status === "pending");
    if (!target) {
      activeId = null;
      return ok({ done: true, remaining: 0, ...summary() });
    }
    target.status = "in_progress";
    activeId = target.id;
    const remaining = tasks.filter((t) => t.status === "pending").length;
    return ok({ done: false, task: view(target), remaining });
  };

  const complete = (args = {}) => {
    const targetId = typeof args.id === "string" && args.id ? args.id : activeId;
    if (!targetId) {
      return err("no_active_task", "No task id supplied and no task is in progress. Call task.next first.");
    }
    const task = tasks.find((t) => t.id === targetId);
    if (!task) {
      return err("unknown_task", `No task with id ${targetId}.`);
    }
    task.status = args.status === "failed" ? "failed" : "done";
    if (typeof args.result === "string") {
      task.result = args.result;
    }
    if (activeId === task.id) {
      activeId = null;
    }
    return ok({ task: view(task), ...summary() });
  };

  const list = () => ok(summary());

  const clear = () => {
    tasks = [];
    activeId = null;
    return ok({ cleared: true, ...summary() });
  };

  return { add, next, complete, list, clear };
}
