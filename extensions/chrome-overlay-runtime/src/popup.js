const statusEl = document.getElementById("status");
const bridgeUrlEl = document.getElementById("bridgeUrl");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b64040" : "#24744a";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

document.getElementById("authorize").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    const bridgeUrl = bridgeUrlEl.value.trim() || "ws://127.0.0.1:17345/extension";
    await chrome.storage.local.set({ bridgeUrl });
    const response = await chrome.runtime.sendMessage({
      type: "actions-json:authorize-tab",
      tabId: tab.id,
      bridgeUrl,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Authorization failed");
    }
    setStatus("Authorized and connecting.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.getElementById("closeOverlay").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    await chrome.tabs.sendMessage(tab.id, { type: "actions-json:close-overlay" });
    setStatus("Close request sent.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});
