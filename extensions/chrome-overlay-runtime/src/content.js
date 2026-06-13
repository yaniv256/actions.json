(() => {
  if (window.__actionsJsonOverlayRuntimeLoaded) {
    return;
  }
  window.__actionsJsonOverlayRuntimeLoaded = true;

  const RUNTIME_ID = `actions-json-runtime-${Math.random().toString(36).slice(2)}`;
  let socket = null;
  let backgroundBridge = false;
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
  let stateProjectionModulePromise = null;

  const LAUNCHER_ATTR = "data-actions-json-overlay-launcher";
  const OVERLAY_REGISTRY_STORAGE_KEY = "actionsJsonOverlayRegistry.v1";
  const MENU_OVERLAY_STATE_STORAGE_KEY = "actionsJsonMenuOverlayState.v1";
  const STORAGE_BUNDLE_KEY = "actionsJsonStorageBundle";
  const OVERLAY_BUNDLE_MARKER = "actions.json.overlay.bundle";
  const BOOKMARKLET_RELAY_SOURCE = "ajbm";
  const EXTENSION_RELAY_SOURCE = "ajex";

  const protocolSend = (item) => {
    if (backgroundBridge) {
      chrome.runtime.sendMessage({ type: "actions-json:bridge-protocol", item }, () => {});
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(item));
    }
  };

  const newActionCallId = (prefix = "call") => {
    if (globalThis.crypto?.randomUUID) {
      return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const isHumanInteractionAction = (name) =>
    name === "viewport.scroll" ||
    name.startsWith("pointer.") ||
    name === "text.insert" ||
    name === "transfer.insert" ||
    name === "keyboard.press";

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

  // Generic in-session task queue (logic in src/agent/task-queue.mjs so it is
  // unit-testable). Externalizes a multi-step plan so an agent does not have to
  // hold the whole loop in context: seed tasks with task.add, pull one at a time
  // with task.next, do the work, report task.complete, pull the next. On an
  // empty task.next the agent learns the run is done and gets a summary of every
  // completed/failed task to ground its final report. State lives for the tab
  // session. The module is imported lazily on first use: an eager import fires a
  // network script load at injection time, which strict page CSP blocks for the
  // page-injected runtime (extension content scripts load from the extension
  // origin and are unaffected).
  let taskQueueImpl = null;
  let taskQueueLoadPromise = null;
  const ensureTaskQueue = () => {
    if (taskQueueImpl) {
      return Promise.resolve();
    }
    if (!taskQueueLoadPromise) {
      taskQueueLoadPromise = import(chrome.runtime.getURL("src/agent/task-queue.mjs"))
        .then((module) => {
          taskQueueImpl = module.createTaskQueue();
        })
        .catch(() => {
          taskQueueLoadPromise = null;
        });
    }
    return taskQueueLoadPromise;
  };

  const taskQueueCall = async (primitive, method, args) => {
    if (!taskQueueImpl) {
      await ensureTaskQueue();
    }
    if (!taskQueueImpl) {
      return primitiveError(
        primitive,
        "task_queue_unavailable",
        "Task queue module could not be loaded on this page (script loading may be blocked by page CSP).",
      );
    }
    const result = taskQueueImpl[method](args);
    if (result.ok === false) {
      return primitiveError(primitive, result.error.code, result.error.message);
    }
    const { ok: _ok, ...value } = result;
    return primitiveSuccess(primitive, value);
  };

  const taskAdd = (args = {}) => taskQueueCall("task.add", "add", args);
  const taskNext = () => taskQueueCall("task.next", "next");
  const taskComplete = (args = {}) => taskQueueCall("task.complete", "complete", args);
  const taskList = () => taskQueueCall("task.list", "list");
  const taskClear = () => taskQueueCall("task.clear", "clear");

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
    if (!shouldReconnect || !bridgeUrl || backgroundBridge) return;
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

  const removeUnsafeAttributes = (root) => {
    root.querySelectorAll("*").forEach((node) => {
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = String(attribute.value || "").trim().toLowerCase();
        if (name.startsWith("on") || value.startsWith("javascript:")) {
          node.removeAttribute(attribute.name);
        }
      }
    });
  };

  const parseHtmlDocument = (html, options = {}) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const style = Array.from(doc.querySelectorAll("style")).map((node) => node.textContent || "").join("\n");
    removeUnsafeAttributes(doc);
    if (!options.preserveScripts) {
      doc.querySelectorAll("script").forEach((node) => node.remove());
    }
    return {
      title: doc.querySelector("title")?.textContent?.trim(),
      style,
      body: doc.body ? doc.body.innerHTML : html,
      html: doc.documentElement ? doc.documentElement.outerHTML : html
    };
  };

  const buildOverlayArtifactHtml = ({ title, parsed }) => {
    const artifactTitle = title || parsed?.title || "actions.json overlay";
    const style = parsed?.style || "";
    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(artifactTitle)}</title>`,
      `<style>\n${style}\n</style>`,
      "</head>",
      "<body>",
      parsed?.body || "",
      "</body>",
      "</html>",
      ""
    ].join("\n");
  };

  const jsonForScriptText = (value) =>
    JSON.stringify(value ?? null)
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");

  const buildTemplateDocumentHtml = ({ parsed, data }) => {
    const docHtml = parsed?.html || "<html><head></head><body></body></html>";
    const dataScript = `<script type="application/json" data-actions-json-overlay-data>${jsonForScriptText(data)}</script>`;
    if (/<head[^>]*>/i.test(docHtml)) {
      return docHtml.replace(/<head([^>]*)>/i, `<head$1>${dataScript}`);
    }
    if (/<html[^>]*>/i.test(docHtml)) {
      return docHtml.replace(/<html([^>]*)>/i, `<html$1><head>${dataScript}</head>`);
    }
    return `<!doctype html><html><head>${dataScript}</head><body>${docHtml}</body></html>`;
  };

  const buildOverlayBundleHtml = ({ title, templateHtml, dataJson, metadata }) => {
    const artifactTitle = title || "actions.json overlay bundle";
    const bootstrapData = {
      protocol: OVERLAY_BUNDLE_MARKER,
      version: 1,
      title: artifactTitle,
      metadata,
      template_html: templateHtml,
      data_json: dataJson
    };
    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(artifactTitle)}</title>`,
      "</head>",
      "<body>",
      '<main id="actions-json-overlay-bundle-root">Loading actions.json overlay bundle...</main>',
      `<script type="application/json" data-actions-json-overlay-bundle>${jsonForScriptText(bootstrapData)}</script>`,
      "<script>",
      "(() => {",
      "  const bundle = JSON.parse(document.querySelector('[data-actions-json-overlay-bundle]').textContent);",
      "  const parser = new DOMParser();",
      "  const doc = parser.parseFromString(bundle.template_html, 'text/html');",
      "  const dataScript = doc.createElement('script');",
      "  dataScript.type = 'application/json';",
      "  dataScript.setAttribute('data-actions-json-overlay-data', '');",
      "  dataScript.textContent = bundle.data_json;",
      "  doc.head.prepend(dataScript);",
      "  document.open();",
      "  document.write('<!doctype html>' + doc.documentElement.outerHTML);",
      "  document.close();",
      "})();",
      "</script>",
      "</body>",
      "</html>",
      ""
    ].join("\n");
  };

  const renderOverlayDocument = (container, parsed, options = {}) => {
    container.textContent = "";
    const iframe = document.createElement("iframe");
    iframe.dataset.overlayDocument = "true";
    iframe.setAttribute("sandbox", options.allowScripts ? "allow-scripts" : "allow-same-origin");
    iframe.setAttribute("title", "actions.json overlay content");

    if (options.allowScripts) {
      iframe.srcdoc = buildTemplateDocumentHtml({ parsed, data: options.data });
      container.appendChild(iframe);
      return iframe;
    }

    const populate = () => {
      const frameDoc = iframe.contentDocument;
      if (!frameDoc) return;

      frameDoc.open();
      frameDoc.write("<!doctype html><html><head></head><body></body></html>");
      frameDoc.close();
      frameDoc.title = parsed?.title || "actions.json overlay";
      frameDoc.body.innerHTML = parsed?.body || "";

      const css = parsed?.style || "";
      if (css && iframe.contentWindow?.CSSStyleSheet) {
        const sheet = new iframe.contentWindow.CSSStyleSheet();
        sheet.replaceSync(css);
        frameDoc.adoptedStyleSheets = [...frameDoc.adoptedStyleSheets, sheet];
      }
    };

    iframe.addEventListener("load", populate, { once: true });
    container.appendChild(iframe);

    return iframe;
  };

  const filenameFromTitle = (title) => {
    const base = String(title || "actions-json-overlay")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return `${base || "actions-json-overlay"}.html`;
  };

  const escapeHtml = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

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
    const { html, template, title, width = 980, height = 760 } = overlayArgs || {};
    const hasHtml = typeof html === "string" && html.length > 0;
    const hasTemplate = template && typeof template === "object";
    if (hasHtml && hasTemplate) {
      throw new Error("overlay.open accepts either html or template, not both");
    }
    if (!hasHtml && !hasTemplate) {
      throw new Error("overlay.open requires either a non-empty html string or a template storage reference");
    }
    const normalized = { ...overlayArgs, title, width, height };
    if (hasHtml) normalized.html = html;
    if (hasTemplate) normalized.template = template;
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
        openOverlay(overlayArgs).catch((error) => {
          emitDomEvent("actions-json:overlay-open-failed", {
            launcher_id: launcherId,
            error: error.message || String(error)
          });
        });
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
    .overlay-document-frame,
    iframe[data-overlay-document] {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }
  `;

  const openOverlay = async (overlayArgs) => {
    const normalizedOverlayArgs = registerOverlayArgs(overlayArgs);
    if (normalizedOverlayArgs.launcher || Array.isArray(normalizedOverlayArgs.launchers)) {
      persistRegisteredOverlays().catch((_error) => {});
    }
    const resolvedOverlayArgs = await resolveOverlayContent(normalizedOverlayArgs);
    const { html, title, width = 980, height = 760 } = resolvedOverlayArgs;

    const existing = document.getElementById("__actions_json_overlay_runtime_host");
    if (existing) existing.remove();

    const parsed = parseHtmlDocument(html, { preserveScripts: Boolean(resolvedOverlayArgs.__templateDriven) });
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
      <style>${reportBaseCss}</style>
      <section class="overlay-frame" role="dialog" aria-label="actions.json overlay report">
        <header class="overlay-bar" data-drag-handle>
          <div class="overlay-title"></div>
          <div class="overlay-actions">
            <button class="overlay-btn" type="button" data-download>Download</button>
            <button class="overlay-btn" type="button" data-upload>Upload</button>
            <button class="overlay-btn" type="button" data-minimize aria-expanded="true">Minimize</button>
            <button class="overlay-btn" type="button" data-reset>Reset</button>
            <button class="overlay-btn" type="button" data-close>Close</button>
            <input type="file" accept=".html,text/html" data-upload-input hidden>
          </div>
        </header>
        <main class="overlay-body"></main>
      </section>
    `;
    const displayTitle = title || parsed.title || "actions.json overlay";
    const artifactHtml = resolvedOverlayArgs.__templateDriven
      ? buildOverlayBundleHtml({
        title: displayTitle,
        templateHtml: resolvedOverlayArgs.__templateAsset.content,
        dataJson: resolvedOverlayArgs.__dataJson,
        metadata: {
          template: resolvedOverlayArgs.template,
          data: resolvedOverlayArgs.data || null,
          resolved_template_path: resolvedOverlayArgs.__templateAsset.canonicalPath,
          resolved_data_path: resolvedOverlayArgs.__dataAsset?.canonicalPath || null
        }
      })
      : buildOverlayArtifactHtml({ title: displayTitle, parsed });
    shadow.querySelector(".overlay-title").textContent = displayTitle;
    renderOverlayDocument(shadow.querySelector(".overlay-body"), parsed, {
      allowScripts: Boolean(resolvedOverlayArgs.__templateDriven),
      data: resolvedOverlayArgs.__dataValue
    });
    document.documentElement.appendChild(host);

    const bar = shadow.querySelector("[data-drag-handle]");
    const frame = shadow.querySelector(".overlay-frame");
    const close = shadow.querySelector("[data-close]");
    const minimize = shadow.querySelector("[data-minimize]");
    const reset = shadow.querySelector("[data-reset]");
    const download = shadow.querySelector("[data-download]");
    const upload = shadow.querySelector("[data-upload]");
    const uploadInput = shadow.querySelector("[data-upload-input]");
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
    download.addEventListener("click", () => {
      const blob = new Blob([artifactHtml], { type: "text/html;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filenameFromTitle(displayTitle);
      anchor.rel = "noopener";
      document.documentElement.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      emitDomEvent("actions-json:overlay-downloaded", {
        overlay_id: overlayId,
        filename: anchor.download,
        bytes: artifactHtml.length
      });
    });
    upload.addEventListener("click", () => {
      uploadInput.click();
    });
    uploadInput.addEventListener("change", async () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = "";
      if (!file) return;
      try {
        const uploadedHtml = await file.text();
        const overlayBundle = parseOverlayBundleArtifact(uploadedHtml);
        if (overlayBundle) {
          const refs = await importOverlayBundleToPrivate(overlayBundle);
          await openOverlay({
            template: refs.template,
            data: refs.data,
            title: overlayBundle.title || file.name.replace(/\.html?$/i, "") || "Imported overlay",
            width,
            height
          });
        } else {
          const uploadedParsed = parseHtmlDocument(uploadedHtml);
          const uploadedTitle = uploadedParsed.title || file.name.replace(/\.html?$/i, "") || "Imported overlay";
          await openOverlay({
            html: uploadedHtml,
            title: uploadedTitle,
            width,
            height
          });
        }
        emitDomEvent("actions-json:overlay-uploaded", {
          overlay_id: overlayId,
          filename: file.name,
          bytes: uploadedHtml.length
        });
      } catch (error) {
        emitDomEvent("actions-json:overlay-upload-failed", {
          overlay_id: overlayId,
          filename: file.name,
          error: error.message || String(error)
        });
      }
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

    return {
      ok: true,
      overlay_id: overlayId,
      launchers,
      template: resolvedOverlayArgs.__templateDriven ? resolvedOverlayArgs.template : null,
      data: resolvedOverlayArgs.__templateDriven ? (resolvedOverlayArgs.data || null) : null
    };
  };

  const closeOverlay = () => {
    const existing = document.getElementById("__actions_json_overlay_runtime_host");
    if (existing) {
      const overlayId = existing.dataset.overlayId || null;
      existing.remove();
      emitDomEvent("actions-json:overlay-closed", { overlay_id: overlayId });
    }
    const menu = document.getElementById("__actions_json_menu_overlay_host");
    if (menu) {
      menu.remove();
      persistMenuOverlayState({ open: false }).catch((_error) => {});
      emitDomEvent("actions-json:overlay-closed", { overlay_id: "actions-json-menu" });
    }
    return { ok: true };
  };

  const menuOverlayControl = () => {
    const host = document.getElementById("__actions_json_menu_overlay_host");
    if (!host || !host.__actionsJsonMenuControl) {
      throw new Error("The actions.json menu overlay is not open; nothing to collapse, expand, or move.");
    }
    return { host, control: host.__actionsJsonMenuControl };
  };

  const collapseMenuOverlay = () => {
    const { control } = menuOverlayControl();
    control.setCollapsed(true);
    return { ok: true, overlay_id: "actions-json-menu", collapsed: true, geometry: control.geometry() };
  };

  const expandMenuOverlay = () => {
    const { control } = menuOverlayControl();
    control.setCollapsed(false);
    return { ok: true, overlay_id: "actions-json-menu", collapsed: false, geometry: control.geometry() };
  };

  const hideMenuOverlay = () => {
    const { control } = menuOverlayControl();
    control.setHidden(true);
    return { ok: true, overlay_id: "actions-json-menu", hidden: true };
  };

  const showMenuOverlay = () => {
    const { control } = menuOverlayControl();
    control.setHidden(false);
    return { ok: true, overlay_id: "actions-json-menu", hidden: false, geometry: control.geometry() };
  };

  const moveMenuOverlay = (args = {}) => {
    const { control } = menuOverlayControl();
    const corner = typeof args.corner === "string" ? args.corner.toLowerCase() : null;
    let left = Number.isFinite(args.left) ? args.left : null;
    let top = Number.isFinite(args.top) ? args.top : null;
    if (corner) {
      const margin = 12;
      const geo = control.geometry();
      const w = geo.width;
      const h = geo.height;
      const right = Math.max(margin, window.innerWidth - w - margin);
      const bottom = Math.max(margin, window.innerHeight - h - margin);
      const map = {
        "top-left": [margin, margin],
        "top-right": [right, margin],
        "bottom-left": [margin, bottom],
        "bottom-right": [right, bottom],
      };
      if (!map[corner]) {
        throw new Error(`Unknown corner '${args.corner}'. Use top-left, top-right, bottom-left, or bottom-right, or pass left/top.`);
      }
      [left, top] = map[corner];
    }
    if (left == null || top == null) {
      throw new Error("overlay.menu.move requires a corner, or numeric left and top coordinates.");
    }
    control.place(left, top);
    return { ok: true, overlay_id: "actions-json-menu", geometry: control.geometry() };
  };

  const menuOverlayGeometryFrom = (host) => {
    const rect = host.getBoundingClientRect();
    return {
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: host.style.width || `${Math.round(rect.width)}px`,
      height: host.style.height || `${Math.round(rect.height)}px`,
      minWidth: host.style.minWidth,
      minHeight: host.style.minHeight,
      resize: host.style.resize,
      right: host.style.right,
      bottom: host.style.bottom,
    };
  };

  const persistMenuOverlayState = async (state) => {
    await storageSet({
      [MENU_OVERLAY_STATE_STORAGE_KEY]: {
        version: 1,
        updated_at: new Date().toISOString(),
        ...state,
      },
    });
  };

  const openMenuOverlay = (options = {}) => {
    const restoreState = options.restoreState && typeof options.restoreState === "object" ? options.restoreState : {};
    const existing = document.getElementById("__actions_json_menu_overlay_host");
    if (existing) {
      existing.remove();
    }

    const host = document.createElement("div");
    host.id = "__actions_json_menu_overlay_host";
    const restoredGeometry = restoreState.geometry && typeof restoreState.geometry === "object"
      ? restoreState.geometry
      : null;
    const initialLeft = restoredGeometry?.left || null;
    const initialTop = restoredGeometry?.top || null;
    const initialWidth = restoredGeometry?.width || "min(340px, calc(100vw - 48px))";
    const initialHeight = restoredGeometry?.height || "min(420px, calc(100vh - 48px))";
    host.style.cssText = [
      "position:fixed",
      initialLeft ? `left:${initialLeft}` : "right:24px",
      `top:${initialTop || "24px"}`,
      initialLeft ? "right:auto" : "right:24px",
      `width:${initialWidth}`,
      `height:${initialHeight}`,
      "min-width:220px",
      "min-height:42px",
      "z-index:2147483647",
      "resize:both",
      "overflow:hidden",
      "background:white",
      "border:1px solid rgba(20,24,31,0.22)",
      "border-radius:10px",
      "box-shadow:0 24px 80px rgba(0,0,0,0.32)"
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          --ink: #15171d;
          --muted: #5d6372;
          --line: #dce1ea;
          --bar: #18202c;
          --tab-active: #ffffff;
          all: initial;
          color: var(--ink);
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        * { box-sizing: border-box; }
        .panel {
          width: 100%;
          height: 100%;
          display: grid;
          grid-template-rows: 42px minmax(0, 1fr);
          background: #f7f8fb;
          color: var(--ink);
        }
        .panel[data-collapsed="true"] {
          grid-template-rows: 42px;
        }
        .panel[data-collapsed="true"] .body {
          display: none;
        }
        .panel[data-collapsed="true"] .bar {
          grid-template-columns: 30px;
          padding: 6px;
        }
        .panel[data-collapsed="true"] .title,
        .panel[data-collapsed="true"] [data-close] {
          display: none;
        }
        .panel[data-collapsed="true"] .actions {
          gap: 0;
        }
        .bar {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 8px;
          min-width: 0;
          padding: 0 8px 0 10px;
          background: var(--bar);
          color: #fff;
          cursor: move;
          user-select: none;
        }
        .title {
          display: flex;
          gap: 4px;
          align-items: center;
          min-width: 0;
          height: 100%;
          color: #fff;
          font: 750 12px/1 system-ui, sans-serif;
          letter-spacing: 0.02em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .actions {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .icon {
          appearance: none;
          width: 30px;
          height: 30px;
          padding: 0;
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 7px;
          background: rgba(255,255,255,0.08);
          color: #fff;
          font: 800 15px/1 system-ui, sans-serif;
          cursor: pointer;
        }
        .icon:hover { background: rgba(255,255,255,0.16); }
        .body {
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          border-top: 0;
        }
        .panel-view {
          display: none;
          width: 100%;
          height: 100%;
          min-height: 0;
        }
        .panel-view.active {
          display: block;
        }
        iframe {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: #fff;
        }
      </style>
      <section class="panel" role="dialog" aria-label="actions.json menu">
        <header class="bar" data-drag-handle>
          <div class="title">actions.json agent</div>
          <div class="actions">
            <button class="icon" type="button" title="Collapse" data-minimize>☰</button>
            <button class="icon" type="button" title="Close" data-close>×</button>
          </div>
        </header>
        <main class="body">
          <section class="panel-view active" data-panel="agent" role="tabpanel">
            <iframe title="actions.json agent" allow="microphone; autoplay" src="${chrome.runtime.getURL("sidepanel.html?surface=overlay&tab=agent")}"></iframe>
          </section>
        </main>
      </section>
    `;
    document.documentElement.appendChild(host);

    const panel = shadow.querySelector(".panel");
    const bar = shadow.querySelector("[data-drag-handle]");
    const minimize = shadow.querySelector("[data-minimize]");
    const close = shadow.querySelector("[data-close]");
    let drag = null;
    let restoreGeometry = restoredGeometry;
    let persistTimer = null;

    const persistCurrentState = (extra = {}) => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        const collapsed = panel.dataset.collapsed === "true";
        const geometry = collapsed && restoreGeometry
          ? restoreGeometry
          : menuOverlayGeometryFrom(host);
        persistMenuOverlayState({
          open: true,
          selected_tab: "agent",
          collapsed,
          geometry,
          ...extra,
        }).catch((_error) => {});
      }, 0);
    };

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const place = (left, top) => {
      const rect = host.getBoundingClientRect();
      host.style.left = `${clamp(left, 8, window.innerWidth - Math.min(rect.width, window.innerWidth) - 8)}px`;
      host.style.top = `${clamp(top, 8, window.innerHeight - Math.min(rect.height, window.innerHeight) - 8)}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };
    const setCollapsed = (collapsed) => {
      if (collapsed) {
        const rect = host.getBoundingClientRect();
        restoreGeometry = {
          width: host.style.width,
          height: host.style.height,
          minWidth: host.style.minWidth,
          minHeight: host.style.minHeight,
          resize: host.style.resize,
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          right: host.style.right,
          bottom: host.style.bottom,
        };
        panel.dataset.collapsed = "true";
        host.style.left = `${rect.left}px`;
        host.style.top = `${rect.top}px`;
        host.style.right = "auto";
        host.style.bottom = "auto";
        host.style.width = "42px";
        host.style.height = "42px";
        host.style.minWidth = "42px";
        host.style.minHeight = "42px";
        host.style.resize = "none";
        minimize.title = "Expand";
        persistCurrentState({ collapsed: true, geometry: restoreGeometry });
        return;
      }
      panel.dataset.collapsed = "false";
      if (restoreGeometry) {
        host.style.width = restoreGeometry.width;
        host.style.height = restoreGeometry.height;
        host.style.minWidth = restoreGeometry.minWidth;
        host.style.minHeight = restoreGeometry.minHeight;
        host.style.resize = restoreGeometry.resize;
        host.style.left = restoreGeometry.left;
        host.style.top = restoreGeometry.top;
        host.style.right = restoreGeometry.right;
        host.style.bottom = restoreGeometry.bottom;
      }
      restoreGeometry = null;
      minimize.title = "Collapse";
      place(host.getBoundingClientRect().left, host.getBoundingClientRect().top);
      persistCurrentState({ collapsed: false });
    };

    // Expose a programmatic control surface so runtime primitives can collapse,
    // expand, and move the menu overlay without simulating shadow-DOM pointer
    // events (which the bound handlers ignore). Reuses the same setCollapsed/place
    // logic the header buttons use, including geometry persistence and clamping.
    host.__actionsJsonMenuControl = {
      setCollapsed,
      place,
      isCollapsed: () => panel.dataset.collapsed === "true",
      setHidden: (hidden) => {
        // Hide removes the overlay from hit-testing entirely so it cannot
        // intercept clicks on page controls underneath. The open/collapsed
        // state and geometry are untouched, so show restores it exactly.
        host.style.visibility = hidden ? "hidden" : "";
        host.style.pointerEvents = hidden ? "none" : "";
        host.dataset.hidden = hidden ? "true" : "false";
      },
      isHidden: () => host.dataset.hidden === "true",
      geometry: () => {
        const rect = host.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      },
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
      if (drag && drag.pointerId === event.pointerId) {
        drag = null;
        persistCurrentState();
      }
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    minimize.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(panel.dataset.collapsed !== "true");
    });
    close.addEventListener("click", () => {
      host.remove();
      clearTimeout(persistTimer);
      persistMenuOverlayState({ open: false }).catch((_error) => {});
      emitDomEvent("actions-json:overlay-closed", { overlay_id: "actions-json-menu" });
    });

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => persistCurrentState())
      : null;
    resizeObserver?.observe(host);

    if (restoreState.collapsed === true) {
      setCollapsed(true);
    } else {
      persistCurrentState({ collapsed: false });
    }

    emitDomEvent("actions-json:overlay-opened", { overlay_id: "actions-json-menu" });
    return { ok: true, overlay_id: "actions-json-menu" };
  };

  const restoreMenuOverlayIfNeeded = async () => {
    if (document.getElementById("__actions_json_menu_overlay_host")) {
      return { ok: true, restored: false, already_open: true };
    }
    const stored = await storageGet(MENU_OVERLAY_STATE_STORAGE_KEY);
    if (!stored || stored.open !== true) return { ok: true, restored: false };
    return { ...openMenuOverlay({ restoreState: stored }), restored: true };
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

  const normalizeStorageScope = (scope = "private") => {
    const value = String(scope || "private").trim();
    if (value === "private" || value === "public") return value;
    const sharedMatch = value.match(/^shared[:/](.+)$/);
    if (sharedMatch && /^[a-z0-9._-]+$/i.test(sharedMatch[1])) {
      return `shared/${sharedMatch[1]}`;
    }
    throw new Error(`Unknown storage scope: ${value}`);
  };

  const normalizeStorageRelativePath = (path) => {
    const value = String(path || "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
    if (!value) throw new Error("Storage asset path is required");
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Unsafe storage path: ${path}`);
    }
    return parts.join("/");
  };

  const storageRefFrom = (ref, defaultScope = "private") => {
    if (!ref || typeof ref !== "object") {
      throw new Error("Storage asset reference must be an object");
    }
    const rawPath = normalizeStorageRelativePath(ref.path);
    if (rawPath.startsWith("scopes/")) {
      const parts = rawPath.split("/");
      if (parts.length < 4) throw new Error(`Unsafe storage path: ${ref.path}`);
      if (parts[1] === "shared") {
        if (parts.length < 5) throw new Error(`Unsafe shared storage path: ${ref.path}`);
        return {
          scope: `shared/${parts[2]}`,
          path: parts.slice(3).join("/"),
          canonicalPath: rawPath
        };
      }
      const scope = normalizeStorageScope(parts[1]);
      return {
        scope,
        path: parts.slice(2).join("/"),
        canonicalPath: rawPath
      };
    }
    const scope = normalizeStorageScope(ref.scope || defaultScope);
    return {
      scope,
      path: rawPath,
      canonicalPath: `scopes/${scope}/${rawPath}`
    };
  };

  const getStorageBundle = async () => {
    const bundle = await storageGet(STORAGE_BUNDLE_KEY);
    if (bundle?.protocol === "actions.json.storage.bundle" && Array.isArray(bundle.entries)) {
      return bundle;
    }
    return { protocol: "actions.json.storage.bundle", version: 1, entries: [] };
  };

  const readStorageEntryContent = (entry) => {
    if (typeof entry?.content === "string") return entry.content;
    if (typeof entry?.text === "string") return entry.text;
    if (entry?.content_json !== undefined) return JSON.stringify(entry.content_json, null, 2);
    return "";
  };

  const storageLookupPathsFor = (normalizedRef) => {
    const paths = [normalizedRef.canonicalPath];
    if (normalizedRef.path && !paths.includes(normalizedRef.path)) {
      paths.push(normalizedRef.path);
    }
    return paths;
  };

  const resolveStorageAsset = async (ref, options = {}) => {
    const normalizedRef = storageRefFrom(ref, options.defaultScope || "private");
    const bundle = await getStorageBundle();
    const lookupPaths = storageLookupPathsFor(normalizedRef);
    const entry = bundle.entries.find((candidate) => lookupPaths.includes(candidate?.path));
    if (!entry) {
      throw new Error(`${options.label || "Storage asset"} not found: ${normalizedRef.canonicalPath}`);
    }
    return {
      ...normalizedRef,
      content: readStorageEntryContent(entry),
      content_type: entry.content_type || entry.contentType || null,
      entry,
      resolvedPath: entry.path
    };
  };

  const parseJsonAsset = (asset, label) => {
    try {
      return JSON.parse(asset.content || "null");
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${asset.canonicalPath}`);
    }
  };

  const resolveOverlayContent = async (normalizedOverlayArgs) => {
    if (typeof normalizedOverlayArgs.html === "string") {
      return normalizedOverlayArgs;
    }
    const templateAsset = await resolveStorageAsset(normalizedOverlayArgs.template, {
      label: "Overlay template asset"
    });
    let dataAsset = null;
    let dataValue = null;
    if (normalizedOverlayArgs.data) {
      dataAsset = await resolveStorageAsset(normalizedOverlayArgs.data, {
        label: "Overlay data asset"
      });
      dataValue = parseJsonAsset(dataAsset, "Overlay data asset");
    }
    return {
      ...normalizedOverlayArgs,
      html: templateAsset.content,
      __templateDriven: true,
      __templateAsset: templateAsset,
      __dataAsset: dataAsset,
      __dataValue: dataValue,
      __dataJson: dataAsset?.content || "null"
    };
  };

  const parseOverlayBundleArtifact = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const node = doc.querySelector("[data-actions-json-overlay-bundle]");
    if (!node) return null;
    const bundle = JSON.parse(node.textContent || "{}");
    if (bundle?.protocol !== OVERLAY_BUNDLE_MARKER || typeof bundle.template_html !== "string") {
      throw new Error("Uploaded overlay bundle is not an actions.json overlay bundle");
    }
    return bundle;
  };

  const privateRefForUploadedAsset = (ref, fallbackPath) => {
    if (ref && typeof ref === "object") {
      const normalized = storageRefFrom({ ...ref, scope: ref.scope || "private" }, "private");
      return {
        scope: "private",
        path: normalized.path || fallbackPath,
        canonicalPath: `scopes/private/${normalized.path || fallbackPath}`
      };
    }
    const path = normalizeStorageRelativePath(fallbackPath);
    return { scope: "private", path, canonicalPath: `scopes/private/${path}` };
  };

  const upsertStorageEntries = async (entriesToUpsert) => {
    const bundle = await getStorageBundle();
    const paths = new Set(entriesToUpsert.map((entry) => entry.path));
    const entries = [
      ...bundle.entries.filter((entry) => entry?.path && !paths.has(entry.path)),
      ...entriesToUpsert
    ];
    await storageSet({
      [STORAGE_BUNDLE_KEY]: {
        ...bundle,
        protocol: "actions.json.storage.bundle",
        version: bundle.version || 1,
        entries,
        imported_at: new Date().toISOString()
      }
    });
    return entries;
  };

  const importOverlayBundleToPrivate = async (bundle, currentUrl = location.href) => {
    const host = new URL(currentUrl).hostname || "current-site";
    const slug = filenameFromTitle(bundle.title || "imported-overlay").replace(/\.html$/i, "");
    const metadata = bundle.metadata && typeof bundle.metadata === "object" ? bundle.metadata : {};
    const templateRef = privateRefForUploadedAsset(metadata.template, `sites/${host}/overlays/${slug}/template.html`);
    const dataRef = privateRefForUploadedAsset(metadata.data, `sites/${host}/overlays/${slug}/data.json`);
    const dataJson = typeof bundle.data_json === "string" ? bundle.data_json : JSON.stringify(bundle.data_json ?? null, null, 2);
    await upsertStorageEntries([
      {
        path: templateRef.canonicalPath,
        content_type: "text/html",
        content: bundle.template_html
      },
      {
        path: dataRef.canonicalPath,
        content_type: "application/json",
        content: dataJson
      }
    ]);
    return {
      template: { scope: "private", path: templateRef.path },
      data: { scope: "private", path: dataRef.path }
    };
  };

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

  const listClaimedTabs = async () => sendRuntimeMessage({
    type: "actions-json:claimed-tabs-list"
  });

  const activateClaimedTab = async (args = {}) => {
    const tabId = Number(args.tab_id ?? args.tabId);
    if (!Number.isInteger(tabId)) {
      throw new Error("browser.claimed_tabs.activate requires tab_id");
    }
    return sendRuntimeMessage({
      type: "actions-json:claimed-tabs-activate",
      tabId,
      reconnectDelayMs: 300
    });
  };

  const entryModifiedAtMs = (entry = {}) => {
    const value = entry.modified_at_ms ?? entry.last_modified_ms ?? entry.mtime_ms ?? entry.updated_at_ms;
    if (Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };

  const mergeBridgeHydrationBundle = (currentBundle, incomingBundle) => {
    const byPath = new Map();
    for (const entry of Array.isArray(currentBundle?.entries) ? currentBundle.entries : []) {
      if (typeof entry?.path === "string" && entry.path) {
        byPath.set(entry.path, entry);
      }
    }

    let updatedCount = 0;
    let preservedCount = 0;
    for (const entry of incomingBundle.entries) {
      if (typeof entry?.path !== "string" || !entry.path) {
        continue;
      }
      const previous = byPath.get(entry.path);
      if (!previous || entryModifiedAtMs(entry) > entryModifiedAtMs(previous)) {
        byPath.set(entry.path, entry);
        updatedCount += 1;
      } else {
        preservedCount += 1;
      }
    }

    const entries = Array.from(byPath.values()).sort((left, right) =>
      String(left.path || "").localeCompare(String(right.path || ""))
    );
    return {
      ...incomingBundle,
      entries,
      imported_at: new Date().toISOString(),
      x_actions_json_bridge_hydration_merged: true,
      x_actions_json_hydration_updated_count: updatedCount,
      x_actions_json_hydration_preserved_count: preservedCount
    };
  };

  const importStorageBundle = async (args = {}) => {
    const bundle = args.bundle;
    if (bundle?.protocol !== "actions.json.storage.bundle" || !Array.isArray(bundle.entries)) {
      throw new Error("storage.import_bundle requires an actions.json.storage.bundle");
    }
    const currentBundle = bundle.x_actions_json_bridge_hydration
      ? await storageGet(STORAGE_BUNDLE_KEY)
      : null;
    const normalizedBundle = bundle.x_actions_json_bridge_hydration
      ? mergeBridgeHydrationBundle(currentBundle, bundle)
      : {
          ...bundle,
          imported_at: new Date().toISOString()
        };
    await storageSet({ [STORAGE_BUNDLE_KEY]: normalizedBundle });
    return {
      ok: true,
      entry_count: normalizedBundle.entries.length,
      merged: Boolean(normalizedBundle.x_actions_json_bridge_hydration_merged),
      updated_count: normalizedBundle.x_actions_json_hydration_updated_count || 0,
      preserved_count: normalizedBundle.x_actions_json_hydration_preserved_count || 0,
      synced_at_ms: normalizedBundle.synced_at_ms || null,
      imported_at: normalizedBundle.imported_at
    };
  };

  const listStorageBundle = async () => {
    const bundle = await storageGet(STORAGE_BUNDLE_KEY);
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
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth
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
    const maxPayloadBytes = Math.max(1000, Math.min(Number(args.max_payload_bytes ?? args.maxPayloadBytes ?? 16000), 256000));
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
    const payload = { matches, match_count: matches.length };
    const approximateBytes = new Blob([JSON.stringify(payload)]).size;
    if (approximateBytes > maxPayloadBytes) {
      return primitiveSuccess("dom.observe.visible", {
        ok: false,
        error: {
          code: "payload_too_large",
          message: "The visible DOM query matched too much page content. Narrow the selector or text query and try again.",
          recoverable: true,
          evidence: {
            selector,
            text_contains: textContains || null,
            match_count: matches.length,
            approximate_bytes: approximateBytes,
            max_payload_bytes: maxPayloadBytes,
            narrowing_hints: [
              "Use a narrower selector.",
              "Prefer a site-specific actions.site action when one exists.",
              "Use max_matches with a small value only when the first few matches are known to be useful.",
              "Target buttons, links, headings, or data-testid selectors instead of broad page containers."
            ]
          }
        }
      });
    }
    return primitiveSuccess("dom.observe.visible", payload);
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

  const runtimeSessionLog = async (args = {}) => {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-session-log",
      limit: args.limit,
    });
    return primitiveSuccess("runtime.session.log", response.log || response);
  };

  const runtimeAgentUserMessage = async (args = {}) => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) {
      return primitiveError("runtime.agent.user_message", "invalid_input", "runtime.agent.user_message requires non-empty text.", {});
    }
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-session-user-message",
      text,
      responseMode: "text_only_transcript",
    });
    return primitiveSuccess("runtime.agent.user_message", response.result || response);
  };

  const runtimeAgentStart = async (args = {}) => {
    const textOnly = args.text_only !== false && args.textOnly !== false;
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-session-start",
      textOnly,
    });
    return primitiveSuccess("runtime.agent.start", response);
  };

  const runtimeAgentStop = async () => {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-session-stop",
    });
    return primitiveSuccess("runtime.agent.stop", response);
  };

  const showAgentToast = ({ text, request_id: requestId } = {}) => {
    const message = typeof text === "string" ? text.trim() : "";
    if (!message) return { ok: false, reason: "empty_text" };
    const existing = document.querySelector("[data-actions-json-agent-toast]");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.dataset.actionsJsonAgentToast = "true";
    if (requestId) toast.dataset.requestId = String(requestId);
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "2147483647",
      maxWidth: "420px",
      padding: "12px 14px",
      borderRadius: "10px",
      background: "rgba(18, 24, 38, 0.96)",
      color: "#fff",
      font: "14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      boxShadow: "0 18px 48px rgba(0,0,0,0.34)",
      whiteSpace: "pre-wrap",
      pointerEvents: "none"
    });
    document.documentElement.append(toast);
    window.setTimeout(() => {
      if (toast.isConnected) toast.remove();
    }, 12_000);
    return { ok: true };
  };

  const primitiveSuccess = (primitive, value) => ({
    ok: true,
    primitive,
    adapter: "extension",
    value
  });

  const menuOverlayCurrentlyVisible = () => {
    const host = document.getElementById("__actions_json_menu_overlay_host");
    if (!host) return false;
    if (host.dataset.hidden === "true") return false;
    const style = window.getComputedStyle(host);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = host.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const primitiveError = (primitive, code, message, evidence = {}) => {
    let finalMessage = message;
    let finalEvidence = evidence;
    // The first suspect for "no visible element" and dead click points is the
    // actions.json overlay itself covering the target (or having swallowed the
    // click that should have revealed it). Say so in the error so agents reach
    // for overlay.menu.hide before inventing other theories.
    if (code === "target_not_found" && menuOverlayCurrentlyVisible()) {
      finalMessage = `${message} The actions.json overlay is open and may be covering the target or may have intercepted the click that should have revealed it; call overlay.menu.hide, retry, then overlay.menu.show.`;
      finalEvidence = { ...evidence, overlay_menu_visible: true };
    }
    return {
      ok: false,
      primitive,
      adapter: "extension",
      error: {
        code,
        message: finalMessage,
        recoverable: true,
        evidence: finalEvidence
      }
    };
  };

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

  const rectDiagnostic = (element) => {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom
    };
  };

  const viewportDiagnostic = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scroll_x: window.scrollX,
    scroll_y: window.scrollY
  });

  const locatorElementInfo = (args = {}) => {
    const locator = args.locator;
    const visibleCandidates = resolveLocatorCandidates(locator).filter(isElementVisible);
    const element = visibleCandidates[0] || null;
    if (!element) {
      return primitiveError("locator.element_info", "target_not_found", "No visible element matched the locator.", {
        locator
      });
    }
    const elementInfoFor = (candidate) => {
      const rect = candidate.getBoundingClientRect();
      const visibleRect = visibleRectFor(candidate) || rect;
      return {
        tag_name: candidate.tagName.toLowerCase(),
        text: normalizeText(candidate.textContent),
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
      };
    };
    const primary = elementInfoFor(element);
    return primitiveSuccess("locator.element_info", {
      locator,
      ...primary,
      ambiguous: visibleCandidates.length > 1,
      candidate_count: visibleCandidates.length,
      candidates: visibleCandidates.map(elementInfoFor)
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
    let diagnosticTargetElement = null;
    if (args.scope && typeof args.scope === "object") {
      const scopeElement = findScopedElement(args.scope);
      if (!scopeElement) {
        return primitiveError("viewport.scroll", "target_not_found", "No visible element matched the scroll scope.", {
          scope: args.scope
        });
      }
      diagnosticTargetElement = scopeElement;
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
    const targetElementBefore = diagnosticTargetElement ? rectDiagnostic(diagnosticTargetElement) : null;
    const scrollTargetBefore = target === window ? null : rectDiagnostic(target);
    const viewportBefore = viewportDiagnostic();

    if (target === window) {
      window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
    } else {
      target.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = target === window
      ? { scroll_x: window.scrollX, scroll_y: window.scrollY }
      : { scroll_x: target.scrollLeft, scroll_y: target.scrollTop };
    const targetElementAfter = diagnosticTargetElement ? rectDiagnostic(diagnosticTargetElement) : null;
    const scrollTargetAfter = target === window ? null : rectDiagnostic(target);
    const viewportAfter = viewportDiagnostic();

    return primitiveSuccess("viewport.scroll", {
      moved: after.scroll_x !== before.scroll_x || after.scroll_y !== before.scroll_y,
      target: targetKind,
      before,
      after,
      delta_x: deltaX,
      delta_y: deltaY,
      diagnostics: {
        viewport: viewportAfter,
        viewport_before: viewportBefore,
        target_element: diagnosticTargetElement
          ? {
              tag_name: diagnosticTargetElement.tagName.toLowerCase(),
              text: normalizeText(diagnosticTargetElement.textContent),
              before: targetElementBefore,
              after: targetElementAfter
            }
          : null,
        scroll_target: {
          kind: targetKind,
          before: target === window ? before : scrollTargetBefore,
          after: target === window ? after : scrollTargetAfter
        }
      }
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

  const pointFromViewportPointOrLocator = (primitive, value, role) => {
    if (!value || typeof value !== "object") {
      return { error: primitiveError(primitive, "target_not_found", `No ${role} point or locator was provided.`, { [role]: value || null }) };
    }
    const x = Number(value.x);
    const y = Number(value.y);
    if (Number.isFinite(x) || Number.isFinite(y)) {
      const viewportError = validateViewportPoint(primitive, x, y, value);
      if (viewportError) return { error: viewportError };
      return {
        point: { x, y },
        element: document.elementFromPoint(x, y),
        geometry: { source: "coordinates", input: value, point: { x, y } },
      };
    }
    const locator = value.locator && typeof value.locator === "object" ? value.locator : value;
    const element = resolveSingleVisibleLocator(locator);
    if (!element) {
      return {
        error: primitiveError(primitive, "target_not_found", `No visible element matched the ${role} locator.`, {
          [role]: locator,
        }),
      };
    }
    const visibleRect = visibleRectFor(element) || element.getBoundingClientRect();
    const point = {
      x: visibleRect.left + (visibleRect.right - visibleRect.left) / 2,
      y: visibleRect.top + (visibleRect.bottom - visibleRect.top) / 2,
    };
    const viewportError = validateViewportPoint(primitive, point.x, point.y, point);
    if (viewportError) return { error: viewportError };
    return {
      point,
      element,
      geometry: {
        source: "locator",
        locator,
        tag_name: element.tagName.toLowerCase(),
        text: normalizeText(element.textContent),
        bounding_box: rectDiagnostic(element),
        point,
      },
    };
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
    const start = pointFromViewportPointOrLocator("pointer.drag", from, "from");
    if (start.error) return start.error;
    const end = pointFromViewportPointOrLocator("pointer.drag", to, "to");
    if (end.error) return end.error;
    const startX = start.point.x;
    const startY = start.point.y;
    const endX = end.point.x;
    const endY = end.point.y;
    const target = start.element || document.elementFromPoint(startX, startY);
    if (!target) {
      return primitiveError("pointer.drag", "target_not_found", "No element exists at the requested drag start point.", { from, to });
    }
    moveVisiblePointer(startX, startY);
    dispatchPointerEvent(target, "pointerdown", { x: startX, y: startY, buttons: 1 });
    dispatchPointerEvent(target, "mousedown", { x: startX, y: startY, buttons: 1, eventCtor: MouseEvent });
    const steps = Math.max(1, Math.min(Number(args.steps ?? 1), 40));
    for (let step = 1; step <= steps; step += 1) {
      const x = startX + ((endX - startX) * step) / steps;
      const y = startY + ((endY - startY) * step) / steps;
      moveVisiblePointer(x, y);
      const stepTarget = document.elementFromPoint(x, y) || target;
      dispatchPointerEvent(stepTarget, "pointermove", { x, y, buttons: 1 });
      dispatchPointerEvent(stepTarget, "mousemove", { x, y, buttons: 1, eventCtor: MouseEvent });
    }
    const moveTarget = document.elementFromPoint(endX, endY) || target;
    dispatchPointerEvent(moveTarget, "pointerup", { x: endX, y: endY, buttons: 0 });
    dispatchPointerEvent(moveTarget, "mouseup", { x: endX, y: endY, buttons: 0, eventCtor: MouseEvent });
    if (moveTarget !== target) {
      dispatchPointerEvent(target, "pointerup", { x: endX, y: endY, buttons: 0 });
      dispatchPointerEvent(target, "mouseup", { x: endX, y: endY, buttons: 0, eventCtor: MouseEvent });
    }
    return primitiveSuccess("pointer.drag", {
      dragged: true,
      from: { x: startX, y: startY },
      to: { x: endX, y: endY },
      steps,
      diagnostics: {
        viewport: viewportDiagnostic(),
        from: start.geometry,
        to: end.geometry,
      },
    });
  };

  const isEditableElement = (element) => {
    if (!element) return false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }
    return element.isContentEditable;
  };

  const resolveEditableTarget = (targetSpec) => {
    if (!targetSpec) return document.activeElement;
    if (typeof targetSpec === "string") return document.querySelector(targetSpec);
    if (typeof targetSpec !== "object") return null;
    if (typeof targetSpec.selector === "string" && targetSpec.selector.trim()) {
      return resolveSingleLocator({ selector: targetSpec.selector.trim() });
    }
    if (targetSpec.locator && typeof targetSpec.locator === "object") {
      return resolveSingleLocator(targetSpec.locator);
    }
    return resolveSingleLocator(targetSpec);
  };

  const insertTextIntoEditable = (primitive, args = {}) => {
    const text = String(args.text ?? "");
    const target = resolveEditableTarget(args.target);
    if (!isEditableElement(target)) {
      return primitiveError(primitive, "target_not_editable", "The target element is not editable.", {
        target: args.target || null,
        tag_name: target?.tagName?.toLowerCase?.() || null
      });
    }
    target.focus?.();
    const mode = args.mode === "replace" ? "replace" : "append";
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = mode === "replace" ? 0 : Number.isInteger(target.selectionStart) ? target.selectionStart : target.value.length;
      const end = mode === "replace" ? target.value.length : Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
      const insertedText = mode === "append" && start === target.value.length && target.value && !target.value.endsWith("\n")
        ? `${text}`
        : text;
      target.value = `${target.value.slice(0, start)}${insertedText}${target.value.slice(end)}`;
      const cursor = start + insertedText.length;
      target.setSelectionRange?.(cursor, cursor);
    } else {
      if (mode === "replace") target.textContent = "";
      const inserted = document.execCommand?.("insertText", false, text);
      if (!inserted) target.textContent = mode === "append" ? `${target.textContent || ""}${text}` : text;
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return primitiveSuccess(primitive, { inserted: true, inserted_length: text.length });
  };

  const textInsert = (args = {}) => {
    return insertTextIntoEditable("text.insert", args);
  };

  const transferBufferAction = async (primitive, args = {}) => {
    const response = await sendRuntimeMessage({
      type: "actions-json:transfer-buffer",
      primitive,
      arguments: args,
    });
    const result = response.result;
    if (!result || typeof result !== "object") {
      return primitiveError(primitive, "transfer_failed", "Transfer buffer returned an invalid response.", { primitive });
    }
    return result;
  };

  const transferInsert = async (args = {}) => {
    const result = await transferBufferAction("transfer.insert", args);
    if (result.ok === false) return result;
    return insertTextIntoEditable("transfer.insert", {
      text: result.value?.text ?? result.value?.rendered_text ?? "",
      target: args.target,
      mode: args.mode,
    });
  };

  const storageReadFile = async (args = {}) => {
    const response = await sendRuntimeMessage({
      type: "actions-json:storage-read-file",
      arguments: args,
      pageUrl: location.href,
    });
    const result = response.result;
    if (!result || typeof result !== "object") {
      return primitiveError("storage.read_file", "storage_file_read_failed", "Storage file reader returned an invalid response.", {});
    }
    return result;
  };

  const keyboardPress = (args = {}) => {
    const rawKey = String(args.key || "");
    const rawModifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
    const chordParts = rawKey.includes("+") ? rawKey.split("+").filter(Boolean) : [];
    const key = chordParts.length > 1 ? chordParts.at(-1) : rawKey;
    const modifiers = [
      ...rawModifiers,
      ...(chordParts.length > 1 ? chordParts.slice(0, -1) : []),
    ].map((modifier) => String(modifier).toLowerCase());
    if (!key) {
      return primitiveError("keyboard.press", "invalid_key", "keyboard.press requires a key.", {
        key: rawKey,
        modifiers
      });
    }
    const target = document.activeElement || document.body;
    const eventInit = {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      altKey: modifiers.includes("alt") || modifiers.includes("option"),
      ctrlKey: modifiers.includes("control") || modifiers.includes("ctrl"),
      metaKey: modifiers.includes("meta") || modifiers.includes("cmd") || modifiers.includes("command"),
      shiftKey: modifiers.includes("shift"),
    };
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, eventInit));
    }
    return primitiveSuccess("keyboard.press", { pressed: true, key, modifiers, fidelity: "page_level" });
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
    runtimeAgentStart,
    runtimeAgentStop,
    runtimeAgentUserMessage,
    viewportScroll,
    pointerClick
  };

  const loadManifest = async () => {
    if (manifest) return manifest;
    const response = await fetch(chrome.runtime.getURL("actions/overlay.actions.json"));
    manifest = await response.json();
    return manifest;
  };

  const loadStateProjectionModule = async () => {
    if (!stateProjectionModulePromise) {
      stateProjectionModulePromise = import(chrome.runtime.getURL("src/agent/state-projections.mjs"));
    }
    return stateProjectionModulePromise;
  };

  const executeStateProjection = async (message) => {
    const module = await loadStateProjectionModule();
    return module.executeStateProjection({
      bundle: message.bundle,
      pageUrl: location.href,
      document,
      projectionName: message.projection_name,
      summaryName: message.summary_name || null,
      maxBytes: message.max_bytes,
    });
  };

  const findExecutableAction = (actions, name) => {
    const declaredTool = actions.tools?.find((tool) => tool.name === name);
    if (declaredTool) return declaredTool;
    const primitive = actions.primitive_dictionary?.primitives?.find((entry) => entry.name === name);
    if (!primitive || primitive.support === "unsupported") return null;
    return primitive;
  };

  const executeAction = async (message) => {
    const rateLimitWaitMs = await waitForHumanInteractionSlot(message.name);
    const actions = await loadManifest();
    const action = findExecutableAction(actions, message.name);
    if (!action) throw new Error(`Unknown action: ${message.name}`);

    let output;
    if (message.name === "overlay.open") {
      output = await openOverlay(message.arguments || {});
    } else if (message.name === "overlay.register_launcher") {
      output = await registerLauncher(message.arguments || {});
    } else if (message.name === "overlay.close") {
      output = closeOverlay();
    } else if (message.name === "overlay.menu.collapse") {
      output = collapseMenuOverlay();
    } else if (message.name === "overlay.menu.expand") {
      output = expandMenuOverlay();
    } else if (message.name === "overlay.menu.move") {
      output = moveMenuOverlay(message.arguments || {});
    } else if (message.name === "overlay.menu.hide") {
      output = hideMenuOverlay();
    } else if (message.name === "overlay.menu.show") {
      output = showMenuOverlay();
    } else if (message.name === "task.add") {
      output = await taskAdd(message.arguments || {});
    } else if (message.name === "task.next") {
      output = await taskNext();
    } else if (message.name === "task.complete") {
      output = await taskComplete(message.arguments || {});
    } else if (message.name === "task.list") {
      output = await taskList();
    } else if (message.name === "task.clear") {
      output = await taskClear();
    } else if (message.name === "runtime.configure_pacing") {
      output = configurePrimitivePacing(message.arguments || {});
    } else if (message.name === "runtime.session.log") {
      output = await runtimeSessionLog(message.arguments || {});
    } else if (message.name === "runtime.agent.start") {
      output = await runtimeAgentStart(message.arguments || {});
    } else if (message.name === "runtime.agent.stop") {
      output = await runtimeAgentStop();
    } else if (message.name === "runtime.agent.user_message") {
      output = await runtimeAgentUserMessage(message.arguments || {});
    } else if (message.name === "browser.claimed_tabs.list") {
      output = await listClaimedTabs();
    } else if (message.name === "browser.claimed_tabs.activate") {
      output = await activateClaimedTab(message.arguments || {});
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
    } else if (message.name === "transfer.write") {
      output = await transferBufferAction("transfer.write", message.arguments || {});
    } else if (message.name === "transfer.read") {
      output = await transferBufferAction("transfer.read", message.arguments || {});
    } else if (message.name === "transfer.clear") {
      output = await transferBufferAction("transfer.clear", message.arguments || {});
    } else if (message.name === "transfer.insert") {
      output = await transferInsert(message.arguments || {});
    } else if (message.name === "storage.read_file") {
      output = await storageReadFile(message.arguments || {});
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

    return annotatePrimitivePacing(output, rateLimitWaitMs);
  };

  const handleActionCall = async (message) => {
    const callId = message.call_id || newActionCallId();
    try {
      const output = await executeAction(message);
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

  const enqueueActionCall = (message) => {
    const run = primitiveQueue.then(() => handleActionCall(message));
    primitiveQueue = run.catch(() => {});
    return run;
  };

  const shouldUseBackgroundBridge = (bridgeUrl) => {
    if (location.protocol !== "https:") return false;
    try {
      return new URL(bridgeUrl).protocol === "ws:";
    } catch (_error) {
      return false;
    }
  };

  const runtimeReadyItem = (actions) => ({
    type: "runtime_ready",
    runtime_id: RUNTIME_ID,
    runtime_key: runtimeKey,
    authorization_id: authorizationId,
    extension_version: extensionVersion,
    url: location.href,
    manifest: actions
  });

  const runtimeStatusItem = (actions) => ({
    type: "runtime_status",
    runtime_id: RUNTIME_ID,
    runtime_key: runtimeKey,
    authorization_id: authorizationId,
    extension_version: extensionVersion,
    url: location.href,
    connected: true,
    actions: actions.tools?.map((tool) => tool.name) || []
  });

  const prepareRuntimeReady = async (message = {}) => {
    runtimeKey = message.runtimeKey || runtimeKey;
    authorizationId = message.authorizationId || authorizationId;
    extensionVersion = message.extensionVersion || extensionVersion;
    const actions = await loadManifest();
    await restoreRegisteredOverlays();
    await restoreMenuOverlayIfNeeded();
    installManifestAttachments(actions);
    return runtimeReadyItem(actions);
  };

  const handleBridgeStateProjectionCall = async (message) => {
    const callId = message.call_id || newActionCallId();
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "actions-json:bridge-state-projection-call", item: message },
          (result) => resolve(result),
        );
      } catch (error) {
        resolve({
          ok: false,
          error: {
            code: "state_projection_failed",
            message: error.message || String(error),
            recoverable: true,
          },
        });
      }
    });
    if (!response || response.ok === false || response.output?.ok === false) {
      protocolSend({
        type: "action_error",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        error: response?.error || response?.output?.error || {
          code: "state_projection_failed",
          message: "State projection execution failed in the extension runtime.",
          recoverable: true,
        },
      });
      return;
    }
    protocolSend({
      type: "action_call_output",
      call_id: callId,
      runtime_id: RUNTIME_ID,
      output: response.output,
    });
  };

  const handleBridgeSiteActionCall = async (message) => {
    const callId = message.call_id || newActionCallId();
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "actions-json:bridge-site-action-call", item: message },
          (result) => resolve(result),
        );
      } catch (error) {
        resolve({
          ok: false,
          error: {
            code: "site_action_failed",
            message: error.message || String(error),
            recoverable: true,
          },
        });
      }
    });
    if (!response || response.ok === false || response.output?.ok === false) {
      protocolSend({
        type: "action_error",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        error: response?.error || response?.output?.error || {
          code: "site_action_failed",
          message: "Site action execution failed in the extension runtime.",
          recoverable: true,
        },
      });
      return;
    }
    protocolSend({
      type: "action_call_output",
      call_id: callId,
      runtime_id: RUNTIME_ID,
      output: response.output,
    });
  };

  const handleBridgeMessage = async (message, actions) => {
    if (message.type === "action_call") {
      if (message.runtime_id && relayedRuntimeIds.has(message.runtime_id)) {
        relayToPage(message);
        return;
      }
      await enqueueActionCall(message);
    } else if (message.type === "state_projection_call") {
      await handleBridgeStateProjectionCall(message);
    } else if (message.type === "site_action_call") {
      await handleBridgeSiteActionCall(message);
    } else if (message.type === "runtime_status") {
      protocolSend(runtimeStatusItem(actions));
      for (const runtimeId of relayedRuntimeIds) {
        relayToPage({ ...message, runtime_id: runtimeId });
      }
    }
  };

  const connect = async (bridgeUrl) => {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    shouldReconnect = true;
    const actions = await loadManifest();
    await restoreRegisteredOverlays();
    await restoreMenuOverlayIfNeeded();
    installManifestAttachments(actions);

    const previousSocket = socket;
    socket = null;
    if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
      previousSocket.close();
    }

    if (shouldUseBackgroundBridge(bridgeUrl)) {
      backgroundBridge = true;
      const readyItem = runtimeReadyItem(actions);
      const response = await chrome.runtime.sendMessage({
        type: "actions-json:bridge-connect",
        bridgeUrl,
        readyItem,
        relayedReadyItems: Array.from(relayedRuntimeReady.values())
      });
      if (response?.ok === false) {
        backgroundBridge = false;
        throw new Error(response.error || "Background bridge connection failed.");
      }
      return;
    }

    backgroundBridge = false;
    const ws = new WebSocket(bridgeUrl);
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      reconnectAttempts = 0;
      protocolSend(runtimeReadyItem(actions));
      for (const item of relayedRuntimeReady.values()) {
        protocolSend(item);
      }
    });
    ws.addEventListener("message", async (event) => {
      if (socket !== ws) return;
      const message = JSON.parse(event.data);
      await handleBridgeMessage(message, actions);
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
        () => prepareRuntimeReady(message).then((readyItem) => sendResponse({ ok: true, readyItem })),
        (error) => sendResponse({ ok: false, error: error.message || String(error) })
      );
      return true;
    }
    if (message?.type === "actions-json:runtime-ready") {
      prepareRuntimeReady(message).then(
        (readyItem) => sendResponse({ ok: true, readyItem }),
        (error) => sendResponse({ ok: false, error: error.message || String(error) })
      );
      return true;
    }
    if (message?.type === "actions-json:bridge-message") {
      loadManifest().then(
        (actions) => handleBridgeMessage(message.item || {}, actions).then(() => sendResponse({ ok: true })),
        (error) => sendResponse({ ok: false, error: error.message || String(error) })
      );
      return true;
    }
    if (message?.type === "actions-json:agent-toast") {
      sendResponse(showAgentToast(message));
      return true;
    }
    if (message?.type === "actions-json:close-overlay") {
      sendResponse(closeOverlay());
    }
    if (message?.type === "actions-json:open-menu-overlay") {
      sendResponse(openMenuOverlay());
    }
    if (message?.type === "actions-json:execute-action") {
      executeAction({
        call_id: message.call_id,
        name: message.name,
        arguments: message.arguments || {}
      }).then(
        (output) => sendResponse({ ok: true, output }),
        (error) => sendResponse({
          ok: false,
          error: {
            code: "handler_failed",
            message: error.message || String(error)
          }
        })
      );
      return true;
    }
    if (message?.type === "actions-json:execute-state-projection") {
      executeStateProjection(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({
          ok: false,
          error: {
            code: "state_projection_failed",
            message: error.message || String(error)
          }
        })
      );
      return true;
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
