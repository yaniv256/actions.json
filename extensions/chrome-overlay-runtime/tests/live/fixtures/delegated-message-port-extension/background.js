const events = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "delegated-port-probe:event") {
    events.push({
      ...message.event,
      sender: {
        tabId: sender.tab?.id ?? null,
        frameId: sender.frameId ?? null,
        documentId: sender.documentId ?? null,
        url: sender.url ?? null,
      },
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "delegated-port-probe:events") {
    sendResponse({ ok: true, events: structuredClone(events) });
    return false;
  }
  return false;
});

self.__delegatedPortProbeEvents = () => structuredClone(events);
