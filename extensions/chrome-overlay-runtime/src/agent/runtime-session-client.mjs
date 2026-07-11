import { DEFAULT_MODEL } from "./realtime-model.mjs";

export function createRuntimeHostedSessionClient({
  chromeApi = globalThis.chrome,
  eventObserver = null,
} = {}) {
  if (!chromeApi?.runtime?.sendMessage) {
    throw new Error("createRuntimeHostedSessionClient requires chrome.runtime messaging");
  }
  const observer = typeof eventObserver === "function" ? eventObserver : null;
  let state = {
    status: "disconnected",
    model: DEFAULT_MODEL,
    error: null,
    inputMuted: false,
    outputMuted: false,
    textOnly: true,
  };
  let tools = [];

  chromeApi.runtime.onMessage?.addListener?.((message) => {
    if (message?.type !== "actions-json:agent-session-event") {
      return false;
    }
    if (message.state && typeof message.state === "object") {
      state = { ...state, ...message.state };
    }
    if (message.event) {
      observer?.(message.event);
    }
    return false;
  });

  const sendCommand = async (type, payload = {}) => {
    const response = await chromeApi.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) {
      throw new Error(response?.error || `${type} failed`);
    }
    if (response.state && typeof response.state === "object") {
      state = { ...state, ...response.state };
    }
    return { ...state };
  };

  return {
    getState() {
      return { ...state };
    },
    setTools(nextTools = []) {
      tools = Array.isArray(nextTools) ? nextTools : [];
      chromeApi.runtime.sendMessage({ type: "actions-json:agent-session-tools", tools }).catch(() => {});
      return tools;
    },
    async start({ textOnly = true } = {}) {
      return sendCommand("actions-json:agent-session-start", { textOnly, tools });
    },
    async refreshState() {
      return sendCommand("actions-json:agent-session-state");
    },
    async setInputMuted(muted = true) {
      return sendCommand("actions-json:agent-session-mute", { muted: Boolean(muted) });
    },
    async setOutputMuted(muted = true) {
      return sendCommand("actions-json:agent-session-output-mute", { muted: Boolean(muted) });
    },
    async sendUserMessage({ text } = {}) {
      const response = await chromeApi.runtime.sendMessage({
        type: "actions-json:agent-session-user-message",
        text,
      });
      if (!response?.ok) {
        throw new Error(response?.error || "actions-json:agent-session-user-message failed");
      }
      if (response.state && typeof response.state === "object") {
        state = { ...state, ...response.state };
      }
      return response.result || response;
    },
    async stop() {
      return sendCommand("actions-json:agent-session-stop");
    },
    async closeDurableSession() {
      return sendCommand("actions-json:agent-session-close");
    },
  };
}

export function createUnavailableHostedSessionClient({
  message = "Extension runtime messaging unavailable",
} = {}) {
  let state = {
    status: "disconnected",
    model: DEFAULT_MODEL,
    error: null,
    inputMuted: false,
    outputMuted: false,
    textOnly: true,
  };

  return {
    getState() {
      return { ...state };
    },
    setTools(nextTools = []) {
      return Array.isArray(nextTools) ? nextTools : [];
    },
    async start() {
      state = { ...state, status: "error", error: message };
      throw new Error(message);
    },
    async refreshState() {
      return { ...state };
    },
    async setInputMuted() {
      state = { ...state, status: "error", error: message };
      throw new Error(message);
    },
    async setOutputMuted() {
      state = { ...state, status: "error", error: message };
      throw new Error(message);
    },
    async sendUserMessage() {
      state = { ...state, status: "error", error: message };
      throw new Error(message);
    },
    async stop() {
      state = { ...state, status: "stopped", error: null };
      return { ...state };
    },
    async closeDurableSession() {
      state = { ...state, status: "stopped", error: null };
      return { ...state };
    },
  };
}
