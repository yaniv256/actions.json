const errorMessage = (error) => String(error?.message || error || "");

const isAlreadyAttachedError = (error) =>
  /already attached/i.test(errorMessage(error));

const isNotAttachedError = (error) =>
  /not attached/i.test(errorMessage(error));

const MAX_ATTACHMENT_STABILIZATION_ATTEMPTS = 3;
const EXTERNAL_DEBUGGER_NEXT_STEP =
  "Close DevTools or release the other debugger attached to this tab, then retry the action.";

const externalDebuggerOwnershipError = (cause) => {
  const error = new Error(
    "This tab is controlled by DevTools or another debugger, so actions.json cannot use trusted browser controls.",
    { cause },
  );
  error.code = "debugger_owned_externally";
  error.recoverable = true;
  error.retryable = false;
  error.next_step = EXTERNAL_DEBUGGER_NEXT_STEP;
  return error;
};

/**
 * Coordinates every chrome.debugger consumer for a tab.
 *
 * Logical holders belong to extension consumers and survive a browser-driven
 * detach. Physical attachment state belongs to Chrome and is repaired before
 * a holder is granted or attested. Keeping those two lifecycles separate is
 * essential: deleting holders on onDetach lets a transient operation release
 * the persistent a11y/avatar holder and detach underneath it.
 */
export class DebuggerSessionManager {
  constructor({ attach, detach, sendCommand }) {
    if (typeof attach !== "function" || typeof detach !== "function" || typeof sendCommand !== "function") {
      throw new TypeError("DebuggerSessionManager requires attach, detach, and sendCommand functions");
    }

    this.attach = attach;
    this.detach = detach;
    this.sendCommand = sendCommand;
    this.states = new Map();
    this.queues = new Map();
  }

  stateFor(tabId) {
    let state = this.states.get(tabId);
    if (!state) {
      state = {
        holders: 0,
        attachment: "detached", // detached | owned | adopted | pending-detach
        generation: 0,
      };
      this.states.set(tabId, state);
    }
    return state;
  }

  holderCount(tabId) {
    return this.states.get(tabId)?.holders || 0;
  }

  async withTabLock(tabId, operation) {
    const previous = this.queues.get(tabId) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    const tail = task.catch(() => {});
    this.queues.set(tabId, tail);

    try {
      return await task;
    } finally {
      if (this.queues.get(tabId) === tail) this.queues.delete(tabId);
    }
  }

  probe(tabId) {
    return this.sendCommand(
      { tabId },
      "Runtime.evaluate",
      { expression: "void 0", returnByValue: true },
    );
  }

  async finishPendingDetach(tabId, state) {
    if (state.attachment !== "pending-detach") return;
    try {
      await this.detach({ tabId });
    } catch (error) {
      if (!isNotAttachedError(error)) throw error;
    }
    state.attachment = "detached";
  }

  async attachOrAdopt(tabId, state) {
    try {
      await this.attach({ tabId });
      state.attachment = "owned";
      return;
    } catch (error) {
      if (!isAlreadyAttachedError(error)) throw error;
    }

    // chrome.debugger.attach also reports "already attached" when another
    // extension or DevTools owns the target. Only adopt a session if this
    // extension can actually issue commands through it.
    try {
      await this.probe(tabId);
    } catch (error) {
      if (isNotAttachedError(error)) throw externalDebuggerOwnershipError(error);
      throw error;
    }
    state.attachment = "adopted";
  }

  async establishAttachment(tabId, state) {
    if (state.attachment === "owned" || state.attachment === "adopted") {
      try {
        await this.probe(tabId);
        return;
      } catch (error) {
        if (!isNotAttachedError(error)) throw error;
        state.attachment = "detached";
      }
    }

    await this.attachOrAdopt(tabId, state);
  }

  async ensureStableAttachment(tabId, state) {
    // Finish cleanup from a prior failed final release before capturing the
    // generation fence. Chrome emits onDetach for this manager-initiated
    // detach; that expected transition must not invalidate the fresh attach
    // established in the following stabilization attempt.
    await this.finishPendingDetach(tabId, state);
    for (let attempt = 0; attempt < MAX_ATTACHMENT_STABILIZATION_ATTEMPTS; attempt += 1) {
      const generation = state.generation;
      await this.establishAttachment(tabId, state);
      if (state.generation === generation &&
          (state.attachment === "owned" || state.attachment === "adopted")) {
        return;
      }
      // onDetach landed while attach/probe was awaiting. Its event is the
      // authoritative physical-state transition, even if a stale callback
      // subsequently resolved successfully, so repair again before returning.
      state.attachment = "detached";
    }
    throw new Error(`Debugger attachment for tab ${tabId} did not stabilize`);
  }

  acquire(tabId) {
    return this.withTabLock(tabId, async () => {
      const state = this.stateFor(tabId);
      await this.ensureStableAttachment(tabId, state);
      state.holders += 1;
    });
  }

  attestHeld(tabId) {
    return this.withTabLock(tabId, async () => {
      const state = this.stateFor(tabId);
      await this.ensureStableAttachment(tabId, state);
      if (state.holders === 0) state.holders = 1;
    });
  }

  release(tabId) {
    return this.withTabLock(tabId, async () => {
      const state = this.states.get(tabId);
      if (!state) return;

      if (state.holders > 1) {
        state.holders -= 1;
        return;
      }
      if (state.holders === 1) state.holders = 0;

      if (state.attachment === "adopted" || state.attachment === "detached") {
        this.states.delete(tabId);
        return;
      }

      if (state.attachment === "owned" || state.attachment === "pending-detach") {
        state.attachment = "pending-detach";
        try {
          await this.detach({ tabId });
        } catch (error) {
          if (!isNotAttachedError(error)) throw error;
        }
        state.attachment = "detached";
        this.states.delete(tabId);
      }
    });
  }

  handleDetach(tabId) {
    const state = this.states.get(tabId);
    if (!state) return;
    state.generation += 1;
    state.attachment = "detached";
    // Deliberately retain state.holders. Chrome lost the physical session;
    // extension consumers did not relinquish their logical ownership.
  }

  handleTabRemoved(tabId) {
    return this.withTabLock(tabId, async () => {
      this.states.delete(tabId);
    });
  }
}
