// Options page for spec 037: cloud storage config + optional usage-read key.
// Config keys are the contract consumed by background.js and the reconciler:
//   actionsJsonCloudStorage = {bucket, region, prefix, accessKeyId, secretAccessKey}
//   actionsJsonUsageReadKey = string
// Secrets are never logged or echoed back into the page beyond the input state.

import { createCloudStore } from "./agent/cloud-store.mjs";
import {
  bridgePairingState,
  removeBridgePairingSecret,
  saveBridgePairingSecret,
} from "./agent/bridge-pairing-settings.mjs";
import { bridgeConnectionEntries } from "./agent/bridge-connection-log.mjs";

const $ = (id) => document.getElementById(id);
const FIELDS = ["bucket", "region", "prefix", "accessKeyId", "secretAccessKey"];

function readForm() {
  const config = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  if (!config.prefix) config.prefix = "actions-json";
  const complete = FIELDS.every((f) => config[f]);
  return complete ? config : null;
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = ok ? "ok" : "err";
}

function renderBridgeConnectionLog(entries) {
  const list = $("bridge-connection-log");
  list.replaceChildren();
  $("bridge-connection-empty").hidden = entries.length > 0;
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = `connection-log-entry connection-log-entry--${entry.status}`;

    const heading = document.createElement("div");
    heading.className = "connection-log-heading";
    const status = document.createElement("strong");
    status.textContent = entry.status;
    const time = document.createElement("time");
    time.dateTime = entry.timestamp;
    time.textContent = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "Time unavailable";
    heading.append(status, time);

    const summary = document.createElement("div");
    summary.textContent = `${entry.stage}: ${entry.summary}`;
    item.append(heading, summary);

    if (entry.detail) {
      const detail = document.createElement("code");
      detail.textContent = entry.detail;
      item.append(detail);
    }

    const context = document.createElement("small");
    context.textContent = [
      entry.bridgeUrl || "Bridge URL unavailable",
      entry.extensionVersion ? `extension ${entry.extensionVersion}` : "",
      entry.extensionId ? `ID ${entry.extensionId}` : "",
    ].filter(Boolean).join(" · ");
    item.append(context);
    list.append(item);
  }
}

async function refreshBridgeConnectionLog() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "actions-json:agent-session-log",
      limit: 40,
    });
    const manifest = chrome.runtime.getManifest();
    renderBridgeConnectionLog(bridgeConnectionEntries(response?.log?.events, {
      extensionId: chrome.runtime.id,
      extensionVersion: manifest.version,
    }));
  } catch (error) {
    renderBridgeConnectionLog([{
      timestamp: new Date().toISOString(),
      status: "failed",
      stage: "diagnostics",
      summary: "The extension could not load its connection history.",
      detail: error?.message || String(error),
      bridgeUrl: $("bridgeUrl").value.trim(),
      extensionId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
    }]);
  }
}

async function load() {
  const stored = await chrome.storage.local.get([
    "actionsJsonCloudStorage",
    "actionsJsonUsageReadKey",
    "bridgeUrl",
  ]);
  const config = stored.actionsJsonCloudStorage;
  if (config) for (const f of FIELDS) $(f).value = config[f] ?? "";
  if (stored.actionsJsonUsageReadKey) $("usageReadKey").value = stored.actionsJsonUsageReadKey;
  $("bridgeUrl").value = stored.bridgeUrl || "ws://127.0.0.1:17345/extension";
  const pairing = await bridgePairingState(chrome.storage.local);
  setStatus(
    $("bridge-pairing-status"),
    pairing.paired ? "A bridge secret is saved on this browser." : "No bridge secret is saved.",
    pairing.paired,
  );
  await refreshBridgeConnectionLog();
}

$("save-bridge-pairing").addEventListener("click", async () => {
  const bridgeUrl = $("bridgeUrl").value.trim();
  if (!/^wss?:\/\//i.test(bridgeUrl)) {
    setStatus($("bridge-pairing-status"), "Enter a ws:// or wss:// bridge URL.", false);
    return;
  }
  await chrome.storage.local.set({ bridgeUrl });
  setStatus($("bridge-pairing-status"), "Saving and verifying the secure bridge…", true);
  const result = await saveBridgePairingSecret({
    storageArea: chrome.storage.local,
    runtime: chrome.runtime,
    value: $("bridgeHandshakeSecret").value,
    bridgeUrl,
  });
  if (result.ok) {
    $("bridgeHandshakeSecret").value = "";
    setStatus(
      $("bridge-pairing-status"),
      "✓ Coding agent connected. Switch to a website tab and choose Take control.",
      true,
    );
  } else {
    setStatus($("bridge-pairing-status"), result.message, false);
  }
  await refreshBridgeConnectionLog();
});

$("remove-bridge-pairing").addEventListener("click", async () => {
  await removeBridgePairingSecret({
    storageArea: chrome.storage.local,
    runtime: chrome.runtime,
  });
  $("bridgeHandshakeSecret").value = "";
  setStatus($("bridge-pairing-status"), "Bridge secret removed. Connections now fail closed.", true);
  await refreshBridgeConnectionLog();
});

$("refresh-bridge-log").addEventListener("click", refreshBridgeConnectionLog);

$("save").addEventListener("click", async () => {
  const config = readForm();
  if (!config) {
    setStatus($("status"), "All five fields are required (or clear all to disable).", false);
    const empty = FIELDS.every((f) => !$(f).value.trim());
    if (empty) {
      await chrome.storage.local.remove("actionsJsonCloudStorage");
      setStatus($("status"), "Cloud storage disabled.", true);
    }
    return;
  }
  await chrome.storage.local.set({ actionsJsonCloudStorage: config });
  setStatus($("status"), "Saved.", true);
});

$("test").addEventListener("click", async () => {
  const config = readForm();
  if (!config) {
    setStatus($("status"), "Fill in all fields before testing.", false);
    return;
  }
  setStatus($("status"), "Writing probe object…", true);
  const store = createCloudStore({ getConfig: async () => config });
  const res = await store.testWrite();
  if (res.ok) {
    setStatus($("status"), "✓ Wrote probe object to the bucket.", true);
  } else {
    setStatus($("status"), `Test write failed: ${res.error}`, false);
  }
});

$("save-usage").addEventListener("click", async () => {
  const key = $("usageReadKey").value.trim();
  if (key) {
    await chrome.storage.local.set({ actionsJsonUsageReadKey: key });
    setStatus($("usage-status"), "Usage-read key saved.", true);
  } else {
    await chrome.storage.local.remove("actionsJsonUsageReadKey");
    setStatus($("usage-status"), "Usage-read key removed.", true);
  }
});

load();
