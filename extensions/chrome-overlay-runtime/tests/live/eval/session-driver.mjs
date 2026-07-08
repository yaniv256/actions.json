// EVAL-U3: drive one task end-to-end against a REAL GPT-Realtime session. No new
// extension code needed — the runtime already exposes the whole session surface as
// bridge tools (runtime.agent.start / user_message / await_event / stop), so the driver
// composes those. NO fake transport (R3): runtime.agent.start uses the real
// HostedRealtimeSessionManager + real WebRTC transport + the real OpenAI key configured
// in the extension.
//
// Completion detection (deferred-question resolution): runtime.agent.await_event blocks
// until the next output event and returns {idle:true, silent_ms} after a quiet window —
// that idle-after-silence IS the "agent finished acting" signal (better than a blind
// sleep). We drain events past our cursor until we see idle for `quietMs`, capturing the
// agent's tool calls along the way (needed by U5/R9), bounded by a per-task ceiling so a
// wedged session becomes a timeout FAILURE, not a hang.
//
// `bridge` is the orchestrator's bound caller: { start(args), userMessage(args),
// awaitEvent(args), stop(args) } -> each returns the MCP tool's parsed output.

export const DEFAULT_QUIET_MS = 4000;      // silence that means "done acting"
export const DEFAULT_CEILING_MS = 120000;  // per-task max wait before timeout-fail

/**
 * Run one task: start (or reuse) a session, inject the prompt, await completion.
 * @returns {Promise<{ ok, timedOut, toolCalls, events, error? }>}
 */
export async function driveTask(bridge, task, opts = {}) {
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const ceilingMs = opts.ceilingMs ?? DEFAULT_CEILING_MS;
  const targetUrlContains = opts.targetUrlContains || 'docs.google.com/document/d/';
  const route = { target_url_contains: targetUrlContains };

  const toolCalls = [];
  const events = [];
  const started = Date.now();

  try {
    if (!opts.sessionAlreadyStarted) {
      await bridge.start({ text_only: true, ...route });
    }
    // Inject the human-phrased prompt as a user message; queue behind any in-flight response.
    await bridge.userMessage({ text: task.prompt, mode: 'queue', ...route });

    // Drain events until a quiet idle or the ceiling.
    let cursor = -1; // replay from the retained queue so we don't miss the response start
    let lastActivity = Date.now();
    let sawActivity = false; // guard against a premature idle before the agent even starts
    while (Date.now() - started < ceilingMs) {
      const remaining = ceilingMs - (Date.now() - started);
      const res = await bridge.awaitEvent({ cursor, timeout_ms: Math.max(1000, Math.min(25000, remaining)), ...route });
      const out = res.output ?? res;
      if (out?.idle) {
        // Idle = no event within the window. Only treat it as "done acting" once we have
        // actually SEEN the agent act (an event) AND it has since been quiet for quietMs.
        // Without the sawActivity guard, a slow-to-start agent's first long idle would be
        // mistaken for completion and we'd score a still-unedited doc.
        if (sawActivity && Date.now() - lastActivity >= quietMs) {
          return { ok: true, timedOut: false, toolCalls, events };
        }
        continue;
      }
      const batch = out?.events || [];
      for (const ev of batch) {
        events.push(ev);
        if (typeof ev.seq === 'number') cursor = Math.max(cursor, ev.seq);
        if (ev.type === 'tool_call' || ev.type === 'tool_result' || (ev.type || '').includes('tool')) toolCalls.push(ev);
      }
      if (batch.length) { lastActivity = Date.now(); sawActivity = true; }
    }
    return { ok: false, timedOut: true, toolCalls, events, error: `ceiling ${ceilingMs}ms reached without idle` };
  } catch (e) {
    return { ok: false, timedOut: false, toolCalls, events, error: String(e && e.message || e) };
  }
}
