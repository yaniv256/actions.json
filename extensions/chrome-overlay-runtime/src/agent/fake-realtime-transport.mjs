export class FakeRealtimeTransportFactory {
  constructor() {
    this.transports = [];
  }

  create({ model }) {
    const transport = {
      model,
      connected: false,
      closed: false,
      events: [],
      async connect() {
        const errorConfig = globalThis.__ACTIONS_JSON_FAKE_REALTIME_CONNECT_ERROR;
        if (errorConfig) {
          const error = new Error(errorConfig.message || "Fake Realtime connect failed");
          error.name = errorConfig.name || "Error";
          throw error;
        }
        this.connected = true;
      },
      async sendEvent(event) {
        this.events.push(event);
      },
      async close() {
        this.closed = true;
      },
      async setInputMuted(muted) {
        this.inputMuted = Boolean(muted);
      },
      async setOutputMuted(muted) {
        this.outputMuted = Boolean(muted);
      },
    };
    this.transports.push(transport);
    return transport;
  }
}
