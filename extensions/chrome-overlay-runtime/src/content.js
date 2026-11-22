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
  let projectionSnapshotStoreModulePromise = null;
  let projectionGraphQueryModulePromise = null;
  let projectionSnapshotStore = null;
  const projectionSnapshotAuthorities = new Map();
  const projectionCursorAuthorities = new Map();
  const projectionAuthorityTabIds = new Set();
  let projectionNavigationPoller = null;
  let projectionNavigationEpoch = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let projectionNavigationHref = location.href;

  const LAUNCHER_ATTR = "data-actions-json-overlay-launcher";
  const OVERLAY_REGISTRY_STORAGE_KEY = "actionsJsonOverlayRegistry.v1";
  const MENU_OVERLAY_STATE_STORAGE_KEY = "actionsJsonMenuOverlayState.v1";
  const PROTOFACE_SETTINGS_STORAGE_KEY = "ACTIONS_JSON_PROTOFACE_SETTINGS_V1";
  // Mirrors OVERLAY_SETTINGS_STORAGE_KEY / DEFAULT_OVERLAY_SETTINGS.showCost in
  // src/agent/overlay-settings-store.mjs. content.js is not a module, so the key
  // is repeated rather than imported; the default stays false in both places.
  const OVERLAY_SETTINGS_STORAGE_KEY = "ACTIONS_JSON_OVERLAY_SETTINGS_V1";
  let overlayShowCost = false;
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
      menu.__actionsJsonMenuControl?.dispose?.();
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
      existing.__actionsJsonMenuControl?.dispose?.();
      existing.remove();
    }

    const host = document.createElement("div");
    host.id = "__actions_json_menu_overlay_host";
    const DISCLOSURE_STATES = new Set(["resting", "controls", "opened"]);
    // The host uses border-box sizing, so include its two border pixels around
    // the iframe's 74px resting content and 128px controls content.
    const RESTING_GEOMETRY = Object.freeze({ width: "min(340px, calc(100vw - 48px))", height: "76px" });
    const CONTROLS_GEOMETRY = Object.freeze({ width: "min(340px, calc(100vw - 48px))", height: "130px" });
    const OPENED_GEOMETRY = Object.freeze({
      width: "min(340px, calc(100vw - 48px))",
      height: "min(420px, calc(100vh - 48px))",
    });
    const restoredGeometry = restoreState.geometry && typeof restoreState.geometry === "object"
      ? restoreState.geometry
      : null;
    const restoredOpenedGeometry = restoreState.opened_geometry
      && typeof restoreState.opened_geometry === "object"
      ? restoreState.opened_geometry
      : null;
    const initialDisclosureState = DISCLOSURE_STATES.has(restoreState.disclosure_state)
      ? restoreState.disclosure_state
      : "resting";
    const defaultGeometry = initialDisclosureState === "opened"
      ? OPENED_GEOMETRY
      : initialDisclosureState === "controls"
        ? CONTROLS_GEOMETRY
        : RESTING_GEOMETRY;
    const initialLeft = restoredGeometry?.left || null;
    const initialTop = restoredGeometry?.top || null;
    // Resting and controls are content-sized states, not user-resizable states.
    // Persist their position, but always normalize dimensions on startup so an
    // older release cannot permanently restore obsolete/clipping geometry.
    const initialWidth = initialDisclosureState === "opened"
      ? restoredGeometry?.width || defaultGeometry.width
      : defaultGeometry.width;
    const initialHeight = initialDisclosureState === "opened"
      ? restoredGeometry?.height || defaultGeometry.height
      : defaultGeometry.height;
    host.dataset.disclosureState = initialDisclosureState;
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
      `resize:${initialDisclosureState === "opened" ? "both" : "none"}`,
      "overflow:hidden",
      "box-sizing:border-box",
      "background:white",
      "border:1px solid rgba(20,24,31,0.22)",
      "border-radius:10px",
      "box-shadow:0 24px 80px rgba(0,0,0,0.32)"
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    const defaultAgentUrl = chrome.runtime.getURL(
      `agent-surface.html?surface=overlay&tab=agent&parentOrigin=${encodeURIComponent(location.origin)}&disclosure=${initialDisclosureState}`
    );
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
          grid-template-rows: 42px minmax(0, 1fr) auto;
          background: #f7f8fb;
          color: var(--ink);
        }
        :host([data-disclosure-state="resting"]) .panel,
        :host([data-disclosure-state="controls"]) .panel {
          grid-template-rows: minmax(0, 1fr);
        }
        :host([data-disclosure-state="resting"]) .bar,
        :host([data-disclosure-state="controls"]) .bar {
          display: none;
        }
        :host([data-disclosure-state="resting"]) .body,
        :host([data-disclosure-state="controls"]) .body {
          grid-row: 1;
        }
        :host([data-disclosure-state="resting"]) .cost-meter,
        :host([data-disclosure-state="controls"]) .cost-meter {
          display: none;
        }
        :host([data-disclosure-state]) .panel[data-collapsed="true"] .bar {
          display: grid;
        }
        /* Collapsed, the panel IS the 42px box: the header bar is layered
           over the body rather than stacked above it, so the whole square is
           the live agent surface with the collapse control on top of it. */
        .panel[data-collapsed="true"] {
          grid-template-rows: 42px;
          grid-template-columns: 42px;
        }
        /* NOT display:none.
           The live-status pill renders INSIDE the agent iframe — page-world
           shadow DOM cannot request microphone permission, so the pill cannot
           move out here (docs/chrome-extension.md:78-80). Hiding .body would
           hide the very surface that tells the user the session is still live,
           and would also tear down the iframe's rendering. Instead the body is
           clipped to the 42px square and stacked under the header controls.
           The characterization spec's "agent iframe is still mounted while
           collapsed" assertion is the guard on this rule. */
        .panel[data-collapsed="true"] .body {
          grid-row: 1;
          grid-column: 1;
          width: 42px;
          height: 42px;
          overflow: hidden;
        }
        .panel[data-collapsed="true"] .bar {
          grid-row: 1;
          grid-column: 1;
          z-index: 1;
          grid-template-columns: 30px;
          padding: 6px;
          background: transparent;
        }
        .panel[data-collapsed="true"] .cost-meter {
          display: none;
        }
        .panel[data-collapsed="true"] .title,
        .panel[data-collapsed="true"] [data-close] {
          display: none;
        }
        /* The collapse control sits over a live surface now, so it needs its
           own contrast rather than inheriting the header's solid bar. */
        .panel[data-collapsed="true"] [data-minimize] {
          border-color: rgba(15, 23, 42, 0.28);
          background: rgba(255, 255, 255, 0.82);
          color: #18202c;
        }
        .panel[data-collapsed="true"] [data-minimize]:hover {
          background: #ffffff;
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
        .cost-meter {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 5px 12px;
          border-top: 1px solid var(--line);
          background: var(--bar);
          color: #e6edf3;
          font-size: 11px;
          line-height: 1.4;
          flex-shrink: 0;
        }
        .cost-meter[hidden] { display: none; }
        .cost-meter .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #3fb950;
          flex-shrink: 0;
        }
        .cost-meter[data-cache-state="drain"] .dot {
          background: #f85149;
          animation: costMeterDrainPulse 1s ease-in-out infinite;
        }
        @keyframes costMeterDrainPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.25; }
        }
      </style>
      <section class="panel" role="dialog" aria-label="actions.json menu">
        <header class="bar" data-drag-handle>
          <div class="title">actions.json agent</div>
          <div class="actions">
            <!-- NOT a hamburger. A ☰ promises "open a menu" everywhere else on
                 the web; this control makes the panel disappear into a 42px
                 square, and a live install ended with the user believing the
                 overlay had closed. The glyph and the accessible name both
                 describe collapsing. -->
            <button class="icon" type="button" title="Collapse panel" aria-label="Collapse panel" data-minimize>▁</button>
            <button class="icon" type="button" title="Close" data-close>×</button>
          </div>
        </header>
        <main class="body">
          <section class="panel-view active" data-panel="agent" role="tabpanel">
            <iframe title="actions.json agent" allow="microphone; autoplay" src="${defaultAgentUrl}"></iframe>
          </section>
        </main>
        <footer class="cost-meter" data-cost-meter hidden>
          <span class="dot" data-cost-meter-dot></span>
          <span data-cost-meter-label></span>
        </footer>
      </section>
    `;
    document.documentElement.appendChild(host);
    const agentIframe = shadow.querySelector("iframe[title='actions.json agent']");
    const agentOrigin = new URL(defaultAgentUrl).origin;
    const assignAvatarAgentUrl = (stored = {}) => {
      const enabled = stored?.[PROTOFACE_SETTINGS_STORAGE_KEY]?.enabled === true;
      if (enabled) {
        agentIframe.src = `${defaultAgentUrl}&avatar=protoface`;
      }
    };
    try {
      chrome.storage.local.get(PROTOFACE_SETTINGS_STORAGE_KEY, (stored) => {
        if (chrome.runtime?.lastError) {
          return;
        }
        assignAvatarAgentUrl(stored);
      });
    } catch {}
    const panel = shadow.querySelector(".panel");
    const bar = shadow.querySelector("[data-drag-handle]");
    const minimize = shadow.querySelector("[data-minimize]");
    const close = shadow.querySelector("[data-close]");
    let drag = null;
    let restoreGeometry = restoredGeometry;
    let openedGeometry = restoredOpenedGeometry
      || (initialDisclosureState === "opened" && restoredGeometry ? restoredGeometry : null);
    let persistTimer = null;
    let initialRestingPlacementEligible = true;

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
          disclosure_state: host.dataset.disclosureState,
          geometry,
          opened_geometry: openedGeometry,
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
    const geometryForDisclosure = (state) => {
      if (state === "opened") {
        return {
          ...OPENED_GEOMETRY,
          ...(openedGeometry || {}),
        };
      }
      return state === "controls" ? CONTROLS_GEOMETRY : RESTING_GEOMETRY;
    };
    const setDisclosureState = (state) => {
      if (!DISCLOSURE_STATES.has(state)) return false;
      if (host.dataset.disclosureState === state) return true;
      initialRestingPlacementEligible = false;
      const wasCollapsed = panel.dataset.collapsed === "true";
      const currentState = host.dataset.disclosureState;
      if (currentState === "opened" && !wasCollapsed) {
        openedGeometry = menuOverlayGeometryFrom(host);
      }
      host.dataset.disclosureState = state;
      if (!wasCollapsed) {
        const rect = host.getBoundingClientRect();
        const target = geometryForDisclosure(state);
        host.style.width = target.width;
        host.style.height = target.height;
        host.style.minWidth = target.minWidth || "220px";
        host.style.minHeight = target.minHeight || "42px";
        host.style.resize = state === "opened" ? (target.resize || "both") : "none";
        place(rect.left, rect.top);
      }
      persistCurrentState();
      return true;
    };
    const applyRestingCorner = (corner) => {
      if (!initialRestingPlacementEligible) return;
      if (
        restoredGeometry?.left
        || restoredGeometry?.top
        || restoredGeometry?.right
        || restoredGeometry?.bottom
      ) return;
      const rect = host.getBoundingClientRect();
      const margin = 24;
      const positions = {
        "top-left": [margin, margin],
        "top-right": [window.innerWidth - rect.width - margin, margin],
        "bottom-left": [margin, window.innerHeight - rect.height - margin],
        "bottom-right": [window.innerWidth - rect.width - margin, window.innerHeight - rect.height - margin],
      };
      const position = positions[corner] || positions["bottom-right"];
      place(position[0], position[1]);
      initialRestingPlacementEligible = false;
      persistCurrentState();
    };
    const handleDisclosureMessage = (event) => {
      const data = event.data;
      if (event.source !== agentIframe.contentWindow) return;
      if (event.origin !== agentOrigin) return;
      if (data?.type !== "actions-json:overlay-disclosure" || data.version !== 1) return;
      if (!DISCLOSURE_STATES.has(data.state)) return;
      setDisclosureState(data.state);
    };
    window.addEventListener("message", handleDisclosureMessage);
    const handleOverlaySettingsChanged = (changes, area) => {
      if (area !== "local" || !changes[OVERLAY_SETTINGS_STORAGE_KEY]) return;
      const settings = changes[OVERLAY_SETTINGS_STORAGE_KEY].newValue || {};
      overlayShowCost = settings.showCost === true;
      if (lastCostMeterState) applyCostMeter(lastCostMeterState);
    };

    // Read placement and cost preferences only after the geometry controller
    // exists. The test storage shim calls `get` synchronously, while Chrome
    // normally calls it asynchronously, so initializing earlier would create
    // an order-dependent temporal-dead-zone bug.
    try {
      chrome.storage.local.get(OVERLAY_SETTINGS_STORAGE_KEY, (stored) => {
        if (chrome.runtime?.lastError) return;
        const settings = stored?.[OVERLAY_SETTINGS_STORAGE_KEY] || {};
        overlayShowCost = settings.showCost === true;
        applyRestingCorner(settings.restingCorner);
        if (lastCostMeterState) applyCostMeter(lastCostMeterState);
      });
      chrome.storage.onChanged?.addListener(handleOverlaySettingsChanged);
    } catch {}
    if (lastCostMeterState) applyCostMeter(lastCostMeterState);
    const COLLAPSED_SIZE = 42;
    // Where the collapsed square should land.
    //
    // The shipped behaviour pinned the PANEL'S OWN top-left, so a wide panel
    // collapsed leftward — away from the header control on its right edge that
    // the user had just pressed. During a live install the user pressed
    // collapse, the panel vanished from under his finger and reappeared
    // hundreds of pixels away, and he concluded the overlay had closed.
    //
    // So the collapsed box is anchored to the PRESSED CONTROL instead: it is
    // centred on that control's centre, which guarantees the 42px box CONTAINS
    // the point the finger is already on. Clamping is left entirely to `place`
    // above — it already solves the viewport problem and must not be
    // reimplemented here.
    const collapsedOriginFor = (anchorElement) => {
      const anchor = anchorElement || minimize;
      const anchorRect = anchor.getBoundingClientRect();
      // A detached or zero-box anchor tells us nothing; fall back to the
      // panel's own top-left rather than collapsing to 0,0.
      if (!anchorRect.width && !anchorRect.height) {
        const hostRect = host.getBoundingClientRect();
        return { left: hostRect.left, top: hostRect.top };
      }
      return {
        left: anchorRect.left + anchorRect.width / 2 - COLLAPSED_SIZE / 2,
        top: anchorRect.top + anchorRect.height / 2 - COLLAPSED_SIZE / 2,
      };
    };
    const setCollapsed = (collapsed, anchorElement = null) => {
      // The no-op guard. Repeated collapse must NOT re-capture geometry: the
      // second capture would save the already-collapsed 42x42 box as the state
      // to restore, and expand would never bring the panel back.
      // A mutation is not successful until its terminal outcome is observed.
      if (panel.dataset.collapsed === String(collapsed)) return;
      initialRestingPlacementEligible = false;
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
        // Read the anchor BEFORE the collapse mutates layout — once the panel
        // is 42x42 the header button has already moved.
        const origin = collapsedOriginFor(anchorElement);
        panel.dataset.collapsed = "true";
        host.style.width = `${COLLAPSED_SIZE}px`;
        host.style.height = `${COLLAPSED_SIZE}px`;
        host.style.minWidth = `${COLLAPSED_SIZE}px`;
        host.style.minHeight = `${COLLAPSED_SIZE}px`;
        host.style.resize = "none";
        // Size first, then place: `place` measures the host to clamp, so it
        // must see the collapsed box, not the expanded one.
        place(origin.left, origin.top);
        minimize.title = "Expand panel";
        minimize.setAttribute("aria-label", "Expand panel");
        minimize.textContent = "▢";
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
      minimize.title = "Collapse panel";
      minimize.setAttribute("aria-label", "Collapse panel");
      minimize.textContent = "▁";
      place(host.getBoundingClientRect().left, host.getBoundingClientRect().top);
      persistCurrentState({ collapsed: false });
    };

    // Expose a programmatic control surface so runtime primitives can collapse,
    // expand, and move the menu overlay without simulating shadow-DOM pointer
    // events (which the bound handlers ignore). Reuses the same setCollapsed/place
    // logic the header buttons use, including geometry persistence and clamping.
    host.__actionsJsonMenuControl = {
      setCollapsed,
      setDisclosureState,
      place: (left, top) => {
        initialRestingPlacementEligible = false;
        place(left, top);
      },
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
      dispose: () => {
        window.removeEventListener("message", handleDisclosureMessage);
        chrome.storage.onChanged?.removeListener?.(handleOverlaySettingsChanged);
        clearTimeout(persistTimer);
        resizeObserver?.disconnect();
      },
    };

    bar.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      initialRestingPlacementEligible = false;
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
      // Pass the pressed control so the collapsed square lands ON the user's
      // finger instead of at the panel's far top-left corner.
      setCollapsed(panel.dataset.collapsed !== "true", event.currentTarget);
    });
    close.addEventListener("click", () => {
      host.__actionsJsonMenuControl?.dispose?.();
      host.remove();
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
          const responseError = response?.error;
          const messageText =
            typeof responseError === "string"
              ? responseError
              : (responseError?.message || `runtime message ${message?.type || "unknown"} returned no error detail`);
          reject(new Error(messageText));
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
      captured_at: new Date().toISOString(),
      surface_identity: response.surface_identity,
      freshness: response.freshness,
      delay_ms_applied: delayMs,
      ignored_arguments: []
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
    return Boolean(visibleRectFor(element));
  };

  const isElementRendered = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const rectFromClientRect = (rect) => ({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom
  });

  const rectWidth = (rect) => Math.max(0, rect.right - rect.left);
  const rectHeight = (rect) => Math.max(0, rect.bottom - rect.top);
  const rectArea = (rect) => rectWidth(rect) * rectHeight(rect);

  const intersectRects = (a, b) => {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top };
  };

  const viewportRect = () => ({
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
    x: 0,
    y: 0
  });

  const overflowClips = (value) => value && value !== "visible" && value !== "clip";

  const elementLabel = (element) => {
    if (!(element instanceof Element)) return null;
    const id = element.id ? `#${element.id}` : "";
    const testId = element.getAttribute("data-testid");
    const testLabel = testId ? `[data-testid="${testId}"]` : "";
    const className = typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    return `${element.tagName.toLowerCase()}${id}${testLabel}${className}`;
  };

  const clippingAncestorsFor = (element) => {
    const ancestors = [];
    let parent = element?.parentElement || null;
    while (parent && parent !== document.documentElement) {
      const style = window.getComputedStyle(parent);
      if (overflowClips(style.overflowX) || overflowClips(style.overflowY) || overflowClips(style.overflow)) {
        const rect = parent.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          ancestors.push({
            element: parent,
            rect: rectFromClientRect(rect),
            overflow_x: style.overflowX,
            overflow_y: style.overflowY,
            scroll_left: parent.scrollLeft,
            scroll_top: parent.scrollTop,
            max_scroll_left: Math.max(0, parent.scrollWidth - parent.clientWidth),
            max_scroll_top: Math.max(0, parent.scrollHeight - parent.clientHeight),
            label: elementLabel(parent)
          });
        }
      }
      parent = parent.parentElement;
    }
    return ancestors;
  };

  const pointerCandidatePointsFor = (visibleRect) => {
    const width = rectWidth(visibleRect);
    const height = rectHeight(visibleRect);
    const insetX = Math.min(4, width / 4);
    const insetY = Math.min(4, height / 4);
    const left = visibleRect.left + insetX;
    const right = visibleRect.right - insetX;
    const top = visibleRect.top + insetY;
    const bottom = visibleRect.bottom - insetY;
    const centerX = visibleRect.left + width / 2;
    const centerY = visibleRect.top + height / 2;
    return [
      { x: centerX, y: centerY },
      { x: left, y: centerY },
      { x: right, y: centerY },
      { x: centerX, y: top },
      { x: centerX, y: bottom },
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom }
    ];
  };

  const pointerHitFor = (element, visibleRect) => {
    if (!(element instanceof Element) || !visibleRect) {
      return { receives_events: false, point: null, hit_element: null, occluded_by: null };
    }
    const candidates = pointerCandidatePointsFor(visibleRect);
    const centerPoint = candidates[0];
    let centerHit = null;
    for (const point of candidates) {
      const hitElement = document.elementFromPoint(point.x, point.y);
      if (point === centerPoint) centerHit = hitElement;
      if (hitElement === element || element.contains(hitElement)) {
        return {
          receives_events: true,
          point,
          hit_element: hitElement,
          occluded_by: null
        };
      }
    }
    const hitElement = centerHit;
    const hitRect = hitElement instanceof Element
      ? rectFromClientRect(hitElement.getBoundingClientRect())
      : null;
    return {
      receives_events: false,
      point: centerPoint,
      hit_element: hitElement,
      occluded_by: !(hitElement instanceof Element) ? null : {
        target_label: elementLabel(hitElement),
        tag_name: hitElement.tagName.toLowerCase(),
        rect: hitRect
      }
    };
  };

  const occlusionScrollOperationFor = (geometry) => {
    const occluderRect = geometry?.occluded_by?.rect;
    const point = geometry?.action_point;
    const rect = geometry?.bounding_box;
    if (!occluderRect || !point || !rect) return null;
    const padding = 8;

    const operationFor = (target, targetElement, targetLabel, bounds, currentX, currentY, maxX, maxY) => {
      const candidates = [
        { delta_x: rect.right - (occluderRect.left - padding), delta_y: 0 },
        { delta_x: rect.left - (occluderRect.right + padding), delta_y: 0 },
        { delta_x: 0, delta_y: rect.bottom - (occluderRect.top - padding) },
        { delta_x: 0, delta_y: rect.top - (occluderRect.bottom + padding) }
      ].filter(({ delta_x: deltaX, delta_y: deltaY }) => {
        if (deltaX === 0 && deltaY === 0) return false;
        const nextX = currentX + deltaX;
        const nextY = currentY + deltaY;
        if (deltaX !== 0 && (maxX <= 0 || nextX < 0 || nextX > maxX)) return false;
        if (deltaY !== 0 && (maxY <= 0 || nextY < 0 || nextY > maxY)) return false;
        const shifted = {
          left: rect.left - deltaX,
          right: rect.right - deltaX,
          top: rect.top - deltaY,
          bottom: rect.bottom - deltaY
        };
        if (deltaX !== 0) {
          return shifted.left >= bounds.left + padding
            && shifted.right <= bounds.right - padding;
        }
        return shifted.top >= bounds.top + padding
          && shifted.bottom <= bounds.bottom - padding;
      }).sort((left, right) => (
        Math.abs(left.delta_x) + Math.abs(left.delta_y)
        - Math.abs(right.delta_x) - Math.abs(right.delta_y)
      ));
      const candidate = candidates[0];
      if (!candidate) return null;
      return {
        target,
        ...(targetElement ? { target_element: targetElement } : {}),
        ...(targetLabel ? { target_label: targetLabel } : {}),
        ...candidate,
        current_scroll_x: currentX,
        current_scroll_y: currentY,
        max_scroll_x: maxX,
        max_scroll_y: maxY,
        reason: "occluded"
      };
    };

    for (const ancestor of geometry.clipping_ancestors || []) {
      const operation = operationFor(
        "element",
        ancestor.element,
        ancestor.label,
        ancestor.rect,
        ancestor.scroll_left,
        ancestor.scroll_top,
        ancestor.max_scroll_left,
        ancestor.max_scroll_top
      );
      if (operation) return operation;
    }
    return operationFor(
      "window",
      null,
      null,
      viewportRect(),
      window.scrollX,
      window.scrollY,
      Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    );
  };

  const scrollOperationFor = (element, geometry) => {
    if (!geometry?.rendered) return null;
    if (!geometry.receives_events) {
      const occlusionOperation = occlusionScrollOperationFor(geometry);
      if (occlusionOperation) return occlusionOperation;
    }
    const rect = geometry.bounding_box;
    const padding = 8;
    for (const ancestor of geometry.clipping_ancestors || []) {
      let deltaX = 0;
      let deltaY = 0;
      if (rect.left < ancestor.rect.left + padding) deltaX = rect.left - ancestor.rect.left - padding;
      else if (rect.right > ancestor.rect.right - padding) deltaX = rect.right - ancestor.rect.right + padding;
      if (rect.top < ancestor.rect.top + padding) deltaY = rect.top - ancestor.rect.top - padding;
      else if (rect.bottom > ancestor.rect.bottom - padding) deltaY = rect.bottom - ancestor.rect.bottom + padding;
      const canScrollX = ancestor.max_scroll_left > 0 && deltaX !== 0;
      const canScrollY = ancestor.max_scroll_top > 0 && deltaY !== 0;
      if (canScrollX || canScrollY) {
        return {
          target: "element",
          target_element: ancestor.element,
          target_label: ancestor.label,
          delta_x: canScrollX ? deltaX : 0,
          delta_y: canScrollY ? deltaY : 0,
          current_scroll_x: ancestor.scroll_left,
          current_scroll_y: ancestor.scroll_top,
          max_scroll_x: ancestor.max_scroll_left,
          max_scroll_y: ancestor.max_scroll_top
        };
      }
    }
    const viewport = viewportRect();
    let deltaX = 0;
    let deltaY = 0;
    if (rect.left < viewport.left + padding) deltaX = rect.left - viewport.left - padding;
    else if (rect.right > viewport.right - padding) deltaX = rect.right - viewport.right + padding;
    if (rect.top < viewport.top + padding) deltaY = rect.top - viewport.top - padding;
    else if (rect.bottom > viewport.bottom - padding) deltaY = rect.bottom - viewport.bottom + padding;
    if (deltaX !== 0 || deltaY !== 0) {
      return {
        target: "window",
        delta_x: deltaX,
        delta_y: deltaY,
        current_scroll_x: window.scrollX,
        current_scroll_y: window.scrollY,
        max_scroll_x: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        max_scroll_y: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      };
    }
    return null;
  };

  const visibilityGeometryFor = (element) => {
    const rendered = isElementRendered(element);
    const rect = element instanceof Element ? rectFromClientRect(element.getBoundingClientRect()) : null;
    if (!rendered || !rect) {
      return {
        state: "not_rendered",
        rendered: false,
        visible: false,
        clickable: false,
        receives_events: false,
        fully_visible: false,
        bounding_box: rect,
        visible_rect: null,
        visible_ratio: 0,
        scroll_operation: null
      };
    }
    let visibleRect = intersectRects(rect, viewportRect());
    const clippingAncestors = clippingAncestorsFor(element);
    const clippedBy = [];
    for (const ancestor of clippingAncestors) {
      const before = visibleRect;
      visibleRect = visibleRect ? intersectRects(visibleRect, ancestor.rect) : null;
      if (!before || !visibleRect || rectArea(visibleRect) < rectArea(before)) {
        clippedBy.push({
          target_label: ancestor.label,
          rect: ancestor.rect,
          overflow_x: ancestor.overflow_x,
          overflow_y: ancestor.overflow_y
        });
      }
    }
    const area = rectArea(rect);
    const visibleArea = visibleRect ? rectArea(visibleRect) : 0;
    const visibleRatio = area > 0 ? visibleArea / area : 0;
    const fullyVisible = visibleRatio >= 0.98;
    const hasClickableArea = Boolean(visibleRect && rectWidth(visibleRect) >= 8 && rectHeight(visibleRect) >= 8);
    const pointerHit = hasClickableArea
      ? pointerHitFor(element, visibleRect)
      : { receives_events: false, point: null, hit_element: null, occluded_by: null };
    const clickable = hasClickableArea && pointerHit.receives_events;
    const geometry = {
      state: fullyVisible && clickable ? "visible" : "requires_scroll",
      rendered: true,
      visible: Boolean(visibleRect),
      clickable,
      receives_events: pointerHit.receives_events,
      fully_visible: fullyVisible,
      bounding_box: rect,
      visible_rect: visibleRect,
      visible_ratio: visibleRatio,
      clipped_by: clippedBy,
      clipping_ancestors: clippingAncestors,
      action_point: pointerHit.point,
      occluding_element: pointerHit.hit_element,
      occluded_by: pointerHit.occluded_by
    };
    geometry.scroll_operation = fullyVisible && clickable ? null : scrollOperationFor(element, geometry);
    return geometry;
  };

  const publicVisibility = (geometry) => {
    if (!geometry) return null;
    const {
      clipping_ancestors: _ancestors,
      occluding_element: _occludingElement,
      ...publicGeometry
    } = geometry;
    if (publicGeometry.scroll_operation?.target_element) {
      const { target_element: _targetElement, ...publicOperation } = publicGeometry.scroll_operation;
      publicGeometry.scroll_operation = publicOperation;
    }
    return publicGeometry;
  };

  const publicScrollOperation = (operation) => {
    if (!operation) return null;
    const { target_element: _targetElement, ...publicOperation } = operation;
    return publicOperation;
  };

  const performScrollOperation = async (operation) => {
    if (!operation) return false;
    if (operation.target === "window") {
      window.scrollBy({ left: operation.delta_x, top: operation.delta_y, behavior: "instant" });
    } else if (operation.target === "element") {
      if (!(operation.target_element instanceof Element)) return false;
      operation.target_element.scrollBy({ left: operation.delta_x, top: operation.delta_y, behavior: "instant" });
    } else {
      return false;
    }
    await sleep(50);
    return true;
  };

  const ensureElementInView = async (element, options = {}) => {
    const initial = visibilityGeometryFor(element);
    let current = initial;
    const performed = [];
    if (options.auto_scroll !== false && (!current.fully_visible || !current.clickable)) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!current.scroll_operation) break;
        const operation = current.scroll_operation;
        const moved = await performScrollOperation(operation);
        if (!moved) break;
        performed.push(operation);
        current = visibilityGeometryFor(element);
        if (current.fully_visible && current.clickable) break;
      }
    }
    return { initial, current, performed };
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
    return visibilityGeometryFor(element).visible_rect;
  };

  const selectorListFrom = (config, fallback = []) => {
    if (Array.isArray(config?.selectors) && config.selectors.length > 0) return config.selectors;
    if (typeof config?.selector === "string" && config.selector.trim()) return [config.selector];
    return fallback;
  };

  const findScopedElement = (scope = {}) => {
    const root = frameRootFor(scope);
    if (!root) return null; // frame error (recorded in lastLocatorFrameError)
    const selectors = selectorListFrom(scope, ["body"]);
    const candidates = [];
    for (const selector of selectors) {
      try {
        candidates.push(...Array.from(root.querySelectorAll(selector)));
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

  const queryRelative = (root, selector, options = {}) => {
    const visibleOnly = options.visible_only ?? options.visibleOnly ?? true;
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
    const uniqueMatches = Array.from(new Set(matches));
    return visibleOnly ? uniqueMatches.filter(isElementVisible) : uniqueMatches;
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

  const runJavascriptWithDebugger = async (args = {}, primitive = "debug.run_javascript") => {
    const source = args.source || args.javascript;
    if (typeof source !== "string" || !source.trim()) {
      throw new Error(`${primitive} requires source`);
    }
    return sendRuntimeMessage({
      type: "actions-json:debug-evaluate",
      primitive,
      source,
      javascript: args.javascript,
      args: args.args && typeof args.args === "object" ? args.args : {}
    }, 60_000);
  };

  const runJavascript = async (args = {}) =>
    runJavascriptWithDebugger(args, "browser.run_javascript");

  const pageInfo = () => primitiveSuccess("page.info", {
    url: location.href,
    title: document.title
  });

  const domObserveVisible = (args = {}) => {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "*";
    const textContains = normalizeText(args.text_contains || args.textContains).toLowerCase();
    const maxPayloadBytes = Math.max(1000, Math.min(Number(args.max_payload_bytes ?? args.maxPayloadBytes ?? 16000), 256000));
    const root = frameRootFor(args);
    if (!root) {
      return primitiveError("dom.observe.visible", lastLocatorFrameError.code,
        lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`,
        { frame: lastLocatorFrameError.frame });
    }
    let candidates;
    try {
      candidates = Array.from(root.querySelectorAll(selector));
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
        const geometry = visibilityGeometryFor(element);
        const visibleRect = geometry.visible_rect || rect;
        const visibleCenter = {
          x: visibleRect.left + (visibleRect.right - visibleRect.left) / 2,
          y: visibleRect.top + (visibleRect.bottom - visibleRect.top) / 2
        };
        const result = {
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
          },
          visible_center: visibleCenter,
          clickable: geometry.clickable,
          receives_events: geometry.receives_events,
          occluded_by: geometry.occluded_by || null,
          visible_rect: geometry.visible_rect || visibleRect
        };
        if (geometry.clickable && geometry.receives_events !== false) {
          result.clickable_center = geometry.action_point || visibleCenter;
        }
        return result;
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

  // Enumerate matches and read their ATTRIBUTES, without the viewport filter that
  // dom.observe.visible applies.
  //
  // `visible` in this file is a RENDERING predicate, not an EXISTENCE one.
  // visibilityGeometryFor starts with intersectRects(rect, viewportRect()), and
  // isElementVisible is Boolean(visible_rect). So every element scrolled off screen
  // is "invisible" — present in the DOM, addressable, inert to that filter.
  //
  // Enumerating a scrollable collection through a viewport-scoped instrument
  // therefore under-reports by however much is scrolled away, and the under-report
  // is indistinguishable from "those elements do not exist." Trello's checklist is
  // the case that forced this: nine rows in the DOM, dom.observe.visible returns 1,
  // whichever one happens to straddle the viewport edge. The sibling snapshot
  // projection sees all nine, because a snapshot runs querySelectorAll and reads
  // attributes with no filter at all.
  //
  // So this is dom.observe.visible minus one `.filter(isElementVisible)`, plus the
  // ability to name which attributes you want. It reports `visible` per match rather
  // than silently deciding for you: the caller learns what is on screen AND what
  // exists, which are different questions that the old primitive answered as one.
  //
  // Attributes, not text, because accessible names often live only on an attribute:
  // Trello's row name is the aria-label of a 1x1 <input> whose textContent is "".
  //
  // Read-only and portable: no debugger, no privileged capability. a11y.query reads
  // the same names, but it is capability_class "privileged", absent from this
  // dispatch entirely, and it resolves ONE node where this must ENUMERATE.
  const domObserveAttributes = (args = {}) => {
    const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim() : "*";
    const requested = Array.isArray(args.attributes) ? args.attributes.filter((name) => typeof name === "string" && name.trim()) : [];
    if (requested.length === 0) {
      return primitiveError("dom.observe.attributes", "invalid_arguments",
        "Name at least one attribute to read, for example [\"aria-label\", \"aria-checked\"]. Use the pseudo-attribute \"text\" for normalized textContent.",
        { selector });
    }
    const textContains = normalizeText(args.text_contains || args.textContains).toLowerCase();
    const maxPayloadBytes = Math.max(1000, Math.min(Number(args.max_payload_bytes ?? args.maxPayloadBytes ?? 16000), 256000));
    const root = frameRootFor(args);
    if (!root) {
      return primitiveError("dom.observe.attributes", lastLocatorFrameError.code,
        lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`,
        { frame: lastLocatorFrameError.frame });
    }
    let candidates;
    try {
      candidates = Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      return primitiveError("dom.observe.attributes", "invalid_selector", "The selector could not be queried.", { selector });
    }
    const maxMatches = Math.max(1, Math.min(Number(args.max_matches ?? args.maxMatches ?? 50), 200));
    // Match text against textContent OR aria-label, the same haystack the rest of the
    // locator vocabulary uses — otherwise a filter here could never see a clipped
    // node's only text, which is the whole point of this primitive.
    const matches = candidates
      .filter((element) => {
        if (!textContains) return true;
        return normalizeText(element.textContent || element.getAttribute("aria-label")).toLowerCase().includes(textContains);
      })
      .slice(0, maxMatches)
      .map((element) => {
        const attributes = {};
        for (const name of requested) {
          attributes[name] = name === "text"
            ? normalizeText(element.textContent)
            : element.getAttribute(name);
        }
        return {
          tag_name: element.tagName.toLowerCase(),
          attributes,
          visible: isElementVisible(element)
        };
      });
    const payload = { matches, match_count: matches.length, visible_count: matches.filter((match) => match.visible).length };
    const approximateBytes = new Blob([JSON.stringify(payload)]).size;
    if (approximateBytes > maxPayloadBytes) {
      return primitiveSuccess("dom.observe.attributes", {
        ok: false,
        error: {
          code: "payload_too_large",
          message: "The attribute query matched too much page content. Narrow the selector, the text query, or the attribute list.",
          recoverable: true,
          evidence: {
            selector,
            attributes: requested,
            text_contains: textContains || null,
            match_count: matches.length,
            approximate_bytes: approximateBytes,
            max_payload_bytes: maxPayloadBytes,
            narrowing_hints: [
              "Use a narrower selector.",
              "Request fewer attributes.",
              "Use max_matches with a small value only when the first few matches are known to be useful."
            ]
          }
        }
      });
    }
    return primitiveSuccess("dom.observe.attributes", payload);
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
    const root = frameRootFor(args);
    if (!root) {
      return primitiveError("dom.list_sections", lastLocatorFrameError.code,
        lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`,
        { frame: lastLocatorFrameError.frame });
    }
    let candidates;
    try {
      candidates = Array.from(root.querySelectorAll(selector));
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
    const root = frameRootFor(args);
    if (!root) {
      return primitiveError("dom.snapshot_text", lastLocatorFrameError.code,
        lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`,
        { frame: lastLocatorFrameError.frame });
    }
    let elements;
    try {
      elements = Array.from(root.querySelectorAll(selector)).filter(isElementVisible);
    } catch (_error) {
      return primitiveError("dom.snapshot_text", "invalid_selector", "The selector could not be queried.", { selector });
    }
    const fullText = normalizeText(elements.map((element) => element.textContent || "").join("\n"));
    return primitiveSuccess("dom.snapshot_text", {
      text: fullText.slice(0, maxChars),
      truncated: fullText.length > maxChars
    });
  };

  const debugRunJavascript = async (args = {}) =>
    runJavascriptWithDebugger(args, "debug.run_javascript");

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
    // mode: "queue" (default, wait for an in-flight response) or "interrupt"
    // (cancel the active response and send now).
    const mode = args.mode === "interrupt" ? "interrupt" : "queue";
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-session-user-message",
      text,
      mode,
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

  const runtimeAgentMemoryClear = async () => {
    const response = await sendRuntimeMessage({
      type: "actions-json:agent-memory-clear",
    });
    return primitiveSuccess("runtime.agent.memory_clear", response);
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

  // Spec 037 live cost meter: lives INSIDE the agent overlay panel (a footer
  // strip in its shadow DOM) so it inherits overlay.menu.hide/show/collapse —
  // agents that hide the overlay to screenshot the page hide the meter too.
  // The latest meter state is cached so a menu opened later starts current.
  const usd = (v) => `$${Number(v ?? 0).toFixed(v >= 0.01 || v === 0 ? 2 : 4)}`;
  let lastCostMeterState = null;
  const applyCostMeter = (meter) => {
    const host = document.getElementById("__actions_json_menu_overlay_host");
    const footer = host?.shadowRoot?.querySelector("[data-cost-meter]");
    if (!footer) return false;
    const label = footer.querySelector("[data-cost-meter-label]");
    const drain = meter.cacheState === "drain";
    // Opt-in: the cost meter is off until the user turns it on in the popup.
    // Defaulting it visible put a running dollar figure on every page an agent
    // touched, which is a distraction for most sessions and a privacy surprise
    // when screen-sharing.
    if (!overlayShowCost) {
      footer.hidden = true;
      return false;
    }
    footer.hidden = false;
    footer.dataset.cacheState = drain ? "drain" : "ok";
    label.textContent =
      `session ${usd(meter.sessionUsd)} · last ${usd(meter.lastUsd)} · today ${usd(meter.dayUsd)}`;
    footer.title = drain
      ? "Cache-miss drain signature: this response billed zero cached input tokens on a large context."
      : "Estimated gpt-realtime cost. 'today' is a this-browser estimate.";
    return true;
  };
  const showCostMeter = ({ meter } = {}) => {
    if (!meter || typeof meter !== "object") return { ok: false, reason: "no_meter" };
    lastCostMeterState = meter;
    const applied = applyCostMeter(meter);
    return { ok: true, applied };
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

  // Resolve the document a locator should query, given an optional `frame`.
  // `frame` is a CSS selector (or array, outer->inner) for iframe(s) to step
  // into. Same-origin only: a cross-origin frame's contentDocument is
  // unreachable from page JS -> frame_cross_origin. Returns {ok:true, root} or
  // {ok:false, error:{code, frame, message?}}.
  const resolveFrameRoot = (frame, topDocument) => {
    if (frame === undefined || frame === null || frame === "") {
      return { ok: true, root: topDocument };
    }
    const selectors = Array.isArray(frame) ? frame : [frame];
    let root = topDocument;
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      const isFrame = el && (el.tagName === "IFRAME" || el.tagName === "FRAME");
      if (!isFrame) {
        return { ok: false, error: { code: "frame_not_found", frame: sel } };
      }
      let innerDoc = null;
      try {
        innerDoc = el.contentDocument;
      } catch (_error) {
        innerDoc = null;
      }
      if (!innerDoc) {
        return {
          ok: false,
          error: {
            code: "frame_cross_origin",
            frame: sel,
            message: "Frame is cross-origin; its contents cannot be targeted from page JS.",
          },
        };
      }
      root = innerDoc;
    }
    return { ok: true, root };
  };

  let lastLocatorFrameError = null;

  // Resolve the document a selector/scope-based resolver should query, honoring
  // an optional `frame` field (universal targeting dimension). Records any frame
  // error in lastLocatorFrameError and returns null on failure so callers yield
  // empty results (not a silent top-document query that would hide the bad
  // frame). Every element-resolution subsystem (locators, extract scope,
  // dom.observe/list_sections/snapshot_text) funnels its root through this — a
  // resolver that hard-codes `document` instead is a frame-blind regression.
  const frameRootFor = (spec = {}) => {
    lastLocatorFrameError = null;
    const frame = spec && typeof spec === "object" ? spec.frame : undefined;
    if (frame === undefined || frame === null || frame === "") {
      return document;
    }
    const result = resolveFrameRoot(frame, document);
    if (!result.ok) {
      lastLocatorFrameError = result.error;
      return null;
    }
    return result.root;
  };

  // The complete locator vocabulary. A key outside this set used to be silently
  // ignored, which left a locator like {role, name} or {css} with no identity —
  // it then matched every interactive element and pointer.click hit the first
  // one in DOM order (on dash.cloudflare.com: the sidebar logo, navigating
  // away). Unknown keys are now a hard error that names the supported keys.
  const LOCATOR_KEYS = new Set(["selector", "text", "text_contains", "text_equals", "frame", "retarget", "match_index"]);
  const LOCATOR_KEY_HINTS = {
    css: "use `selector`",
    role: "use a11y.query for role/name, or `selector` + `text_equals`",
    name: "use a11y.query for role/name, or `selector` + `text_equals`",
    testid: "use `selector: \"[data-testid='...']\"`",
  };

  const locatorShapeError = (locator) => {
    const unknownKeys = Object.keys(locator).filter((key) => !LOCATOR_KEYS.has(key));
    if (!unknownKeys.length) return null;
    const hints = unknownKeys.filter((key) => LOCATOR_KEY_HINTS[key]).map((key) => `${key}: ${LOCATOR_KEY_HINTS[key]}`);
    return {
      code: "invalid_locator",
      frame: null,
      unknown_keys: unknownKeys,
      supported_keys: Array.from(LOCATOR_KEYS),
      message: `Unsupported locator key(s): ${unknownKeys.join(", ")}. Supported: ${Array.from(LOCATOR_KEYS).join(", ")}.`
        + (hints.length ? ` ${hints.join("; ")}.` : ""),
    };
  };

  // Text identity sources. text_equals must equal ONE source (visible text,
  // aria-label, title, value) — not the space-joined concatenation, which made
  // any control whose aria-label repeats its visible text unmatchable by
  // exact text (dash.cloudflare.com "Create Token", 2026-11-20).
  // text / text_contains keep matching the joined haystack.
  function elementTextSources(element) {
    return [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("value"),
    ].filter(Boolean).map(normalizeText).filter(Boolean);
  }

  function elementTextMatches(element, text, exact) {
    const sources = elementTextSources(element);
    return exact ? sources.includes(text) : sources.join(" ").includes(text);
  }

  const resolveLocatorCandidates = (locator) => {
    lastLocatorFrameError = null;
    if (!locator || typeof locator !== "object") return [];
    const shapeError = locatorShapeError(locator);
    if (shapeError) {
      lastLocatorFrameError = shapeError;
      return [];
    }
    const frameResult = resolveFrameRoot(locator.frame, document);
    if (!frameResult.ok) {
      lastLocatorFrameError = frameResult.error;
      return [];
    }
    const root = frameResult.root;
    let candidates = [];
    if (typeof locator.selector === "string" && locator.selector.trim()) {
      candidates = queryRelative(root, locator.selector.trim(), { visible_only: false });
    } else {
      candidates = Array.from(
        root.querySelectorAll("button, a, input, textarea, select, [role], [aria-label], [data-testid], [data-test], [data-actions-json-target]")
      );
    }
    const text = normalizeText(locator.text || locator.text_contains || locator.text_equals);
    const identityCandidates = !text ? candidates : candidates.filter((element) => {
      return elementTextMatches(element, text, Boolean(locator.text_equals));
    });
    const retarget = locator.retarget;
    let resolvedCandidates = identityCandidates;
    if (retarget && typeof retarget === "object") {
      if (typeof retarget.selector !== "string" || !retarget.selector.trim()) return [];
      const targets = identityCandidates.flatMap((identity) => {
        const scope = typeof retarget.closest === "string" && retarget.closest.trim()
          ? identity.closest(retarget.closest.trim())
          : identity;
        return scope
          ? queryRelative(scope, retarget.selector.trim(), { visible_only: false })
          : [];
      });
      resolvedCandidates = Array.from(new Set(targets));
      const retargetText = normalizeText(retarget.text || retarget.text_contains || retarget.text_equals);
      if (retargetText) {
        resolvedCandidates = resolvedCandidates.filter((element) => {
          return elementTextMatches(element, retargetText, Boolean(retarget.text_equals));
        });
      }
    }
    if (locator.match_index === undefined) return resolvedCandidates;
    const matchIndex = Number(locator.match_index);
    if (!Number.isInteger(matchIndex) || matchIndex < 0) return [];
    return resolvedCandidates[matchIndex] ? [resolvedCandidates[matchIndex]] : [];
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

  const clickTargetDiagnostic = (element) => {
    if (!(element instanceof Element)) return null;
    return {
      tag_name: element.tagName.toLowerCase(),
      id: element.id || null,
      class_name: typeof element.className === "string" ? element.className : null,
      role: element.getAttribute("role"),
      data_testid: element.getAttribute("data-testid"),
      type: element.getAttribute("type"),
      text: normalizeText(element.textContent).slice(0, 240),
      disabled: Boolean(element.disabled),
      aria_disabled: element.getAttribute("aria-disabled"),
      bounding_box: rectDiagnostic(element),
      viewport: viewportDiagnostic()
    };
  };

  const locatorElementInfo = async (args = {}) => {
    const locator = args.locator;
    const renderedCandidates = resolveLocatorCandidates(locator).filter(isElementRendered);
    const element = renderedCandidates[0] || null;
    if (!element) {
      if (lastLocatorFrameError) {
        return primitiveError(
          "locator.element_info",
          lastLocatorFrameError.code,
          lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`,
          { locator, frame: lastLocatorFrameError.frame },
        );
      }
      return primitiveError("locator.element_info", "target_not_found", "No visible element matched the locator.", {
        locator
      });
    }
    const visibility = await ensureElementInView(element, { auto_scroll: args.auto_scroll ?? args.autoScroll ?? true });
    if (!visibility.current.clickable) {
      return primitiveError("locator.element_info", "target_not_actionable", "Element matched the locator but is not currently clickable.", {
        locator,
        initial_visibility: publicVisibility(visibility.initial),
        visibility: publicVisibility(visibility.current),
        scroll_operations_performed: visibility.performed.map(publicScrollOperation)
      });
    }
    const visibleCandidates = renderedCandidates.filter(isElementVisible);
    const elementInfoFor = (candidate, knownVisibility = null) => {
      const rect = candidate.getBoundingClientRect();
      const candidateVisibility = knownVisibility || visibilityGeometryFor(candidate);
      const visibleRect = candidateVisibility.visible_rect || rect;
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
        clickable_center: candidateVisibility.action_point || {
          x: visibleRect.left + (visibleRect.right - visibleRect.left) / 2,
          y: visibleRect.top + (visibleRect.bottom - visibleRect.top) / 2
        },
        clickable: candidateVisibility.clickable,
        visibility: publicVisibility(candidateVisibility)
      };
    };
    const primary = elementInfoFor(element, visibility.current);
    return primitiveSuccess("locator.element_info", {
      locator,
      ...primary,
      ambiguous: visibleCandidates.length > 1,
      candidate_count: visibleCandidates.length,
      initial_visibility: publicVisibility(visibility.initial),
      scroll_operations_performed: visibility.performed.map(publicScrollOperation),
      candidates: visibleCandidates.map((candidate) => (
        candidate === element ? primary : elementInfoFor(candidate)
      ))
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

  // Read a form control's LIVE value property. Nothing else could:
  // locator.text_content returns textContent||aria-label, and an <input> has
  // neither; every text_contains filter reads getAttribute("value"), the
  // ATTRIBUTE, which React and friends never write — they set the property.
  //
  // The gap is not cosmetic. "Has this component finished initialising?" has
  // exactly one DOM-level answer: its input holds the framework's default
  // value. Without this read, a workflow can only wait for the element to be
  // VISIBLE, then type into a node whose controlled-value handler is not yet
  // attached — the write lands and is discarded on the next render, silently.
  // (Trello's add-checklist popover, 2026-07-10.)
  //
  // `settable` reports whether this element even has a value to read, so a
  // gate can distinguish "not ready" from "wrong element" instead of treating
  // an empty string as both.
  const locatorValue = (args = {}) => {
    const locator = args.locator;
    const element = resolveSingleVisibleLocator(locator);
    if (!element) {
      return primitiveError("locator.value", "target_not_found", "No visible element matched the locator.", { locator });
    }
    const settable = typeof element.value === "string";
    const value = settable
      ? element.value
      : element.isContentEditable
        ? normalizeText(element.textContent)
        : null;
    return primitiveSuccess("locator.value", {
      locator,
      value,
      settable,
      tag_name: element.tagName.toLowerCase()
    });
  };

  // dom.focus — move keyboard focus to a specific element by locator. Some
  // transient surfaces (an overlay search/find field, a command palette) keep
  // keyboard focus after they close, so a later type/keypress lands in the wrong
  // place; an explicit focus step re-seats focus on the intended target. Reports
  // whether focus took and the text selection before/after, so callers can tell
  // whether focusing preserved or collapsed an existing selection (e.g. a
  // Find-match selection on a canvas editor).
  const domFocus = (args = {}) => {
    const locator = args.locator;
    const element = resolveSingleVisibleLocator(locator);
    if (!element) {
      return primitiveError("dom.focus", "target_not_found", "No visible element matched the locator.", { locator });
    }
    if (typeof element.focus !== "function") {
      return primitiveError("dom.focus", "target_not_focusable", "Matched element has no focus() method.", {
        locator,
        tag_name: element.tagName ? element.tagName.toLowerCase() : null,
      });
    }
    const selectionBefore = (window.getSelection && window.getSelection().toString()) || "";
    element.focus({ preventScroll: false });
    const selectionAfter = (window.getSelection && window.getSelection().toString()) || "";
    const active = document.activeElement;
    return primitiveSuccess("dom.focus", {
      focused: active === element,
      tag_name: element.tagName ? element.tagName.toLowerCase() : null,
      active_is_target: active === element,
      selection_preserved: selectionBefore.length > 0 && selectionBefore === selectionAfter,
      selection_before_length: selectionBefore.length,
      selection_after_length: selectionAfter.length,
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

  // --- overlay.cursor.point: the ghost cursor -------------------------------
  //
  // An animated pointer that TRAVELS to the element the agent is acting on and
  // lands on it, so the user sees WHERE the agent acted and THAT it acted.
  //
  // Technique borrowed (Apache-2.0) from openai/realtime-voice-component's
  // `useGhostCursor` + docs/widget-and-cursor.md, reimplemented in vanilla JS.
  // Behaviours adopted because they already solved the hard cases:
  //   - scroll an off-screen target into view BEFORE animating; never point at
  //     something the user cannot see
  //   - chain moves from the previous position so a sequence reads as one
  //     continuous journey rather than unrelated flashes
  //   - reduced-motion users get arrival feedback WITHOUT travel animation
  //   - scroll / wheel / touch input dismisses the cursor
  //   - point at real elements to CONFIRM real state changes, never to simulate
  //     them; cursor motion stays secondary to the real page update
  //
  // The correctness rule this primitive exists to honour
  // A clickable center is only a coordinate until hit-testing proves its target:
  // a bounding-rect midpoint is a COORDINATE, not a hit-tested target. Drawing
  // the cursor at a rect midpoint would confidently point at a spot the click
  // never reached — the documented case had a fully in-viewport row whose
  // centre resolved, via elementFromPoint, to the page's sticky header. So we
  // render at the HIT-TESTED point and, when the hit-test resolves a DIFFERENT
  // element, we report `occluded_by` instead of claiming success.
  //
  // Three separate booleans, never conflated
  // Viewport visibility and DOM existence are distinct states:
  //   exists      -> the element is in the DOM
  //   on_screen   -> its rect intersects the viewport (after our scroll)
  //   receives_events -> elementFromPoint at the point resolves to it
  // Vocabulary is the established one from
  // Accessibility matches still require an independent actionability attestation.
  //
  // Written as a single dependency-injected factory so the decision logic is
  // testable off-browser against a fake DOM, and so the tests exercise THIS
  // shipped source rather than a copy of it.
  const createGhostCursorController = (deps) => {
    const {
      doc,
      win,
      render,
      now,
      schedule,
      cancelScheduled,
      prefersReducedMotion,
      overlayHostId,
      travelMs = 520,
      arrivalMs = 260,
      frameMs = 16,
    } = deps;

    let position = null;
    let animation = null;
    let dismissListenersBound = false;
    let lastDismissal = null;

    const rectOf = (element) => element.getBoundingClientRect();

    const viewport = () => ({
      width: win.innerWidth,
      height: win.innerHeight,
    });

    const intersectsViewport = (rect) => {
      const view = viewport();
      return rect.right > 0 && rect.bottom > 0
        && rect.left < view.width && rect.top < view.height
        && rect.right > rect.left && rect.bottom > rect.top;
    };

    const describe = (element) => {
      if (!element || element.nodeType !== 1) return null;
      const attr = (name) => (typeof element.getAttribute === "function" ? element.getAttribute(name) : null);
      return {
        tag_name: String(element.tagName || "").toLowerCase(),
        target_label: attr("aria-label")
          || attr("data-testid")
          || (element.id ? `#${element.id}` : null)
          || String(element.tagName || "").toLowerCase(),
      };
    };

    // Is `hit` the target, inside it, or its container? Mirrors pointerHitFor's
    // containment rule so the two attestations cannot disagree.
    const hitSatisfies = (target, hit) => {
      if (!hit) return false;
      if (hit === target) return true;
      if (typeof target.contains === "function" && target.contains(hit)) return true;
      if (typeof hit.contains === "function" && hit.contains(target)) return true;
      return false;
    };

    // Is the occluder our own overlay pill? The pill is ITSELF a potential
    // occluder of the element being pointed at, and an agent that knows the
    // pill is in the way can call overlay.menu.hide — so name it explicitly
    // rather than reporting a generic obstruction.
    const isOverlayPill = (element) => {
      let node = element;
      while (node && node.nodeType === 1) {
        if (node.id === overlayHostId) return true;
        node = node.parentElement || null;
      }
      return false;
    };

    const cancelAnimation = (reason) => {
      if (!animation) return false;
      if (animation.timer !== null && animation.timer !== undefined) cancelScheduled(animation.timer);
      const cancelled = animation;
      animation = null;
      cancelled.settle({ completed: false, dismissed: true, dismissed_by: reason });
      return true;
    };

    // Scroll / wheel / touch dismisses the cursor: the user has taken over, and
    // a pointer left behind on a page that has moved under it is pointing at
    // the wrong thing.
    const dismiss = (reason) => {
      lastDismissal = { reason, at: now() };
      const hadAnimation = cancelAnimation(reason);
      position = null;
      render({ visible: false, reason });
      return hadAnimation;
    };

    // Dismissal must fire on USER input only. Our own scrollIntoView emits a
    // `scroll` event, and a naive listener treats that as the user taking over
    // and cancels the very animation we just started — the agent's own scroll
    // dismissing the agent's own cursor. Caught by the live smoke, which is the
    // only harness where a real scroll event actually fires.
    //
    // `wheel` and `touchstart` are unambiguously user-generated, so they always
    // dismiss. `scroll` is not: it is emitted by programmatic and user scrolling
    // alike, and a scrollIntoView-generated event carries no flag distinguishing
    // it from a user's. A time window is the wrong instrument — a real browser
    // keeps emitting settling `scroll` events for an unbounded interval, so any
    // grace period is either too short (self-dismissal returns) or long enough
    // to swallow genuine user scrolls.
    //
    // Instead: suppress by POSITION. Record where our own scroll put the page;
    // absorb scroll events while the page is still at (or settling toward) that
    // offset, and dismiss as soon as the page moves somewhere we did not put it
    // — which is exactly what a user scroll does.
    let selfScrollTarget = null;

    const currentScrollOffset = () => ({
      x: win.scrollX || 0,
      y: win.scrollY || 0,
    });

    const onUserInput = (event) => {
      const type = event && event.type ? event.type : "user_input";
      if (type === "scroll" && selfScrollTarget) {
        const at = currentScrollOffset();
        // Within a couple of pixels of where WE scrolled to: this is our own
        // scroll (or its settling tail), not the user.
        if (Math.abs(at.x - selfScrollTarget.x) <= 2 && Math.abs(at.y - selfScrollTarget.y) <= 2) {
          return;
        }
        // The page moved somewhere we did not put it — the user has taken over.
        selfScrollTarget = null;
      }
      dismiss(type);
    };

    const bindDismissListeners = () => {
      if (dismissListenersBound) return;
      dismissListenersBound = true;
      for (const type of ["scroll", "wheel", "touchstart"]) {
        win.addEventListener(type, onUserInput, { passive: true, capture: true });
      }
    };

    // Travel from the previous position so a sequence of points reads as one
    // continuous journey. The FIRST point has no origin to chain from, so it
    // arrives in place rather than flying in from an arbitrary corner.
    const animateTo = (from, to) => new Promise((resolve) => {
      const startedAt = now();
      const state = {
        timer: null,
        settle: (outcome) => resolve(outcome),
      };
      animation = state;
      const step = () => {
        if (animation !== state) return;
        const elapsed = now() - startedAt;
        const progress = travelMs <= 0 ? 1 : Math.min(1, elapsed / travelMs);
        // easeOutCubic — decelerate into the target so the landing reads as
        // deliberate rather than as an abrupt stop.
        const eased = 1 - Math.pow(1 - progress, 3);
        const point = {
          x: from.x + (to.x - from.x) * eased,
          y: from.y + (to.y - from.y) * eased,
        };
        position = point;
        render({ visible: true, point, phase: "travel", progress });
        if (progress >= 1) {
          animation = null;
          resolve({ completed: true, dismissed: false });
          return;
        }
        state.timer = schedule(step, frameMs);
      };
      step();
    });

    const point = async (target, options = {}) => {
      const label = options.label ?? null;
      bindDismissListeners();

      // exists / on_screen / receives_events are three separate facts. Compute
      // each one, never infer one from another.
      const exists = Boolean(target && target.nodeType === 1 && doc.contains(target));
      if (!exists) {
        return {
          ok: false,
          code: "target_not_found",
          exists: false,
          on_screen: false,
          receives_events: false,
        };
      }

      // Scroll an off-screen target into view BEFORE animating. Pointing at a
      // spot the user cannot see is worse than not pointing at all.
      let scrolled = false;
      if (!intersectsViewport(rectOf(target))) {
        if (typeof target.scrollIntoView === "function") {
          // block:"center" deliberately, NOT the default top-alignment: the
          // documented failure is that top-aligning parks the target directly
          // beneath a sticky header, which is exactly the occlusion this
          // primitive is supposed to detect rather than cause.
          target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          // Record where OUR scroll left the page, so the scroll events it
          // emits are recognised as ours rather than as the user taking over.
          selfScrollTarget = currentScrollOffset();
          scrolled = true;
        }
      }

      const rect = rectOf(target);
      const onScreen = intersectsViewport(rect);
      // `visible_center` is GEOMETRY ONLY — the midpoint of a rectangle. It is
      // never the thing we render at until a hit-test has vouched for it.
      const visibleCenter = {
        x: rect.left + (rect.right - rect.left) / 2,
        y: rect.top + (rect.bottom - rect.top) / 2,
      };

      if (!onScreen) {
        return {
          ok: false,
          code: "target_off_screen",
          exists: true,
          on_screen: false,
          receives_events: false,
          scrolled_into_view: scrolled,
          visible_center: visibleCenter,
        };
      }

      const hit = doc.elementFromPoint(visibleCenter.x, visibleCenter.y);
      const receivesEvents = hitSatisfies(target, hit);

      if (!receivesEvents) {
        // Do NOT draw a cursor here. A pointer rendered at this coordinate
        // would be a confident lie: it would sit on top of whatever is actually
        // painted there. Report the obstruction so the caller can clear it.
        const occluder = describe(hit);
        return {
          ok: false,
          code: "target_occluded",
          exists: true,
          on_screen: true,
          receives_events: false,
          scrolled_into_view: scrolled,
          visible_center: visibleCenter,
          occluded_by: occluder
            ? { ...occluder, is_overlay_pill: isOverlayPill(hit) }
            : null,
        };
      }

      // Attested: this point is hit-tested and the target owns it. Only now is
      // it a `clickable_center` rather than a bare coordinate.
      const clickableCenter = visibleCenter;
      const origin = position;
      const reducedMotion = prefersReducedMotion();

      let travelled = false;
      let dismissedBy = null;

      if (reducedMotion || !origin) {
        // Reduced motion: NO travel animation. Arrival feedback still appears —
        // the user must still learn WHERE the agent acted; they just do not get
        // a moving object to track across the screen.
        position = clickableCenter;
        render({ visible: true, point: clickableCenter, phase: "arrive", reduced_motion: reducedMotion, label });
      } else {
        const outcome = await animateTo(origin, clickableCenter);
        travelled = true;
        if (outcome.dismissed) {
          return {
            ok: false,
            code: "cursor_dismissed",
            exists: true,
            on_screen: true,
            receives_events: true,
            scrolled_into_view: scrolled,
            clickable_center: clickableCenter,
            dismissed_by: outcome.dismissed_by,
            animated: true,
          };
        }
        position = clickableCenter;
        render({ visible: true, point: clickableCenter, phase: "arrive", reduced_motion: false, label });
      }

      return {
        ok: true,
        exists: true,
        on_screen: true,
        receives_events: true,
        scrolled_into_view: scrolled,
        visible_center: visibleCenter,
        clickable_center: clickableCenter,
        clickable: true,
        actionability_attested: true,
        occluded_by: null,
        animated: travelled,
        reduced_motion: reducedMotion,
        chained_from: origin ? { x: origin.x, y: origin.y } : null,
        dismissed_by: dismissedBy,
        label,
      };
    };

    return {
      point,
      dismiss,
      position: () => (position ? { ...position } : null),
      lastDismissal: () => lastDismissal,
      handleUserInput: onUserInput,
    };
  };

  let ghostCursorController = null;

  const ghostCursorInstance = () => {
    if (ghostCursorController) return ghostCursorController;
    ghostCursorController = createGhostCursorController({
      doc: document,
      win: window,
      // Reuse the EXISTING visible-pointer element rather than minting a second
      // cursor: moveVisiblePointer already owns #actions-json-ghost-pointer and
      // its arrival pulse, and two independent cursors on one page would be a
      // UX bug, not a feature.
      render: ({ visible, point }) => {
        if (!visible) {
          const existing = document.getElementById("actions-json-ghost-pointer");
          if (existing) existing.style.opacity = "0";
          return;
        }
        const existing = document.getElementById("actions-json-ghost-pointer");
        if (existing) existing.style.opacity = "1";
        moveVisiblePointer(point.x, point.y);
      },
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancelScheduled: (timer) => clearTimeout(timer),
      prefersReducedMotion: () => Boolean(
        window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
      overlayHostId: "__actions_json_menu_overlay_host",
    });
    return ghostCursorController;
  };

  const overlayCursorPoint = async (args = {}) => {
    const locator = args.locator;
    if (!locator || typeof locator !== "object") {
      return primitiveError("overlay.cursor.point", "target_not_found", "overlay.cursor.point requires a locator identifying the element to point at.", {
        locator: locator ?? null,
      });
    }
    const target = resolveSingleLocator(locator);
    if (!target) {
      return primitiveError("overlay.cursor.point", "target_not_found", "No element matched the locator, so there is nothing to point at.", {
        locator,
        exists: false,
        on_screen: false,
        receives_events: false,
      });
    }
    const result = await ghostCursorInstance().point(target, { label: args.label });
    if (!result.ok) {
      const messages = {
        target_off_screen: "The target could not be brought on screen, so the cursor was not drawn; pointing at an element the user cannot see would be misleading.",
        target_occluded: "Something else owns the hit-test at the target's centre, so the cursor was NOT drawn there — drawing it would point at a spot a click never reaches. Clear the occluder (overlay.menu.hide if it is the actions.json overlay) and retry.",
        cursor_dismissed: "The user scrolled or touched the page while the cursor was travelling, so it was dismissed before arriving.",
        target_not_found: "The resolved element left the document before the cursor could point at it.",
      };
      return primitiveError("overlay.cursor.point", result.code, messages[result.code] || "The cursor could not point at the target.", {
        locator,
        ...result,
      });
    }
    return primitiveSuccess("overlay.cursor.point", {
      pointed: true,
      ...result,
    });
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

  // A mutating locator primitive used to require the target to be inside the
  // viewport already and reported an offscreen-but-rendered control as
  // "target_not_found", while locator.element_info auto-scrolled the same
  // locator into view (dash.cloudflare.com "Add new policy", 2026-11-20).
  // Scroll the first rendered candidate into view instead, and say so.
  function resolveVisibleLocatorScrollingIfNeeded(locator) {
    const visible = resolveSingleVisibleLocator(locator);
    if (visible) return { element: visible, scrolled_into_view: false };
    const rendered = resolveLocatorCandidates(locator).find(isElementRendered) || null;
    if (!rendered || typeof rendered.scrollIntoView !== "function") return { element: null, scrolled_into_view: false };
    rendered.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return isElementVisible(rendered)
      ? { element: rendered, scrolled_into_view: true }
      : { element: null, scrolled_into_view: false };
  }

  const pointFromViewportPointOrLocator = (primitive, value, role) => {
    if (!value || typeof value !== "object") {
      return { error: primitiveError(primitive, "target_not_found", `No ${role} point or locator was provided.`, { [role]: value || null }) };
    }
    if (("x" in value || "y" in value) && (value.x == null || value.y == null)) {
      return { error: primitiveError(primitive, "missing_coordinates", `The ${role} point is missing x or y. A workflow expression likely resolved to null because the target geometry was not found; re-find the target instead.`, { [role]: { x: value.x ?? null, y: value.y ?? null } }) };
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
    // An explicit `locator` object is validated strictly; the legacy top-level
    // form shares its object with click options (button, modifiers), so only
    // the locator keys are taken from it.
    const locator = value.locator && typeof value.locator === "object"
      ? value.locator
      : Object.fromEntries(Object.entries(value).filter(([key]) => LOCATOR_KEYS.has(key)));
    const { element, scrolled_into_view: scrolledIntoView } = resolveVisibleLocatorScrollingIfNeeded(locator);
    if (!element && lastLocatorFrameError) {
      return {
        error: primitiveError(primitive, lastLocatorFrameError.code,
          lastLocatorFrameError.message || `Frame '${lastLocatorFrameError.frame}' could not be targeted.`, {
            [role]: locator,
            frame: lastLocatorFrameError.frame,
            unknown_keys: lastLocatorFrameError.unknown_keys,
            supported_keys: lastLocatorFrameError.supported_keys,
          }),
      };
    }
    if (!element) {
      return {
        error: primitiveError(primitive, "target_not_found", `No visible element matched the ${role} locator.`, {
          [role]: locator,
        }),
      };
    }
    const visibleRect = visibleRectFor(element) || element.getBoundingClientRect();
    const actionability = visibilityGeometryFor(element);
    if (!actionability.clickable || !actionability.receives_events || !actionability.action_point) {
      return {
        error: primitiveError(primitive, "target_not_actionable", `The ${role} locator resolved, but its visible point does not receive pointer events.`, {
          [role]: locator,
          actionability: {
            state: actionability.state,
            visible: actionability.visible,
            fully_visible: actionability.fully_visible,
            clickable: actionability.clickable,
            receives_events: actionability.receives_events,
            visible_rect: actionability.visible_rect,
            occluded_by: actionability.occluded_by,
            scroll_operation: actionability.scroll_operation,
          },
        }),
      };
    }
    const point = actionability.action_point;
    const viewportError = validateViewportPoint(primitive, point.x, point.y, point);
    if (viewportError) return { error: viewportError };
    return {
      point,
      element,
      geometry: {
        source: "locator",
        scrolled_into_view: scrolledIntoView,
        locator,
        tag_name: element.tagName.toLowerCase(),
        text: normalizeText(element.textContent),
        bounding_box: rectDiagnostic(element),
        point,
        actionability: {
          clickable: actionability.clickable,
          receives_events: actionability.receives_events,
          fully_visible: actionability.fully_visible,
          occluded_by: actionability.occluded_by,
        },
      },
    };
  };

  const dispatchPointerClick = (target, { x, y, button, detail = 1, modifiers = [] }) => {
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
      view: window,
      altKey: modifiers.includes("alt") || modifiers.includes("option"),
      ctrlKey: modifiers.includes("control") || modifiers.includes("ctrl"),
      metaKey: modifiers.includes("meta") || modifiers.includes("cmd") || modifiers.includes("command"),
      shiftKey: modifiers.includes("shift")
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

  const requirePointCoordinates = (primitive, args) => {
    if (args.x == null || args.y == null) {
      return primitiveError(primitive, "missing_coordinates", "x and y are required. A workflow expression likely resolved to null because the target geometry was not found; re-find the target instead of clicking.", {
        x: args.x ?? null,
        y: args.y ?? null
      });
    }
    return null;
  };

  const KNOWN_POINTER_MODIFIERS = new Set(["shift", "alt", "option", "control", "ctrl", "meta", "cmd", "command"]);

  const pointerClick = (args = {}) => {
    const resolved = pointFromViewportPointOrLocator("pointer.click", args, "target");
    if (resolved.error) return resolved.error;
    const x = resolved.point.x;
    const y = resolved.point.y;
    const modifiers = (Array.isArray(args.modifiers) ? args.modifiers : [])
      .map((modifier) => String(modifier).toLowerCase());
    const unknownModifier = modifiers.find((modifier) => !KNOWN_POINTER_MODIFIERS.has(modifier));
    if (unknownModifier) {
      return primitiveError("pointer.click", "invalid_input", `Unknown pointer modifier "${unknownModifier}". Supported: shift, alt/option, control/ctrl, meta/cmd/command.`, {
        modifiers: args.modifiers
      });
    }
    const target = resolved.element || document.elementFromPoint(x, y);
    if (!target) {
      return primitiveError("pointer.click", "target_not_found", "No element exists at the requested point.", { x, y });
    }
    moveVisiblePointer(x, y);
    dispatchPointerClick(target, { x, y, button: args.button || "left", modifiers });
    return primitiveSuccess("pointer.click", {
      clicked: true,
      x,
      y,
      modifiers,
      geometry: resolved.geometry,
      target: clickTargetDiagnostic(target)
    });
  };

  const pointerMove = (args = {}) => {
    const missingError = requirePointCoordinates("pointer.move", args);
    if (missingError) return missingError;
    const x = Number(args.x);
    const y = Number(args.y);
    const viewportError = validateViewportPoint("pointer.move", x, y, args);
    if (viewportError) return viewportError;
    moveVisiblePointer(x, y);
    return primitiveSuccess("pointer.move", { x, y });
  };

  const pointerDoubleClick = (args = {}) => {
    const missingError = requirePointCoordinates("pointer.double_click", args);
    if (missingError) return missingError;
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
    // Pass the WHOLE locator through (including `frame`, text_*, etc.) so
    // frame-aware resolution applies — do NOT rebuild a selector-only locator,
    // which would silently drop `frame`.
    if (targetSpec.locator && typeof targetSpec.locator === "object") {
      return resolveSingleLocator(targetSpec.locator);
    }
    return resolveSingleLocator(targetSpec);
  };

  const waitForEditableHandlers = () => new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      Promise.race([
        new Promise((done) => requestAnimationFrame(done)),
        new Promise((done) => setTimeout(done, 50))
      ]).then(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });

  const selectEditableContents = (target, mode) => {
    const selection = window.getSelection?.();
    const range = document.createRange();
    const textNodes = [];
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue && node.nodeValue.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node);
    if (textNodes.length > 0) {
      const first = textNodes[0];
      const last = textNodes[textNodes.length - 1];
      if (mode === "append") {
        range.setStart(last, last.nodeValue.length);
        range.collapse(true);
      } else {
        range.setStart(first, 0);
        range.setEnd(last, last.nodeValue.length);
      }
    } else {
      range.selectNodeContents(target);
      if (mode === "append") range.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString?.() || "";
  };

  const clipboardHtmlFromText = (text) => {
    const escaped = text.replace(/[&<>"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;"
    }[char]));
    // Rich-text editors (ProseMirror/Atlassian) prefer the text/html flavor,
    // where raw newlines are collapsible whitespace. Encode paragraph structure
    // explicitly or multi-line insertions flatten into a single line.
    return escaped
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
      .join("");
  };

  // Decide the text/html clipboard flavor. When the caller supplies a non-empty
  // html string, use it verbatim (they control it — e.g. a <table> that Google
  // Sheets expands into a real range). Otherwise derive paragraph structure from
  // the plain text (back-compat: every current caller keeps working). An empty
  // string is treated as absent so a caller passing "" does not silently strip
  // the html flavor.
  const clipboardHtmlFlavor = (text, html) => {
    return typeof html === "string" && html.length > 0
      ? html
      : clipboardHtmlFromText(text);
  };

  const syntheticClipboardEvent = (text, html) => {
    let clipboardData = null;
    if (typeof DataTransfer === "function") {
      clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      clipboardData.setData("text/html", clipboardHtmlFlavor(text, html));
    }
    let event;
    try {
      event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData
      });
    } catch (_error) {
      event = new Event("paste", { bubbles: true, cancelable: true, composed: true });
    }
    if (clipboardData && !event.clipboardData) {
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
    }
    return event;
  };

  // Where a clipboard/selection event dispatches: the resolved locator target,
  // or the focused element when no locator was given. Frame targeting (reaching
  // inside an iframe) is handled by the locator's `frame` field, not here — the
  // caller points a target locator at the inner element and the frame-aware
  // resolver descends. Paste stays dumb and configurable.
  const pasteTargetKind = (resolved, activeElement) => {
    if (resolved) {
      return { target: resolved, target_kind: "resolved-locator" };
    }
    return { target: activeElement, target_kind: "activeElement" };
  };

  const insertTextIntoEditable = async (primitive, args = {}, reportProgress) => {
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
      const beforeInputType = mode === "replace" ? "insertReplacementText" : "insertText";
      target.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: beforeInputType,
        data: text
      }));
      const nextValue = `${target.value.slice(0, start)}${insertedText}${target.value.slice(end)}`;
      const prototype = Object.getPrototypeOf(target);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      const ownValueSetter = Object.getOwnPropertyDescriptor(target, "value")?.set;
      const valueSetter = prototypeValueSetter || ownValueSetter;
      if (valueSetter) {
        valueSetter.call(target, nextValue);
      } else {
        target.value = nextValue;
      }
      const cursor = start + insertedText.length;
      target.setSelectionRange?.(cursor, cursor);
    } else {
      const beforePasteText = target.textContent || "";
      reportProgress?.("editable_selection_settled", "entered");
      const selectedText = selectEditableContents(target, mode);
      document.dispatchEvent(new Event("selectionchange", { bubbles: false }));
      await waitForEditableHandlers();
      reportProgress?.("editable_selection_settled", "completed");
      const pasteEvent = syntheticClipboardEvent(text);
      reportProgress?.("synthetic_paste_dispatched", "entered");
      const dispatched = target.dispatchEvent(pasteEvent);
      reportProgress?.("synthetic_paste_dispatched", "completed");
      reportProgress?.("editable_handlers_settled", "entered");
      await waitForEditableHandlers();
      reportProgress?.("editable_handlers_settled", "completed");
      const afterPasteText = target.textContent || "";
      if (!dispatched || pasteEvent.defaultPrevented || afterPasteText !== beforePasteText) {
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return primitiveSuccess(primitive, {
          inserted: true,
          inserted_length: text.length,
          input_method: "synthetic-paste",
          selected_text_length: selectedText.length,
          selection_sync: "selectionchange+animation-frame"
        });
      }
      selectEditableContents(target, mode);
      const inserted = document.execCommand?.("insertText", false, text);
      if (!inserted) target.textContent = mode === "append" ? `${target.textContent || ""}${text}` : text;
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return primitiveSuccess(primitive, {
      inserted: true,
      inserted_length: text.length,
      input_method: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? "native-value-setter+input" : undefined
    });
  };

  const textInsert = (args = {}, reportProgress) => {
    return insertTextIntoEditable("text.insert", args, reportProgress);
  };

  // text.type — type a string into the focused element as keystrokes. Synthetic by
  // default (portable). With { trusted:true } it relays to the background CDP
  // per-character Input.dispatchKeyEvent path, which REPLACES the active selection
  // and reaches canvas editors (Docs/Slides/Sheets) — the overtype path for a
  // keyboard-made selection, where clipboard.paste does not route to the live selection.
  const textType = async (args = {}, reportProgress) => {
    const text = String(args.text ?? "");
    if (args.trusted === true) {
      const relayed = await chrome.runtime.sendMessage({
        type: "actions-json:marker-trusted-text",
        text,
        select_back_chars: args.select_back_chars,
      });
      if (!relayed?.ok) {
        return primitiveError("text.type", "trusted_text_failed", relayed?.error || "Trusted text relay failed.", { length: text.length });
      }
      return primitiveSuccess("text.type", { typed: true, length: text.length, selected_back: relayed.selected_back ?? 0, fidelity: "trusted" });
    }
    // Synthetic: insert at the focused editable (same path as text.insert, no target).
    const result = insertTextIntoEditable("text.type", { text, mode: args.mode || "insert" }, reportProgress);
    return result;
  };

  // clipboard.paste — write into a DOM element via a synthetic paste event
  // (clipboard -> page). With args.text: paste that text. Without: paste the
  // current system clipboard. Requires a resolved target unless the caller
  // deliberately opts into the focused element for a canvas/model-backed editor;
  // an iframe target falls back to the focused inner element (pasteTargetKind).
  // This is the write path for iframe-hosted editors (Google Docs/Sheets/Slides)
  // that text.insert cannot reach.
  const clipboardPaste = async (args = {}) => {
    const usesActiveElement = !args.target && args.use_active_element === true;
    if (!args.target && !usesActiveElement) {
      return primitiveError("clipboard.paste", "paste_target_required",
        "clipboard.paste requires an explicit target. Set use_active_element:true only for a canvas/iframe editor whose receiving element cannot be addressed directly.", {});
    }
    const resolved = args.target ? resolveEditableTarget(args.target) : null;
    const { target, target_kind } = pasteTargetKind(resolved, document.activeElement);
    if (!target) {
      return primitiveError("clipboard.paste", "no_paste_target",
        "No focused or resolvable element to paste into; click into the editor first.", {});
    }
    if (!target.isConnected) {
      return primitiveError("clipboard.paste", "paste_target_stale",
        "The resolved paste target is no longer connected to the document. Re-resolve it before retrying.", {});
    }
    if (!isEditableElement(target)) {
      return primitiveError("clipboard.paste", "paste_target_not_editable",
        "The resolved paste target is not an editable input, textarea, or contenteditable element.", {
          tag_name: target.tagName?.toLowerCase?.() || null,
          target_kind,
        });
    }
    let payload = args.text;
    let source = "argument";
    if (payload === undefined || payload === null) {
      source = "system-clipboard";
      try {
        payload = await navigator.clipboard.readText();
      } catch (error) {
        return primitiveError("clipboard.paste", "clipboard_read_denied",
          `Could not read the system clipboard: ${error?.message || error}`, {});
      }
    }
    payload = String(payload);
    target.focus?.();
    const focusOwner = target.ownerDocument?.activeElement || null;
    if (focusOwner !== target) {
      return primitiveError("clipboard.paste", "paste_focus_not_acquired",
        "The resolved paste target did not retain focus. No paste event was dispatched.", {
          expected_tag_name: target.tagName?.toLowerCase?.() || null,
          actual_tag_name: focusOwner?.tagName?.toLowerCase?.() || null,
          target_kind,
        });
    }
    const target_identity = {
      tag_name: target.tagName?.toLowerCase?.() || null,
      id: target.id || null,
      class_name: typeof target.className === "string" ? target.className : null,
      role: target.getAttribute?.("role") || null,
      aria_label: target.getAttribute?.("aria-label") || null,
      contenteditable: target.getAttribute?.("contenteditable") || null,
      focus_attested: true,
    };

    // A synthetic paste has no native default insertion. On standard controls,
    // dispatching a bubbling/composed paste event lets an ancestor editor consume
    // the payload while the intended textarea remains unchanged. Use the same
    // native-value-setter/input path as text.insert so the write cannot escape
    // the explicitly resolved field.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const result = await insertTextIntoEditable("clipboard.paste", {
        text: payload,
        target: args.target,
        mode: "append",
      });
      if (!result?.ok) return result;
      return {
        ...result,
        value: {
          ...result.value,
          pasted: true,
          source,
          target_kind,
          target_identity,
          scoped_write: "native-control",
        },
      };
    }

    const beforeText = target.textContent || "";
    const pasteEvent = syntheticClipboardEvent(payload, args.html);
    const dispatchReturned = target.dispatchEvent(pasteEvent);
    await waitForEditableHandlers();
    const afterText = target.textContent || "";
    // An explicit contenteditable target must itself change. A prevented event
    // is not proof of correct scope: an ancestor can claim the paste while
    // mutating a sibling (the LinkedIn incident class). Only the deliberate
    // active-element compatibility path may accept a claimed event without a
    // DOM-text delta, because canvas/model-backed editors store state elsewhere.
    if (afterText === beforeText && !usesActiveElement) {
      return primitiveError("clipboard.paste", "paste_unverified",
        "The explicit contenteditable target did not change. A prevented ancestor event is not proof that the intended target received the paste.", {
          target_kind,
          target_identity,
          default_prevented: pasteEvent.defaultPrevented,
          dispatch_returned: dispatchReturned,
        });
    }
    if (afterText === beforeText && dispatchReturned && !pasteEvent.defaultPrevented) {
      return primitiveError("clipboard.paste", "paste_unverified",
        "The opted-in active element did not change and no handler claimed the paste event.", {
          target_kind,
          target_identity,
        });
    }
    return primitiveSuccess("clipboard.paste", {
      pasted: true,
      inserted_length: payload.length,
      input_method: "synthetic-paste",
      default_prevented: pasteEvent.defaultPrevented,
      html_provided: typeof args.html === "string" && args.html.length > 0,
      target_kind,
      target_identity,
      dispatch_returned: dispatchReturned,
      target_text_changed: afterText !== beforeText,
      scope_verification: afterText !== beforeText ? "target-text-changed" : "active-element-handler-claimed",
      scope_mode: usesActiveElement ? "active-element-opt-in" : "explicit-target",
      source,
    });
  };

  // clipboard.read / clipboard.write — pure system-clipboard I/O, no page touch.
  const clipboardRead = async () => {
    try {
      const text = await navigator.clipboard.readText();
      return primitiveSuccess("clipboard.read", { text, length: text.length });
    } catch (error) {
      return primitiveError("clipboard.read", "clipboard_read_denied",
        `Could not read the system clipboard: ${error?.message || error}`, {});
    }
  };

  const clipboardWrite = async (args = {}) => {
    const text = String(args.text ?? "");
    try {
      await navigator.clipboard.writeText(text);
      return primitiveSuccess("clipboard.write", { written: true, length: text.length });
    } catch (error) {
      return primitiveError("clipboard.write", "clipboard_write_denied",
        `Could not write the system clipboard: ${error?.message || error}`, {});
    }
  };

  // text.select — select a range on the page (page only). Precursor to copy.
  const textSelect = (args = {}) => {
    const resolved = args.target ? resolveEditableTarget(args.target) : null;
    const { target, target_kind } = pasteTargetKind(resolved, document.activeElement);
    if (!target) {
      return primitiveError("text.select", "no_select_target",
        "No focused or resolvable element to select.", {});
    }
    target.focus?.();
    const selected = selectEditableContents(target, "replace");
    return primitiveSuccess("text.select", {
      selected: true,
      selected_length: (selected || "").length,
      selected_text: selected || "",
      large_selection: (selected || "").length >= 500,
      target_identity: {
        tag_name: target.tagName?.toLowerCase?.() || null,
        id: target.id || null,
        class_name: typeof target.className === "string" ? target.className : null,
        role: target.getAttribute?.("role") || null,
        aria_label: target.getAttribute?.("aria-label") || null,
        contenteditable: target.getAttribute?.("contenteditable") || null,
      },
      target_kind,
    });
  };

  // clipboard.copy — move the current selection into the system clipboard
  // (page -> clipboard). Dispatches a synthetic copy event so page-side copy
  // handlers (e.g. Google) run, then writes the selection text to the clipboard.
  const clipboardCopy = async (args = {}) => {
    const resolved = args.target ? resolveEditableTarget(args.target) : null;
    const { target } = pasteTargetKind(resolved, document.activeElement);
    const copyEvent = new ClipboardEvent("copy", { bubbles: true, cancelable: true, composed: true });
    target?.dispatchEvent?.(copyEvent);
    const selectionText = String(document.getSelection?.() || "");
    let clipboard_write = "ok";
    try {
      if (selectionText) await navigator.clipboard.writeText(selectionText);
      else clipboard_write = "empty_selection";
    } catch (error) {
      clipboard_write = "denied";
    }
    return primitiveSuccess("clipboard.copy", {
      copied: true,
      copied_length: selectionText.length,
      clipboard_write,
    });
  };

  // page.fetch — authenticated same-origin GET from the page context. Returns
  // the raw response body so a site map's workflow action can parse a
  // page-published text/HTML view (Google Docs /mobilebasic, Sheets /htmlview)
  // that the canvas-rendered DOM does not expose. Read-only by construction:
  // same-origin + GET only; no method/body params, no cross-origin.
  const isSameOrigin = (url, pageOrigin) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return false;
    }
    return parsed.origin === pageOrigin;
  };

  const pageFetch = async (args = {}) => {
    const url = String(args.url ?? "");
    if (!isSameOrigin(url, location.origin)) {
      let requested = null;
      try { requested = new URL(url).origin; } catch (_error) { requested = null; }
      return primitiveError("page.fetch", "page_fetch_cross_origin",
        "page.fetch only allows same-origin GET requests.",
        { requested_origin: requested, page_origin: location.origin });
    }
    let response;
    try {
      response = await fetch(url, { credentials: "include", method: "GET", redirect: "follow" });
    } catch (error) {
      return primitiveError("page.fetch", "page_fetch_failed",
        `Fetch failed: ${error?.message || error}`, { url });
    }
    const body = await response.text();
    return primitiveSuccess("page.fetch", {
      ok: response.ok,
      status: response.status,
      content_type: response.headers.get("content-type"),
      length: body.length,
      body,
    });
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

  const fileTransferAction = async (primitive, args = {}) => {
    const response = await sendRuntimeMessage({
      type: "actions-json:file-transfer",
      primitive,
      arguments: args,
    });
    const result = response?.result;
    if (!result || typeof result !== "object") {
      return primitiveError(primitive, "file_transfer_failed", "File transfer store returned an invalid response.", {
        primitive,
        transfer_id: args.transfer_id || null,
      });
    }
    return result;
  };

  const bytesFromBase64 = (base64) => {
    const binary = atob(base64 || "");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

  const base64FromBytes = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };

  const FILE_TRANSFER_MAX_BYTES = 25 * 1024 * 1024;
  const FILE_TRANSFER_CHUNK_BYTES = 192 * 1024;
  const sha256Hex = async (bytes) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  };

  const normalizeTransferOrigin = (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };

  const fileTransferUploadConsume = async (args = {}) => {
    const primitive = "file.transfer.upload.consume";
    const expectedOrigin = normalizeTransferOrigin(args.origin);
    if (!expectedOrigin || expectedOrigin !== window.location.origin) {
      return primitiveError(primitive, "transfer_origin_mismatch", "Current page origin does not match the transfer origin.", {
        expected_origin: expectedOrigin,
        actual_origin: window.location.origin,
      });
    }
    const selector = args.file_input?.selector;
    if (typeof selector !== "string" || !selector) {
      return primitiveError(primitive, "transfer_file_input_invalid", "file_input.selector is required.");
    }
    let input;
    try {
      input = document.querySelector(selector);
    } catch (error) {
      return primitiveError(primitive, "transfer_file_input_invalid", "file_input.selector is not valid CSS.", {
        message: error.message || String(error),
      });
    }
    if (!(input instanceof HTMLInputElement) || input.type !== "file") {
      return primitiveError(primitive, "transfer_file_input_not_found", "The selector did not resolve one file input.", {
        selector,
      });
    }
    const stored = await fileTransferAction(primitive, {
      transfer_id: args.transfer_id,
      origin: expectedOrigin,
    });
    if (stored.ok === false) return stored;
    const currentInput = document.querySelector(selector);
    if (!(currentInput instanceof HTMLInputElement) || currentInput.type !== "file" || !currentInput.isConnected) {
      return primitiveError(primitive, "transfer_file_input_stale", "The file input changed while transfer bytes were loading.", { selector });
    }
    const bytes = bytesFromBase64(stored.value?.base64 || "");
    const file = new File([bytes], stored.value.filename, {
      type: stored.value.mime_type || "application/octet-stream",
      lastModified: Date.now(),
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    currentInput.files = transfer.files;
    currentInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    currentInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const completed = await fileTransferAction("file.transfer.upload.complete", {
      transfer_id: args.transfer_id,
      origin: expectedOrigin,
    });
    if (completed.ok === false) return completed;
    return {
      ok: true,
      primitive,
      adapter: "extension",
      value: {
        ...completed.value,
        base64: undefined,
        attached: true,
        selector,
      },
    };
  };

  const fileTransferDownloadCapture = async (args = {}) => {
    const primitive = "file.transfer.download.capture";
    let url;
    try {
      url = new URL(args.url, window.location.href);
    } catch {
      return primitiveError(primitive, "transfer_download_url_invalid", "Download URL is invalid.");
    }
    const expectedOrigin = normalizeTransferOrigin(args.origin);
    if (!expectedOrigin || expectedOrigin !== window.location.origin || url.origin !== expectedOrigin) {
      return primitiveError(primitive, "transfer_origin_mismatch", "Download URL and current page must match the authorized origin.", {
        expected_origin: expectedOrigin,
        page_origin: window.location.origin,
        url_origin: url.origin,
      });
    }
    let response;
    try {
      response = await fetch(url.href, { credentials: "include", redirect: "follow" });
    } catch (error) {
      return primitiveError(primitive, "transfer_download_failed", "Browser download fetch failed.", {
        message: error.message || String(error),
      });
    }
    if (!response.ok) {
      return primitiveError(primitive, "transfer_download_failed", `Browser download returned HTTP ${response.status}.`, {
        status: response.status,
      });
    }
    if (normalizeTransferOrigin(response.url) !== expectedOrigin) {
      return primitiveError(primitive, "transfer_origin_mismatch", "Download redirected outside the authorized origin.", {
        expected_origin: expectedOrigin,
        actual_origin: normalizeTransferOrigin(response.url),
      });
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > FILE_TRANSFER_MAX_BYTES) {
      return primitiveError(primitive, "transfer_oversize", "Download exceeds the configured size limit.", { max_bytes: FILE_TRANSFER_MAX_BYTES, content_length: contentLength });
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > FILE_TRANSFER_MAX_BYTES) {
          await reader.cancel("transfer_oversize").catch(() => {});
          return primitiveError(primitive, "transfer_oversize", "Download exceeds the configured size limit.", { max_bytes: FILE_TRANSFER_MAX_BYTES, size });
        }
        chunks.push(Uint8Array.from(value));
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      size = bytes.byteLength;
      if (size > FILE_TRANSFER_MAX_BYTES) return primitiveError(primitive, "transfer_oversize", "Download exceeds the configured size limit.", { max_bytes: FILE_TRANSFER_MAX_BYTES, size });
      chunks.push(bytes);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const filename = args.filename || decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "download.bin");
    const actualMimeType = response.headers.get("content-type") || "application/octet-stream";
    if (args.mime_type && args.mime_type !== actualMimeType) {
      return primitiveError(primitive, "transfer_mime_mismatch", "Download MIME type does not match the expected value.", { expected_mime_type: args.mime_type, actual_mime_type: actualMimeType });
    }
    const expectedSha256 = await sha256Hex(bytes);
    let result = await fileTransferAction("file.transfer.create", {
      transfer_id: args.transfer_id,
      direction: "download",
      filename,
      mime_type: actualMimeType,
      origin: expectedOrigin,
      expected_size: bytes.byteLength,
      expected_sha256: expectedSha256,
    });
    if (result.ok === false) return result;
    for (let chunkOffset = 0, index = 0; chunkOffset < bytes.byteLength; chunkOffset += FILE_TRANSFER_CHUNK_BYTES, index += 1) {
      result = await fileTransferAction("file.transfer.chunk", {
        transfer_id: args.transfer_id,
        index,
        base64: base64FromBytes(bytes.slice(chunkOffset, chunkOffset + FILE_TRANSFER_CHUNK_BYTES)),
      });
      if (result.ok === false) return result;
    }
    return fileTransferAction("file.transfer.finalize", { transfer_id: args.transfer_id });
  };

  const transferInsert = async (args = {}, reportProgress) => {
    const result = await transferBufferAction("transfer.insert", args);
    if (result.ok === false) return result;
    return insertTextIntoEditable("transfer.insert", {
      text: result.value?.text ?? result.value?.rendered_text ?? "",
      target: args.target,
      mode: args.mode,
    }, reportProgress);
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
    // Synthetic (untrusted) dispatch. Canvas editors (Slides/Docs/Sheets) ignore
    // these; for those, call keyboard.press with trusted:true (background CDP path).
    return primitiveSuccess("keyboard.press", { pressed: true, key, modifiers, fidelity: "synthetic" });
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

  const loadProjectionRetrievalModules = async () => {
    projectionSnapshotStoreModulePromise ||= import(chrome.runtime.getURL("src/agent/projection-snapshot-store.mjs"));
    projectionGraphQueryModulePromise ||= import(chrome.runtime.getURL("src/agent/projection-graph-query.mjs"));
    const [storeModule, queryModule] = await Promise.all([
      projectionSnapshotStoreModulePromise,
      projectionGraphQueryModulePromise,
    ]);
    projectionSnapshotStore ||= storeModule.createProjectionSnapshotStore();
    return { store: projectionSnapshotStore, queryModule };
  };

  const projectionAuthority = (message = {}, projectionName = message.projection_name) => {
    const authority = {
      runtime_id: RUNTIME_ID,
      // The store itself lives in one content realm, but retaining the tab id
      // in every authority/cursor also prevents a forwarded handle replay.
      tab_id: message.tab_id ?? message.authority?.tab_id ?? "content-realm",
      navigation_epoch: projectionNavigationEpoch,
      projection: projectionName,
      catalog_revision: message.catalog_revision
        ?? message.effective_revision
        ?? message.authority?.catalog_revision
        ?? message.bundle?.effective_revision
        ?? message.bundle?.provenance?.effective_revision
        ?? "catalog-unversioned",
    };
    projectionAuthorityTabIds.add(authority.tab_id);
    return authority;
  };

  const normalizeProjectionRetrievalMessage = (message = {}) => {
    const args = message.arguments && typeof message.arguments === "object" ? message.arguments : {};
    return {
      ...message,
      ...args,
      cursor: args.cursor ?? args.continuation ?? message.cursor ?? message.continuation,
      arguments: args,
    };
  };

  const authorityForProjectionHandle = (message) => {
    const authority = message.cursor
      ? projectionCursorAuthorities.get(message.cursor)
      : projectionSnapshotAuthorities.get(message.snapshot_id);
    if (!authority) return null;
    const claimedTab = message.tab_id ?? message.authority?.tab_id;
    const claimedRevision = message.catalog_revision ?? message.effective_revision ?? message.authority?.catalog_revision;
    if ((claimedTab !== undefined && claimedTab !== authority.tab_id)
      || (claimedRevision !== undefined && claimedRevision !== authority.catalog_revision)) {
      const error = new Error("The projection handle belongs to another tab or catalog revision.");
      error.code = "snapshot_authority_mismatch";
      throw error;
    }
    return authority;
  };

  const projectionRetrievalError = (error) => ({
    ok: false,
    error: {
      code: error?.code || "projection_retrieval_failed",
      message: error?.message || String(error),
      ...(error?.details && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
  });

  const clampProjectionPageSize = (value) => {
    const requested = Number(value ?? 5);
    if (!Number.isInteger(requested) || requested <= 0 || requested > 50) {
      const error = new Error("page_size must be an integer from 1 through 50.");
      error.code = "projection_page_size_invalid";
      throw error;
    }
    return requested;
  };

  const compactProjectionNode = (node) => {
    const attributeEntries = Object.entries(node.attributes || {});
    const shown = attributeEntries.slice(0, 12).map(([name, value]) => [
      name,
      typeof value === "string" ? value.slice(0, 160) : value,
    ]);
    return {
      ref: node.ref,
      type: node.type,
      ...(node.label != null ? { label: String(node.label).slice(0, 160) } : {}),
      ...(shown.length > 0 ? { attributes: Object.fromEntries(shown) } : {}),
      ...(attributeEntries.length > shown.length ? { omitted_attribute_count: attributeEntries.length - shown.length } : {}),
    };
  };

  const projectionNavigationUrl = (node) => {
    const attributes = node?.attributes || {};
    const candidate = [attributes.url, attributes.href].find((value) => typeof value === "string" && value.trim());
    if (!candidate) return null;
    try {
      const resolved = new URL(candidate, location.href);
      if (!['http:', 'https:'].includes(resolved.protocol)) return null;
      return resolved.href.slice(0, 2048);
    } catch (_error) {
      return null;
    }
  };

  const enrichProjectionSearchMatch = (match, graph) => {
    const node = graph.nodes.find((candidate) => candidate.ref === match.ref);
    const navigationUrl = projectionNavigationUrl(node);
    return {
      ...match,
      ...(node?.label != null ? { label: String(node.label).slice(0, 160) } : {}),
      ...(navigationUrl ? { navigation_url: navigationUrl } : {}),
    };
  };

  const enforceProjectionAnswerBudget = (answer, maxBytes) => {
    const requested = Number(maxBytes ?? 16 * 1024);
    const budget = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 64 * 1024) : 16 * 1024;
    const bytes = new TextEncoder().encode(JSON.stringify(answer)).length;
    if (bytes <= budget) return answer;
    const error = new Error("Projection retrieval answer exceeded the configured byte budget; request a smaller page.");
    error.code = "projection_answer_too_large";
    error.details = { response_bytes: bytes, response_max_bytes: budget };
    throw error;
  };

  const resolveProjectionRequest = (store, message, operation) => {
    const authority = authorityForProjectionHandle(message);
    if (!authority) {
      const error = new Error("Run state_read first and provide its active snapshot_id.");
      error.code = "snapshot_required";
      throw error;
    }
    if (message.cursor) {
      const cursor = store.resolveCursor({ authority, handle: message.cursor });
      if (cursor.query?.operation !== operation) {
        const error = new Error("The continuation belongs to another projection operation.");
        error.code = "cursor_operation_mismatch";
        throw error;
      }
      return {
        authority,
        snapshot: store.getSnapshot(authority, cursor.snapshot_id),
        args: cursor.query.arguments,
        pageSize: cursor.page_size,
        offset: cursor.offset,
      };
    }
    if (typeof message.snapshot_id !== "string" || !message.snapshot_id) {
      const error = new Error("Run state_read first and provide its active snapshot_id.");
      error.code = "snapshot_required";
      throw error;
    }
    return {
      authority,
      snapshot: store.getSnapshot(authority, message.snapshot_id),
      args: message.arguments || {},
      pageSize: clampProjectionPageSize(message.page_size),
      offset: 0,
    };
  };

  const pageProjectionResults = ({ store, authority, snapshot, operation, args, items, pageSize, offset }) => {
    const page = items.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const more = nextOffset < items.length;
    const nextCursorRecord = more
      ? store.createCursor({
          authority,
          snapshot_id: snapshot.snapshot_id,
          query: { operation, arguments: args },
          scope: args.scope_refs || null,
          order: args.order_by_measure ? { measure: args.order_by_measure, descending: args.descending === true } : null,
          page_size: pageSize,
          offset: nextOffset,
          retrieval_revision: "projection-lexical-v1",
        })
      : null;
    const nextCursor = nextCursorRecord?.handle || null;
    if (nextCursor) {
      projectionCursorAuthorities.set(nextCursor, authority);
      while (projectionCursorAuthorities.size > 256) {
        projectionCursorAuthorities.delete(projectionCursorAuthorities.keys().next().value);
      }
    }
    return { page, more, nextCursor };
  };

  const executeProjectionNavigate = async (message = {}) => {
    try {
      message = normalizeProjectionRetrievalMessage(message);
      const { store, queryModule } = await loadProjectionRetrievalModules();
      const request = resolveProjectionRequest(store, message, "navigate");
      const { snapshot, args } = request;
      const graph = snapshot.graph;
      const mode = args.operation || (args.node_ref ? "node" : "roots");
      let refs;
      if (mode === "roots") {
        refs = [...graph.roots];
      } else if (mode === "node") {
        refs = [args.node_ref].filter(Boolean);
        const known = new Set(graph.nodes.map((node) => node.ref));
        if (refs.length !== 1 || !known.has(refs[0])) {
          const error = new Error(`Unknown projection node ${args.node_ref}.`);
          error.code = "graph_node_not_found";
          throw error;
        }
      } else if (mode === "neighbors" || mode === "traverse") {
        if (args.measure_filter !== undefined) {
          const error = new Error("measure_filter is not supported by this retrieval revision.");
          error.code = "graph_constraint_unsupported";
          throw error;
        }
        const requestedDepth = mode === "neighbors" ? 1 : Number(args.max_depth ?? 3);
        if (!Number.isInteger(requestedDepth) || requestedDepth < 0 || requestedDepth > 10) {
          const error = new Error("max_depth must be an integer from 0 through 10.");
          error.code = "graph_depth_invalid";
          throw error;
        }
        const measureOrder = args.measure_order;
        const orderByMeasure = typeof measureOrder === "string" ? measureOrder : measureOrder?.name;
        const traversed = queryModule.traverseGraph(graph, {
          start_refs: [args.node_ref],
          direction: args.direction,
          edge_types: args.edge_types,
          max_depth: requestedDepth,
          limit: 1000,
          order_by_measure: orderByMeasure,
          descending: typeof measureOrder === "object" && measureOrder?.descending === true,
        });
        refs = mode === "neighbors" ? traversed.filter((ref) => ref !== args.node_ref) : traversed;
      } else {
        const error = new Error(`Unknown projection navigation operation ${mode}.`);
        error.code = "graph_navigation_operation_invalid";
        throw error;
      }
      const nodeByRef = new Map(graph.nodes.map((node) => [node.ref, node]));
      const items = refs.map((ref) => nodeByRef.get(ref)).filter(Boolean).map(compactProjectionNode);
      const paged = pageProjectionResults({ store, ...request, operation: "navigate", items });
      return enforceProjectionAnswerBudget({
        ok: true,
        operation: "navigate",
        snapshot_id: snapshot.snapshot_id,
        mode,
        nodes: paged.page,
        coverage: graph.coverage?.graph,
        ...(paged.nextCursor ? { continuation: paged.nextCursor } : {}),
      }, message.max_bytes);
    } catch (error) {
      return projectionRetrievalError(error);
    }
  };

  const executeProjectionSearch = async (message = {}) => {
    try {
      message = normalizeProjectionRetrievalMessage(message);
      const { store, queryModule } = await loadProjectionRetrievalModules();
      const request = resolveProjectionRequest(store, message, "search");
      const { snapshot, args } = request;
      const searchMode = args.search_mode || args.mode || "lexical";
      if (searchMode !== "lexical") {
        const error = new Error("The content realm currently accepts lexical projection search only.");
        error.code = "semantic_provider_unavailable";
        throw error;
      }
      let scopeRefs = args.scope_refs;
      if (!scopeRefs && Array.isArray(args.scope)) scopeRefs = args.scope;
      if (!scopeRefs && typeof args.scope === "string") scopeRefs = [args.scope];
      if (!scopeRefs && args.scope && typeof args.scope === "object") {
        const scopeDepth = Number(args.scope.max_depth ?? 10);
        if (!Number.isInteger(scopeDepth) || scopeDepth < 0 || scopeDepth > 10) {
          const error = new Error("scope.max_depth must be an integer from 0 through 10.");
          error.code = "graph_depth_invalid";
          throw error;
        }
        scopeRefs = queryModule.traverseGraph(snapshot.graph, {
          start_refs: [args.scope.node_ref],
          direction: args.scope.direction,
          edge_types: args.scope.edge_types,
          max_depth: scopeDepth,
          limit: 1000,
        });
      }
      const result = queryModule.searchLexicalIndex(snapshot.graph, args.query, {
        scope_refs: scopeRefs,
        limit: snapshot.graph.nodes.length || 1,
      });
      const items = result.matches.map((match) => ({
        ref: match.ref,
        type: match.node_type,
        score: match.score,
        match_kind: match.match_kind,
        fields: match.fields.map((field) => ({
          field: field.field,
          path: field.path,
          snippet: String(field.text).slice(0, 160),
          matched_terms: field.matched_terms,
        })),
      })).map((match) => enrichProjectionSearchMatch(match, snapshot.graph));
      const paged = pageProjectionResults({ store, ...request, operation: "search", items });
      return enforceProjectionAnswerBudget({
        ok: true,
        operation: "search",
        mode: "lexical",
        snapshot_id: snapshot.snapshot_id,
        status: result.status,
        matches: paged.page,
        coverage: result.coverage,
        ...(paged.nextCursor ? { continuation: paged.nextCursor } : {}),
      }, message.max_bytes);
    } catch (error) {
      return projectionRetrievalError(error);
    }
  };

  // Privileged-background preparation route. This never reaches the model: it
  // returns bounded local field candidates so background can apply the trusted
  // projection policy before any query or page text is sent to a provider.
  const prepareProjectionSemanticSearch = async (message = {}) => {
    try {
      message = normalizeProjectionRetrievalMessage(message);
      const { store, queryModule } = await loadProjectionRetrievalModules();
      const request = resolveProjectionRequest(store, message, "search");
      const { authority, snapshot, args } = request;
      let scopeRefs = args.scope_refs;
      if (!scopeRefs && Array.isArray(args.scope)) scopeRefs = args.scope;
      if (!scopeRefs && typeof args.scope === "string") scopeRefs = [args.scope];
      if (!scopeRefs && args.scope && typeof args.scope === "object") {
        const scopeDepth = Number(args.scope.max_depth ?? 10);
        if (!Number.isInteger(scopeDepth) || scopeDepth < 0 || scopeDepth > 10) {
          const error = new Error("scope.max_depth must be an integer from 0 through 10.");
          error.code = "graph_depth_invalid";
          throw error;
        }
        scopeRefs = queryModule.traverseGraph(snapshot.graph, {
          start_refs: [args.scope.node_ref],
          direction: args.scope.direction,
          edge_types: args.scope.edge_types,
          max_depth: scopeDepth,
          limit: 1000,
        });
      }
      const scope = scopeRefs ? new Set(scopeRefs) : null;
      const lexical = queryModule.searchLexicalIndex(snapshot.graph, args.query, {
        scope_refs: scopeRefs,
        limit: snapshot.graph.nodes.length || 1,
      });
      const lexicalMatches = lexical.matches.slice(0, 50).map((match) => ({
        ref: match.ref,
        type: match.node_type,
        score: match.score,
        fields: match.fields.slice(0, 4).map((field) => ({
          field: field.field,
          path: field.path,
          snippet: String(field.text).slice(0, 160),
          matched_terms: field.matched_terms,
        })),
      }));
      const nodes = new Map(snapshot.graph.nodes.map((node) => [node.ref, node]));
      const parents = new Map();
      for (const edge of snapshot.graph.edges) {
        if (!snapshot.graph.containment_edge_types.includes(edge.type)) continue;
        const list = parents.get(edge.to) || [];
        if (list.length < 8) list.push(edge.from);
        parents.set(edge.to, list);
      }
      const ancestryFor = (ref) => {
        const output = [];
        const seen = new Set([ref]);
        let frontier = [ref];
        for (let depth = 0; depth < 8 && frontier.length; depth += 1) {
          const next = [];
          for (const current of frontier) {
            for (const parent of parents.get(current) || []) {
              if (seen.has(parent)) continue;
              seen.add(parent);
              output.push(parent);
              next.push(parent);
            }
          }
          frontier = next;
        }
        return output;
      };
      const candidates = [];
      let candidateBytes = 0;
      let candidateComplete = snapshot.graph.coverage?.lexical?.complete === true;
      for (let index = 0; index < snapshot.graph.lexical_index.records.length; index += 1) {
        const record = snapshot.graph.lexical_index.records[index];
        if (scope && !scope.has(record.node_ref)) continue;
        if (candidates.length >= 100_000) { candidateComplete = false; break; }
        const candidate = {
          id: `${record.node_ref}\u001f${record.path}`,
          node_ref: record.node_ref,
          field: record.field,
          path: record.path,
          node_type: nodes.get(record.node_ref)?.type || "unknown",
          ancestry: ancestryFor(record.node_ref),
          value: record.text,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
        if (candidateBytes + bytes > 8_000_000) { candidateComplete = false; break; }
        candidateBytes += bytes;
        candidates.push(candidate);
      }
      return {
        ok: true,
        snapshot_id: snapshot.snapshot_id,
        semantic_namespace: authority.projection,
        projection_name: authority.projection,
        catalog_revision: authority.catalog_revision,
        lexical_result: {
          ok: true,
          operation: "search",
          mode: "lexical",
          snapshot_id: snapshot.snapshot_id,
          status: lexical.status,
          matches: lexicalMatches,
          coverage: lexical.coverage,
        },
        candidates,
        coverage: {
          graph: snapshot.graph.coverage?.graph,
          lexical: snapshot.graph.coverage?.lexical,
          candidates: { complete: candidateComplete, candidate_count: candidates.length },
        },
      };
    } catch (error) {
      return projectionRetrievalError(error);
    }
  };

  const finalizeProjectionSemanticSearch = async (message = {}) => {
    try {
      message = normalizeProjectionRetrievalMessage(message);
      const { store } = await loadProjectionRetrievalModules();
      const request = resolveProjectionRequest(store, message, "search");
      const supplied = Array.isArray(message.ranked_matches) ? message.ranked_matches : null;
      const items = (supplied || request.args.__semantic_ranked_matches)
        ?.map((match) => enrichProjectionSearchMatch(match, request.snapshot.graph));
      const semantic = message.semantic || request.args.__semantic_metadata;
      if (!Array.isArray(items) || !semantic || typeof semantic !== "object") {
        const error = new Error("The semantic result page is missing its frozen ranked result set.");
        error.code = "semantic_cursor_invalid";
        throw error;
      }
      const cursorArgs = supplied
        ? { ...request.args, __semantic_ranked_matches: structuredClone(items), __semantic_metadata: structuredClone(semantic) }
        : request.args;
      const paged = pageProjectionResults({
        store,
        ...request,
        operation: "search",
        args: cursorArgs,
        items,
      });
      return enforceProjectionAnswerBudget({
        ok: true,
        operation: "search",
        mode: "hybrid",
        snapshot_id: request.snapshot.snapshot_id,
        status: semantic.complete ? (paged.page.length ? "matches" : "no_confident_match") : "incomplete",
        matches: paged.page,
        coverage: semantic.coverage,
        semantic: semantic.semantic,
        ...(paged.nextCursor ? { continuation: paged.nextCursor } : {}),
      }, message.max_bytes);
    } catch (error) {
      return projectionRetrievalError(error);
    }
  };

  const advanceProjectionNavigationEpoch = async () => {
    if (location.href === projectionNavigationHref) return;
    projectionNavigationHref = location.href;
    projectionNavigationEpoch = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!projectionSnapshotStore) return;
    for (const tabId of projectionAuthorityTabIds) {
      projectionSnapshotStore.cleanupNavigation({
        runtime_id: RUNTIME_ID,
        tab_id: tabId,
        retain_navigation_epoch: projectionNavigationEpoch,
      });
    }
  };

  // SPA history transitions do not reload a content script. Polling the URL is
  // intentionally cheap and gives those transitions the same fail-closed
  // cursor cleanup as a full document navigation (which destroys this realm).
  projectionNavigationPoller = setInterval(() => {
    advanceProjectionNavigationEpoch().catch(() => {});
  }, 500);
  window.addEventListener("popstate", advanceProjectionNavigationEpoch);
  window.addEventListener("hashchange", advanceProjectionNavigationEpoch);

  // Per-tab marker registry (KTD3): markers are stable anchors minted by a
  // projection run; coordinates are NEVER stored (KTD4) — the marker-runner
  // resolves a marker's recipe live at query/move time. Cleared naturally on
  // navigation (content script reload); re-running a projection replaces its
  // own markers.
  const stateMarkerRegistry = new Map();
  const stateProjectionSnapshots = new Map();

  const registerStateMarkers = (projectionName, markers) => {
    for (const [id, existing] of stateMarkerRegistry) {
      if (existing.projection === projectionName) stateMarkerRegistry.delete(id);
    }
    for (const marker of markers) {
      stateMarkerRegistry.set(marker.id, {
        ...marker,
        projection: projectionName,
        registered_at: new Date().toISOString(),
      });
    }
  };

  const executeStateProjection = async (message) => {
    const module = await loadStateProjectionModule();
    const { store } = await loadProjectionRetrievalModules();
    const authority = projectionAuthority(message);
    const result = await module.executeStateProjection({
      bundle: message.bundle,
      pageUrl: location.href,
      document,
      projectionName: message.projection_name,
      summaryName: message.summary_name || null,
      summaryArguments: message.summary_arguments || {},
      maxBytes: message.max_bytes,
      projectionCache: message.projection_cache || {},
      activateGraph: ({ graph }) => {
        const activated = store.activate({
          authority,
          graph,
          declaredKeys: Array.isArray(message.continuity_keys) ? message.continuity_keys : [],
        });
        projectionSnapshotAuthorities.set(activated.snapshot_id, authority);
        while (projectionSnapshotAuthorities.size > 32) {
          projectionSnapshotAuthorities.delete(projectionSnapshotAuthorities.keys().next().value);
        }
        return {
          snapshot_id: activated.snapshot_id,
          roots: activated.graph.roots,
          active: true,
          navigation_ready: true,
          transitions: activated.transitions,
        };
      },
    });
    if (result?.ok && Array.isArray(result.markers)) {
      registerStateMarkers(result.projection || message.projection_name, result.markers);
    }
    if (message.record_snapshot === true && result?.ok && result.state !== undefined) {
      stateProjectionSnapshots.set(message.projection_name, {
        state: result.state,
        state_hash: result.state_hash || null,
        observed_at: result.observed_at || new Date().toISOString(),
      });
    }
    return result;
  };

  const executeStatePostcondition = async (message) => {
    const module = await loadStateProjectionModule();
    const projection = await module.executeStateProjection({
      bundle: message.bundle,
      pageUrl: location.href,
      document,
      projectionName: message.projection_name,
      maxBytes: message.max_bytes,
      consumer: "internal_compute",
      projectionCache: message.projection_cache || {},
    });
    if (projection?.ok && Array.isArray(projection.markers)) {
      registerStateMarkers(projection.projection || message.projection_name, projection.markers);
    }
    if (projection?.ok === false) {
      return projection;
    }
    const verification = await module.verifyStatePostcondition({
      postcondition: message.postcondition,
      state: projection.state,
      input: message.input || {},
    });
    const { state: _state, ...metadata } = projection;
    return {
      ...metadata,
      verification,
      ...(verification?.ok === false ? { error: verification.error } : {}),
    };
  };

  const executeStateDiff = async (message) => {
    const module = await loadStateProjectionModule();
    const projection = await module.executeStateProjection({
      bundle: message.bundle,
      pageUrl: location.href,
      document,
      projectionName: message.projection_name,
      maxBytes: message.compute_max_bytes,
      consumer: "internal_compute",
      projectionCache: message.projection_cache || {},
    });
    if (projection?.ok === false) {
      return projection;
    }
    const key = message.projection_name;
    const previous = stateProjectionSnapshots.get(key);
    const patches = previous?.state === undefined
      ? []
      : module.diffStates(previous.state, projection.state);
    stateProjectionSnapshots.set(key, {
      state: projection.state,
      state_hash: projection.state_hash || null,
      observed_at: projection.observed_at || new Date().toISOString(),
    });
    const output = {
      ok: true,
      projection: message.projection_name,
      baseline: previous ? "previous_snapshot" : "initialized",
      patch_format: "json_patch",
      patches,
      semantic_deltas: module.buildSemanticDeltas(patches),
      previous_state_hash: previous?.state_hash || null,
      state_hash: projection.state_hash || null,
      observed_at: projection.observed_at || null,
      ...(Array.isArray(projection.cache_updates) ? { cache_updates: projection.cache_updates } : {}),
    };
    const requested = Number(message.response_max_bytes);
    const responseBudget = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, module.STATE_PROJECTION_LIMITS.diffResponseBytes)
      : module.STATE_PROJECTION_LIMITS.diffResponseBytes;
    const responseBytes = new TextEncoder().encode(JSON.stringify(output)).length;
    if (responseBytes > responseBudget) {
      return {
        ok: false,
        error: {
          code: "state_diff_payload_too_large",
          message: "State diff output exceeded the configured response budget.",
          response_bytes: responseBytes,
          response_max_bytes: responseBudget,
        },
      };
    }
    return output;
  };

  // --- Marker-runner (action layer, KTD1/KTD2) -------------------------------
  // A marker's recipe is a declarative sequence of existing portable primitives.
  // The runner executes it live at query/move time — coordinates are never
  // stored (KTD4). The consumer holds only the marker id + its typed promise.

  const runMarkerRecipeStep = async (step) => {
    const args = step.args || {};
    switch (step.primitive) {
      case "keyboard.press":
        if (args.trusted === true) {
          // Content scripts cannot attach the debugger; relay to the background
          // worker, which dispatches the real CDP key on this same tab.
          const relayed = await chrome.runtime.sendMessage({
            type: "actions-json:marker-trusted-key",
            key: args.key,
            modifiers: args.modifiers || [],
            repeat: args.repeat,
          });
          if (!relayed?.ok) {
            return primitiveError("keyboard.press", "trusted_key_failed", relayed?.error || "Trusted key relay failed.", { key: args.key });
          }
          return primitiveSuccess("keyboard.press", { pressed: true, key: args.key, repeat: relayed.repeat ?? 1, fidelity: "trusted" });
        }
        return keyboardPress(args);
      case "pointer.click":
        return pointerClick(args);
      case "pointer.move":
        return pointerMove(args);
      case "pointer.double_click":
        return pointerDoubleClick(args);
      case "locator.element_info":
        return locatorElementInfo(args);
      case "locator.wait_for":
        return locatorWaitFor(args);
      case "dom.focus":
        return domFocus(args);
      case "text.insert":
        return textInsert(args);
      case "text.type":
        return textType(args);
      case "viewport.scroll":
        return viewportScroll(args);
      default:
        return primitiveError("marker.query", "invalid_recipe_step", `Recipe step primitive "${step.primitive}" is not allowed.`, { step });
    }
  };

  const runMarkerRecipe = async (marker) => {
    // Seed location from a static anchor coordinate when the projection author
    // supplied one — on canvas surfaces (Docs/Slides) text has no DOM coordinate,
    // so the marker's anchor {x,y} IS its resolved location and the recipe just
    // enacts it (e.g. pointer.click). A later step may refine this.
    let location = (marker.anchor && Number.isFinite(marker.anchor.x) && Number.isFinite(marker.anchor.y))
      ? { x: marker.anchor.x, y: marker.anchor.y }
      : null;
    for (let index = 0; index < marker.recipe.length; index += 1) {
      const step = marker.recipe[index];
      const result = await runMarkerRecipeStep(step);
      const ok = result?.ok !== false && result?.value?.ok !== false;
      if (!ok) {
        return {
          ok: false,
          error: {
            code: "marker_recipe_step_failed",
            message: `Marker "${marker.id}" recipe step ${index + 1} (${step.primitive}) failed.`,
            step_index: index,
            primitive: step.primitive,
            cause: result?.error || result?.value?.error || result,
          },
        };
      }
      const value = result?.value || result;
      // A step resolves the location if it exposes one — a locator's
      // clickable_center, or a plain {x,y} (pointer.click / pointer.move return this).
      if (value?.clickable_center && Number.isFinite(value.clickable_center.x)) {
        location = { x: value.clickable_center.x, y: value.clickable_center.y };
      } else if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
        location = { x: value.x, y: value.y };
      }
    }
    return { ok: true, location };
  };

  const resolveRegisteredMarker = (primitive, markerId) => {
    if (typeof markerId !== "string" || !markerId) {
      return { error: primitiveError(primitive, "invalid_input", "A marker id is required.", { marker: markerId }) };
    }
    const marker = stateMarkerRegistry.get(markerId);
    if (!marker) {
      return {
        error: primitiveError(primitive, "marker_not_found", `No registered marker "${markerId}". Re-run the projection that mints it — markers clear on navigation.`, {
          marker: markerId,
          registered: [...stateMarkerRegistry.keys()],
        }),
      };
    }
    return { marker };
  };

  const markerQuery = async (args = {}) => {
    const { marker, error } = resolveRegisteredMarker("marker.query", args.id ?? args.marker);
    if (error) return error;
    const run = await runMarkerRecipe(marker);
    if (!run.ok) return primitiveError("marker.query", run.error.code, run.error.message, run.error);
    return primitiveSuccess("marker.query", {
      marker: marker.id,
      type: marker.type,
      location: run.location,
      resolved_at: new Date().toISOString(),
    });
  };

  const markerMoveTo = async (primitive, expectedType, args = {}) => {
    const { marker, error } = resolveRegisteredMarker(primitive, args.marker ?? args.id);
    if (error) return error;
    if (marker.type !== expectedType) {
      return primitiveError(primitive, "marker_type_mismatch", `Marker "${marker.id}" is a ${marker.type} marker; ${primitive} requires a ${expectedType} marker.`, {
        marker: marker.id,
        type: marker.type,
      });
    }
    const run = await runMarkerRecipe(marker);
    if (!run.ok) return primitiveError(primitive, run.error.code, run.error.message, run.error);
    if (expectedType === "pointer") {
      if (!run.location) {
        return primitiveError(primitive, "marker_promise_unkept", `Marker "${marker.id}" recipe completed but produced no location to move the pointer to. Its recipe must end with a locating step (e.g. locator.element_info).`, {
          marker: marker.id,
        });
      }
      moveVisiblePointer(run.location.x, run.location.y);
    }
    return primitiveSuccess(primitive, {
      marker: marker.id,
      type: marker.type,
      moved: true,
      location: run.location,
      resolved_at: new Date().toISOString(),
    });
  };

  const findExecutableAction = (actions, name) => {
    const declaredTool = actions.tools?.find((tool) => tool.name === name);
    if (declaredTool) return declaredTool;
    const primitive = actions.primitive_dictionary?.primitives?.find((entry) => entry.name === name);
    if (!primitive || primitive.support === "unsupported") return null;
    return primitive;
  };

  const executeAction = async (message, reportProgress) => {
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
    } else if (message.name === "overlay.cursor.point") {
      output = await overlayCursorPoint(message.arguments || {});
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
    } else if (message.name === "runtime.agent.memory_clear") {
      output = await runtimeAgentMemoryClear();
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
    } else if (message.name === "marker.query") {
      output = await markerQuery(message.arguments || {});
    } else if (message.name === "cursor.move_to") {
      output = await markerMoveTo("cursor.move_to", "cursor", message.arguments || {});
    } else if (message.name === "pointer.move_to") {
      output = await markerMoveTo("pointer.move_to", "pointer", message.arguments || {});
    } else if (message.name === "locator.element_info") {
      output = await locatorElementInfo(message.arguments || {});
    } else if (message.name === "locator.text_content") {
      output = locatorTextContent(message.arguments || {});
    } else if (message.name === "locator.value") {
      output = locatorValue(message.arguments || {});
    } else if (message.name === "dom.focus") {
      output = domFocus(message.arguments || {});
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
      output = await textInsert(message.arguments || {}, reportProgress);
    } else if (message.name === "text.type") {
      output = await textType(message.arguments || {}, reportProgress);
    } else if (message.name === "clipboard.paste") {
      output = await clipboardPaste(message.arguments || {});
    } else if (message.name === "clipboard.read") {
      output = await clipboardRead();
    } else if (message.name === "clipboard.write") {
      output = await clipboardWrite(message.arguments || {});
    } else if (message.name === "text.select") {
      output = textSelect(message.arguments || {});
    } else if (message.name === "clipboard.copy") {
      output = await clipboardCopy(message.arguments || {});
    } else if (message.name === "page.fetch") {
      output = await pageFetch(message.arguments || {});
    } else if (message.name === "transfer.write") {
      output = await transferBufferAction("transfer.write", message.arguments || {});
    } else if (message.name === "transfer.read") {
      output = await transferBufferAction("transfer.read", message.arguments || {});
    } else if (message.name === "transfer.clear") {
      output = await transferBufferAction("transfer.clear", message.arguments || {});
    } else if (message.name === "transfer.insert") {
      output = await transferInsert(message.arguments || {}, reportProgress);
    } else if (message.name === "file.transfer.upload.consume") {
      output = await fileTransferUploadConsume(message.arguments || {});
    } else if (message.name === "file.transfer.download.capture") {
      output = await fileTransferDownloadCapture(message.arguments || {});
    } else if (message.name?.startsWith("file.transfer.")) {
      output = await fileTransferAction(message.name, message.arguments || {});
    } else if (message.name === "storage.read_file") {
      output = await storageReadFile(message.arguments || {});
    } else if (message.name === "keyboard.press") {
      // Honor trusted:true here too (workflow/runtime dispatch path). Without
      // this, a workflow's keyboard.press{trusted:true} fell through to the
      // SYNTHETIC keyboardPress and canvas editors (Docs/Slides/Sheets) ignored
      // it — so Find's Enter/Escape never committed inside a composed action,
      // even though the same call worked as a direct primitive. Mirrors the
      // direct-path trusted relay.
      const kargs = message.arguments || {};
      if (kargs.trusted === true) {
        const relayed = await chrome.runtime.sendMessage({
          type: "actions-json:marker-trusted-key",
          key: kargs.key,
          modifiers: kargs.modifiers || [],
          repeat: kargs.repeat,
        });
        output = relayed?.ok
          ? primitiveSuccess("keyboard.press", { pressed: true, key: kargs.key, repeat: relayed.repeat ?? 1, fidelity: "trusted" })
          : primitiveError("keyboard.press", "trusted_key_failed", relayed?.error || "Trusted key relay failed.", { key: kargs.key });
      } else {
        output = keyboardPress(kargs);
      }
    } else if (message.name === "page.info") {
      output = pageInfo();
    } else if (message.name === "dom.observe.visible") {
      output = domObserveVisible(message.arguments || {});
    } else if (message.name === "dom.observe.attributes") {
      output = domObserveAttributes(message.arguments || {});
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
    let lastEnteredContentPhase = null;
    let lastCompletedContentPhase = null;
    const reportProgress = (phase, status = "completed") => {
      if (status === "entered") lastEnteredContentPhase = phase;
      if (status === "completed") lastCompletedContentPhase = phase;
      protocolSend({
        type: "action_progress",
        call_id: callId,
        runtime_id: RUNTIME_ID,
        action: message.name || null,
        last_entered_content_phase: lastEnteredContentPhase,
        last_completed_content_phase: lastCompletedContentPhase,
        observed_at: new Date().toISOString(),
      });
    };
    try {
      reportProgress("action_handler", "entered");
      const output = await executeAction(message, reportProgress);
      reportProgress("action_handler", "completed");
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
        output: {
          progress: {
            last_entered_content_phase: lastEnteredContentPhase,
            last_completed_content_phase: lastCompletedContentPhase,
          },
        },
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
        ...(response?.output !== undefined ? { output: response.output } : {}),
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
        ...(response?.output !== undefined ? { output: response.output } : {}),
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
    if (message?.type === "actions-json:file-transfer-test") {
      const operation = message.name === "file.transfer.upload.consume"
        ? fileTransferUploadConsume(message.arguments || {})
        : message.name === "file.transfer.download.capture"
          ? fileTransferDownloadCapture(message.arguments || {})
          : fileTransferAction(message.name, message.arguments || {});
      Promise.resolve(operation).then(sendResponse, (error) => sendResponse({
        ok: false,
        error: error.message || String(error),
      }));
      return true;
    }
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
    if (message?.type === "actions-json:cost-meter-update") {
      sendResponse(showCostMeter(message));
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
    if (message?.type === "actions-json:execute-projection-navigate") {
      executeProjectionNavigate(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({ ok: false, error: projectionRetrievalError(error).error })
      );
      return true;
    }
    if (message?.type === "actions-json:execute-projection-search") {
      executeProjectionSearch(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({ ok: false, error: projectionRetrievalError(error).error })
      );
      return true;
    }
    if (message?.type === "actions-json:prepare-projection-semantic-search") {
      prepareProjectionSemanticSearch(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({ ok: false, error: projectionRetrievalError(error).error })
      );
      return true;
    }
    if (message?.type === "actions-json:finalize-projection-semantic-search") {
      finalizeProjectionSemanticSearch(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({ ok: false, error: projectionRetrievalError(error).error })
      );
      return true;
    }
    if (message?.type === "actions-json:execute-state-postcondition") {
      executeStatePostcondition(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({
          ok: false,
          error: {
            code: "state_postcondition_failed",
            message: error.message || String(error)
          }
        })
      );
      return true;
    }
    if (message?.type === "actions-json:execute-state-diff") {
      executeStateDiff(message).then(
        (output) => sendResponse({ ok: output?.ok !== false, output, error: output?.error || null }),
        (error) => sendResponse({
          ok: false,
          error: {
            code: "state_diff_failed",
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
      if (projectionNavigationPoller) {
        clearInterval(projectionNavigationPoller);
        projectionNavigationPoller = null;
      }
      if (projectionSnapshotStore) {
        for (const tabId of projectionAuthorityTabIds) {
          projectionSnapshotStore.cleanupTab({ runtime_id: RUNTIME_ID, tab_id: tabId });
        }
      }
      relayedRuntimeIds.clear();
      relayedRuntimeReady.clear();
      window.removeEventListener("message", handleBookmarkletRelayMessage);
      window.removeEventListener("popstate", scheduleLauncherRefresh);
      window.removeEventListener("hashchange", scheduleLauncherRefresh);
      window.removeEventListener("popstate", advanceProjectionNavigationEpoch);
      window.removeEventListener("hashchange", advanceProjectionNavigationEpoch);
    }
  };
})();
