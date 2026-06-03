chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("bridgeUrl");
  if (!existing.bridgeUrl) {
    await chrome.storage.local.set({ bridgeUrl: "ws://127.0.0.1:17345/extension" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "actions-json:capture-visible-tab") {
    return false;
  }

  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  const delayMs = Number.isFinite(message.delayMs)
    ? Math.max(0, Math.min(30_000, Math.floor(message.delayMs)))
    : 0;
  const capture = () => {
    chrome.tabs.captureVisibleTab(
      windowId,
      {
        format: message.format === "jpeg" ? "jpeg" : "png",
        quality: Number.isInteger(message.quality) ? message.quality : undefined,
      },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      }
    );
  };

  if (tabId) {
    chrome.tabs.update(tabId, { active: true }, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      setTimeout(capture, delayMs);
    });
  } else {
    setTimeout(capture, delayMs);
  }

  return true;
});
