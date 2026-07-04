// Options page for spec 037: cloud storage config + optional usage-read key.
// Config keys are the contract consumed by background.js and the reconciler:
//   actionsJsonCloudStorage = {bucket, region, prefix, accessKeyId, secretAccessKey}
//   actionsJsonUsageReadKey = string
// Secrets are never logged or echoed back into the page beyond the input state.

import { createCloudStore } from "./agent/cloud-store.mjs";

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

async function load() {
  const stored = await chrome.storage.local.get([
    "actionsJsonCloudStorage",
    "actionsJsonUsageReadKey",
  ]);
  const config = stored.actionsJsonCloudStorage;
  if (config) for (const f of FIELDS) $(f).value = config[f] ?? "";
  if (stored.actionsJsonUsageReadKey) $("usageReadKey").value = stored.actionsJsonUsageReadKey;
}

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
