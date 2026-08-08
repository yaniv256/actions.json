const BRIDGE_EVENT_PREFIX = "background.bridge.";

const safeText = (value) => typeof value === "string" ? value : "";

export const bridgeConnectionEntries = (
  events,
  { extensionId = "", extensionVersion = "", limit = 8 } = {},
) => {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  return (Array.isArray(events) ? events : [])
    .filter((event) => safeText(event?.name).startsWith(BRIDGE_EVENT_PREFIX))
    .slice(-boundedLimit)
    .reverse()
    .map((event) => {
      const error = safeText(event?.output?.error_message);
      const attempt = event.name === "background.bridge.pairing";
      return {
        timestamp: safeText(event.timestamp),
        status: attempt ? "attempt" : event.ok === true ? "connected" : "failed",
        stage: event.name.slice(BRIDGE_EVENT_PREFIX.length).replaceAll(".", " · "),
        summary: safeText(event.summary) || (error ? "Connection failed." : "Connection event."),
        detail: error,
        bridgeUrl: safeText(event?.input?.bridge_url),
        extensionId: safeText(extensionId),
        extensionVersion: safeText(extensionVersion),
      };
    });
};
