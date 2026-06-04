(() => {
  if (window.__actionsJsonOverlayRuntimeLoaded) {
    return;
  }
  window.__actionsJsonOverlayRuntimeLoaded = true;

  const RUNTIME_ID = `actions-json-runtime-${Math.random().toString(36).slice(2)}`;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let shouldReconnect = false;
  let manifest = null;
  let runtimeKey = null;
  let authorizationId = null;
  let extensionVersion = null;
  let activeOverlayArgs = null;
  const overlayRegistry = new Map();
  let launcherRefreshTimer = null;
  let suppressLauncherObserverUntil = 0;
  let launcherObserver = null;
  let launcherUrlPoller = null;
  const relayedRuntimeIds = new Set();
  const relayedRuntimeReady = new Map();
  const DEFAULT_MIN_PRIMITIVE_INTERVAL_MS = 500;
  let minPrimitiveIntervalMs = DEFAULT_MIN_PRIMITIVE_INTERVAL_MS;
  let primitiveQueue = Promise.resolve();
  let lastHumanInteractionStartedAt = 0;

  const LAUNCHER_ATTR = "data-actions-json-overlay-launcher";
  const OVERLAY_REGISTRY_STORAGE_KEY = "actionsJsonOverlayRegistry.v1";
  const BOOKMARKLET_RELAY_SOURCE = "ajbm";
  const EXTENSION_RELAY_SOURCE = "ajex";

  const protocolSend = (item) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(item));
    }
  };

  const isHumanInteractionAction = (name) =>
    name === "viewport.scroll" || name.startsWith("pointer.") || name === "text.insert" || name === "keyboard.press";

  const waitForHumanInteractionSlot = async (name) => {
    if (!isHumanInteractionAction(name)) return 0;
    const elapsed = Date.now() - lastHumanInteractionStartedAt;
    const waitMs = lastHumanInteractionStartedAt ? Math.max(0, minPrimitiveIntervalMs - elapsed) : 0;
    if (waitMs > 0) await sleep(waitMs);
    lastHumanInteractionStartedAt = Date.now();
    return waitMs;
  };

  const annotatePrimitivePacing = (output, waitMs) => {
    if (!output || typeof output !== "object" || !output.primitive) return output;
    if (output.value && typeof output.value === "object" && !Array.isArray(output.value)) {
      return {
        ...output,
        value: {
          ...output.value,
          rate_limit_wait_ms: waitMs,
        },
      };
    }
    return {
      ...output,
      rate_limit_wait_ms: waitMs,
    };
  };

  const configurePrimitivePacing = (args = {}) => {
    const requested = Number(args.min_interval_ms ?? DEFAULT_MIN_PRIMITIVE_INTERVAL_MS);
    if (!Number.isFinite(requested) || requested < 0 || requested > 10000) {
      return primitiveError("runtime.configure_pacing", "invalid_interval", "min_interval_ms must be 0..10000.", {
        min_interval_ms: args.min_interval_ms,
      });
    }
    minPrimitiveIntervalMs = Math.round(requested);
    return primitiveSuccess("runtime.configure_pacing", {
      min_interval_ms: minPrimitiveIntervalMs,
    });
  };

  const relayToPage = (item) => {
    window.postMessage(
      {
        source: EXTENSION_RELAY_SOURCE,
        direction: "extension-to-page",
        item
      },
      "*"
    );
  };

  const handleBookmarkletRelayMessage = (event) => {
    if (event.source !== window) return;
    const envelope = event.data || {};
    if (envelope.source !== BOOKMARKLET_RELAY_SOURCE || envelope.direction !== "page-to-extension") return;
    const item = envelope.item || {};
    if (item.type === "runtime_ready" && item.runtime_id) {
      relayedRuntimeIds.add(item.runtime_id);
      relayedRuntimeReady.set(item.runtime_id, item);
      protocolSend(item);
      return;
    }
    if (!item.runtime_id || !relayedRuntimeIds.has(item.runtime_id)) return;
    protocolSend(item);
  };

  window.addEventListener("message", handleBookmarkletRelayMessage);

  const scheduleReconnect = (bridgeUrl) => {
    if (!shouldReconnect || !bridgeUrl) return;
    clearTimeout(reconnectTimer);
    const delay = Math.min(5000, 500 * 2 ** Math.min(reconnectAttempts, 4));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => connect(bridgeUrl).catch(() => scheduleReconnect(bridgeUrl)), delay);
  };

  const emitDomEvent = (name, payload) => {
    protocolSend({
      type: "dom_event",
      event_id: `dom-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      event: name,
      name,
      runtime_id: RUNTIME_ID,
      url: location.href,
      observed_at: new Date().toISOString(),
      payload
    });
  };

  const parseHtmlDocument = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const style = Array.from(doc.querySelectorAll("style")).map((node) => node.textContent || "").join("\n");
    doc.querySelectorAll("script").forEach((node) => node.remove());
    return {
      title: doc.querySelector("title")?.textContent?.trim(),
      style,
      body: doc.body ? doc.body.innerHTML : html
    };
  };

  const launcherIdFrom = (launcher, title) => {
    const raw = launcher.id || title || "overlay";
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "overlay";
  };

  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  const textMatches = (element, needle) => {
    if (!needle) return true;
    const text = (element.textContent || element.getAttribute("aria-label") || "").trim().toLowerCase();
    const expected = String(needle).toLowerCase();
    return text.includes(expected);
  };

  const exactTextMatches = (element, needle) => {
    if (!needle) return true;
    const text = (element.textContent || element.getAttribute("aria-label") || "").trim().toLowerCase();
    return text === String(needle).toLowerCase();
  };

  const urlMatchesLauncher = (launcher) => {
    if (launcher.url_contains && !location.href.includes(launcher.url_contains)) {
      return false;
    }
    if (launcher.url_matches) {
      try {
        return new RegExp(launcher.url_matches).test(location.href);
      } catch (_error) {
        return false;
      }
    }
    return true;
  };

  const findLauncherTargets = (launcher) => {
    const selectors = Array.isArray(launcher.selectors)
      ? launcher.selectors
      : launcher.selector
        ? [launcher.selector]
        : [];
    const candidates = [];

    for (const selector of selectors) {
      try {
        candidates.push(...document.querySelectorAll(selector));
      } catch (_error) {
        // Selector hints can drift on living websites; skip invalid hints.
      }
    }

    if (candidates.length === 0 && launcher.text_contains) {
      candidates.push(
        ...document.querySelectorAll(
          "a, button, h1, h2, h3, h4, [role='heading'], span, div"
        )
      );
    }

    const seen = new Set();
    return candidates
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return (
          isVisible(element) &&
          textMatches(element, launcher.text_contains) &&
          exactTextMatches(element, launcher.text_equals)
        );
      })
      .slice(0, Number(launcher.max_instances) || 3);
  };

  const removeLauncherButtons = (launcherId) => {
    document.querySelectorAll(`[${LAUNCHER_ATTR}]`).forEach((element) => {
      if (element.getAttribute(LAUNCHER_ATTR) === launcherId) {
        element.remove();
      }
    });
  };

  const overlayRegistryIdFrom = (overlayArgs) => {
    const launcher = Array.isArray(overlayArgs.launchers)
      ? overlayArgs.launchers[0]
      : overlayArgs.launcher;
    return launcherIdFrom(launcher || {}, overlayArgs.overlay_id || overlayArgs.id || overlayArgs.title);
  };

  const normalizeOverlayArgs = (overlayArgs) => {
    const { html, title, width = 980, height = 760 } = overlayArgs || {};
    if (typeof html !== "string" || html.length === 0) {
      throw new Error("overlay.open requires a non-empty html string");
    }
    const normalized = { ...overlayArgs, html, title, width, height };
    normalized.__registryId = overlayRegistryIdFrom(normalized);
    return normalized;
  };

  const registerOverlayArgs = (overlayArgs) => {
    const normalized = normalizeOverlayArgs(overlayArgs);
    activeOverlayArgs = normalized;
    if (normalized.launcher || Array.isArray(normalized.launchers)) {
      overlayRegistry.set(normalized.__registryId, normalized);
    }
    return normalized;
  };

  const serializeOverlayRegistry = () => ({
    version: 1,
    updated_at: new Date().toISOString(),
    entries: Array.from(overlayRegistry.values()).map((overlayArgs) => {
      const { __registryId, ...serializable } = overlayArgs;
      return serializable;
    })
  });

  const createLauncherButton = (launcher, launcherId, overlayArgs) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = launcher.label || "Open overlay";
    button.title = launcher.title || launcher.label || "Open actions.json overlay";
    button.setAttribute(LAUNCHER_ATTR, launcherId);
    button.style.cssText = [
      "appearance:none",
      "border:1px solid rgba(21,108,128,0.35)",
      "background:#e6f5f8",
      "color:#0f5261",
      "border-radius:6px",
      "padding:4px 8px",
      "margin-left:8px",
      "font:700 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "letter-spacing:0",
      "cursor:pointer",
      "vertical-align:middle",
      "box-shadow:0 4px 12px rgba(20,31,54,0.10)",
      "white-space:nowrap"
    ].join(";");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (overlayArgs) {
        openOverlay(overlayArgs);
        emitDomEvent("actions-json:overlay-launcher-opened", { launcher_id: launcherId });
      }
    });
    return button;
  };

  const installLaunchers = (overlayArgs) => {
    const configs = [
      ...(Array.isArray(overlayArgs.launchers) ? overlayArgs.launchers : []),
      ...(overlayArgs.launcher ? [overlayArgs.launcher] : [])
    ].filter(Boolean);
    const installed = [];

    for (const launcher of configs) {
      const launcherId = launcherIdFrom(launcher, overlayArgs.title);
      removeLauncherButtons(launcherId);
      if (!urlMatchesLauncher(launcher)) {
        continue;
      }
      const targets = findLauncherTargets(launcher);
      for (const target of targets) {
        const button = createLauncherButton(launcher, launcherId, overlayArgs);
        const placement = launcher.placement || "afterend";
        if (placement === "beforebegin" || placement === "afterbegin" || placement === "beforeend" || placement === "afterend") {
          target.insertAdjacentElement(placement, button);
        } else {
          target.insertAdjacentElement("afterend", button);
        }
        installed.push({ launcher_id: launcherId, placement, target_text: (target.textContent || "").trim().slice(0, 120) });
      }
    }

    return installed;
  };

  const persistRegisteredOverlays = async () => {
    await storageSet({ [OVERLAY_REGISTRY_STORAGE_KEY]: serializeOverlayRegistry() });
  };

  const restoreRegisteredOverlays = async () => {
    const stored = await storageGet(OVERLAY_REGISTRY_STORAGE_KEY);
    const entries = Array.isArray(stored?.entries) ? stored.entries : [];
    for (const entry of entries) {
      try {
        const normalized = normalizeOverlayArgs(entry);
        if (normalized.launcher || Array.isArray(normalized.launchers)) {
          overlayRegistry.set(normalized.__registryId, normalized);
        }
      } catch (_error) {
        // Stored overlay payloads are user-controlled data; skip entries that no longer validate.
      }
    }
    const launchers = refreshRegisteredLaunchers();
    if (overlayRegistry.size > 0) {
      startLauncherObservers();
    }
    return launchers;
  };

  const registerLauncher = async (overlayArgs) => {
    const normalizedOverlayArgs = registerOverlayArgs(overlayArgs);
    await persistRegisteredOverlays();
    const launchers = installLaunchers(normalizedOverlayArgs);
    startLauncherObservers();
    return { ok: true, overlay_id: normalizedOverlayArgs.__registryId, launchers };
  };

  const refreshRegisteredLaunchers = () => {
    if (overlayRegistry.size === 0) return [];
    suppressLauncherObserverUntil = Date.now() + 250;
    return Array.from(overlayRegistry.values()).flatMap((overlayArgs) => installLaunchers(overlayArgs));
  };

  const scheduleLauncherRefresh = () => {
    if (overlayRegistry.size === 0) return;
    clearTimeout(launcherRefreshTimer);
    const delay = Math.max(180, suppressLauncherObserverUntil - Date.now());
    launcherRefreshTimer = setTimeout(() => {
      refreshRegisteredLaunchers();
    }, delay);
  };

  const startLauncherObservers = () => {
    if (launcherObserver || launcherUrlPoller) return;
    let lastHref = location.href;
    launcherObserver = new MutationObserver(() => scheduleLauncherRefresh());
    launcherObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleLauncherRefresh);
    window.addEventListener("hashchange", scheduleLauncherRefresh);
    launcherUrlPoller = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        scheduleLauncherRefresh();
      }
    }, 500);
  };

  const launcherFromAttachment = (attachment) => {
    if (attachment?.kind !== "overlay_launcher") return null;
    const opens = attachment.affordance?.opens;
    if (opens?.tool !== "overlay.open") return null;
    const target = attachment.target || {};
    const affordance = attachment.affordance || {};
    const selectors = Array.isArray(target.selectors) && target.selectors.length > 0
      ? target.selectors
      : target.fallback_selectors;
    return {
      overlayArgs: {
        ...(opens.arguments || {}),
        launchers: [
          {
            id: attachment.id,
            label: affordance.label,
            title: affordance.title || attachment.description,
            selectors,
            text_contains: target.text_contains,
            text_equals: target.text_equals,
            url_contains: target.url_contains,
            url_matches: target.url_matches,
            placement: affordance.placement,
            max_instances: affordance.max_instances
          }
        ]
      }
    };
  };

  const installManifestAttachments = (actions) => {
    const attachments = Array.isArray(actions?.attachments) ? actions.attachments : [];
    const installed = [];
    for (const attachment of attachments) {
      const normalized = launcherFromAttachment(attachment);
      if (!normalized) continue;
      const overlayArgs = registerOverlayArgs(normalized.overlayArgs);
      installed.push(...installLaunchers(overlayArgs));
    }
    if (attachments.length > 0) {
      startLauncherObservers();
    }
    return installed;
  };

  const reportBaseCss = `
    :host {
      --bg: #f7f8fb;
      --ink: #15171d;
      --muted: #5d6372;
      --subtle: #858c9b;
      --line: #dce1ea;
      --paper: #ffffff;
      --accent: #156c80;
      --green: #24744a;
      --yellow: #a36700;
      --red: #b64040;
      --blue-soft: #e6f5f8;
      --amber-soft: #fff1dd;
      --green-soft: #eaf7ef;
      --red-soft: #fff0f0;
      --shadow: 0 16px 40px rgba(27, 36, 52, 0.08);
      --radius: 8px;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    .overlay-frame {
      width: 100%;
      height: 100%;
      display: grid;
      grid-template-rows: 42px 1fr;
      background: #f7f8fb;
      color: #15171d;
      font-family: var(--sans);
      line-height: 1.55;
    }
    .overlay-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 10px 0 14px;
      background: #18202c;
      color: #fff;
      cursor: move;
      user-select: none;
    }
    .overlay-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 750;
      letter-spacing: 0;
    }
    .overlay-actions { display: flex; gap: 6px; flex: 0 0 auto; }
    .overlay-btn {
      appearance: none;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border-radius: 6px;
      height: 28px;
      padding: 0 9px;
      font: 700 12px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    .overlay-btn:hover { background: rgba(255, 255, 255, 0.16); }
    .overlay-body {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      background:
        linear-gradient(180deg, rgba(21, 108, 128, 0.08), transparent 320px),
        var(--bg);
    }
    .overlay-frame[data-minimized="true"] {
      grid-template-rows: 42px;
    }
    .overlay-frame[data-minimized="true"] .overlay-body {
      display: none;
    }
    .overlay-body .topbar { display: none; }
    .overlay-body .shell { width: 100%; max-width: 1180px; margin: 0 auto; padding-top: 26px; padding-bottom: 40px; }
  `;

  const openOverlay = (overlayArgs) => {
    const normalizedOverlayArgs = registerOverlayArgs(overlayArgs);
    if (normalizedOverlayArgs.launcher || Array.isArray(normalizedOverlayArgs.launchers)) {
      persistRegisteredOverlays().catch((_error) => {});
    }
    const { html, title, width = 980, height = 760 } = normalizedOverlayArgs;

    const existing = document.getElementById("__actions_json_overlay_runtime_host");
    if (existing) existing.remove();

    const parsed = parseHtmlDocument(html);
    const overlayId = `overlay-${Date.now().toString(36)}`;
    const host = document.createElement("div");
    host.id = "__actions_json_overlay_runtime_host";
    host.dataset.overlayId = overlayId;
    host.style.cssText = [
      "position:fixed",
      "left:72px",
      "top:56px",
      `width:min(${Number(width) || 980}px, calc(100vw - 96px))`,
      `height:min(${Number(height) || 760}px, calc(100vh - 96px))`,
      "z-index:2147483647",
      "resize:both",
      "overflow:hidden",
      "min-width:420px",
      "min-height:320px",
      "background:white",
      "border:1px solid rgba(20, 24, 31, 0.22)",
      "border-radius:10px",
      "box-shadow:0 24px 80px rgba(0,0,0,0.32)"
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${reportBaseCss}\n${parsed.style}</style>
      <section class="overlay-frame" role="dialog" aria-label="actions.json overlay report">
        <header class="overlay-bar" data-drag-handle>
          <div class="overlay-title"></div>
          <div class="overlay-actions">
            <button class="overlay-btn" type="button" data-minimize aria-expanded="true">Minimize</button>
            <button class="overlay-btn" type="button" data-reset>Reset</button>
            <button class="overlay-btn" type="button" data-close>Close</button>
          </div>
        </header>
        <main class="overlay-body"></main>
      </section>
    `;
    shadow.querySelector(".overlay-title").textContent = title || parsed.title || "actions.json overlay";
    shadow.querySelector(".overlay-body").innerHTML = parsed.body;
    document.documentElement.appendChild(host);

    const bar = shadow.querySelector("[data-drag-handle]");
    const frame = shadow.querySelector(".overlay-frame");
    const close = shadow.querySelector("[data-close]");
    const minimize = shadow.querySelector("[data-minimize]");
    const reset = shadow.querySelector("[data-reset]");
    let drag = null;
    let restoreGeometry = null;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const place = (left, top) => {
      const rect = host.getBoundingClientRect();
      host.style.left = `${clamp(left, 8, window.innerWidth - Math.min(rect.width, window.innerWidth) - 8)}px`;
      host.style.top = `${clamp(top, 8, window.innerHeight - Math.min(rect.height, window.innerHeight) - 8)}px`;
    };

    bar.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      bar.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    bar.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      place(event.clientX - drag.dx, event.clientY - drag.dy);
    });

    const endDrag = (event) => {
      if (drag && drag.pointerId === event.pointerId) drag = null;
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);

    const setMinimized = (nextMinimized) => {
      if (nextMinimized) {
        const rect = host.getBoundingClientRect();
        restoreGeometry = {
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          minWidth: host.style.minWidth,
          minHeight: host.style.minHeight,
          resize: host.style.resize,
          overflow: host.style.overflow
        };
        frame.dataset.minimized = "true";
        host.style.width = `${Math.min(Math.max(rect.width, 360), 520)}px`;
        host.style.height = "42px";
        host.style.minWidth = "280px";
        host.style.minHeight = "42px";
        host.style.resize = "none";
        host.style.overflow = "hidden";
        minimize.textContent = "Expand";
        minimize.setAttribute("aria-expanded", "false");
        emitDomEvent("actions-json:overlay-minimized", { overlay_id: overlayId });
        return;
      }

      frame.dataset.minimized = "false";
      if (restoreGeometry) {
        host.style.width = restoreGeometry.width;
        host.style.height = restoreGeometry.height;
        host.style.minWidth = restoreGeometry.minWidth;
        host.style.minHeight = restoreGeometry.minHeight;
        host.style.resize = restoreGeometry.resize;
        host.style.overflow = restoreGeometry.overflow;
      }
      restoreGeometry = null;
      minimize.textContent = "Minimize";
      minimize.setAttribute("aria-expanded", "true");
      place(host.getBoundingClientRect().left, host.getBoundingClientRect().top);
      emitDomEvent("actions-json:overlay-expanded", { overlay_id: overlayId });
    };

    minimize.addEventListener("click", () => {
      setMinimized(frame.dataset.minimized !== "true");
    });
    close.addEventListener("click", () => {
      host.remove();
      emitDomEvent("actions-json:overlay-closed", { overlay_id: overlayId });
    });
    reset.addEventListener("click", () => {
      if (frame.dataset.minimized === "true") {
        setMinimized(false);
      }
      host.style.left = "72px";
      host.style.top = "56px";
      host.style.width = `min(${Number(width) || 980}px, calc(100vw - 96px))`;
      host.style.height = `min(${Number(height) || 760}px, calc(100vh - 96px))`;
    });

    const launchers = refreshRegisteredLaunchers();
    startLauncherObservers();

    return { ok: true, overlay_id: overlayId, launchers };
  };

  const closeOverlay = () => {
    const existing = document.getElementById("__actions_json_overlay_runtime_host");
    if (existing) {
      const overlayId = existing.dataset.overlayId || null;
      existing.remove();
      emitDomEvent("actions-json:overlay-closed", { overlay_id: overlayId });
    }
    return { ok: true };
  };

  const sendRuntimeMessage = (message, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timeout = Number.isFinite(timeoutMs)
        ? Math.max(1, Math.min(60_000, Math.floor(timeoutMs)))
        : 10_000;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`runtime message ${message?.type || "unknown"} timed out after ${timeout}ms`));
      }, timeout);

      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "screenshot capture failed"));
          return;
        }
        resolve(response);
      });
    });

  const dataUrlByteLength = (dataUrl) => {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return dataUrl.length;
    const base64 = dataUrl.slice(comma + 1);
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const loadImageFromDataUrl = (dataUrl) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("failed to decode screenshot for resizing"));
      image.src = dataUrl;
    });

  const encodeCanvas = (canvas, mimeType, quality) => {
    if (mimeType === "image/jpeg") {
      return canvas.toDataURL(mimeType, Math.max(0.1, Math.min(1, quality)));
    }
    return canvas.toDataURL(mimeType);
  };

  const resizeScreenshot = async (dataUrl, args = {}, capturedFormat = "png") => {
    const requestedMaxKb = Number.isFinite(args.max_kilobytes) ? args.max_kilobytes : args.max_kb;
    const maxKb = Number.isFinite(requestedMaxKb) ? Math.max(1, Math.floor(requestedMaxKb)) : null;
    const maxBytes = maxKb ? maxKb * 1024 : null;
    const maxWidth = Number.isFinite(args.max_width) ? Math.max(1, Math.floor(args.max_width)) : null;
    const maxHeight = Number.isFinite(args.max_height) ? Math.max(1, Math.floor(args.max_height)) : null;

    if (!maxBytes && !maxWidth && !maxHeight) {
      return {
        dataUrl,
        mimeType: capturedFormat === "jpeg" ? "image/jpeg" : "image/png",
        imageBytes: dataUrlByteLength(dataUrl),
        encodedWidth: null,
        encodedHeight: null,
        quality: null,
        resized: false
      };
    }

    const image = await loadImageFromDataUrl(dataUrl);
    let scale = 1;
    if (maxWidth && image.naturalWidth > maxWidth) {
      scale = Math.min(scale, maxWidth / image.naturalWidth);
    }
    if (maxHeight && image.naturalHeight > maxHeight) {
      scale = Math.min(scale, maxHeight / image.naturalHeight);
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("failed to create screenshot resize canvas");

    let mimeType = capturedFormat === "jpeg" ? "image/jpeg" : "image/png";
    let quality = Number.isInteger(args.quality) ? args.quality / 100 : 0.82;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      let encoded = encodeCanvas(canvas, mimeType, quality);
      let bytes = dataUrlByteLength(encoded);
      if (!maxBytes || bytes <= maxBytes) {
        return {
          dataUrl: encoded,
          mimeType,
          imageBytes: bytes,
          encodedWidth: canvas.width,
          encodedHeight: canvas.height,
          quality: mimeType === "image/jpeg" ? Math.round(quality * 100) : null,
          resized: true
        };
      }

      if (mimeType !== "image/jpeg") {
        mimeType = "image/jpeg";
        quality = Math.min(quality, 0.76);
      } else if (quality > 0.42) {
        quality -= 0.12;
      } else {
        scale *= Math.max(0.35, Math.sqrt(maxBytes / bytes) * 0.92);
      }
    }

    const encoded = encodeCanvas(canvas, mimeType, quality);
    return {
      dataUrl: encoded,
      mimeType,
      imageBytes: dataUrlByteLength(encoded),
      encodedWidth: canvas.width,
      encodedHeight: canvas.height,
      quality: mimeType === "image/jpeg" ? Math.round(quality * 100) : null,
      resized: true
    };
  };

  const storageGet = (key) =>
    new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(result?.[key]);
      });
    });

  const storageSet = (values) =>
    new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve();
      });
    });

  const captureScreenshot = async (args = {}) => {
    const format = args.format === "jpeg" ? "jpeg" : "png";
    const delayMs = Number.isFinite(args.delay_ms)
      ? Math.max(0, Math.min(30_000, Math.floor(args.delay_ms)))
      : 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const captureTimeoutMs = Number.isFinite(args.capture_timeout_ms)
      ? Math.max(1, Math.min(60_000, Math.floor(args.capture_timeout_ms)))
      : 10_000;
    const response = await sendRuntimeMessage({
      type: "actions-json:capture-visible-tab",
      format,
      quality: Number.isInteger(args.quality) ? args.quality : undefined,
      delayMs: 0
    }, captureTimeoutMs);
    const resized = await resizeScreenshot(response.dataUrl, args, format);
    return {
      ok: true,
      data_url: resized.dataUrl,
      mime_type: resized.mimeType,
      image_bytes: resized.imageBytes,
      encoded: {
        width: resized.encodedWidth,
        height: resized.encodedHeight,
        quality: resized.quality,
        resized: resized.resized
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        device_pixel_ratio: window.devicePixelRatio
      },
      url: location.href,
      captured_at: new Date().toISOString()
    };
  };

  const importStorageBundle = async (args = {}) => {
    const bundle = args.bundle;
    if (bundle?.protocol !== "actions.json.storage.bundle" || !Array.isArray(bundle.entries)) {
      throw new Error("storage.import_bundle requires an actions.json.storage.bundle");
    }
    const normalizedBundle = {
      ...bundle,
      imported_at: new Date().toISOString()
    };
    await storageSet({ actionsJsonStorageBundle: normalizedBundle });
    return {
      ok: true,
      entry_count: normalizedBundle.entries.length,
      synced_at_ms: normalizedBundle.synced_at_ms || null,
      imported_at: normalizedBundle.imported_at
    };
  };

  const listStorageBundle = async () => {
    const bundle = await storageGet("actionsJsonStorageBundle");
    const entries = Array.isArray(bundle?.entries) ? bundle.entries : [];
    return {
      ok: true,
      protocol: bundle?.protocol || null,
      version: bundle?.version || null,
      synced_at_ms: bundle?.synced_at_ms || null,
      imported_at: bundle?.imported_at || null,
      entry_count: entries.length,
      paths: entries.map((entry) => entry.path).filter(Boolean)
    };
  };

  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const isElementVisible = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const isElementRendered = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const isRectInViewport = (rect) => (
    rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= window.innerHeight
      && rect.left <= window.innerWidth
  );

  const visibleRectFor = (element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  };

  const selectorListFrom = (config, fallback = []) => {
    if (Array.isArray(config?.selectors) && config.selectors.length > 0) return config.selectors;
    if (typeof config?.selector === "string" && config.selector.trim()) return [config.selector];
    return fallback;
  };

  const findScopedElement = (scope = {}) => {
    const selectors = selectorListFrom(scope, ["body"]);
    const candidates = [];
    for (const selector of selectors) {
      try {
        candidates.push(...Array.from(document.querySelectorAll(selector)));
      } catch (_error) {
        // Invalid selector hints are ignored; a later selector may still match.
      }
    }

    const textEquals = normalizeText(scope.text_equals || scope.textEquals).toLowerCase();
    const textContains = normalizeText(scope.text_contains || scope.textContains).toLowerCase();

    return candidates.find((candidate) => {
      if (!isElementVisible(candidate)) return false;
      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label")).toLowerCase();
      if (textEquals && text !== textEquals) return false;
      if (textContains && !text.includes(textContains)) return false;
      return true;
    }) || null;
  };

  const countVisibleMatches = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll(selector)).filter(isElementVisible).length;
    } catch (_error) {
      return 0;
    }
  };

  const findExtractionRoot = (scopeElement, itemSelector, scope = {}) => {
    if (!scopeElement) return document.body;
    if (scope.root_selector || scope.rootSelector) {
      try {
        const root = scopeElement.closest(scope.root_selector || scope.rootSelector);
        if (root) return root;
      } catch (_error) {
        // Fall through to the generic strategies below.
      }
    }

    const strategy = scope.root_strategy || scope.rootStrategy || "scope";
    if (strategy === "nearest_ancestor_containing_items") {
      const maxDepth = Math.max(0, Math.min(Number(scope.max_ancestor_depth ?? scope.maxAncestorDepth ?? 4), 20));
      let current = scopeElement;
      for (let depth = 0; current && depth <= maxDepth; depth += 1, current = current.parentElement) {
        if (countVisibleMatches(current, itemSelector) > 0) return current;
      }
    }
    if (strategy === "parent") return scopeElement.parentElement || scopeElement;
    return scopeElement;
  };

  const queryRelative = (root, selector) => {
    const matches = [];
    for (const part of String(selector || "").split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed === ":scope") {
        matches.push(root);
        continue;
      }
      try {
        if (root.matches?.(trimmed)) matches.push(root);
      } catch (_error) {
        // Some relative selectors are valid only through querySelectorAll.
      }
      try {
        matches.push(...Array.from(root.querySelectorAll(trimmed)));
      } catch (_error) {
        // Invalid selectors are ignored so one bad field rule does not abort the action.
      }
    }
    return Array.from(new Set(matches)).filter(isElementVisible);
  };

  const readAttributeValue = (element, attribute) => {
    if (!element) return "";
    if (attribute === "text") return normalizeText(element.textContent);
    if (attribute === "href") {
      if (element instanceof HTMLAnchorElement) return element.href || element.getAttribute("href") || "";
      return element.getAttribute("href") || "";
    }
    if (attribute === "src") {
      if (element instanceof HTMLImageElement) return element.src || element.getAttribute("src") || "";
      return element.getAttribute("src") || "";
    }
    if (attribute === "currentSrc") {
      return element instanceof HTMLImageElement ? element.currentSrc || element.src || "" : "";
    }
    return normalizeText(element.getAttribute(attribute));
  };

  const extractFieldValue = (itemRoot, field) => {
    const selectors = field.selector ? [field.selector] : [":scope"];
    const attributes = Array.isArray(field.attributes) && field.attributes.length > 0
      ? field.attributes
      : field.attribute
        ? [field.attribute]
        : ["text"];
    for (const selector of selectors) {
      for (const element of queryRelative(itemRoot, selector)) {
        for (const attribute of attributes) {
          const value = readAttributeValue(element, attribute);
          if (value) return value;
        }
      }
    }
    return "";
  };

  const extractItemsFromRoot = (root, args) => {
    const itemSelector = args.item_selector || args.itemSelector;
    if (!itemSelector) {
      throw new Error("browser.extract_elements requires item_selector");
    }
    const fields = Array.isArray(args.fields) && args.fields.length > 0 ? args.fields : null;
    if (!fields) {
      throw new Error("browser.extract_elements requires fields");
    }

    let itemRoots = [];
    try {
      itemRoots = Array.from(root.querySelectorAll(itemSelector)).filter(isElementVisible);
    } catch (_error) {
      itemRoots = [];
    }

    const items = [];
    const seen = new Set();

    for (const itemRoot of itemRoots) {
      const item = {};
      for (const field of fields) {
        if (!field?.name) continue;
        item[field.name] = extractFieldValue(itemRoot, field);
      }

      const hasValue = Object.values(item).some((value) => normalizeText(value));
      if (!hasValue) continue;
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }

    return items;
  };

  const extractElements = async (args = {}) => {
    const scope = args.scope && typeof args.scope === "object" ? args.scope : {};
    const scopeElement = findScopedElement(scope);
    if (!scopeElement) {
      throw new Error("browser.extract_elements scope not found");
    }
    const itemSelector = args.item_selector || args.itemSelector;
    const root = findExtractionRoot(scopeElement, itemSelector, scope);
    const items = extractItemsFromRoot(root, args);

    return {
      ok: true,
      scope: {
        text: normalizeText(scopeElement.textContent || scopeElement.getAttribute("aria-label")),
        selector_count: selectorListFrom(scope, ["body"]).length
      },
      items,
      item_count: items.length,
      extracted_at: new Date().toISOString(),
      url: location.href
    };
  };

  const runJavascript = async (args = {}) => {
    const source = args.source || args.javascript;
    if (typeof source !== "string" || !source.trim()) {
      throw new Error("browser.run_javascript requires source");
    }
    const actionArgs = args.args && typeof args.args === "object" ? args.args : {};
    const helpers = {
      normalizeText,
      isElementVisible,
      queryRelative
    };
    const action = new Function(
      "args",
      "helpers",
      `"use strict"; return (async () => {\n${source}\n})()`
    );
    return {
      ok: true,
      result: await action(actionArgs, helpers),
      url: location.href
    };
  };

  const pageInfo = () => primitiveSuccess("page.info", {
    url: location.href,
    title: document.title
  });

  const domObserveVisible = (args = {}) => {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "*";
    const textContains = normalizeText(args.text_contains || args.textContains).toLowerCase();
    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(selector));
    } catch (_error) {
      return primitiveError("dom.observe.visible", "invalid_selector", "The selector could not be queried.", { selector });
    }
    const maxMatches = Math.max(1, Math.min(Number(args.max_matches ?? args.maxMatches ?? 50), 200));
    const matches = candidates
      .filter(isElementVisible)
      .filter((element) => {
        if (!textContains) return true;
        return normalizeText(element.textContent || element.getAttribute("aria-label")).toLowerCase().includes(textContains);
      })
      .slice(0, maxMatches)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag_name: element.tagName.toLowerCase(),
          text: normalizeText(element.textContent || element.getAttribute("aria-label")),
          bounding_box: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom
          }
        };
      });
    return primitiveSuccess("dom.observe.visible", { matches, match_count: matches.length });
  };

  const deriveSectionHeading = (section, headingSelector, maxHeadingLength) => {
    const selectors = headingSelector
      ? [headingSelector]
      : ["h1,h2,h3,h4,h5,h6,[role='heading'],[aria-label]"];
    for (const selector of selectors) {
      let candidates = [];
      try {
        candidates = Array.from(section.querySelectorAll(selector));
      } catch (_error) {
        candidates = [];
      }
      if (section.matches?.(selector)) candidates.unshift(section);
      for (const candidate of candidates) {
        const text = normalizeText(candidate.getAttribute("aria-label") || candidate.textContent);
        if (text && text.length <= maxHeadingLength) return text;
      }
    }

    const text = normalizeText(section.getAttribute("aria-label") || section.textContent);
    if (!text) return "";
    const beforeControls = text.split(/\b(?:Forward|Back|See more)\b/i)[0].trim();
    return (beforeControls || text).slice(0, maxHeadingLength).trim();
  };

  const domListSections = (args = {}) => {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "section,[role='region']";
    const headingSelector = typeof args.heading_selector === "string" && args.heading_selector.trim()
      ? args.heading_selector.trim()
      : (typeof args.headingSelector === "string" && args.headingSelector.trim() ? args.headingSelector.trim() : "");
    const itemSelector = typeof args.item_selector === "string" && args.item_selector.trim()
      ? args.item_selector.trim()
      : (typeof args.itemSelector === "string" && args.itemSelector.trim() ? args.itemSelector.trim() : "");
    const textContains = normalizeText(args.text_contains || args.textContains).toLowerCase();
    const maxSections = Math.max(1, Math.min(Number(args.max_sections ?? args.maxSections ?? 100), 500));
    const maxHeadingLength = Math.max(12, Math.min(Number(args.max_heading_length ?? args.maxHeadingLength ?? 120), 500));
    let candidates;
    try {
      candidates = Array.from(document.querySelectorAll(selector));
    } catch (_error) {
      return primitiveError("dom.list_sections", "invalid_selector", "The section selector could not be queried.", { selector });
    }

    const sections = candidates
      .filter(isElementRendered)
      .map((section, index) => {
        const rect = section.getBoundingClientRect();
        const heading = deriveSectionHeading(section, headingSelector, maxHeadingLength);
        let itemCount = 0;
        if (itemSelector) {
          try {
            itemCount = Array.from(section.querySelectorAll(itemSelector)).filter(isElementRendered).length;
          } catch (_error) {
            itemCount = 0;
          }
        }
        return {
          index,
          tag_name: section.tagName.toLowerCase(),
          heading,
          text: normalizeText(section.textContent || section.getAttribute("aria-label")).slice(0, maxHeadingLength),
          scroll_y: window.scrollY + rect.top,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          visible: isRectInViewport(rect),
          item_count: itemCount,
        };
      })
      .filter((section) => !textContains || `${section.heading} ${section.text}`.toLowerCase().includes(textContains))
      .slice(0, maxSections);

    return primitiveSuccess("dom.list_sections", {
      sections,
      section_count: sections.length,
      scroll_y: window.scrollY,
      viewport_height: window.innerHeight,
      url: location.href
    });
  };

  const domSnapshotText = (args = {}) => {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "body";
    const maxChars = Math.max(1, Math.min(Number(args.max_chars ?? args.maxChars ?? 12000), 100000));
    let elements;
    try {
      elements = Array.from(document.querySelectorAll(selector)).filter(isElementVisible);
    } catch (_error) {
      return primitiveError("dom.snapshot_text", "invalid_selector", "The selector could not be queried.", { selector });
    }
    const fullText = normalizeText(elements.map((element) => element.textContent || "").join("\n"));
    return primitiveSuccess("dom.snapshot_text", {
      text: fullText.slice(0, maxChars),
      truncated: fullText.length > maxChars
    });
  };

  const debugRunJavascript = async (args = {}) => {
    const source = args.source || args.javascript;
    if (typeof source !== "string" || !source.trim()) {
      throw new Error("debug.run_javascript requires source");
    }
    return sendRuntimeMessage({
      type: "actions-json:debug-evaluate",
      source,
      javascript: args.javascript,
      args: args.args && typeof args.args === "object" ? args.args : {}
    });
  };

  const primitiveSuccess = (primitive, value) => ({
    ok: true,
    primitive,
    adapter: "extension",
    value
  });

  const primitiveError = (primitive, code, message, evidence = {}) => ({
    ok: false,
    primitive,
    adapter: "extension",
    error: {
      code,
      message,
      recoverable: true,
      evidence
    }
  });

  const resolveLocatorCandidates = (locator) => {
    if (!locator || typeof locator !== "object") return [];
    let candidates = [];
    if (typeof locator.selector === "string" && locator.selector.trim()) {
      candidates = queryRelative(document, locator.selector.trim());
    } else {
      candidates = Array.from(
        document.querySelectorAll("button, a, input, textarea, select, [role], [aria-label], [data-testid], [data-test], [data-actions-json-target]")
      );
    }
    const text = normalizeText(locator.text || locator.text_contains || locator.text_equals);
    if (!text) return candidates;
    return candidates.filter((element) => {
      const haystack = normalizeText(
        [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("value")
        ].filter(Boolean).join(" ")
      );
      return locator.text_equals ? haystack === text : haystack.includes(text);
    });
  };

  const resolveSingleVisibleLocator = (locator) => resolveLocatorCandidates(locator).find(isElementVisible) || null;
  const resolveSingleLocator = (locator) => resolveLocatorCandidates(locator)[0] || null;

  const locatorElementInfo = (args = {}) => {
    const locator = args.locator;
    const element = resolveSingleVisibleLocator(locator);
    if (!element) {
      return primitiveError("locator.element_info", "target_not_found", "No visible element matched the locator.", {
        locator
      });
    }
    const rect = element.getBoundingClientRect();
    const visibleRect = visibleRectFor(element) || rect;
    return primitiveSuccess("locator.element_info", {
      locator,
      tag_name: element.tagName.toLowerCase(),
      text: normalizeText(element.textContent),
      bounding_box: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      },
      clickable_center: {
        x: visibleRect.left + (visibleRect.right - visibleRect.left) / 2,
        y: visibleRect.top + (visibleRect.bottom - visibleRect.top) / 2
      }
    });
  };

  const locatorTextContent = (args = {}) => {
    const locator = args.locator;
    const element = resolveSingleVisibleLocator(locator);
    if (!element) {
      return primitiveError("locator.text_content", "target_not_found", "No visible element matched the locator.", { locator });
    }
    return primitiveSuccess("locator.text_content", {
      locator,
      text: normalizeText(element.textContent || element.getAttribute("aria-label"))
    });
  };

  const locatorWaitFor = async (args = {}) => {
    const locator = args.locator;
    const state = args.state || "visible";
    const timeoutMs = Math.max(0, Math.min(Number(args.timeout_ms ?? args.timeoutMs ?? 1000), 30000));
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const element = state === "attached" ? resolveSingleLocator(locator) : resolveSingleVisibleLocator(locator);
      if (element) {
        return primitiveSuccess("locator.wait_for", {
          matched: true,
          state,
          elapsed_ms: Date.now() - started
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return primitiveError("locator.wait_for", "timeout", "Timed out waiting for locator.", {
      locator,
      state,
      timeout_ms: timeoutMs
    });
  };

  const findScrollableElement = (root, deltaX, deltaY) => {
    if (!(root instanceof Element)) return null;
    const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
    const wantsHorizontal = Math.abs(deltaX) >= Math.abs(deltaY);
    return candidates.find((element) => {
      if (!isElementVisible(element)) return false;
      const style = getComputedStyle(element);
      const overflowX = style.overflowX;
      const overflowY = style.overflowY;
      const canScrollX = element.scrollWidth > element.clientWidth + 1 && overflowX !== "hidden";
      const canScrollY = element.scrollHeight > element.clientHeight + 1 && overflowY !== "hidden";
      return wantsHorizontal ? canScrollX : canScrollY;
    }) || null;
  };

  const viewportScroll = async (args = {}) => {
    const deltaX = Number(args.delta_x ?? args.deltaX ?? args.scroll_x ?? args.scrollX ?? 0);
    const deltaY = Number(args.delta_y ?? args.deltaY ?? args.scroll_y ?? args.scrollY ?? 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return primitiveError("viewport.scroll", "scroll_failed", "Scroll deltas must be finite numbers.", {
        delta_x: args.delta_x,
        delta_y: args.delta_y
      });
    }
    if (deltaX === 0 && deltaY === 0) {
      return primitiveSuccess("viewport.scroll", {
        moved: false,
        target: "viewport",
        before: { scroll_x: window.scrollX, scroll_y: window.scrollY },
        after: { scroll_x: window.scrollX, scroll_y: window.scrollY }
      });
    }

    let target = window;
    let targetKind = "viewport";
    if (args.scope && typeof args.scope === "object") {
      const scopeElement = findScopedElement(args.scope);
      if (!scopeElement) {
        return primitiveError("viewport.scroll", "target_not_found", "No visible element matched the scroll scope.", {
          scope: args.scope
        });
      }
      const root = findExtractionRoot(scopeElement, args.item_selector || args.itemSelector, args.scope);
      const scrollable = findScrollableElement(root, deltaX, deltaY);
      if (!scrollable) {
        return primitiveError("viewport.scroll", "target_not_scrollable", "No scrollable element was found for the requested scope.", {
          scope: args.scope
        });
      }
      target = scrollable;
      targetKind = "element";
    }

    const before = target === window
      ? { scroll_x: window.scrollX, scroll_y: window.scrollY }
      : { scroll_x: target.scrollLeft, scroll_y: target.scrollTop };

    if (target === window) {
      window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
    } else {
      target.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = target === window
      ? { scroll_x: window.scrollX, scroll_y: window.scrollY }
      : { scroll_x: target.scrollLeft, scroll_y: target.scrollTop };

    return primitiveSuccess("viewport.scroll", {
      moved: after.scroll_x !== before.scroll_x || after.scroll_y !== before.scroll_y,
      target: targetKind,
      before,
      after,
      delta_x: deltaX,
      delta_y: deltaY
    });
  };

  const moveVisiblePointer = (x, y) => {
    let pointer = document.getElementById("actions-json-ghost-pointer");
    if (!pointer) {
      pointer = document.createElement("div");
      pointer.id = "actions-json-ghost-pointer";
      pointer.setAttribute("aria-hidden", "true");
      Object.assign(pointer.style, {
        position: "fixed",
        width: "14px",
        height: "14px",
        margin: "-7px 0 0 -7px",
        border: "2px solid #38bdf8",
        borderRadius: "999px",
        background: "rgba(56, 189, 248, 0.28)",
        boxShadow: "0 0 0 4px rgba(56, 189, 248, 0.18)",
        zIndex: "2147483646",
        pointerEvents: "none",
        transition: "left 120ms ease, top 120ms ease, transform 120ms ease"
      });
      document.documentElement.appendChild(pointer);
    }
    pointer.style.left = `${x}px`;
    pointer.style.top = `${y}px`;
    pointer.style.transform = "scale(1.25)";
    setTimeout(() => {
      pointer.style.transform = "scale(1)";
    }, 140);
  };

  const validateViewportPoint = (primitive, x, y, evidence) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return primitiveError(primitive, "point_out_of_viewport", "Point is outside the current viewport.", {
        x: evidence?.x,
        y: evidence?.y,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
    }
    return null;
  };

  const dispatchPointerClick = (target, { x, y, button, detail = 1 }) => {
    const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button: buttonCode,
      buttons: 1 << buttonCode,
      detail,
      view: window
    };
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventCtor(type, common));
    }
  };

  const dispatchPointerEvent = (target, type, { x, y, buttons = 0, button = 0, eventCtor = null }) => {
    const EventCtor = eventCtor || (type.startsWith("pointer") && typeof PointerEvent === "function" ? PointerEvent : MouseEvent);
    target.dispatchEvent(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button,
      buttons,
      view: window
    }));
  };

  const pointerClick = (args = {}) => {
    const x = Number(args.x);
    const y = Number(args.y);
    const viewportError = validateViewportPoint("pointer.click", x, y, args);
    if (viewportError) return viewportError;
    const target = document.elementFromPoint(x, y);
    if (!target) {
      return primitiveError("pointer.click", "target_not_found", "No element exists at the requested point.", { x, y });
    }
    moveVisiblePointer(x, y);
    dispatchPointerClick(target, { x, y, button: args.button || "left" });
    return primitiveSuccess("pointer.click", { clicked: true, x, y });
  };

  const pointerMove = (args = {}) => {
    const x = Number(args.x);
    const y = Number(args.y);
    const viewportError = validateViewportPoint("pointer.move", x, y, args);
    if (viewportError) return viewportError;
    moveVisiblePointer(x, y);
    return primitiveSuccess("pointer.move", { x, y });
  };

  const pointerDoubleClick = (args = {}) => {
    const x = Number(args.x);
    const y = Number(args.y);
    const viewportError = validateViewportPoint("pointer.double_click", x, y, args);
    if (viewportError) return viewportError;
    const target = document.elementFromPoint(x, y);
    if (!target) {
      return primitiveError("pointer.double_click", "target_not_found", "No element exists at the requested point.", { x, y });
    }
    moveVisiblePointer(x, y);
    dispatchPointerClick(target, { x, y, button: "left", detail: 1 });
    dispatchPointerClick(target, { x, y, button: "left", detail: 2 });
    target.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      detail: 2,
      view: window
    }));
    return primitiveSuccess("pointer.double_click", { double_clicked: true, x, y });
  };

  const pointerDrag = (args = {}) => {
    const from = args.from || {};
    const to = args.to || {};
    const startX = Number(from.x);
    const startY = Number(from.y);
    const endX = Number(to.x);
    const endY = Number(to.y);
    const startError = validateViewportPoint("pointer.drag", startX, startY, from);
    if (startError) return startError;
    const endError = validateViewportPoint("pointer.drag", endX, endY, to);
    if (endError) return endError;
    const target = document.elementFromPoint(startX, startY);
    if (!target) {
      return primitiveError("pointer.drag", "target_not_found", "No element exists at the requested drag start point.", { from, to });
    }
    moveVisiblePointer(startX, startY);
    dispatchPointerEvent(target, "pointerdown", { x: startX, y: startY, buttons: 1 });
    dispatchPointerEvent(target, "mousedown", { x: startX, y: startY, buttons: 1, eventCtor: MouseEvent });
    moveVisiblePointer(endX, endY);
    const moveTarget = document.elementFromPoint(endX, endY) || target;
    dispatchPointerEvent(moveTarget, "pointermove", { x: endX, y: endY, buttons: 1 });
    dispatchPointerEvent(moveTarget, "mousemove", { x: endX, y: endY, buttons: 1, eventCtor: MouseEvent });
    dispatchPointerEvent(moveTarget, "pointerup", { x: endX, y: endY, buttons: 0 });
    dispatchPointerEvent(moveTarget, "mouseup", { x: endX, y: endY, buttons: 0, eventCtor: MouseEvent });
    if (moveTarget !== target) {
      dispatchPointerEvent(target, "pointerup", { x: endX, y: endY, buttons: 0 });
      dispatchPointerEvent(target, "mouseup", { x: endX, y: endY, buttons: 0, eventCtor: MouseEvent });
    }
    return primitiveSuccess("pointer.drag", { dragged: true, from: { x: startX, y: startY }, to: { x: endX, y: endY } });
  };

  const isEditableElement = (element) => {
    if (!element) return false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }
    return element.isContentEditable;
  };

  const textInsert = (args = {}) => {
    const text = String(args.text ?? "");
    const target = document.activeElement;
    if (!isEditableElement(target)) {
      return primitiveError("text.insert", "target_not_editable", "The active element is not editable.", {
        tag_name: target?.tagName?.toLowerCase?.() || null
      });
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = Number.isInteger(target.selectionStart) ? target.selectionStart : target.value.length;
      const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
      target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
      const cursor = start + text.length;
      target.setSelectionRange?.(cursor, cursor);
    } else {
      document.execCommand?.("insertText", false, text);
      if (target.textContent === "") target.textContent = text;
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return primitiveSuccess("text.insert", { inserted: true, inserted_length: text.length });
  };

  const keyboardPress = (args = {}) => {
    const key = String(args.key || "");
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
    if (!key || modifiers.length > 0) {
      return primitiveError("keyboard.press", "capability_unavailable", "This runtime can only dispatch page-level unmodified key events here.", {
        key,
        modifiers,
        reason: "trusted_key_events_unavailable"
      });
    }
    const target = document.activeElement || document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    }
    return primitiveSuccess("keyboard.press", { pressed: true, key, fidelity: "page_level" });
  };

  window.actionsJsonOverlay = {
    openHtml: openOverlay,
    registerLauncher,
    close: closeOverlay,
    screenshot: captureScreenshot,
    importStorageBundle,
    listStorageBundle,
    extractElements,
    runJavascript,
    debugRunJavascript,
    locatorElementInfo,
    viewportScroll,
    pointerClick
  };

  const loadManifest = async () => {
    if (manifest) return manifest;
    const response = await fetch(chrome.runtime.getURL("actions/overlay.actions.json"));
    manifest = await response.json();
    return manifest;
  };

  const handleActionCall = async (message) => {
    const callId = message.call_id || crypto.randomUUID();
    try {
      const rateLimitWaitMs = await waitForHumanInteractionSlot(message.name);
      const actions = await loadManifest();
      const action = actions.tools?.find((tool) => tool.name === message.name);
      if (!action) throw new Error(`Unknown action: ${message.name}`);

      let output;
      if (message.name === "overlay.open") {
        output = openOverlay(message.arguments || {});
      } else if (message.name === "overlay.register_launcher") {
        output = await registerLauncher(message.arguments || {});
      } else if (message.name === "overlay.close") {
        output = closeOverlay();
      } else if (message.name === "runtime.configure_pacing") {
        output = configurePrimitivePacing(message.arguments || {});
      } else if (message.name === "browser.screenshot") {
        output = await captureScreenshot(message.arguments || {});
      } else if (message.name === "browser.extract_elements") {
        output = await extractElements(message.arguments || {});
      } else if (message.name === "browser.run_javascript") {
        output = await runJavascript(message.arguments || {});
      } else if (message.name === "debug.run_javascript") {
        output = await debugRunJavascript(message.arguments || {});
      } else if (message.name === "locator.element_info") {
        output = locatorElementInfo(message.arguments || {});
      } else if (message.name === "locator.text_content") {
        output = locatorTextContent(message.arguments || {});
      } else if (message.name === "locator.wait_for") {
        output = await locatorWaitFor(message.arguments || {});
      } else if (message.name === "viewport.scroll") {
        output = await viewportScroll(message.arguments || {});
      } else if (message.name === "pointer.click") {
        output = pointerClick(message.arguments || {});
      } else if (message.name === "pointer.move") {
        output = pointerMove(message.arguments || {});
      } else if (message.name === "pointer.double_click") {
        output = pointerDoubleClick(message.arguments || {});
      } else if (message.name === "pointer.drag") {
        output = pointerDrag(message.arguments || {});
      } else if (message.name === "text.insert") {
        output = textInsert(message.arguments || {});
      } else if (message.name === "keyboard.press") {
        output = keyboardPress(message.arguments || {});
      } else if (message.name === "page.info") {
        output = pageInfo();
      } else if (message.name === "dom.observe.visible") {
        output = domObserveVisible(message.arguments || {});
      } else if (message.name === "dom.list_sections") {
        output = domListSections(message.arguments || {});
      } else if (message.name === "dom.snapshot_text") {
        output = domSnapshotText(message.arguments || {});
      } else if (message.name === "storage.import_bundle") {
        output = await importStorageBundle(message.arguments || {});
      } else if (message.name === "storage.list") {
        output = await listStorageBundle();
      } else {
        throw new Error(`No handler implemented for action: ${message.name}`);
      }

      protocolSend({
        type: "action_call_output",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        output: annotatePrimitivePacing(output, rateLimitWaitMs)
      });
    } catch (error) {
      protocolSend({
        type: "action_error",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        error: {
          code: "handler_failed",
          message: error.message || String(error)
        }
      });
    }
  };

  const enqueueActionCall = (message) => {
    const run = primitiveQueue.then(() => handleActionCall(message));
    primitiveQueue = run.catch(() => {});
    return run;
  };

  const connect = async (bridgeUrl) => {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    shouldReconnect = true;
    const actions = await loadManifest();
    await restoreRegisteredOverlays();
    installManifestAttachments(actions);

    const previousSocket = socket;
    socket = null;
    if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
      previousSocket.close();
    }

    const ws = new WebSocket(bridgeUrl);
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      reconnectAttempts = 0;
      protocolSend({
        type: "runtime_ready",
        runtime_id: RUNTIME_ID,
        runtime_key: runtimeKey,
        authorization_id: authorizationId,
        extension_version: extensionVersion,
        url: location.href,
        manifest: actions
      });
      for (const item of relayedRuntimeReady.values()) {
        protocolSend(item);
      }
    });
    ws.addEventListener("message", async (event) => {
      if (socket !== ws) return;
      const message = JSON.parse(event.data);
      if (message.type === "action_call") {
        if (message.runtime_id && relayedRuntimeIds.has(message.runtime_id)) {
          relayToPage(message);
          return;
        }
        await enqueueActionCall(message);
      } else if (message.type === "runtime_status") {
        protocolSend({
          type: "runtime_status",
          runtime_id: RUNTIME_ID,
          runtime_key: runtimeKey,
          authorization_id: authorizationId,
          extension_version: extensionVersion,
          url: location.href,
          connected: true,
          actions: actions.tools?.map((tool) => tool.name) || []
        });
        for (const runtimeId of relayedRuntimeIds) {
          relayToPage({ ...message, runtime_id: runtimeId });
        }
      }
    });
    ws.addEventListener("error", () => {
      if (socket === ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      scheduleReconnect(bridgeUrl);
    });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "actions-json:connect") {
      runtimeKey = message.runtimeKey || runtimeKey;
      authorizationId = message.authorizationId || authorizationId;
      extensionVersion = message.extensionVersion || extensionVersion;
      connect(message.bridgeUrl).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: error.message || String(error) })
      );
      return true;
    }
    if (message?.type === "actions-json:close-overlay") {
      sendResponse(closeOverlay());
    }
    return false;
  });

  window.__actionsJsonOverlayRuntime = {
    disconnect() {
      shouldReconnect = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close(1000, "runtime replaced");
      }
      socket = null;
      if (launcherObserver) {
        launcherObserver.disconnect();
        launcherObserver = null;
      }
      if (launcherUrlPoller) {
        clearInterval(launcherUrlPoller);
        launcherUrlPoller = null;
      }
      relayedRuntimeIds.clear();
      relayedRuntimeReady.clear();
      window.removeEventListener("message", handleBookmarkletRelayMessage);
      window.removeEventListener("popstate", scheduleLauncherRefresh);
      window.removeEventListener("hashchange", scheduleLauncherRefresh);
    }
  };
})();
