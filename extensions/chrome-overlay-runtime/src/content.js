(() => {
  if (window.__actionsJsonOverlayRuntime?.disconnect) {
    window.__actionsJsonOverlayRuntime.disconnect();
  } else if (window.__actionsJsonOverlayRuntimeLoaded) {
    return;
  }
  window.__actionsJsonOverlayRuntimeLoaded = true;

  const RUNTIME_ID = `actions-json-runtime-${Math.random().toString(36).slice(2)}`;
  let socket = null;
  let reconnectTimer = null;
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

  const LAUNCHER_ATTR = "data-actions-json-overlay-launcher";

  const protocolSend = (item) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(item));
    }
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

  const refreshRegisteredLaunchers = () => {
    if (overlayRegistry.size === 0) return [];
    suppressLauncherObserverUntil = Date.now() + 250;
    return Array.from(overlayRegistry.values()).flatMap((overlayArgs) => installLaunchers(overlayArgs));
  };

  const scheduleLauncherRefresh = () => {
    if (overlayRegistry.size === 0 || Date.now() < suppressLauncherObserverUntil) return;
    clearTimeout(launcherRefreshTimer);
    launcherRefreshTimer = setTimeout(() => {
      refreshRegisteredLaunchers();
    }, 180);
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

  const sendRuntimeMessage = (message) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
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
    const response = await sendRuntimeMessage({
      type: "actions-json:capture-visible-tab",
      format,
      quality: Number.isInteger(args.quality) ? args.quality : undefined,
      delayMs
    });
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

  window.actionsJsonOverlay = {
    openHtml: openOverlay,
    close: closeOverlay,
    screenshot: captureScreenshot,
    importStorageBundle,
    listStorageBundle
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
      const actions = await loadManifest();
      const action = actions.tools?.find((tool) => tool.name === message.name);
      if (!action) throw new Error(`Unknown action: ${message.name}`);

      let output;
      if (message.name === "overlay.open") {
        output = openOverlay(message.arguments || {});
      } else if (message.name === "overlay.close") {
        output = closeOverlay();
      } else if (message.name === "browser.screenshot") {
        output = await captureScreenshot(message.arguments || {});
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
        output
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

  const connect = async (bridgeUrl) => {
    clearTimeout(reconnectTimer);
    const actions = await loadManifest();
    installManifestAttachments(actions);

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }

    socket = new WebSocket(bridgeUrl);
    socket.addEventListener("open", () => {
      protocolSend({
        type: "runtime_ready",
        runtime_id: RUNTIME_ID,
        runtime_key: runtimeKey,
        authorization_id: authorizationId,
        extension_version: extensionVersion,
        url: location.href,
        manifest: actions
      });
    });
    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "action_call") {
        await handleActionCall(message);
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
      }
    });
    socket.addEventListener("close", () => {
      reconnectTimer = setTimeout(() => connect(bridgeUrl).catch(() => {}), 1500);
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
      window.removeEventListener("popstate", scheduleLauncherRefresh);
      window.removeEventListener("hashchange", scheduleLauncherRefresh);
    }
  };
})();
