const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:17345/extension";

export const bridgeHttpOrigin = (bridgeUrl = DEFAULT_BRIDGE_URL) => {
  const url = new URL(bridgeUrl || DEFAULT_BRIDGE_URL);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

const runtimePresent = (payload, runtimeId) =>
  Array.isArray(payload?.runtimes)
  && payload.runtimes.some((runtime) => runtime?.runtime_id === runtimeId);

export async function waitForBridgeRuntime({
  bridgeUrl,
  runtimeId,
  fetchImpl = fetch,
  timeoutMs = 4_000,
  pollMs = 100,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!runtimeId) {
    throw new Error("The extension connected but did not report a runtime ID.");
  }
  const endpoint = `${bridgeHttpOrigin(bridgeUrl)}/runtimes`;
  const deadline = now() + timeoutMs;
  let lastError = null;

  do {
    try {
      const response = await fetchImpl(endpoint);
      if (!response.ok) throw new Error(`Bridge runtime check returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (runtimePresent(payload, runtimeId)) {
        return { ok: true, runtimeId };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  } while (now() < deadline);

  throw new Error(
    lastError?.message
      || `The secure bridge opened, but runtime ${runtimeId} did not register within ${timeoutMs} ms.`,
  );
}
