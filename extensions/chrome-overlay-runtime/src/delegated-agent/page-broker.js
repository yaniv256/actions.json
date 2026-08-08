// Minimal isolated-world broker for empowered website agents. This classic
// content script observes only the declarative discovery link and, after an
// extension-authorized activation message, relays bounded call envelopes over a
// private MessagePort. It never grants authority or broadcasts tool results.
(function () {
  "use strict";

  const DISCOVERY_SELECTOR = 'link[rel~="actions-json-agent"]';
  const DEFAULT_LIMITS = Object.freeze({
    maxEnvelopeBytes: 32 * 1024,
    maxOutstandingCalls: 16,
    maxCallsPerMinute: 30,
    maxObserverMutations: 128,
    observerLifetimeMs: 30_000,
  });

  const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
  const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
  const envelopeBytes = (value) => {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Infinity; }
  };

  function createPageBroker(deps) {
    const doc = deps.doc;
    const win = deps.win;
    const runtime = deps.runtime;
    const MutationObserverCtor = deps.MutationObserverCtor;
    const MessageChannelCtor = deps.MessageChannelCtor;
    const cryptoLike = deps.cryptoLike;
    const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
    const cancelSchedule = deps.cancelSchedule || ((id) => clearTimeout(id));
    const now = deps.now || Date.now;
    const limits = { ...DEFAULT_LIMITS, ...deps };

    let started = false;
    let stopped = false;
    let observer = null;
    let observerTimer = null;
    let mutationCount = 0;
    let lastDiscoveredHref = null;
    let port = null;
    let portNonce = null;
    let lastSequence = 0;
    let callTimestamps = [];
    const outstanding = new Set();

    const sendRuntime = (message) => Promise.resolve(runtime.sendMessage(message));

    const scanDiscovery = () => {
      if (stopped) return;
      let href = null;
      try {
        const link = doc.querySelector(DISCOVERY_SELECTOR);
        href = isNonEmptyString(link?.href) ? link.href : null;
      } catch (_error) { href = null; }
      if (href === lastDiscoveredHref) return;
      lastDiscoveredHref = href;
      if (href) sendRuntime({ type: "actions-json:delegated-agent-discovery", href }).catch(() => {});
    };

    const disconnectObserver = () => {
      observer?.disconnect();
      observer = null;
      if (observerTimer !== null) cancelSchedule(observerTimer);
      observerTimer = null;
    };

    const armObserver = () => {
      disconnectObserver();
      if (stopped) return;
      const target = doc.head || doc.documentElement;
      if (!target) {
        observerTimer = schedule(armObserver, 0);
        return;
      }
      mutationCount = 0;
      observer = new MutationObserverCtor((records) => {
        mutationCount += Array.isArray(records) ? records.length : 1;
        scanDiscovery();
        if (mutationCount >= limits.maxObserverMutations) disconnectObserver();
      });
      observer.observe(target, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["href", "rel"],
      });
      observerTimer = schedule(disconnectObserver, limits.observerLifetimeMs);
    };

    const closePort = () => {
      try { port?.close(); } catch (_error) {}
      port = null;
      portNonce = null;
      lastSequence = 0;
      outstanding.clear();
      callTimestamps = [];
    };

    const postError = (callId, sequence, code, message) => {
      try {
        port?.postMessage({ type: "error", portNonce, sequence, callId: callId || null, code, message });
      } catch (_error) {}
    };

    const acceptRate = () => {
      const cutoff = now() - 60_000;
      callTimestamps = callTimestamps.filter((timestamp) => timestamp > cutoff);
      if (callTimestamps.length >= limits.maxCallsPerMinute) return false;
      callTimestamps.push(now());
      return true;
    };

    const handlePortMessage = async (event) => {
      const envelope = event?.data;
      const sequence = envelope?.sequence;
      const callId = envelope?.callId;
      if (!isRecord(envelope) || envelope.portNonce !== portNonce) {
        postError(callId, sequence, "port_identity_mismatch", "The private port identity does not match the active lease.");
        return;
      }
      if (envelopeBytes(envelope) > limits.maxEnvelopeBytes) {
        postError(callId, sequence, "envelope_too_large", "The call envelope exceeds the private-channel size limit.");
        return;
      }
      if (!Number.isInteger(sequence) || sequence !== lastSequence + 1) {
        postError(callId, sequence, "sequence_invalid", "The call sequence is stale, replayed, or out of order.");
        return;
      }
      lastSequence = sequence;
      if (envelope.type !== "call" || !isNonEmptyString(callId) || !isNonEmptyString(envelope.name) || !isRecord(envelope.arguments)) {
        postError(callId, sequence, "call_invalid", "The private-channel call envelope is invalid.");
        return;
      }
      if (outstanding.has(callId)) {
        postError(callId, sequence, "call_already_outstanding", "Only one outstanding result is allowed per call ID.");
        return;
      }
      if (outstanding.size >= limits.maxOutstandingCalls) {
        postError(callId, sequence, "queue_overflow", "The private-channel outstanding-call queue is full.");
        return;
      }
      if (!acceptRate()) {
        postError(callId, sequence, "rate_exceeded", "The private-channel call rate has been exceeded.");
        return;
      }
      outstanding.add(callId);
      try {
        const response = await sendRuntime({
          type: "actions-json:delegated-agent-call",
          portNonce,
          sequence,
          callId,
          name: envelope.name,
          arguments: envelope.arguments,
        });
        if (!outstanding.delete(callId) || !port) return;
        port.postMessage({
          type: "result",
          portNonce,
          sequence,
          callId,
          ok: response?.ok === true,
          ...(response?.ok === true ? { output: response.output } : { error: response?.error || { code: "call_failed" } }),
        });
      } catch (error) {
        if (!outstanding.delete(callId) || !port) return;
        postError(callId, sequence, "call_failed", error?.message || String(error));
      }
    };

    const activate = (message) => {
      if (!isNonEmptyString(message?.portNonce)) throw new TypeError("Activation port nonce is required");
      if (message.sourceOrigin !== win.location.origin) throw new TypeError("Activation origin does not match this document");
      closePort();
      const channel = new MessageChannelCtor();
      port = channel.port1;
      portNonce = message.portNonce;
      port.onmessage = handlePortMessage;
      port.start?.();
      win.postMessage({
        type: "actions-json:delegated-agent-port",
        portNonce,
      }, message.sourceOrigin, [channel.port2]);
      return { ok: true };
    };

    const onRuntimeMessage = (message, _sender, sendResponse) => {
      if (message?.type !== "actions-json:delegated-agent-activate") return false;
      try {
        sendResponse?.(activate(message));
      } catch (error) {
        sendResponse?.({ ok: false, error: error?.message || String(error) });
      }
      return false;
    };

    const onPageHide = (event) => {
      closePort();
      sendRuntime({
        type: "actions-json:delegated-agent-lifecycle",
        event: "pagehide",
        persisted: event?.persisted === true,
      }).catch(() => {});
    };

    const onPageShow = (event) => {
      scanDiscovery();
      armObserver();
      sendRuntime({
        type: "actions-json:delegated-agent-lifecycle",
        event: "pageshow",
        persisted: event?.persisted === true,
      }).catch(() => {});
    };

    return {
      start() {
        if (started || stopped || win !== win.top) return false;
        started = true;
        runtime.onMessage.addListener(onRuntimeMessage);
        win.addEventListener("pagehide", onPageHide);
        win.addEventListener("pageshow", onPageShow);
        scanDiscovery();
        armObserver();
        return true;
      },
      stop() {
        if (stopped) return;
        stopped = true;
        closePort();
        disconnectObserver();
        win.removeEventListener("pagehide", onPageHide);
        win.removeEventListener("pageshow", onPageShow);
      },
    };
  }

  const g = typeof globalThis !== "undefined" ? globalThis : self;
  const inExtension = typeof chrome !== "undefined"
    && chrome.runtime?.sendMessage
    && typeof document !== "undefined"
    && typeof window !== "undefined";
  if (inExtension && !g.__actionsJsonDelegatedPageBroker) {
    g.__actionsJsonDelegatedPageBroker = createPageBroker({
      doc: document,
      win: window,
      runtime: chrome.runtime,
      MutationObserverCtor: MutationObserver,
      MessageChannelCtor: MessageChannel,
      cryptoLike: crypto,
    });
    g.__actionsJsonDelegatedPageBroker.start();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createPageBroker };
  }
})();
