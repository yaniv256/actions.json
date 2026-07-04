// Spec 038: map a hosted-agent session event to the compact agent-output
// event forwarded to the bridge, or null to drop it. Only agent OUTPUT is
// forwarded — assistant responses, tool calls/results, refusals, and session
// lifecycle. Realtime deltas, audio-transcript chunks, user-role transcripts,
// and heartbeats are dropped so the supervisor's await_event stream stays the
// supervision signal, not noise.

export function agentEventFromSessionEvent(event) {
  if (!event || typeof event !== "object") return null;
  const type = event.type;

  // Assistant transcript = an agent response. User-role transcripts are the
  // supervisor's own injected prompts — not agent output — so drop them.
  if (type === "transcript") {
    if (event.role !== "assistant") return null;
    return { kind: "transcript", payload: { role: "assistant", text: event.text ?? "" } };
  }

  // A completed tool call (name + ok flag). The realtime "tool" events the
  // session manager records carry name/ok/error.
  if (type === "tool") {
    return {
      kind: "tool",
      payload: { name: event.name ?? null, ok: event.ok ?? null, error: event.error ?? null },
    };
  }

  // A refusal / direct-fallback policy exception.
  if (type === "policy_exception") {
    return {
      kind: "refusal",
      payload: { tool: event.tool ?? null, reason: event.reason ?? null },
    };
  }

  // Session lifecycle (started / stopped / idle / error).
  if (type === "session") {
    return { kind: "lifecycle", payload: { state: event.state ?? event.status ?? null } };
  }

  // Everything else — realtime deltas, audio-transcript chunks, session.update,
  // the actions_json.* duplicates, heartbeats — is dropped.
  return null;
}
