const identifier = /^[A-Za-z0-9_.:-]{1,128}$/;

function parseArguments(value) {
  if (typeof value !== "string" || value.length > 64 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function terminalForModel(result, callId) {
  if (!result || result.call_id !== callId) {
    return { ok: false, error: { code: "invalid_host_result" } };
  }
  if (result.type === "action_call_output") return result.output;
  if (result.type === "action_error") return { ok: false, error: result.error };
  return { ok: false, error: { code: "invalid_host_result" } };
}

function serializeOutput(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? serialized
      : JSON.stringify({ ok: false, error: { code: "invalid_host_result" } });
  } catch {
    return JSON.stringify({ ok: false, error: { code: "invalid_host_result" } });
  }
}

/**
 * Bind one resolved actions.json host to OpenAI Realtime event envelopes.
 *
 * This adapter owns no WebRTC, WebSocket, key, account, or UI lifecycle. Its
 * send function is the transport seam. It never falls back to a second action
 * path: the host catalog and handleActionCall boundary remain authoritative.
 */
export class RealtimeAgentAdapter {
  #host;
  #dictionary;
  #send;
  #continueResponse;
  #onToolEvent;

  constructor({ host, dictionary, send, continueResponse = true, onToolEvent = null } = {}) {
    if (!host || typeof host.catalog !== "function" || typeof host.handleActionCall !== "function") {
      throw new TypeError("RealtimeAgentAdapter requires an actions.json host");
    }
    if (!dictionary || !Array.isArray(dictionary.primitives)) {
      throw new TypeError("RealtimeAgentAdapter requires a canonical dictionary");
    }
    if (typeof send !== "function") {
      throw new TypeError("RealtimeAgentAdapter requires a send function");
    }
    this.#host = host;
    this.#dictionary = dictionary;
    this.#send = send;
    this.#continueResponse = Boolean(continueResponse);
    this.#onToolEvent = typeof onToolEvent === "function" ? onToolEvent : null;
  }

  tools() {
    const advertised = new Set(this.#host.catalog().advertised ?? []);
    return this.#dictionary.primitives
      .filter((primitive) => advertised.has(primitive.name))
      .map((primitive) => ({
        type: "function",
        name: primitive.name,
        description: primitive.summary ?? primitive.name,
        parameters: primitive.input_schema ?? { type: "object", properties: {} },
      }));
  }

  sessionUpdate(instructions) {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        instructions,
        tool_choice: "auto",
        tools: this.tools(),
      },
    };
  }

  async handleEvent(event) {
    if (event?.type !== "response.done") return { handled: false, calls: 0 };
    const calls = (event.response?.output ?? []).filter((item) => item?.type === "function_call");
    if (calls.length === 0) return { handled: false, calls: 0 };

    for (const call of calls) {
      const callId = identifier.test(call.call_id ?? "") ? call.call_id : null;
      const name = identifier.test(call.name ?? "") ? call.name : null;
      const args = parseArguments(call.arguments);
      let output;
      if (!callId || !name || args === null) {
        output = { ok: false, error: { code: "invalid_action_call" } };
      } else {
        this.#onToolEvent?.({
          eventType: "tool.call",
          outcome: "success",
          payload: { call_id: callId, name, arguments: args },
        });
        try {
          const result = await this.#host.handleActionCall({
            call_id: callId,
            primitive: name,
            arguments: args,
          });
          output = terminalForModel(result, callId);
        } catch {
          output = { ok: false, error: { code: "action_host_call_failed" } };
        }
      }
      const failed = output && typeof output === "object" && output.ok === false;
      this.#onToolEvent?.({
        eventType: "tool.result",
        outcome: failed ? "failure" : "success",
        payload: {
          call_id: callId ?? "invalid_call",
          name: name ?? "unknown_tool",
          ...(failed ? { reason: output.error?.code ?? "invalid_action_call" } : {}),
        },
      });
      await this.#send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId ?? "invalid_call",
          output: serializeOutput(output),
        },
      });
    }
    if (this.#continueResponse) await this.#send({ type: "response.create" });
    return { handled: true, calls: calls.length };
  }
}
