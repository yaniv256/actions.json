// U3 — RunLifecycle: the eval run's process-ownership manager (R1, KTD1).
//
// The single owning node process registers every long-lived child it starts (the serve
// bridge, the deployed Chrome) with a kill fn, and calls teardown() exactly once in finally.
// teardown() runs the kills in REVERSE registration order (children torn down before the
// things they depend on), is idempotent (safe to call from finally AND a signal handler),
// and NEVER throws — one failing kill must not strand its siblings, or a single stuck child
// would leak the rest.
export class RunLifecycle {
  constructor() {
    this._kills = []; // [{ name, killFn }] in registration order
    this._torndown = false;
  }

  // Register a child's kill fn. name is for logging/diagnostics only.
  register(name, killFn) {
    this._kills.push({ name, killFn });
  }

  // Kill every registered child once, in reverse order. Swallows individual errors so one
  // bad kill can't strand the others; resolves even if some kills throw.
  async teardown() {
    if (this._torndown) return;
    this._torndown = true;
    for (let i = this._kills.length - 1; i >= 0; i--) {
      const { name, killFn } = this._kills[i];
      try {
        await killFn();
      } catch (e) {
        // Log, don't propagate — a stuck/failing kill must not block the rest.
        console.warn(`[lifecycle] kill "${name}" failed: ${String(e && e.message || e)}`);
      }
    }
  }
}
