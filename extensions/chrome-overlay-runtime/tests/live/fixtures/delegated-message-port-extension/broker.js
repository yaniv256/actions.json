(() => {
  if (window !== top) {
    chrome.runtime.sendMessage({
      type: "delegated-port-probe:event",
      event: { name: "iframe-denied", href: location.href },
    }).catch(() => {});
    return;
  }

  globalThis.__DELEGATED_ISOLATED_SECRET__ = "isolated-only";
  const sourceOrigin = location.origin;
  let activePort = null;
  let generation = 0;

  const report = (name, extra = {}) => chrome.runtime.sendMessage({
    type: "delegated-port-probe:event",
    event: { name, href: location.href, generation, ...extra },
  }).catch(() => {});

  const closePort = (reason) => {
    if (!activePort) return;
    activePort.close();
    activePort = null;
    report("port-closed", { reason });
  };

  const handshake = (reason) => {
    closePort("replaced");
    generation += 1;
    const nonce = crypto.randomUUID();
    const channel = new MessageChannel();
    activePort = channel.port1;
    activePort.onmessage = (event) => {
      const envelope = event.data;
      if (envelope?.nonce !== nonce || envelope?.generation !== generation) {
        report("private-port-envelope-denied", { reason: "identity-mismatch" });
        return;
      }
      if (envelope.type === "page-ping") {
        activePort.postMessage({ type: "isolated-pong", nonce, generation, sequence: envelope.sequence });
        report("page-ping-received", { sequence: envelope.sequence });
      } else if (envelope.type === "page-pong") {
        report("page-pong-received", { sequence: envelope.sequence });
      }
    };
    activePort.start();
    try {
      window.postMessage({
        type: "actions-json:delegated-port-probe",
        nonce,
        generation,
        reason,
      }, sourceOrigin, [channel.port2]);
      activePort.postMessage({ type: "isolated-ping", nonce, generation, sequence: 1 });
      report("port-transferred", {
        reason,
        isolatedSeesMainSecret: typeof window.__DELEGATED_MAIN_SECRET__,
      });
    } catch (error) {
      report("port-transfer-threw", { reason, error: error?.message || String(error) });
    }
  };

  window.addEventListener("pagehide", (event) => {
    report("pagehide", { persisted: event.persisted });
    closePort("pagehide");
  });
  window.addEventListener("pageshow", (event) => {
    report("pageshow", { persisted: event.persisted });
    setTimeout(() => handshake(event.persisted ? "bfcache-restore" : "initial-pageshow"), 0);
  });
  report("broker-installed", {
    isolatedSeesMainSecret: typeof window.__DELEGATED_MAIN_SECRET__,
  });
})();
